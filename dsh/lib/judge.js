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
 * @module dsh/lib/judge
 */

import { clamp01 } from './store.js'
import { MEMORY_TYPES } from './store.js'

/** Supported judge modes; `auto` prefers Jev when a key is configured. */
export const JUDGE_MODES = ['auto', 'jev', 'heuristic', 'off']

/**
 * @typedef {object} Judgement
 * @property {string} key          the candidate's signature key.
 * @property {string} type         the labelled type.
 * @property {number} importance   0..1.
 * @property {'yes'|'no'|'unknown'} conflict  whether it contradicts a known memory.
 * @property {number|null} confidence  judge-reported confidence, when available.
 * @property {'jev'|'heuristic'} by    which implementation produced this row.
 * @property {string[]} signals    the deterministic signals that matched.
 * @property {string|null} note    free-form judge note for the ledger (never injected).
 */

/**
 * Build the plugin's judge over the configured mode.
 *
 * @param {object} options - wiring.
 * @param {object} options.config - resolved plugin config (`judge`, `types`, `jev*`).
 * @param {{decide: (request: object) => Promise<any>, available: boolean}} [options.jev] - Jev client.
 * @param {(level: string, message: string, detail?: unknown) => void} [options.log] - host logger.
 * @returns {{mode: string, kind: string, judge: (candidates: any[], context?: object) => Promise<Judgement[]>, heuristics: (candidates: any[]) => Judgement[]}} the judge.
 */
export function createJudge({ config, jev, log = () => {} }) {
  const mode = JUDGE_MODES.includes(config.judge) ? config.judge : 'auto'
  const useJev = mode === 'jev' || (mode === 'auto' && Boolean(jev?.available))
  const kind = mode === 'off' ? 'off' : useJev ? 'jev' : 'heuristic'

  return {
    mode,
    kind,
    heuristics: (candidates) => candidates.map((candidate) => heuristicRow(candidate, config)),
    /**
     * Label every candidate. Never throws: on a Jev failure the same candidates
     * are re-labelled heuristically, and the returned `degraded` marker lets the
     * ledger record why.
     *
     * @param {any[]} candidates - extracted candidates.
     * @param {object} [context] - extra judge context (known memories for conflict checks).
     * @returns {Promise<{rows: Judgement[], model: string|null, degraded: string|null}>} judgements and provenance.
     */
    async judge(candidates, context = {}) {
      if (candidates.length === 0) return { rows: [], model: null, degraded: null }
      if (mode === 'off') return { rows: [], model: null, degraded: 'judge-off' }
      if (!useJev) return { rows: candidates.map((candidate) => heuristicRow(candidate, config)), model: null, degraded: null }
      try {
        const result = await jev.decide({
          candidates,
          types: config.types,
          known: context.known ?? [],
          timeoutMs: config.judgeTimeoutMs,
          signal: context.signal,
        })
        const rows = Array.isArray(result) ? result : result?.rows ?? []
        const model = Array.isArray(result) ? null : result?.model ?? null
        const byKey = new Map(rows.map((row) => [row.key, row]))
        const types = config.types.length > 0 ? config.types : MEMORY_TYPES
        return {
          rows: candidates.map((candidate) => {
            const row = byKey.get(candidate.key)
            if (!row) return heuristicRow(candidate, config, 'jev-missing-row')
            return {
              key: candidate.key,
              type: types.includes(row.type) ? row.type : candidate.hintedType ?? 'fact',
              importance: clamp01(row.importance ?? candidate.signalScore),
              conflict: row.conflict === 'yes' || row.conflict === 'no' ? row.conflict : 'unknown',
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
  }
}

/**
 * The offline judge: type from deterministic signals, importance from the
 * extraction score, conflict unknown.
 *
 * @param {any} candidate - one extracted candidate.
 * @param {object} config - resolved plugin config.
 * @param {string|null} [note] - why the heuristic ran (ledger only).
 * @returns {Judgement} the judgement row.
 */
export function heuristicRow(candidate, config, note = null) {
  const types = config.types.length > 0 ? config.types : MEMORY_TYPES
  const hinted = candidate.hintedType && types.includes(candidate.hintedType) ? candidate.hintedType : null
  return {
    key: candidate.key,
    type: hinted ?? candidate.hintedType ?? 'fact',
    importance: clamp01(candidate.signalScore),
    conflict: 'unknown',
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
 * @param {Judgement} judgement - one judgement row.
 * @param {object} config - resolved plugin config.
 * @returns {{write: boolean, reason: string}} the decision and why.
 */
export function applyGate(judgement, config) {
  if (!judgement) return { write: false, reason: 'no-judgement' }
  if (!config.types.includes(judgement.type)) return { write: false, reason: `type-disabled:${judgement.type}` }
  if (judgement.importance < config.minImportance) return { write: false, reason: 'below-min-importance' }
  if (judgement.conflict === 'yes' && config.reviewOnConflict) return { write: true, review: true, reason: 'conflict' }
  return { write: true, reason: 'ok' }
}
