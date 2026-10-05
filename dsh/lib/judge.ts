/**
 * The judgement layer: turn candidates into labelled, scored memories.
 *
 * This is the plugin's only optional model call, and it is a *port*: Jev
 * (TypeSafe System One, a decision model rather than a generative one) is the
 * preferred implementation, and a deterministic heuristic is the fallback that
 * keeps the plugin working — and testable — with no key, no network, and no
 * latency budget.
 *
 * Three disciplines are enforced here rather than left to the caller:
 *  1. The model never writes. It returns labels and probabilities; the write
 *     gate is a plain threshold comparison in `applyGate`, owned by code.
 *  2. Fail-open. Any judge failure degrades to the heuristic (or to "skip this
 *     turn"), never to a thrown error inside the harness's turn boundary.
 *  3. The judge cannot invent content. It receives candidate texts and returns
 *     indices, types, scores, and probabilities — there is no field it could
 *     put a new sentence into.
 *
 * Types: the model port is described structurally, so a test can hand in a
 * three-line fake without importing anything, and the plugin keeps its
 * zero-dependency promise. The candidate shape is shared with the transport
 * (`JevCandidate`) because that is the only place its `text` is read.
 *
 * @module dsh/lib/judge
 */

import { clamp01 } from './store.ts'
import { MEMORY_TYPES } from './store.ts'
import type {
  JevCandidate,
  JevDecideRequest,
  JevDecideResult,
  JevPairRequest,
  JevPairResult,
  JevPartnerRequest,
  JevPartnerResult,
  JevRow,
  PairDecision,
} from './jev.ts'

/** Host logger signature, repeated per module so no module imports another for it. */
export type LogSink = (level: string, message: string, detail?: unknown) => void

/** Supported judge modes; `auto` prefers Jev when a key is configured. */
export const JUDGE_MODES: string[] = ['auto', 'jev', 'heuristic', 'off']

/** One judgement row: labels and provenance, never content. */
export interface Judgement {
  /** the candidate's signature key. */
  key: string
  /** the labelled type. */
  type: string
  /** 0..1. */
  importance: number
  /**
   * Noul answer to "is this worth remembering at all", 0..1, or null when the
   * judge cannot answer it (the heuristic never can).
   *
   * This — not `importance` — is what the write gate reads when present. The two
   * answer different questions: `remember` is "does this belong in long-term
   * memory", `importance` is "where does it rank once it does".
   */
  remember: number | null
  /** whether it contradicts a known memory. */
  conflict: 'yes' | 'no' | 'unknown'
  /**
   * The raw probability behind `conflict`, or null when the judge had none to give.
   *
   * Recorded, never decided on: see `JevRow.conflictScore`. `null` rather than `0` for the heuristic,
   * so a missing answer cannot be mistaken for a confident "no conflict" when the threshold is later
   * set from the distribution.
   */
  conflictScore?: number | null
  /** judge-reported confidence, when available. */
  confidence: number | null
  /** which implementation produced this row. */
  by: 'jev' | 'heuristic'
  /** the deterministic signals that matched. */
  signals: string[]
  /** free-form judge note for the ledger (never injected). */
  note: string | null
}

/** What `judge()` returns: the rows, the model id, and why it degraded. */
export interface JudgeResult {
  rows: Judgement[]
  model: string | null
  degraded: string | null
}

/** Extra judge context: known memories for the conflict question, the workspace, and the turn's signal. */
export interface JudgeContext {
  known?: string[]
  /** the workspace the candidates came from; forwarded as model framing. */
  project?: string | null
  /**
   * The messages around the candidates, oldest first.
   *
   * Judging a sentence with no idea what was being discussed is the gap this fills; whether it
   * improves the judgement is measured in `eval/judge-context.ts`, not assumed.
   */
  conversation?: string[]
  signal?: AbortSignal
}

/** The resolved config fields the judgement layer reads. */
export interface JudgeConfig {
  judge: string
  types: string[]
  judgeTimeoutMs?: number
}

/** The model port: Jev implements it, tests fake it. */
export interface JudgeModelPort {
  /** asked per judgement call, so a credential added later takes effect next turn. */
  isAvailable(): Promise<boolean>
  decide(request: JevDecideRequest): Promise<JevDecideResult | JevRow[]>
  /** which known memory a new one contradicts; see `Judge.choosePartner`. */
  choosePartner(request: JevPartnerRequest): Promise<JevPartnerResult>
  /** what the relationship is between a new sentence and a stored memory. */
  decidePair(request: JevPairRequest): Promise<JevPairResult>
}

