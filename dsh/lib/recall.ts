/**
 * Recall: choose which memories enter a session's prompt, and render them.
 *
 * Selection is deterministic on purpose. The judgement layer may rank, but the
 * quota per type, the recency decay, and the token budget are code — a memory
 * that is important stays in even when a model would have dropped it, and a
 * memory that is not in the configured types never appears at all.
 *
 * Types: this module never touches the disk and never sees a host object, so it
 * describes a record by the few fields it reads (`RecallableRecord`) instead of
 * importing `MemoryRecord`. That keeps the ranking functions usable — and
 * testable — with hand-built records, and keeps the plugin zero-dependency.
 *
 * @module dsh/lib/recall
 */

import { createBm25Scorer } from './conflict.ts'
import { estimateTokens } from './text.ts'
import { recordIdOf } from './store.ts'

/** Default per-type quota; the sum is the effective injection ceiling. */
export const DEFAULT_QUOTA: Record<string, number> = { constraint: 4, pitfall: 3, decision: 2 }

/** Age is a tie-breaker, not a filter: a 300-day-old constraint still beats a fresh fact. */
const HALF_LIFE_DAYS = 180

/** The fields selection, rendering and search read off a stored memory. */
export interface RecallableRecord {
  id: string
  type: string
  text: string
  cwd: string | null
  importance: number
  status: string
  createdAt: number
  /** cleaned rendering, used for injection when `preferCanonical` is on. */
  canonical?: string | null
}

/** The one field the workspace-scope rule reads. */
export interface ScopeRecord {
  cwd?: string | null
}

/** One chosen memory: the record plus why it ranked where it did. */
export interface RecalledMemory {
  /** the chosen record. */
  record: RecallableRecord
  /** deterministic ranking score. */
  score: number
  /** age in days at recall time. */
  ageDays: number
}

/** Selection inputs; `cwd` and `types` are required, the rest have defaults. */
export interface RecallOptions {
  /** the session's working directory. */
  cwd: string | null
  /** enabled types. */
  types: string[]
  /** per-type ceiling. */
  quota?: Record<string, number>
  /** total injection budget. */
  maxTokens?: number
  /** clock. */
  now?: number
  /** whether suspected conflicts may enter. */
  includeNeedsReview?: boolean
  /** inject the canonical rendering when a record has one. */
  preferCanonical?: boolean
  /**
   * Leave out an id that says nothing beyond the sentence it belongs to.
   *
   * On by default, and it is not cosmetic. When ids were `signatureOf(text)`, the rendered line was
   * printing the memory twice — the same sentence again, with digits folded to `<n>` — and half the
   * block's tokens were that duplicate. Measured on the live store at the time: 16 of 16 records, and
   * removing it took the block from 4.4 to 6.5 memories in 591 tokens.
   *
   * Ids are content hashes now, so what is left to omit is a 12-character digest: ~4 tokens per
   * memory rather than a whole repeated sentence. **The size of the win therefore shrank and the
   * 4.4 → 6.5 figure above no longer describes this code** — it was measured under the old id scheme.
   * The switch is kept because a digest is not information to a reader, and `memory_forget` takes a
   * `query` as well as an `id`.
   *
   * Ids that carry information are still kept: an archive hit (`l0:...`), or a record injected in a
   * canonical form, whose id refers to the verbatim text the model can no longer see.
   */
  omitRedundantId?: boolean
  /**
   * What the session is currently about, so injection can look at the conversation.
   *
   * Before this existed the injected set was a property of the store alone: "importance ×0.85 +
   * decay ×0.15", type quotas, token budget. Measured against the 36-probe baseline that covered
   * **2 of 36 (6%)** of the memories the probes needed — because a memory's importance says nothing
   * about whether it answers the question being asked right now. Injection is the only recall the
   * model gets without asking, so missing 94% of what was needed is the largest number on the
   * reading side.
   *
   * Empty or absent keeps the old behaviour exactly (see `relevanceWeight`), which is what the
   * first turn of a session gets: there is no conversation yet.
   */
  query?: string | null
  /**
   * How many slots to reserve for the most recently written memories.
   *
   * A memory written at the end of a turn has not been mentioned in the conversation yet, so at
   * `relevanceWeight` it scores only the importance half of the blend — and anything the conversation
   * *does* mention outranks it. That is the right order in general and the wrong one for the sentence
   * the person just stated, which is the one they are most likely to expect the model to know.
   *
   * `0` (the default) is the measured baseline. The reserve deliberately ignores the per-type quota —
   * its purpose is "this was just learned, the model should see it" — but it does not ignore the token
   * budget, and it can only add records that passed the same eligibility filter.
   */
  recentSlots?: number
  /**
   * How much a *just written* memory is boosted above its rank, in score units.
   *
   * The softer half of the same idea as `recentSlots`, and the one that survived measurement. A
   * reserve guarantees the newest record a slot by evicting the lowest-ranked answer, which cost 3 to
   * 10 points of coverage on the probes; a bonus lets it compete instead — enough to beat the weak
   * relevance matches, not enough to displace a strong one. Half-life is six hours, which is "this
   * session" rather than "this month": the prior's own decay has a much longer half-life and exists to
   * break near-ties, not to notice something written a minute ago.
   */
  recencyBonus?: number
  /**
   * How much the query matters against importance, in 0..1.
   *
   * `0` is the old ranking; `1` ignores importance entirely. The shipped value is swept against the
   * probes rather than chosen — see `DEFAULT_RELEVANCE_WEIGHT`.
   */
  relevanceWeight?: number
}

