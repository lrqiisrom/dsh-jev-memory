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

import { clipAtClause, excerpt, normalize, splitSentences } from './text.ts'
import {
  emphasisWeight,
  matchTypeSignals,
  screenSentence,
  signatureOf,
  stripPastedPrefixes,
} from './signals.ts'

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
  /**
   * Units decided elsewhere, instead of splitting the message on punctuation.
   *
   * When a model has read the window and returned the person's own spans, those are the sentences
   * — the deterministic splitter becomes the fallback rather than the authority. Each unit carries
   * the `seq` of the message it was sliced from, and its text is that slice, so the identity rule
   * downstream is unchanged: a unit that happens to equal what the splitter would have produced
   * gets the same id, and the labels already attached to it keep working.
   *
   * `type` is present only on the model write path (`writeMode: 'model'`), where one call decided
   * both that the span is worth remembering *and* what kind of memory it is. Its presence is what
   * tells the gate not to re-decide: the measured reason for that path existing is that the local
   * type-and-score rule and this call disagree, and the call is right more often (F1 0.69 vs 0.37
   * over the same 120 rows). Without the field the gate would overrule it and write nothing.
   */
  units?: ReadonlyArray<{ seq: number; text: string; type?: string | null }> | null
  onVeto: ((sentence: string, reason: string | null, seq?: number) => void) | null
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
  units: null,
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
  /**
   * The type the model write path assigned to this span, or null on the deterministic path.
   *
   * Not a hint: on that path it is the decision, and `applyGate` is skipped for the candidates that
   * carry it. Stored so the ledger can show what the model said next to what was written.
   */
  modelType?: string | null
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
      const candidate = fromToolFailure(event.data, seq, callNames, config)
      if (candidate) candidates.push(candidate)
    }
  }

  return candidates
    .filter((candidate, index, all) => all.findIndex((other) => other.key === candidate.key) === index)
    .sort((a, b) => b.signalScore - a.signalScore)
    .slice(0, config.maxPerTurn)
}

/**
 * Every message in the turn, for the archive.
 *
 * Unlike {@link extractCandidates} this filters nothing but empty text: no screens, no length
 * minimum, no type signals. The archive exists so a wrong promotion decision stays
 * reversible, and a filter here would reintroduce exactly the loss it is meant to prevent.
 *
 * The assistant's own messages are included. Nothing else in the system records them, and
 * without them there is no way to answer the question the labelled corpus keeps asking — "is
 * this the model's words rather than the person's?" — because that question is a comparison
 * against what the model said earlier in the same session.
 *
 * @param events - one turn's events, oldest first.
 * @returns the messages with text, each tagged with its role and sequence.
 */