/** The judge handle the plugin mounts. */
export interface Judge {
  mode: string
  kind: string
  heuristics(candidates: JevCandidate[]): Judgement[]
  judge(candidates: JevCandidate[], context?: JudgeContext): Promise<JudgeResult>
  /**
   * Ask which known memory an incoming one contradicts.
   *
   * `null` means the judge could not answer at all (offline judge, or the call
   * failed) and the caller should fall back to its deterministic pairing. An
   * answer with `index: null` means the model *was* asked and named none of them —
   * a different fact, and one the caller must not paper over with a guess.
   */
  choosePartner(
    incoming: string,
    known: string[],
    context?: JudgeContext,
  ): Promise<{ index: number | null; confidence: number | null; via: 'jev' } | null>
  /**
   * Ask what the relationship is between a new sentence and one stored memory.
   *
   * `null` means the judge has no opinion — the offline judge always, and the model
   * whenever it could not answer. The caller must then keep its deterministic
   * behaviour rather than guess, because guessing here means either losing something
   * the person said or overwriting a memory on a coin flip.
   */
  decidePair(
    incoming: string,
    existing: string,
    context?: JudgeContext,
  ): Promise<{ decision: PairDecision | null; confidence: number | null; by: 'jev' | 'heuristic'; model: string | null }>
}

/** The judgement fields the write gate reads. */
export interface GateInput {
  type: string
  importance: number
  /** the judge's "worth remembering" probability, when it answered that question. */
  remember?: number | null
  conflict: string
  /** the raw probability behind `conflict`, for the unsure band; `null` when the judge had none. */
  conflictScore?: number | null
}

/** The config fields the write gate reads. */
export interface GateConfig {
  types: string[]
  minImportance: number
  /** threshold on the judge's "worth remembering" Noul answer. */
  minRemember: number
  reviewOnConflict: boolean
  /**
   * Below the conflict threshold but at or above this, the answer is treated as "unsure" and the person
   * is asked instead of the plugin guessing. `0` disables the band.
   *
   * The band exists because the number behind the verdict is the useful part: 0.02 and 0.68 both read as
   * `no`, and they call for opposite decisions. Measured on 16 real near-miss candidates, two landed in
   * 0.3-0.7 while the anchors separated cleanly (a real reversal 0.97, an unrelated sentence 0.10), so
   * the band is narrow enough to be worth someone's attention.
   */
  conflictReviewMinScore?: number
}

/** The write gate's decision, and why. */
export interface GateDecision {
  write: boolean
  /** present and true only for a suspected conflict with review enabled. */
  review?: boolean
  reason: string
}

/**
 * Build the plugin's judge over the configured mode.
 *
 * @param options - wiring: the resolved config, the Jev client, and a logger.
 * @returns the judge.
 */
