/**
 * The measurement behind "the window is rounds, not messages" (`conversationWindow` in the plugin).
 *
 * A round is the person's prompt plus the final assistant answer of that turn; the intermediate
 * assistant lines and tool traffic are what the turn *did*, not what was said to the person.
 *
 * Two things are compared over the last rounds of a real session log: how much of it is the person's
 * own words, and what the shipped segment call does with it. The second half matters because the
 * call's answer quotes every span it keeps, so its cost tracks the window — and, as it turned out,
 * tracks its own answer length far more than the window size:
 *
 *   last 5 messages       6779 chars   1 their message   valid, 2807ms   (over the 1600ms budget)
 *   5 rounds, uncapped   12276 chars   5 their messages  valid, 1216ms
 *   5 rounds, 150 cap      989 chars   5 their messages  valid, 1268ms
 *
 * Run: `DSH_LIVE_ROUTE=yes node eval/window-shapes.ts` (about four calls). Without the variable it
 * prints the sizes only. Override the session with WINDOW_SESSION, the call count with WINDOW_LIMIT.
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildSegmentPrompt, explainSegments, SEGMENT_DEFAULTS, SEGMENT_SYSTEM } from '../dsh/lib/segment.ts'

if (process.env.DSH_LIVE_ROUTE !== 'yes') {
  console.log('refusing to run: this makes real model calls. Set DSH_LIVE_ROUTE=yes to continue (the table of sizes prints either way if you set ROUNDS_CALL=no).')
  process.exit(0)
}
const dir = join(homedir(), '.dsh', 'jev-memory', 'l0')
const entries: Array<{ sessionId?: string; seq?: number; role?: string; text?: string }> = []
for (const file of (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort()) {
  for (const line of (await readFile(join(dir, file), 'utf8')).trim().split('\n')) {
    if (line.trim() !== '') entries.push(JSON.parse(line))
  }
}
const usable = entries.filter((e) => typeof e.text === 'string' && e.text.trim() !== '')
const session = usable[usable.length - 1]?.sessionId
const log = usable.filter((e) => e.sessionId === session)

// Group into rounds: walking forward, a user message opens a round; the assistant messages after it
// (until the next user message) are that round's answer.
const rounds: Array<{ user: string; answers: string[] }> = []
for (const entry of log) {
  if (entry.role === 'user') rounds.push({ user: entry.text ?? '', answers: [] })
  else if (rounds.length > 0 && entry.role === 'assistant') rounds[rounds.length - 1]!.answers.push(entry.text ?? '')
}
console.log(`session log: ${log.length} messages, ${rounds.length} rounds`)

const lastMessages = log.slice(-5).map((entry, index) => ({ seq: index, role: entry.role ?? 'user', text: entry.text ?? '' }))
const lastRounds = rounds.slice(-5)
const answer = (round: (typeof lastRounds)[number]): string => round.answers[round.answers.length - 1] ?? ''
const roundMessages = (cap: number) =>
  lastRounds.flatMap((round, index) => [
    { seq: index * 2, role: 'user', text: round.user },
    { seq: index * 2 + 1, role: 'assistant', text: answer(round).slice(0, cap) },
  ])

const shapes: Array<{ label: string; messages: ReturnType<typeof roundMessages> }> = [
  { label: '现在：最后 5 条消息', messages: lastMessages },
  { label: '5 轮，助手回答不截断', messages: roundMessages(1e9) },
  { label: '5 轮，每轮助手回答截 400 字', messages: roundMessages(400) },
  { label: '5 轮，每轮助手回答截 150 字', messages: roundMessages(150) },
]
for (const shape of shapes) {
  const chars = shape.messages.reduce((n, m) => n + m.text.length, 0)
  const humans = shape.messages.filter((m) => m.role === 'user').length
  console.log(
    `\n${shape.label}: ${shape.messages.length} 条消息, ${chars} 字, 其中你说的话 ${humans} 条` +
      `（你的话共 ${shape.messages.filter((m) => m.role === 'user').reduce((n, m) => n + m.text.length, 0)} 字）`,
  )
  if (process.env.ROUNDS_CALL !== 'yes') continue
  const started = Date.now()
  const cred = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const key = /DEEPSEEK_API_KEY:\s*(\S+)/u.exec(cred)?.[1] ?? ''
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: SEGMENT_SYSTEM },
        { role: 'user', content: buildSegmentPrompt(shape.messages) },
      ],
      temperature: 0,
      max_tokens: 2500,
      thinking: { type: 'disabled' },
    }),
  })
  const payload = (await response.json()) as Record<string, any>
  const choice = payload.choices?.[0]
  const text = String(choice?.message?.content ?? '')
  const explained = explainSegments(text, shape.messages, SEGMENT_DEFAULTS)
  console.log(
    `  → ${choice?.finish_reason} | 答案 ${text.length} 字 | 判定 ${explained.reason} | 段数 ${explained.segments?.length ?? 0} | ${Date.now() - started}ms`,
  )
}