/**
 * A token that looks like a *name* rather than an ordinary word.
 *
 * Used to decide when a query is quoting something — a file, a symbol, an error code. The
 * shape test matters: `replace` and `intended` also occur once in the store, and treating them
 * as names made the first version of the identifier probe set measure nothing.
 */
export const NAME_LIKE = /\b[A-Za-z][A-Za-z0-9_.-]{4,}\b/gu

/**
 * How much one verbatim name match is worth on top of BM25.
 *
 * Swept against both probe kinds at once, because a bonus big enough to fix identifier queries
 * can drown the prose score. On 36 paraphrase probes and 22 identifier probes: 0 → identifier
 * MRR 0.31 / Hit@1 0%; 4 → 0.55 / 14%; 8 → 0.95 / 91%; **12 and above → 1.00 / 100%**, with the
 * paraphrase numbers unchanged at 0.71 / 67% for every weight up to 128. 16 sits inside that
 * plateau rather than on its edge.
 *
 * It exists because replacing the substring matcher with BM25 fixed paraphrase and *broke*
 * this: on a quoted name the old matcher scored 0.97 and BM25 scored 0.31, since an identifier
 * is one token among many and `memory` or `json` carry little IDF.
 */
const NAME_MATCH_BONUS = 16

/** Ranking options for the on-demand search tool. */
export interface SearchOptions {
  /** session working directory. */
  cwd?: string | null
  /** maximum results. */
  limit?: number
}

/**
 * How much the current conversation counts against a memory's importance when injecting.
 *
 * Swept on the 36-probe baseline (`node eval/recall-report.ts`), because the trade is real in both
 * directions — relevance promotes memories that answer *this* question and demotes memories that were
 * important in general:
 *
 * | weight | coverage | injected that are real memories |
 * |---|---|---|
 * | 0 (the old ranking) | 0 / 36 | — |
 * | 0.35 | 16 / 36 | 22% |
 * | 0.5 | 16 / 36 | 30% |
 * | **0.8** | **17 / 36** | **42%** |
 * | 1.0 | 16 / 36 | 39% |
 *
 * Both columns peak at 0.8 and neither is bought with the other, which is unusual enough to say out
 * loud: the usual objection to relevance-ranked injection is that it fills the budget with whatever
 * shares a word with the question. Here the opposite happened, because the old ranking was filling
 * the budget by *importance*, and the store's important-looking records are mostly the write side's
 * false positives (76 of 94 records in the frozen corpus). The remaining gap is not this number's
 * fault: 16 of 36 probe targets are typed `fact`, which the injection whitelist refuses, and the
 * live store contains no `fact` records at all because the write whitelist refuses them first.
 *
 * Not 1.0: at full weight a memory written this turn that the conversation has not mentioned yet
 * scores zero, and importance is the only thing that can carry it. That case is not in the probe set
 * (the frozen corpus has no recency), so 0.8 is chosen for a reason the probes cannot test — stated
 * as such rather than dressed up as a measurement.
 */
