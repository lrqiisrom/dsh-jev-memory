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
 * @module dsh/lib/echo
 */

/** Thresholds for {@link findEcho}. */
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
