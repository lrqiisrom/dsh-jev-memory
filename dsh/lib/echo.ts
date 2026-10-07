/**
 * Is this sentence something the model already said, pasted into the person's own message?
 *
 * This is the largest single reason a labelled row is marked "don't remember": 30 rows carry a note
 * saying the text came from the model, and **none of them is marked "remember"**. 24 of those 30
 * were still being let through, because the role on the envelope is `user` — pasting a model's
 * answer into your own message is indistinguishable from writing it at the level of metadata.
 *
 * Patterns cannot do it, and that was measured rather than assumed: over those 30 rows the best of
 * four candidate regexes caught 4, the markdown one 2, the assistant-voice one 0. What distinguishes
 * the text is not how it looks but that **the same session already said it** — which is why the
 * archive keeps the assistant's messages, and why this check needs no model at all.
 *
 * Measured on 128 located labelled rows at the thresholds below: **15 of the 28** note-says-model
 * rows caught, **0 of the positives killed**, 20 negatives blocked. Lowering the length floor to 6
 * gains nothing; raising coverage to 0.8 drops the catch to 9.
 *
 * The comparison is deliberately scoped to the same session, and that was measured too rather than
 * assumed. Broadening it to every session's assistant messages, bounded by timestamp, caught the
 * same 15 and killed the same zero — so the rows it misses are not quotes of a subagent's output or
 * of another conversation; they are from other agents, other machines, or hand-edited. A wider net
 * would only add false-positive risk, so the narrow one is the one that shipped.
 *
 * ## Two rules, because the two write paths hand this module different things
 *
 * {@link findEcho} was measured on the **fallback** path, where a candidate *is* the person's own
 * sentence. On the **model** path a candidate is a third-person summary the model wrote plus the
 * verbatim span it came from, and feeding the summary to `findEcho` is why that screen fired once in
 * 61 rows: a rewrite is not a contiguous run of the answer it rewrote. {@link findSpanEcho} is the
 * model path's rule — it compares the *span*, and by token containment rather than by contiguous run,
 * so re-wrapping and stitching non-adjacent parts both still match.
 *
 * @module dsh/lib/echo
 */

import { tokenize } from './conflict.ts'

/**
 * Thresholds for {@link findEcho}.
 *
 * Not reachable from a config row, deliberately, and the parameter below exists only so a test can
 * move a boundary and show which side of it a fixture falls on. A threshold that ships as a config
 * row is a threshold that can ship unmeasured, and this one did: a row that set only `minChars` left
 * `minCoverage` undefined, the floor computed to `NaN`, the comparison never ran, and the screen
 * switched itself off without a word in the log. Re-tuning means editing the constant below and
 * re-running the tests against a labelled batch — which is what a config row would have needed too,
 * minus the silent failure.
 */
export interface EchoSettings {
  /** below this many normalised characters a match is coincidence, not a quote. */
  minChars: number
  /** how much of the candidate has to appear in an earlier message. */
  minCoverage: number
}

/** The measured optimum; see the module note. */
export const ECHO_DEFAULTS: EchoSettings = {
  minChars: 8,
  minCoverage: 0.6,
}

/**
 * Collapse text for comparison: drop whitespace and punctuation, fold case.
 *
 * Whitespace goes because a paste is re-wrapped, and punctuation because the assistant's rendering
 * and the person's paste rarely agree on it. Chinese and latin survive untouched otherwise.
 *
 * @param text - the raw text.
 * @returns the comparable form.
 */