export const DEFAULT_RELEVANCE_WEIGHT = 0.8

/**
 * Half-life of the "just written" bonus, in hours.
 *
 * Six hours is one working session. Long enough that a memory written at the end of a turn is still
 * boosted when the next turn asks something else; short enough that yesterday's note is not competing
 * with today's question on age.
 */
export const RECENCY_HALF_LIFE_HOURS = 6

/** One ranked search match. */
export interface SearchHit {
  record: RecallableRecord
  score: number
}

/**
 * Choose the memories a session should see.
 *
 * @param records - every live record.
 * @param options - selection inputs.
 * @returns the chosen memories, highest score first.
 */
export function selectMemories(records: RecallableRecord[], options: RecallOptions): RecalledMemory[] {
  const {
    cwd,
    types,
    quota = DEFAULT_QUOTA,
    maxTokens = 600,
    now = Date.now(),
    includeNeedsReview = false,
    preferCanonical = false,
    omitRedundantId = true,
  } = options

  // Relevance is computed for the whole store and normalised by the best hit, so the blended score
  // stays in the same 0..1 range as the prior and `relevanceWeight` means what it says. Normalising
  // by the top hit rather than by an absolute score is deliberate: BM25 scores are unbounded and
  // corpus-dependent, so an absolute threshold would mean something different in every store.
  const query = (options.query ?? '').trim()
  const relevanceWeight =
    query === '' ? 0 : Math.min(1, Math.max(0, options.relevanceWeight ?? DEFAULT_RELEVANCE_WEIGHT))
  const recencyBonus = Math.max(0, options.recencyBonus ?? 0)
  const relevance = new Map<string, number>()
  if (query !== '' && relevanceWeight > 0) {
    // The same `cwd` the eligibility filter below uses, and it must be the same: `searchMemories`
    // excludes out-of-scope records, so scoring with the default `null` returned no hits at all for
    // workspace-scoped memories — which is most of them — and the relevance term silently became
    // zero. The feature would have shipped as a no-op that looked like it was working, because the
    // ranking still produced an order (the prior's).
    const hits = searchMemories(records, query, { cwd, limit: records.length })
    const best = hits[0]?.score ?? 0
    if (best > 0) for (const hit of hits) relevance.set(hit.record.id, hit.score / best)
  }

  const eligible: RecalledMemory[] = []
  for (const record of records) {
    if (!types.includes(record.type)) continue
    if (record.status !== 'active' && !(includeNeedsReview && record.status === 'needs-review')) continue
    if (!inScope(record, cwd)) continue
    const ageDays = Math.max(0, (now - record.createdAt) / 86_400_000)
    const decay = 0.5 ** (ageDays / HALF_LIFE_DAYS)
    // Importance dominates; decay only breaks near-ties, so a stale constraint
    // is never displaced by a trivial recent note.
    const prior = record.importance * 0.85 + decay * 0.15
    // The blend. At weight 0 this is the line it always was; above it, a memory that shares no
    // words with the current conversation has to out-rank a relevant one on importance alone,
    // which is the behaviour the 6% coverage number asked to change.
    const blended =
      relevanceWeight === 0 ? prior : relevanceWeight * (relevance.get(record.id) ?? 0) + (1 - relevanceWeight) * prior
    const score = blended + (recencyBonus > 0 ? recencyBonus * 0.5 ** ((ageDays * 24) / RECENCY_HALF_LIFE_HOURS) : 0)
    eligible.push({ record, score, ageDays })
  }

  eligible.sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt)

  // The block is not only its lines: `renderRecall` adds a heading and a retraction note, and the
  // budget was being spent without them. Measured on the 36-probe baseline the block came to 641
  // tokens against a 600 budget — a budget the plugin reports as its own and then overran. Charging
  // the fixed part here is what makes `maxTokens` mean what it says.
  let tokens = fixedCost()
  const perType = new Map<string, number>()
  const chosen: RecalledMemory[] = []
  for (const entry of eligible) {
    const used = perType.get(entry.record.type) ?? 0
    const limit = quota[entry.record.type] ?? 0
    if (limit <= 0 || used >= limit) continue
    const rendered = renderLine(entry, preferCanonical, omitRedundantId)
    const cost = estimateTokens(rendered)
    if (tokens + cost > maxTokens) continue
    perType.set(entry.record.type, used + 1)
    tokens += cost
    chosen.push(entry)
  }

  const recentSlots = Math.max(0, options.recentSlots ?? 0)
  if (recentSlots === 0) return chosen

  // Newest first, and only what the loop above left out: a memory that already earned its place is not
  // made more present by being recent.
  const taken = new Set(chosen.map((entry) => entry.record.id))
  const recent = eligible
    .filter((entry) => !taken.has(entry.record.id))
    .sort((left, right) => right.record.createdAt - left.record.createdAt)
  const reserved: RecalledMemory[] = []
  for (const entry of recent) {
    if (reserved.length >= recentSlots) break
    const cost = estimateTokens(renderLine(entry, preferCanonical, omitRedundantId))
    // It *takes* a slot rather than asking for a spare one. The first version only added when the
    // budget happened to have room, and the measurement showed it doing nothing at all: at the shipped
    // 600-token budget the block is already at 592, so there was never room. A reserve that only fires
    // when nothing needs reserving is not a reserve. The entry it evicts is the lowest-ranked one.
    while (tokens + cost > maxTokens && chosen.length > 0) {
      const dropped = chosen.pop()!
      tokens -= estimateTokens(renderLine(dropped, preferCanonical, omitRedundantId))
      perType.set(dropped.record.type, Math.max(0, (perType.get(dropped.record.type) ?? 1) - 1))
    }
    if (tokens + cost > maxTokens) break
    tokens += cost
    reserved.push(entry)
  }
  // Appended rather than spliced in: the ranked memories are the answer to the question, and these are
  // "what was just learned". Keeping them last also keeps the block's order readable and stable.
  return [...chosen, ...reserved]
}

