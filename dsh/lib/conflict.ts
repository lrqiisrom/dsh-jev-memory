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
 * Tokenize for the overlap score: latin words plus CJK bigrams.
 *
 * Bigrams rather than single characters because single CJK characters are far
 * too common to carry meaning ("的", "用"), and rather than full segmentation
 * because that would need a dictionary the plugin does not have.
 *
 * @param text - any text.
 * @returns the token set.
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = String(text ?? '').toLowerCase()
  for (const word of normalized.match(/[a-z0-9_.-]{3,}/gu) ?? []) tokens.add(word)
  const cjk = normalized.replace(/[^\u3400-\u9fff]/gu, ' ')
  for (const run of cjk.split(/\s+/u)) {
    if (run.length < 2) continue
    for (let index = 0; index + 2 <= run.length; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
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
