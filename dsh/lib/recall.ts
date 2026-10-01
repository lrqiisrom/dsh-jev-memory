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
}

/** Ranking options for the on-demand search tool. */
export interface SearchOptions {
  /** session working directory. */
  cwd?: string | null
  /** maximum results. */
  limit?: number
}

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
  } = options

  const eligible: RecalledMemory[] = []
  for (const record of records) {
    if (!types.includes(record.type)) continue
    if (record.status !== 'active' && !(includeNeedsReview && record.status === 'needs-review')) continue
    if (!inScope(record, cwd)) continue
    const ageDays = Math.max(0, (now - record.createdAt) / 86_400_000)
    const decay = 0.5 ** (ageDays / HALF_LIFE_DAYS)
    // Importance dominates; decay only breaks near-ties, so a stale constraint
    // is never displaced by a trivial recent note.
    const score = record.importance * 0.85 + decay * 0.15
    eligible.push({ record, score, ageDays })
  }

  eligible.sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt)

  const perType = new Map<string, number>()
  const chosen: RecalledMemory[] = []
  let tokens = 0
  for (const entry of eligible) {
    const used = perType.get(entry.record.type) ?? 0
    const limit = quota[entry.record.type] ?? 0
    if (limit <= 0 || used >= limit) continue
    const rendered = renderLine(entry, preferCanonical)
    const cost = estimateTokens(rendered)
    if (tokens + cost > maxTokens) continue
    perType.set(entry.record.type, used + 1)
    tokens += cost
    chosen.push(entry)
  }
  return chosen
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
  options: { includeHelp?: boolean; preferCanonical?: boolean } = {},
): string {
  if (!chosen || chosen.length === 0) return ''
  const lines = chosen.map((entry) => renderLine(entry, options.preferCanonical === true))
  const header = '## 长期记忆（自动积累，按会话工作区召回）'
  const help = options.includeHelp === false ? '' : '\n（这些记忆由插件自动写入，可随时用 `memory_forget` 撤销或修正。）'
  return `${header}\n${lines.join('\n')}${help}`
}

/**
 * One injected line: `- [type] text (id, date)`.
 *
 * @param entry - one selection entry.
 * @returns the rendered line.
 */
export function renderLine(entry: RecalledMemory, preferCanonical = false): string {
  const date = new Date(entry.record.createdAt).toISOString().slice(0, 10)
  // The canonical form is a cleaned rendering of the same sentence; the verbatim one stays
  // on the record and in the ledger either way.
  const canonical = preferCanonical ? entry.record.canonical : null
  const text = typeof canonical === 'string' && canonical !== '' ? canonical : entry.record.text
  return `- [${entry.record.type}] ${text} (${entry.record.id}, ${date})`
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
  const matches: SearchHit[] = []
  for (const record of scoped) {
    const score = scorer(needle, record)
    if (score > 0) matches.push({ record, score })
  }
  // Importance only breaks exact ties: as a multiplier it lets a memory that merely scored
  // "important" outrank one that actually answers the question.
  return matches
    .sort((a, b) => b.score - a.score || b.record.importance - a.record.importance || b.record.createdAt - a.record.createdAt)
    .slice(0, limit)
}
