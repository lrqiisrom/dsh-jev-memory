/**
 * The window the write path reads: the last few rounds of a conversation, in reading order.
 *
 * Extracted from `dsh/index.ts`, where it was a closure, for two reasons that arrived together.
 *
 * The first is that it could not be tested. Everything about the shape of this window was measured —
 * five rounds, each answer capped at 200 characters, per-round rather than per-message — and none of
 * that could be asserted, so a change to the order or the cap had nothing standing in its way.
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
 * Walk a session backwards and return the last `rounds` rounds, oldest round first.
 *
 * A round is a message the person wrote plus the final answer to it. Assistant lines seen before the
 * question they follow belong to that question; the first one collected is the final answer, which is
 * the only one the next round's reader needs. Working backwards is what keeps a long session cheap:
 * five rounds cost five rounds, not the session's whole history.
 *
 * @param currentSeq - the position to walk back from, or null when there is no session to walk.
 * @param messageAt - normalized message at a position, or null. Called lazily, newest first.
 * @param rounds - how many rounds to include.
 * @param answerChars - cap on each round's answer; the person's own words are never truncated.
 * @returns the window in reading order, or null when it cannot be walked.
 */
export function conversationWindowOf(
  currentSeq: number | null | undefined,
  messageAt: (seq: number) => WindowMessage | null,
  rounds: number,
  answerChars: number,
): WindowMessage[] | null {
  if (typeof currentSeq !== 'number' || rounds <= 0) return null
  /** Rounds newest first, each already in reading order. */
  const collected: WindowMessage[][] = []
  /** Assistant lines of the round being walked, newest first. */
  let answers: Array<{ seq: number; text: string }> = []
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
    collected.push([
      { seq, role: 'user', text: message.text },
      ...(answer && answerChars > 0
        ? [{ seq: answer.seq, role: 'assistant', text: answer.text.slice(0, answerChars) }]
        : []),
    ])
    answers = []
    found += 1
  }
  // The *rounds* are reversed, never the flat list: reversing the flat list is what put every answer in
  // front of the question it answered.
  return collected.reverse().flat()
}