/**
 * What the block costs before any memory is in it: the heading and the retraction note.
 *
 * Exported because the evaluation reports a token figure for the same block, and a second copy of
 * this number would drift the moment the heading changes.
 *
 * @returns the token cost of the non-memory part of the injected block.
 */
export function fixedCost(): number {
  return estimateTokens(`${RECALL_HEADER}\n${RECALL_HELP}`)
}

/**
 * Render the injection block. Returns an empty string when there is nothing to
 * add, which is how the prompt assembler learns to contribute no context at all.
 *
 * Every line carries its type, its id, and its date: a model that is told where
 * a memory came from can weigh it, and a human reading the transcript can audit
 * it. The trailing note tells the model how to retract one, because a memory
 * the user cannot get rid of is worse than no memory.
 *
 * @param chosen - selection output.
 * @param options - rendering options.
 * @returns the prompt context text, or ''.
 */
export function renderRecall(
  chosen: readonly RecalledMemory[] | null | undefined,
  options: { includeHelp?: boolean; preferCanonical?: boolean; omitRedundantId?: boolean } = {},
): string {
  if (!chosen || chosen.length === 0) return ''
  const lines = chosen.map((entry) => renderLine(entry, options.preferCanonical === true, options.omitRedundantId !== false))
  const help = options.includeHelp === false ? '' : RECALL_HELP
  return `${RECALL_HEADER}\n${lines.join('\n')}${help}`
}

/** The block's heading. A constant so `fixedCost` and the renderer cannot disagree. */
export const RECALL_HEADER = '## 长期记忆（自动积累，按会话工作区召回）'