export function archiveMessages(events: readonly TurnEvent[]): Array<{ seq: number; role: string; text: string }> {
  const out: Array<{ seq: number; role: string; text: string }> = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const message = event.data
      const text = normalize(textBlocksOf(message?.content).join('\n'))
      if (text === '') continue
      const kind = message?.source?.kind
      if (typeof event.seq !== 'number') continue
      out.push({ seq: event.seq, role: typeof kind === 'string' && kind !== '' ? kind : 'user', text })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = normalize(textBlocksOf(event.data?.message?.content).join('\n'))
      if (text === '') continue
      if (typeof event.seq !== 'number') continue
      out.push({ seq: event.seq, role: 'assistant', text })
    }
  }
  return out
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
  // A non-null `units` means a model read this window and answered about it, so for this message its
  // answer is **authoritative** — including when the answer is "nothing here". That is a rule rather
  // than a detail, and it was wrong first: the original check was `provided.length > 0`, so a message
  // the model returned no *user* span for fell back to the punctuation splitter. Two ways that bit:
  //
  //  - A message whose every span the model marked `pasted` came back through the splitter, and a
  //    pasted block could then be written as the person's own requirement — the exact failure
  //    segmentation exists to prevent, reachable only when the whole message was pasted.
  //  - On `writeMode: 'model'`, an answer of `[]` ("nothing worth remembering") reverted to the local
  //    type-and-score gate and could write the very sentence the call had just rejected. The path was
  //    measured as "written iff an accepted item covers the row" (F1 0.69 over 120 rows); the lenient
  //    reading would have shipped something else under that number.
  //
  // The caller passes `null` — not `[]` — when the call failed, timed out or was refused, so the
  // splitter still owns every case where no model actually answered.
  //
  // The unit's `type` rides along with its text rather than being looked up again after cleaning,
  // because both `stripPastedPrefixes` and `clipAtClause` may edit the text and the association
  // would then have to be re-derived from a string comparison that could silently mismatch.
  const answered = config.units !== null && config.units !== undefined
  const provided = config.units?.filter((unit) => unit.seq === seq) ?? []
  const sources: Array<{ raw: string; modelType: string | null }> = answered
    ? provided.map((unit) => ({ raw: unit.text, modelType: unit.type ?? null }))
    : splitSentences(text).map((raw) => ({ raw, modelType: null }))
  for (const { raw, modelType } of sources) {
    // Screen the cleaned sentence, not the raw one: a `\end{itemize}` in front of a task
    // instruction used to change the verdict, which is the prefix deciding policy.
    const sentence = stripPastedPrefixes(raw)
    if (sentence.length < config.minChars) continue
    const screen = screenSentence(sentence)
    if (!screen.keep) {
      // Every rejection is reported; the caller decides what to record. The gate used to
      // live here, and it hid the `question` screen from the evaluation entirely — the one
      // screen whose reach was just widened, and therefore the one whose mistakes most need
      // to be measurable. A ledger that would drown in questions is the ledger's problem,
      // not the extractor's.
      config.onVeto?.(sentence, screen.reason, seq)
      continue
    }

    const signal = matchTypeSignals(sentence)
    const score = candidateScore(sentence)

    // Two texts, on purpose. `key` is the sentence's identity, computed from **what the
    // person actually wrote** — the same input as before this cleaning existed, so no
    // existing row's id changes and every label stays attached to its sentence. `text` is
    // what gets stored and injected, with a pasted prefix removed so the memory reads as
    // the sentence it is. Getting this backwards is easy and the test caught it once
    // already: the comment claimed the raw sentence while the code passed the cleaned one.
    //
    // They also clip differently, and that is deliberate. The identity keeps the plain hard
    // cut because the ids the labelled corpus is keyed by were built with it — changing it
    // would orphan every label. The stored text cuts at a clause boundary instead: a memory
    // that ends mid-clause is not judgeable (that is what "上下文并不完整" was about), and a
    // hard cut also removes the `(`/`{` that the payload screen matches on.
    const clip = (value: string): string =>
      value.length > config.maxChars ? `${value.slice(0, config.maxChars - 1)}…` : value
    const identity = clip(raw)
    const stored = clipAtClause(sentence, config.maxChars)

    out.push({
      kind: 'user',
      text: stored,
      key: signatureOf(identity),
      seq,
      quote: excerpt(raw, 200),
      hintedType: signal.type,
      signalScore: score,
      signals: signal.hits,
      tool: null,
      modelType,
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
/**
 * Whether a tool-failure sentence would still be extracted, given only its text.
 *
 * Exported for the report, which re-runs today's rules over rows drawn under older
 * ones. It parses the same `工具名 失败：detail` shape `fromToolFailure` writes, so
 * the report cannot drift from the extractor about which failures survive.
 *
 * @param text - a line like `edit 失败：FS_AMBIGUOUS_EDIT`.
 * @returns true when the failure carries a diagnostic.
 */
export function toolFailureKept(text: string): boolean {
  return hasDiagnostic(text.replace(/^[^:：]*[:：]\s*/u, ''))
}

/**
 * Whether a failure says anything beyond its own name.
 *
 * A bare error code is not a memory. "edit 失败：FS_AMBIGUOUS_EDIT" names a condition
 * and no cause, cannot be acted on in a later session, and the person labelling the
 * real corpus marked exactly these rows as unmemorable (`?`, note: "只有调用失败不给
 * 原因分析"). A failure that explains itself does get remembered — "sqlite 写入失败：
 * EDQUOT，磁盘配额用尽，要先清 .pnpm-store" is a labelled positive.
 *
 * @param detail - the failure's first line of detail.
 * @returns true when there is something to learn from it.
 */
function hasDiagnostic(detail: string): boolean {
  const value = detail.trim()
  if (value === '') return false
  if (/^(?:未知错误|unknown(?: error)?|error|failed|failure)$/iu.test(value)) return false
  // A bare code: capitals, digits and underscores only, with no spaces or prose.
  if (/^[A-Z][A-Z0-9_]{2,}$/u.test(value)) return false
  return true
}

function fromToolFailure(
  data: EventData | null | undefined,
  seq: number,
  callNames: Map<string, string>,
  config: ExtractOptions,
): Candidate | null {
  const blocks: unknown[] = Array.isArray(data?.message?.content) ? data.message.content : []
  const failed = data?.error !== undefined || blocks.some((block) => asRecord(block)?.isError === true)
  if (!failed) return null

  const callId = data?.message?.source?.callId
  const tool = (callId && callNames.get(String(callId))) || data?.error?.name || 'tool'
  const detail = normalize(textBlocksOf(data?.message?.content).join(' '))
  const firstLine = detail.split('\n')[0] ?? ''
  const summary = firstLine || String(data?.error?.code ?? '')
  const text = normalize(`${tool} 失败：${summary || '未知错误'}`).slice(0, 240)
  if (text.length < 12) return null
  // Refused for a reason the ledger records rather than dropped in silence: this
  // exact class of rejection was invisible once and it took a person labelling rows
  // by hand to find it.
  if (!hasDiagnostic(summary)) {
    config.onVeto?.(text, 'tool-failure-no-detail', seq)
    return null
  }

  return {
    kind: 'tool-failure',
    text,
    key: signatureOf(text),
    seq,
    quote: excerpt(detail || text, 200),
    hintedType: 'pitfall',
    signalScore: TOOL_FAILURE_SIGNAL_SCORE,
    signals: ['tool-error'],
    tool,
  }
}

/**
 * Where a sentence lands in the extractor's own scoring.
 *
 * Exported because a harness that already holds a sentence — a labelled row in the
 * evaluation CSV — must be scored *exactly* as a live turn would score it. A second
 * copy of this formula is what let the write-precision harness quietly carry one
 * (it had not drifted yet, which is luck rather than design).
 *
 * @param sentence - normalized sentence.
 * @returns a score in 0..1.
 */
export function candidateScore(sentence: string): number {
  return Math.min(1, 0.35 + matchTypeSignals(sentence).weight * 0.35 + emphasisWeight(sentence) + lengthBonus(sentence))
}

/** The score given to a reproducible-looking tool failure, above any threshold in use. */
export const TOOL_FAILURE_SIGNAL_SCORE = 0.75

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
