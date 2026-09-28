/**
 * Candidate extraction: decide which sentences of a finished turn are worth
 * showing to the judgement layer.
 *
 * This stage is deliberately deterministic and cheap. It runs on every turn
 * close, so it must not call a model, and its output is what the judge labels —
 * a judge can only reject candidates, never invent them. That ordering is the
 * reason a hallucinated memory cannot be created by the plugin: every memory
 * text is either a sentence the user actually wrote or a failure signature the
 * harness actually recorded.
 *
 * Scope of the MVP: only direct human messages (`source.kind === 'user'`) and
 * tool failures. Plugin-injected context messages and the model's own prose are
 * excluded on purpose — memorizing the former would launder system prompt text
 * into long-term memory, and the latter is not user intent.
 *
 * @module dsh/lib/extract
 */

import { excerpt, looksInterrogative, normalize, splitSentences } from './text.js'
import { emphasisWeight, isNoise, matchTypeSignals, screenSentence, signatureOf } from './signals.js'

/** Extraction defaults; every one of them is overridable from plugin config. */
export const EXTRACT_DEFAULTS = {
  /** Sentences shorter than this are chatter, not memory. */
  minChars: 8,
  /** Hard cap on one stored sentence, mirroring `clip`. */
  maxChars: 240,
  /** At most this many sentences per human message. */
  maxPerMessage: 3,
  /** At most this many candidates per turn, highest signal score first. */
  maxPerTurn: 6,
  /** Only these failure results become pitfall candidates. */
  includeToolFailures: true,
  /**
   * Called with `(sentence, reason)` for every sentence a screen rejected, so
   * the ledger can account for what was *not* remembered and why.
   */
  onVeto: null,
}

/**
 * @typedef {object} Candidate
 * @property {'user'|'tool-failure'} kind  where the text came from.
 * @property {string} text                 the memory text, verbatim or derived.
 * @property {string} key                  signature hash used for dedup.
 * @property {number} seq                  session seq the candidate came from.
 * @property {string} quote                the exact source excerpt for the ledger.
 * @property {string|null} hintedType      a type the deterministic signals suggest.
 * @property {number} signalScore          0..1 interest score, pre-judgement.
 * @property {string[]} signals            which patterns matched, for the ledger.
 * @property {string|null} tool            tool name for failure candidates.
 */

/**
 * Extract memory candidates from one turn's session events.
 *
 * @param {ReadonlyArray<{seq: number, type: string, data: any}>} events - the turn's events, oldest first.
 * @param {Partial<typeof EXTRACT_DEFAULTS>} [options] - extraction overrides.
 * @returns {Candidate[]} candidates, best first.
 */
export function extractCandidates(events, options = {}) {
  const config = { ...EXTRACT_DEFAULTS, ...options }
  /** @type {Candidate[]} */
  const candidates = []
  /** @type {Map<string, string>} callId → tool name, for failure attribution. */
  const callNames = new Map()

  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'tool/call') {
      const { callId, name } = event.data ?? {}
      if (callId && name) callNames.set(String(callId), String(name))
      continue
    }
    if (event.type === 'user/message') {
      const message = event.data
      if (message?.source?.kind !== 'user') continue
      for (const candidate of fromUserMessage(message, event.seq, config)) candidates.push(candidate)
      continue
    }
    if (event.type === 'tool/result' && config.includeToolFailures) {
      const candidate = fromToolFailure(event.data, event.seq, callNames)
      if (candidate) candidates.push(candidate)
    }
  }

  return candidates
    .filter((candidate, index, all) => all.findIndex((other) => other.key === candidate.key) === index)
    .sort((a, b) => b.signalScore - a.signalScore)
    .slice(0, config.maxPerTurn)
}

/**
 * Split one human message into candidates.
 *
 * @param {any} message - the `user/message` event data.
 * @param {number} seq - the event's seq.
 * @param {typeof EXTRACT_DEFAULTS} config - resolved extraction config.
 * @returns {Candidate[]} candidates from this message.
 */
function fromUserMessage(message, seq, config) {
  const text = normalize(
    (Array.isArray(message?.content) ? message.content : [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n'),
  )
  if (!text) return []

  /** @type {Candidate[]} */
  const out = []
  for (const sentence of splitSentences(text)) {
    if (sentence.length < config.minChars) continue
    if (isNoise(sentence)) continue
    if (looksInterrogative(sentence)) continue
    const screen = screenSentence(sentence)
    if (!screen.keep) {
      // Report the rejection instead of dropping it silently: write precision is
      // measured from what the screens threw away as much as from what was kept.
      config.onVeto?.(sentence, screen.reason)
      continue
    }

    const signal = matchTypeSignals(sentence)
    const clipped = sentence.length > config.maxChars ? `${sentence.slice(0, config.maxChars - 1)}…` : sentence
    const score = Math.min(1, 0.35 + signal.weight * 0.35 + emphasisWeight(sentence) + lengthBonus(sentence))

    out.push({
      kind: 'user',
      text: clipped,
      key: signatureOf(clipped),
      seq,
      quote: excerpt(sentence, 200),
      hintedType: signal.type,
      signalScore: score,
      signals: signal.hits,
      tool: null,
    })
  }

  return out.sort((a, b) => b.signalScore - a.signalScore).slice(0, config.maxPerMessage)
}

/**
 * Turn one failed tool result into a pitfall candidate.
 *
 * The text is derived, never generated: tool name plus the first line of the
 * recorded failure. Numbers and paths are signature-normalized for the dedup
 * key only, so "permission denied on /a/b" and "permission denied on /a/c"
 * collapse into one memory while the stored text stays readable.
 *
 * @param {any} data - the `tool/result` event data.
 * @param {number} seq - the event's seq.
 * @param {Map<string, string>} callNames - callId → tool name.
 * @returns {Candidate|null} the candidate, or null when this is not a failure.
 */
function fromToolFailure(data, seq, callNames) {
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : []
  const failed = data?.error !== undefined || blocks.some((block) => block?.isError === true)
  if (!failed) return null

  const callId = data?.message?.source?.callId
  const tool = (callId && callNames.get(String(callId))) || data?.error?.name || 'tool'
  const detail = normalize(
    blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' '),
  )
  const firstLine = detail.split('\n')[0] ?? ''
  const text = normalize(`${tool} 失败：${firstLine || data?.error?.code || '未知错误'}`).slice(0, 240)
  if (text.length < 12) return null

  return {
    kind: 'tool-failure',
    text,
    key: signatureOf(text),
    seq,
    quote: excerpt(detail || text, 200),
    hintedType: 'pitfall',
    signalScore: 0.75,
    signals: ['tool-error'],
    tool,
  }
}

/**
 * Longer statements carry more context, but the bonus saturates fast so a wall
 * of text cannot outrank a crisp constraint.
 *
 * @param {string} sentence - normalized sentence.
 * @returns {number} bonus in 0..0.15.
 */
function lengthBonus(sentence) {
  return Math.min(0.15, sentence.length / 800)
}
