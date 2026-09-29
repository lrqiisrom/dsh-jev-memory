/**
 * Conflict resolution: pairing a suspected contradiction with the memory it
 * contradicts, and turning the human's answer into a store mutation.
 *
 * Why this module is separate and pure: the pairing and the answer mapping are
 * the parts worth testing exhaustively, and they need neither a store, a clock,
 * nor a model. The plugin's hook keeps only the wiring.
 *
 * The design stance: a contradiction is *never* resolved automatically. The
 * judge can only raise it; a person decides. That is deliberate — a machine that
 * silently replaces what a human told it yesterday is worse than one that asks.
 *
 * @module dsh/lib/conflict
 */

import type { MemoryRecord } from './store.ts'

/** The three answers the question offers, and the labels that identify them. */
export const CONFLICT_CHOICES = {
  replace: '用新的覆盖旧的',
  'keep-old': '保留旧的那条',
  'keep-both': '两条都留着',
} as const

/** One of the three resolutions a human can choose. */
export type ConflictChoice = keyof typeof CONFLICT_CHOICES

/** A suspected contradiction, paired with the record it appears to contradict. */
export interface ConflictPair {
  /** the incoming candidate's text, verbatim. */
  incoming: string
  /** the existing record the incoming one appears to contradict. */
  existing: MemoryRecord
  /** the 0..1 overlap that produced this pairing, for the ledger and for tuning. */
  score: number
  /** which tokens the two share, so a wrong pairing is inspectable after the fact. */
  shared: string[]
}

/**
 * Chinese word segmentation, from the runtime rather than a dependency.
 *
 * `Intl.Segmenter` is part of V8 and Node has shipped full ICU by default since v13
 * (`process.config.variables.icu_small` is `false` on the official builds), so a Chinese
 * dictionary segmenter is already on the machine — "no segmenter" was the wrong summary
 * of the situation, and the fix cost no dependency at all.
 *
 * Measured against raw character bigrams on the case they get wrong, ranking
 * `端口不要用 9000 了` (the memory about ports should beat the one about yarn):
 *
 * | tokenizer                       | 不要用 yarn | 服务端口用 8000 | verdict |
 * |---------------------------------|-------------|-----------------|---------|
 * | raw character bigrams           | 2.733       | 2.188           | wrong   |
 * | segmenter words                 | 1.814       | 4.959           | right   |
 *
 * Bigrams lose because `不要用` becomes `不要` + `要用`, and `要用` is then a *rare* token
 * that mints IDF for whichever memory contains it. The segmenter cuts at `不要|用`.
 *
 * There was a load-time probe here for a while, to fall back to bigrams on a reduced-ICU
 * build that would answer in single characters. It was removed: the case cannot happen on
 * an official build, and a fallback that fires silently is its own kind of surprise. The
 * bigram path now only covers a runtime without `Intl.Segmenter` at all.
 */
const SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    : null

/**
 * Tokenize for the overlap score: latin words, plus Chinese words or bigrams.
 *
 * @param text - any text.
 * @returns the tokens, with repetition, in text order.
 */
