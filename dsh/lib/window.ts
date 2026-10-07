/**
 * The window the write path reads: the last few rounds of a conversation, in reading order.
 *
 * Extracted from `dsh/index.ts`, where it was a closure, for two reasons that arrived together.
 *
 * The first is that it could not be tested. Everything about the shape of this window was measured —
 * three rounds, each answer capped at 200 characters except the newest one, per-round rather than
 * per-message — and none of that could be asserted, so a change to the order or the cap had nothing
 * standing in its way.
 *
 * The second is the bug the extraction exposed. Each round was appended as `[question, answer]` and the
 * whole flat list was reversed at the end, which reverses the round order (intended) *and* swaps each
 * question with its own answer (not intended). A real prompt built from a real session began
 * `[0] 角色=assistant`, `[1] 角色=user`: the model read every answer before the question it answered.
 * Nothing caught it because the one script that inspected windows only counted characters, and
 * `eval/window-shapes.ts` built its own fixture as `[user, assistant]` pairs — the natural order its
 * author assumed.
 *
 * @module dsh/lib/window
 */

/** One message as the write path sees it, after the harness events have been normalized. */
export interface WindowMessage {
  seq: number
  role: string
  text: string
}

/**
 * A wider cap for the newest answers in the window.
 *
 * The flat cap is the wrong shape for attribution. A person who says "also make it 4000" is usually
 * quoting the answer they just read, and the extraction model cannot mark that as a quotation if the
 * sentence is not in the window — measured on 15 verbatim echoes, **14 sat past the 200th character**
 * of the answer they came from (raw offsets 320–3736). The answer nearest the current turn is the one
 * being quoted, so it carries the provenance; the older ones are background and do not need it.
 *
 * `rounds` counts **answers, not rounds**, and the difference is not academic: the newest round in a
 * window is the turn being answered, which has no answer of its own yet. Counting rounds made
 * `rounds: 1` land on that empty round and widen nothing at all, so the arm built from it was
 * byte-identical to the shipped one while looking like a successful experiment.
 *
 * Passed explicitly, never defaulted: the shipped window stays at one flat cap until an experiment
 * says otherwise.
 */
export interface RecentAnswerCap {
  /** How many of the newest answers get `chars` instead of `answerChars`. */
  rounds: number
  /** The cap for those answers. `Infinity` keeps the answer whole. */
  chars: number
}

/**
 * Walk a session backwards and return the last `rounds` rounds, oldest round first.
 *
 * A round is a message the person wrote plus the final answer to it. Assistant lines seen before the
 * question they follow belong to that question; the first one collected is the final answer, which is
 * the only one the next round's reader needs. Working backwards is what keeps a long session cheap:
 * the rounds asked for cost those rounds, never the session's whole history.
 *
 * @param currentSeq - the position to walk back from, or null when there is no session to walk.
 * @param messageAt - normalized message at a position, or null. Called lazily, newest first.
 * @param rounds - how many rounds to include.
 * @param answerChars - cap on each round's answer; the person's own words are never truncated.
 * @param recentAnswers - optional wider cap for the newest answers; omitted means `answerChars` for
 *   every round, which is the shipped window.
 * @returns the window in reading order, or null when it cannot be walked.
 */
export function conversationWindowOf(
  currentSeq: number | null | undefined,
  messageAt: (seq: number) => WindowMessage | null,
  rounds: number,
  answerChars: number,
  recentAnswers?: RecentAnswerCap,
): WindowMessage[] | null {
  if (typeof currentSeq !== 'number' || rounds <= 0) return null
  /** Rounds newest first, each already in reading order. */
  const collected: WindowMessage[][] = []
  /** Assistant lines of the round being walked, newest first. */
  let answers: Array<{ seq: number; text: string }> = []
  /** How many answers have already been given the wider cap, newest first. */
  let widened = 0
  let found = 0
  for (let seq = currentSeq - 1; seq >= 0 && found < rounds; seq -= 1) {
    const message = messageAt(seq)
    if (!message) continue
    if (message.role === 'assistant') {
      answers.push({ seq, text: message.text })
      continue
    }
    if (message.role !== 'user') continue
    const answer = answers[0]
    // Counted over the answers actually emitted, newest first — never over the rounds walked. The
    // newest round is the turn being answered and has no answer of its own, so counting rounds spent
    // the whole widening on a round that had nothing to widen.
    const wide = recentAnswers !== undefined && answer !== undefined && widened < recentAnswers.rounds
    const cap = wide ? recentAnswers.chars : answerChars
    if (wide) widened += 1
    collected.push([
      { seq, role: 'user', text: message.text },
      ...(answer && cap > 0
        ? [{ seq: answer.seq, role: 'assistant', text: answer.text.slice(0, cap) }]
        : []),
    ])
    answers = []
    found += 1
  }
  // The *rounds* are reversed, never the flat list: reversing the flat list is what put every answer in
  // front of the question it answered.
  return collected.reverse().flat()
}