/** The retraction note. Part of the injected block, so it is part of its cost. */
export const RECALL_HELP = '\n（这些记忆由插件自动写入，可随时用 `memory_forget` 撤销或修正。）'

/**
 * One injected line: `- [type] text (id, date)`.
 *
 * @param entry - one selection entry.
 * @returns the rendered line.
 */
export function renderLine(entry: RecalledMemory, preferCanonical = false, omitRedundantId = false): string {
  const date = new Date(entry.record.createdAt).toISOString().slice(0, 10)
  // The canonical form is a cleaned rendering of the same sentence; the verbatim one stays
  // on the record and in the ledger either way.
  const canonical = preferCanonical ? entry.record.canonical : null
  const text = typeof canonical === 'string' && canonical !== '' ? canonical : entry.record.text
  // Checked against the *rendered* text, so a record injected in its canonical form still shows the id:
  // that id belongs to the verbatim text, which differs from what is rendered, and is the only handle
  // the model has for a record it can no longer see.
  const redundant = omitRedundantId && recordIdOf(text) === entry.record.id
  return redundant ? `- [${entry.record.type}] ${text} (${date})` : `- [${entry.record.type}] ${text} (${entry.record.id}, ${date})`
}

/**
 * Scope rule: a memory belongs to the workspace it was learned in, and global
 * memories (no cwd) belong to every workspace. Cross-workspace recall is what
 * would inject one project's conventions into another project's session, so it
 * is excluded by default rather than merged.
 *
 * @param record - the record.
 * @param cwd - the session's working directory.
 * @returns whether the record is in scope.
 */
export function inScope(record: ScopeRecord, cwd: string | null): boolean {
  if (record.cwd === null || record.cwd === undefined) return true
  if (!cwd) return false
  return record.cwd === cwd
}

/**
 * Rank records for the `memory_search` tool: a cheap, deterministic substring
 * and token-overlap score. This is not semantic search and does not pretend to
 * be — the tool exists so a model can check its own long-term memory on demand,
 * and the store is small enough that exact matching is honest and fast.
 *
 * @param records - candidate records.
 * @param query - the search text.
 * @param options - search options.
 * @returns ranked matches.
 */
export function searchMemories(records: RecallableRecord[], query: string, options: SearchOptions = {}): SearchHit[] {
  const { cwd = null, limit = 20 } = options
  const needle = String(query ?? '').trim()
  if (needle === '') return []
  const scoped = records.filter(
    (record) =>
      inScope(record, cwd) &&
      // A superseded memory is history, not current knowledge. It stays in the store and in
      // the ledger so the earlier statement can be read back, but handing it to a model as if
      // it still held would undo the point of asking which one wins.
      record.status !== 'superseded',
  )
  // BM25 rather than substring containment, and the change is measured rather than argued: on
  // 36 probes derived from labelled memories, substring matching ranked the answering memory
  // at MRR 0.23 and returned nothing at all for 27 of 36 — including 17 of the 18 probes that
  // phrased the need in different words, which is the normal way a person asks again. BM25
  // put it at MRR 0.71 with 2 misses. The scorer already existed here for conflict ranking;
  // the search path was simply never switched to it.
  //
  // `type` is deliberately not part of the haystack any more. It was worth 0.3 per token
  // before, which meant a query containing the word "constraint" surfaced every constraint
  // regardless of what it said.
  const scorer = createBm25Scorer(scoped)
  const named = [...new Set(needle.match(NAME_LIKE) ?? [])]
  const matches: SearchHit[] = []
  for (const record of scoped) {
    let score = scorer(needle, record)
    for (const name of named) if (record.text.includes(name)) score += NAME_MATCH_BONUS
    if (score > 0) matches.push({ record, score })
  }
  // Importance only breaks exact ties: as a multiplier it lets a memory that merely scored
  // "important" outrank one that actually answers the question.
  return matches
    .sort((a, b) => b.score - a.score || b.record.importance - a.record.importance || b.record.createdAt - a.record.createdAt)
    .slice(0, limit)
}