export function createJudge({ config, jev, log = () => {} }: { config: JudgeConfig; jev?: JudgeModelPort; log?: LogSink }): Judge {
  const mode = JUDGE_MODES.includes(config.judge) ? config.judge : 'auto'
  /**
   * Whether this call should go to the model.
   *
   * Asked per call, never cached: the model port answers it by resolving the
   * credential, and a key added while the harness runs must take effect on the
   * next turn rather than at the next restart. `kind` stays the *configured*
   * intent so the startup ledger line still says what was asked for; this
   * function says what is actually possible right now.
   */
  async function jevReady(): Promise<boolean> {
    if (mode === 'off' || !jev) return false
    // An explicit mode is not a preference to be second-guessed: `heuristic` means
    // heuristic even when a key is sitting right there. Only `auto` consults the
    // port. (Dropping this branch was a real bug: the plugin called the model while
    // configured for the offline judge, which a test caught as an unexpected
    // network round trip inside an "offline" run.)
    if (mode === 'heuristic') return false
    if (mode === 'jev') return true
    try {
      return await jev.isAvailable()
    } catch {
      return false
    }
  }
  const kind = mode === 'off' ? 'off' : mode === 'heuristic' ? 'heuristic' : 'jev'

  return {
    mode,
    kind,
    heuristics: (candidates) => candidates.map((candidate) => heuristicRow(candidate, config)),
    /**
     * Label every candidate. Never throws: on a Jev failure the same candidates
     * are re-labelled heuristically, and the returned `degraded` marker lets the
     * ledger record why.
     *
     * @param candidates - extracted candidates.
     * @param context - extra judge context (known memories for conflict checks).
     * @returns judgements and provenance.
     */
    async judge(candidates, context = {}) {
      if (candidates.length === 0) return { rows: [], model: null, degraded: null }
      if (mode === 'off') return { rows: [], model: null, degraded: 'judge-off' }
      if (!(await jevReady())) {
        return { rows: candidates.map((candidate) => heuristicRow(candidate, config)), model: null, degraded: null }
      }
      try {
        // `jevReady()` can only be true over a client the caller supplied (or an
        // explicit `judge: 'jev'`); the assertion states that invariant, and an
        // absent client still throws inside this try and degrades, as before.
        const result = await jev!.decide({
          candidates,
          types: config.types,
          known: context.known ?? [],
          project: context.project ?? null,
          conversation: context.conversation ?? [],
          timeoutMs: config.judgeTimeoutMs,
          signal: context.signal,
        })
        const rows: JevRow[] = Array.isArray(result) ? result : result?.rows ?? []
        const model = Array.isArray(result) ? null : result?.model ?? null
        const byKey = new Map(rows.map((row): [string, JevRow] => [row.key, row]))
        const types = config.types.length > 0 ? config.types : MEMORY_TYPES
        return {
          rows: candidates.map((candidate): Judgement => {
            const row = byKey.get(candidate.key)
            if (!row) return heuristicRow(candidate, config, 'jev-missing-row')
            const rowType = row.type
            return {
              key: candidate.key,
              type: typeof rowType === 'string' && types.includes(rowType) ? rowType : candidate.hintedType ?? 'fact',
              importance: clamp01(row.importance ?? candidate.signalScore),
              remember: typeof row.remember === 'number' && Number.isFinite(row.remember) ? clamp01(row.remember) : null,
              conflict: row.conflict === 'yes' || row.conflict === 'no' ? row.conflict : 'unknown',
              // Carried for the ledger, like `confidence`: the verdict alone cannot say whether the
              // threshold is cutting real conflicts off. `null` stays `null` rather than becoming 0, so a
              // missing answer is distinguishable from a confident "no conflict".
              conflictScore:
                typeof row.conflictScore === 'number' && Number.isFinite(row.conflictScore)
                  ? clamp01(row.conflictScore)
                  : null,
              confidence: Number.isFinite(row.confidence) ? clamp01(row.confidence) : null,
              by: 'jev',
              signals: candidate.signals,
              note: typeof row.note === 'string' ? row.note.slice(0, 200) : null,
            }
          }),
          model,
          degraded: null,
        }
      } catch (error) {
        log('warn', 'jev judgement failed; falling back to the heuristic judge', { error: String(error) })
        return {
          rows: candidates.map((candidate) => heuristicRow(candidate, config, 'jev-failed')),
          model: null,
          degraded: 'jev-failed',
        }
      }
    },
    async choosePartner(incoming, known, context = {}) {
      if (known.length === 0) return null
      if (!(await jevReady())) return null
      try {
        const result = await jev!.choosePartner({
          incoming,
          known,
          project: context.project ?? null,
          timeoutMs: config.judgeTimeoutMs,
          signal: context.signal,
        })
        return { index: result.index, confidence: result.confidence, via: 'jev' }
      } catch (error) {
        // Falling back to the lexical pairing keeps the question askable; losing it
        // would mean silently withholding a memory the user could have resolved.
        log('warn', 'partner choice failed; falling back to lexical pairing', { error: String(error) })
        return null
      }
    },

    /**
     * What the relationship is between a new sentence and one stored memory.
     *
     * `null` is the honest answer from a rule: no deterministic check can tell a
     * restatement from a correction, which is exactly the judgement the signature
     * fails at and the reason this question goes to a model. The caller keeps its
     * deterministic path on null rather than guessing, because guessing here means
     * either losing something the person said or overwriting a memory on a coin flip.
     *
     * @param incoming - the new sentence.
     * @param existing - the stored memory it resembles.
     * @param context - workspace framing and cancellation.
     * @returns the decision, or null with `by: 'heuristic'` when nothing can answer.
     */
    async decidePair(
      incoming: string,
      existing: string,
      context: JudgeContext = {},
    ): Promise<{ decision: PairDecision | null; confidence: number | null; by: 'jev' | 'heuristic'; model: string | null }> {
      if (!(await jevReady())) return { decision: null, confidence: null, by: 'heuristic', model: null }
      try {
        const result = await jev!.decidePair({
          incoming,
          existing,
          project: context.project ?? null,
          timeoutMs: config.judgeTimeoutMs,
          signal: context.signal,
        })
        return { decision: result.decision, confidence: result.confidence, by: 'jev', model: result.model }
      } catch (error) {
        log('warn', 'pair decision failed; keeping the deterministic behaviour', { error: String(error) })
        return { decision: null, confidence: null, by: 'heuristic', model: null }
      }
    },
  }
}

/**
 * The offline judge: type from deterministic signals, importance from the
 * extraction score, conflict unknown.
 *
 * @param candidate - one extracted candidate.
 * @param config - resolved plugin config.
 * @param note - why the heuristic ran (ledger only).
 * @returns the judgement row.
 */