export function tokenList(text: string): string[] {
  const tokens: string[] = []
  const normalized = String(text ?? '').toLowerCase()
  for (const word of normalized.match(/[a-z0-9_.-]{3,}/gu) ?? []) tokens.push(word)

  const cjkRuns = normalized
    .replace(/[^\u3400-\u9fff]+/gu, ' ')
    .split(/\s+/u)
    .filter((run) => run.length >= 2)
  if (cjkRuns.length === 0) return tokens

  if (SEGMENTER !== null) {
    for (const run of cjkRuns) {
      for (const part of SEGMENTER.segment(run)) {
        if (part.isWordLike) tokens.push(part.segment)
      }
    }
    return tokens
  }

  // Fallback: character bigrams. Single characters are far too common to carry
  // meaning ("的", "用"), and a dictionary is what would be needed to do better.
  for (const run of cjkRuns) {
    for (let index = 0; index + 2 <= run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

/**
 * The token set for the overlap score.
 *
 * @param text - any text.
 * @returns the distinct tokens.
 */
export function tokenize(text: string): Set<string> {
  return new Set(tokenList(text))
}

/**
 * A relevance score for one existing memory against an incoming sentence.
 *
 * Kept as a bare function so the ranking can be swapped without touching any caller:
 * BM25 today, embeddings tomorrow (see `conflictRanking` in the plugin config). The
 * contract is only "higher means more likely to be about the same thing" — it is a
 * *candidate* ranking, never a verdict. Deciding whether two memories actually
 * contradict each other is the judge's job or the person's, because similarity cannot
 * answer it: "端口用 8000" and "端口改成 9000" are near-identical and incompatible,
 * while "端口 8000" and "服务端口固定 8000，不要改" are near-identical and agree.
 */
export type ConflictScorer = (incoming: string, record: MemoryRecord) => number

/** BM25's free parameters. Defaults are the standard ones. */
export interface Bm25Options {
  /** term-frequency saturation; higher means repetition keeps helping. */
  k1?: number
  /** length normalization; 0 disables it, 1 fully normalizes. */
  b?: number
}

/**
 * Build a BM25 scorer over a fixed set of memories.
 *
 * BM25 rather than the shared-token ratio it replaces because three things matter
 * here and the ratio got all three wrong: it weighted a token that appears in every
 * memory ("项目", "不要") the same as a rare one, it let a long memory win by sheer
 * size, and it counted a term once however often it appeared. IDF, length
 * normalization and term saturation are exactly those three fixes, and BM25 is the
 * standard form of them — it costs one pass over the memories and no dependency.
 *
 * **What it does not fix is paraphrase.** "data 下的文件别碰" and "不要改动 data/
 * 目录" share one token; no lexical scorer will connect them, which is what the
 * `embedding` option exists for. (`tokenList` carries the separate measurement of how
 * Chinese is tokenized — raw bigrams invented a rare token and ranked the wrong memory,
 * the runtime's own segmenter does not.)
 *
 * The stats are computed once per call, so build one scorer per candidate and reuse
 * it across the memories; the returned function caches its query tokens for that.
 *
 * @param records - the memories (the corpus), not including the incoming sentence.
 * @param options - BM25 parameters.
 * @returns a scorer, 0 for no relation at all.
 */
export function createBm25Scorer(records: readonly MemoryRecord[], options: Bm25Options = {}): ConflictScorer {
  const k1 = options.k1 ?? 1.2
  const b = options.b ?? 0.75
  const documents = records.map((record) => {
    const tokens = tokenList(record.text)
    const frequency = new Map<string, number>()
    for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1)
    return { id: record.id, frequency, length: tokens.length }
  })
  const documentFrequency = new Map<string, number>()
  let totalLength = 0
  for (const document of documents) {
    totalLength += document.length
    for (const token of document.frequency.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }
  const count = documents.length
  const averageLength = count === 0 ? 1 : totalLength / count || 1
  const byId = new Map(documents.map((document) => [document.id, document]))

  /** Robertson/Sparck-Jones IDF, smoothed so a term in every document still counts. */
  const idf = (token: string): number => {
    const frequency = documentFrequency.get(token) ?? 0
    return Math.log(1 + (count - frequency + 0.5) / (frequency + 0.5))
  }

  let lastQuery = ''
  let queryTokens: string[] = []
  return (incoming, record) => {
    if (incoming !== lastQuery) {
      lastQuery = incoming
      queryTokens = [...new Set(tokenList(incoming))]
    }
    const document = byId.get(record.id)
    if (document === undefined) return 0
    let score = 0
    for (const token of queryTokens) {
      const frequency = document.frequency.get(token)
      if (frequency === undefined) continue
      const norm = 1 - b + (b * document.length) / averageLength
      score += (idf(token) * (frequency * (k1 + 1))) / (frequency + k1 * norm)
    }
    return score
  }
}

/**
 * The memories most likely to be about the same thing as an incoming sentence.
 *
 * Why this exists: the write path used to hand the judge the first twenty memories
 * *in store order*, so a contradiction sitting at position twenty-one was invisible
 * and the judge answered "no conflict" — a miss with no trace anywhere. Ranking by
 * relevance is what makes the window mean "the twenty most likely", and the window
 * still has to be filled: memories that share no token with the incoming sentence
 * score 0 and are kept, newest first, because a semantic contradiction can look like
 * nothing lexically.
 *
 * @param incoming - the new sentence.
 * @param records - the memories to rank.
 * @param limit - how many to keep.
 * @param scorer - the relevance function; BM25 over `records` by default.
 * @returns up to `limit` records, most relevant first.
 */
export function rankConflictPartners(
  incoming: string,
  records: readonly MemoryRecord[],
  limit: number,
  scorer?: ConflictScorer,
): MemoryRecord[] {
  if (records.length === 0 || limit <= 0) return []
  const score = scorer ?? createBm25Scorer(records)
  return records
    .map((record) => ({ record, score: score(incoming, record) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      // Same relevance: the more recently touched memory is the likelier counterpart,
      // since a rule that was just restated is the one a new statement tends to move.
      return (right.record.updatedAt ?? 0) - (left.record.updatedAt ?? 0)
    })
    .slice(0, limit)
    .map((entry) => entry.record)
}

/**
 * Pick the existing memory most likely to contradict an incoming one.
 *
 * The judge answers "does this contradict something I know?" but not "which
 * one", and a question that cannot name the other side is not answerable. This
 * pairing is deliberately deterministic and cheap: it runs only for candidates
 * the judge already flagged, and every pairing it produces is written to the
 * ledger so a wrong one can be seen rather than suspected.
 *
 * The score is intersection over the *smaller* set, so a short existing memory
 * fully contained in a long incoming one still scores high.
 *
 * @param incoming - the new memory's text.
 * @param records - candidate partners (already scoped and active-filtered by the caller).
 * @param minScore - below this, no partner is named and the caller keeps today's behaviour.
 * @returns the best pairing, or null when nothing is similar enough.
 */
export function findConflictPartner(incoming: string, records: readonly MemoryRecord[], minScore = 0.2): ConflictPair | null {
  const incomingTokens = tokenize(incoming)
  if (incomingTokens.size === 0) return null

  let best: ConflictPair | null = null
  for (const record of records) {
    const otherTokens = tokenize(record.text)
    if (otherTokens.size === 0) continue
    const shared: string[] = []
    for (const token of incomingTokens) if (otherTokens.has(token)) shared.push(token)
    if (shared.length === 0) continue
    const score = shared.length / Math.min(incomingTokens.size, otherTokens.size)
    if (score < minScore) continue
    if (best === null || score > best.score) best = { incoming, existing: record, score, shared }
  }
  return best
}

/**
 * Build the user-facing question.
 *
 * Both sides are quoted verbatim and dated: the person answering is being asked
 * to overrule one of their own past statements, so they need to see exactly what
 * each one said and when, not a summary the plugin wrote.
 *
 * @param pair - the pairing to ask about.
 * @param incomingId - the incoming record's id, used as the question id.
 * @returns the question item for the harness's ask service.
 */
export function buildConflictQuestion(pair: ConflictPair, incomingId: string): {
  id: string
  header: string
  question: string
  detail: string
  options: Array<{ label: string; description: string }>
} {
  const date = new Date(pair.existing.createdAt).toISOString().slice(0, 10)
  return {
    id: `conflict:${incomingId}`,
    header: '长期记忆出现矛盾',
    question: '这条新记住的信息，和你之前说过的一条看起来矛盾。怎么处理？',
    detail: [
      `新记住的：${pair.incoming}`,
      `你之前说的：${pair.existing.text}（${date}，${pair.existing.id}）`,
    ].join('\n'),
    options: [
      { label: CONFLICT_CHOICES.replace, description: '旧的那条不再使用（保留记录，供以后查证）' },
      { label: CONFLICT_CHOICES['keep-old'], description: '丢掉这条新记的' },
      { label: CONFLICT_CHOICES['keep-both'], description: '两条都保留，按不同情况看待' },
    ],
  }
}

/**
 * Map one answer back onto a resolution.
 *
 * A typed answer that matches no label is treated as no answer: guessing what a
 * free-form reply meant is exactly the kind of inference that must not silently
 * delete a memory.
 *
 * @param answer - one answer item from the ask service, if any.
 * @returns the chosen resolution, or null when the human did not choose one.
 */
export function choiceFromAnswer(answer: { selected?: readonly string[]; custom?: string } | undefined): ConflictChoice | null {
  const selected = answer?.selected ?? []
  for (const label of selected) {
    for (const [choice, text] of Object.entries(CONFLICT_CHOICES)) {
      if (label === text) return choice as ConflictChoice
    }
  }
  return null
}