export function normalizeForEcho(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[.,;:!?，。；：！？、"'"'“”‘’（）()\[\]{}<>《》—–-]/gu, '')
}

/** One earlier message to compare against. */
export interface EchoCandidate {
  /** `user`, `assistant`, or whatever the host called it. */
  role: string
  text: string
}

/**
 * Whether `text` is (mostly) something said earlier in the same session, by someone else.
 *
 * Coverage is directional on purpose: the candidate has to be *contained* in what came earlier, not
 * the other way round. A long assistant answer that happens to contain a short phrase of the
 * person's is not an echo of the person.
 *
 * @param text - the candidate sentence.
 * @param earlier - messages that came before it, in the same session.
 * @param settings - thresholds.
 * @returns the match with the fraction of the candidate that was found, or null.
 */
export function findEcho(
  text: string,
  earlier: readonly EchoCandidate[],
  settings: EchoSettings = ECHO_DEFAULTS,
): { role: string; coverage: number } | null {
  const needle = normalizeForEcho(text)
  if (needle.length < settings.minChars) return null
  const floor = Math.max(settings.minChars, Math.ceil(needle.length * settings.minCoverage))
  const others = earlier.filter((message) => message.role !== 'user')
  if (others.length === 0) return null
  const haystacks = others.map((message) => ({ role: message.role, text: normalizeForEcho(message.text) }))

  // Longest window first, stepping down: the more of the candidate that matches, the less likely it
  // is a coincidence, and the first hit is the strongest one.
  for (let size = needle.length; size >= floor; size -= 4) {
    for (let start = 0; start + size <= needle.length; start += 4) {
      const window = needle.slice(start, start + size)
      for (const haystack of haystacks) {
        if (haystack.text.includes(window)) return { role: haystack.role, coverage: size / needle.length }
      }
    }
  }
  return null
}

/**
 * Thresholds for {@link findSpanEcho}.
 *
 * A test seam, not a config surface — see {@link EchoSettings} for why, and `SPAN_ECHO_DEFAULTS` for
 * where the numbers came from.
 */
export interface SpanEchoSettings {
  /** Below this many tokens a match is coincidence, not a quote. */
  minTokens: number
  /** How much of the span's tokens have to appear in one earlier message. */
  minCoverage: number
  /** How many of the newest earlier messages to compare against. */
  lookback: number
}

/**
 * The measured optimum for the model path, in tokens rather than characters.
 *
 * Measured over the 113 rows the model path wrote and a person then labelled (52 keep / 61 don't):
 * catches **18 of the 61**, kills **0 of the 52**. The separation is wide, not fitted: every row it
 * catches scores ≥0.95, and the wrong rows it misses top out at 0.65 — there is nothing at all in
 * between, which is why the coverage threshold is insensitive anywhere from 0.85 to 0.97.
 *
 * `minTokens` is what buys the zero, not the coverage. The one keep it would otherwise kill is a
 * 24-character paste — the person quoting a line back in order to cut it — worth 10 tokens. That
 * margin is thin in both directions and should not be read as comfortable: the same batch contains a
 * genuine echo worth exactly 15, so the floor sits between 10 and 15 with a true positive on the
 * boundary. A fresh batch is owed before either number is treated as settled, and {@link
 * SPAN_ECHO_DEFAULTS} is the kind of constant that should move with the corpus rather than with
 * intuition.
 *
 * `lookback: 2` earns exactly one row over `lookback: 1` (a span quoted from the answer two turns
 * back, with an unrelated exchange in between); three and beyond change nothing.
 */
export const SPAN_ECHO_DEFAULTS: SpanEchoSettings = {
  minTokens: 15,
  minCoverage: 0.95,
  lookback: 2,
}

/**
 * Whether a verbatim span is mostly made of words an earlier message already used.
 *
 * Coverage is directional and order-free, both on purpose. Directional because the question is
 * whether the *span* came from the answer, not whether the answer mentions the span. Order-free
 * because a paste is re-wrapped and because three of the eighteen measured rows stitched together
 * parts of the answer that were never adjacent — a contiguous-run test misses those by construction.
 *
 * The comparison stops at the newest `lookback` messages: the answer a person quotes is the one they
 * just read, and widening the net adds false-positive risk for rows that do not exist. This is why
 * the shipped window's 200-character cap does not bind here — the archive holds the whole answer.
 *
 * @param span - the verbatim span of the person's message the candidate was extracted from.
 * @param earlier - messages that came before it, in the same session, oldest first.
 * @param settings - thresholds.
 * @returns the newest matching message and the fraction of the span found in it, or null.
 */
export function findSpanEcho(
  span: string,
  earlier: readonly EchoCandidate[],
  settings: SpanEchoSettings = SPAN_ECHO_DEFAULTS,
): { role: string; coverage: number } | null {
  const words = [...tokenize(span)]
  if (words.length < settings.minTokens) return null
  const others = earlier.filter((message) => message.role !== 'user').slice(-settings.lookback)
  // Newest first, so the reported hit is the message the person most plausibly quoted.
  for (const message of [...others].reverse()) {
    const said = tokenize(message.text)
    const coverage = words.filter((word) => said.has(word)).length / words.length
    if (coverage >= settings.minCoverage) return { role: message.role, coverage }
  }
  return null
}