export function heuristicRow(candidate: JevCandidate, config: { types: string[] }, note: string | null = null): Judgement {
  const types = config.types.length > 0 ? config.types : MEMORY_TYPES
  const hintedType = candidate.hintedType
  const hinted = hintedType && types.includes(hintedType) ? hintedType : null
  return {
    key: candidate.key,
    type: hinted ?? hintedType ?? 'fact',
    importance: clamp01(candidate.signalScore),
    // The heuristic has no opinion on "worth remembering at all"; it only scores
    // how interesting the sentence looked, so the gate falls back to `importance`.
    remember: null,
    conflict: 'unknown',
    // The heuristic has no probability to report; `null` is the honest value, and it keeps a
    // fabricated 0 out of the distribution the threshold will be set from.
    conflictScore: null,
    confidence: null,
    by: 'heuristic',
    signals: candidate.signals,
    note,
  }
}

/**
 * The write gate. Deliberately a pure function so the policy is testable
 * without a store or a clock, and deliberately not a function of Jev's
 * probability beyond ranking: the threshold is configuration a human owns.
 *
 * @param judgement - one judgement row.
 * @param config - resolved plugin config.
 * @returns the decision and why.
 */
export function applyGate(judgement: GateInput | null | undefined, config: GateConfig): GateDecision {
  if (!judgement) return { write: false, reason: 'no-judgement' }
  if (!config.types.includes(judgement.type)) return { write: false, reason: `type-disabled:${judgement.type}` }

  // Two questions, two thresholds, in that order: "does this belong in memory"
  // (the judge's Noul answer) gates the write; "how important is it" (the Score)
  // only ranks what got in. When the judge cannot answer the first one — the
  // heuristic never can — the score gate stands in, so behaviour degrades instead
  // of silently accepting everything.
  const remember = judgement.remember
  if (typeof remember === 'number') {
    if (remember < config.minRemember) return { write: false, reason: 'below-min-remember' }
  } else if (judgement.importance < config.minImportance) {
    return { write: false, reason: 'below-min-importance' }
  }

  if (judgement.conflict === 'yes' && config.reviewOnConflict) return { write: true, review: true, reason: 'conflict' }
  // Unsure, not absent: the judge did not call it a conflict, but it was not confident that it is not
  // one either. Asking is the whole point of having a person available, and the record is written first
  // (as `needs-review`) so an unanswered question leaves it stored and merely withheld from recall.
  const band = config.conflictReviewMinScore ?? 0
  if (
    config.reviewOnConflict &&
    band > 0 &&
    typeof judgement.conflictScore === 'number' &&
    judgement.conflictScore >= band
  ) {
    return { write: true, review: true, reason: 'conflict-uncertain' }
  }
  return { write: true, reason: 'ok' }
}

/**
 * The gate on the model write path, where one call already answered both of its questions.
 *
 * `applyGate` asks two things — does this belong in memory, and how important is it — and the model
 * write call answers the first one directly, per span, with the window in front of it. Re-asking the
 * deterministic rule here is what that setting exists to avoid: over the same 120 labelled rows the
 * call reached F1 0.69 and the local type-and-score rule 0.37, and the disagreement is not noise —
 * 8 of the corpus's 21 positives are refused by the type whitelist alone (the word "流程" types a real
 * requirement as `procedure`, which is not a memory type), so that refusal fires on a keyword rather
 * than on understanding.
 *
 * What is *not* skipped is the conflict question. That answer comes from the pair decision, a
 * different call about a different thing (this text versus one already stored), and its `yes` still
 * routes the record to `needs-review` so recall never sees an unreviewed contradiction.
 *
 * @param judgement - the judge's row, or null when it did not answer.
 * @param config - the gate config, read only for `reviewOnConflict`.
 * @returns a decision; `write` is always true and `reason` names the path.
 */
export function applyModelGate(judgement: GateInput | null | undefined, config: GateConfig): GateDecision {
  if (judgement?.conflict === 'yes' && config.reviewOnConflict) return { write: true, review: true, reason: 'conflict' }
  // The unsure band applies here too. It is a question about who should decide — the model was not
  // confident either way — and that does not change just because the model wrote the memory's text.
  const band = config.conflictReviewMinScore ?? 0
  if (
    config.reviewOnConflict &&
    band > 0 &&
    typeof judgement?.conflictScore === 'number' &&
    judgement.conflictScore >= band
  ) {
    return { write: true, review: true, reason: 'conflict-uncertain' }
  }
  return { write: true, reason: 'model-write' }
}
