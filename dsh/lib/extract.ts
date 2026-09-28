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
 * Types: session events arrive from the harness, and the plugin deliberately
 * does not import the harness's own event types — the package is zero-dependency
 * so that a workspace copy can mount with `--patch` and no install step. The
 * event payload is therefore described here as a small local structural type
 * (`EventData`) holding only the fields this module reads, and `data` is kept
 * `unknown`-free of assertions: every read goes through `asRecord`, which is a
 * `typeof === 'object'` narrowing, not an `any` escape hatch.
 *
 * @module dsh/lib/extract
 */

import { excerpt, normalize, splitSentences } from './text.ts'
import { emphasisWeight, isNoteworthyVeto, matchTypeSignals, screenSentence, signatureOf } from './signals.ts'

/**
 * A loosely typed session-event payload. Only the fields listed here are read
 * by this module; the index signature keeps the shape open, because the harness
 * owns the real definition.
 */
export interface EventData {
  role?: string
  content?: unknown
  source?: EventSource
  message?: EventMessage
  error?: EventError
  callId?: string
  name?: string
  [key: string]: unknown
}

/** The `source` block of a message: who produced it, and which call it answers. */
export interface EventSource {
  kind?: string
  callId?: string
  [key: string]: unknown
}

/** A nested message, as carried by `tool/result` events. */
export interface EventMessage {
  role?: string
  content?: unknown
  source?: EventSource
  [key: string]: unknown
}

/** The `error` block of a failed tool result. */
export interface EventError {
  name?: string
  code?: string
  [key: string]: unknown
}

/**
 * One event of a turn, oldest first.
 *
 * Every field is optional because `extractCandidates` is a public entry point
 * and is fed synthetic and malformed events by its own tests: an event with no
 * `type` simply matches no branch.
 */
export interface TurnEvent {
  seq?: number
  type?: string
  data?: EventData | null
}

/** The resolved extraction settings: the shape `EXTRACT_DEFAULTS` fills in. */
export interface ExtractOptions {
  minChars: number
  maxChars: number
  maxPerMessage: number
  maxPerTurn: number
  includeToolFailures: boolean
  onVeto: ((sentence: string, reason: string | null) => void) | null
}

/** Extraction defaults; every one of them is overridable from plugin config. */
export const EXTRACT_DEFAULTS: ExtractOptions = {
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

/** One memory candidate, before the judgement layer labels it. */
export interface Candidate {
  /** where the text came from. */
  kind: 'user' | 'tool-failure'
  /** the memory text, verbatim or derived. */
  text: string
  /** signature hash used for dedup. */
  key: string
  /** session seq the candidate came from. */
  seq: number
  /** the exact source excerpt for the ledger. */
  quote: string
  /** a type the deterministic signals suggest. */
  hintedType: string | null
  /** 0..1 interest score, pre-judgement. */
  signalScore: number
  /** which patterns matched, for the ledger. */
  signals: string[]
  /** tool name for failure candidates. */
  tool: string | null
}

/**
 * Read a value as a property bag, or `null` when it cannot be one.
 *
 * This is the module's only narrowing primitive: `typeof value === 'object'`
 * plus one assertion, which is how `unknown` data read off a harness event is
 * accessed without an `any` cast. It is local (rather than imported from a
 * shared helper module) so that the plugin keeps its documented file list and
 * adds no export that the harness could mistake for API.
 *
 * @param value - any value.
 * @returns the value as a record, or null.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * Collect the `text` blocks of a content array.
 *
 * @param content - a `Message['content']` value.
 * @returns the text of every `text` block, in order.
 */
function textBlocksOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const blocks: unknown[] = content
  const out: string[] = []
  for (const block of blocks) {
    const record = asRecord(block)
    if (record?.type === 'text' && typeof record.text === 'string') out.push(record.text)
  }
  return out
}

/**
 * Extract memory candidates from one turn's session events.
 *
 * @param events - the turn's events, oldest first.
 * @param options - extraction overrides.
 * @returns candidates, best first.
 */
export function extractCandidates(
  events: ReadonlyArray<TurnEvent | null | undefined> | null | undefined,
  options: Partial<ExtractOptions> = {},
): Candidate[] {
  const config: ExtractOptions = { ...EXTRACT_DEFAULTS, ...options }
  const candidates: Candidate[] = []
  /** callId → tool name, for failure attribution. */
  const callNames = new Map<string, string>()

  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue
    // A real event always carries its seq; the fallback only covers synthetic
    // events, which never reach a branch that reads it.
    const seq = typeof event.seq === 'number' ? event.seq : 0
    if (event.type === 'tool/call') {
      const callId = event.data?.callId
      const name = event.data?.name
      if (callId && name) callNames.set(String(callId), String(name))
      continue
    }
    if (event.type === 'user/message') {
      const message = event.data
      if (message?.source?.kind !== 'user') continue
      for (const candidate of fromUserMessage(message, seq, config)) candidates.push(candidate)
      continue
    }
    if (event.type === 'tool/result' && config.includeToolFailures) {
      const candidate = fromToolFailure(event.data, seq, callNames)
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
 * @param message - the `user/message` event data.
 * @param seq - the event's seq.
 * @param config - resolved extraction config.
 * @returns candidates from this message.
 */
function fromUserMessage(message: EventData | null | undefined, seq: number, config: ExtractOptions): Candidate[] {
  const text = normalize(textBlocksOf(message?.content).join('\n'))
  if (!text) return []

  const out: Candidate[] = []
  for (const sentence of splitSentences(text)) {
    if (sentence.length < config.minChars) continue
    const screen = screenSentence(sentence)
    if (!screen.keep) {
      // Report the rejection instead of dropping it silently: write precision is
      // measured from what the screens threw away as much as from what was kept —
      // but only the rejections that carry information (see isNoteworthyVeto).
      if (isNoteworthyVeto(screen.reason)) config.onVeto?.(sentence, screen.reason)
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
 * @param data - the `tool/result` event data.
 * @param seq - the event's seq.
 * @param callNames - callId → tool name.
 * @returns the candidate, or null when this is not a failure.
 */
function fromToolFailure(data: EventData | null | undefined, seq: number, callNames: Map<string, string>): Candidate | null {
  const blocks: unknown[] = Array.isArray(data?.message?.content) ? data.message.content : []
  const failed = data?.error !== undefined || blocks.some((block) => asRecord(block)?.isError === true)
  if (!failed) return null

  const callId = data?.message?.source?.callId
  const tool = (callId && callNames.get(String(callId))) || data?.error?.name || 'tool'
  const detail = normalize(textBlocksOf(data?.message?.content).join(' '))
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
 * @param sentence - normalized sentence.
 * @returns bonus in 0..0.15.
 */
function lengthBonus(sentence: string): number {
  return Math.min(0.15, sentence.length / 800)
}
