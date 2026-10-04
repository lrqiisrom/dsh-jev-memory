/**
 * A/B: say out loud which messages are the extraction source and which are only context.
 *
 * Borrowed from TencentDB-Agent-Memory's write path, where the extraction prompt is explicit about it:
 * `【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）` and `【待提取的新消息】（只从这里提取记忆！）`
 * (`MemoryCore/src/core/prompts/l1-extraction.ts:406-416`). Their guarantee does not depend on the
 * model marking attribution correctly — the prompt structure decides what may be mined.
 *
 * Our window carries each round's final assistant answer for one reason only: to tell a block the
 * person pasted (from the model's own earlier reply) apart from their own words. The prompt never says
 * so, and the measurement of 2026-10-03 showed the cost — with assistant text in the window the model
 * enumerated spans *inside it* too, returning 10 segments in 5074ms where a shorter window returned
 * the 5 human spans in 1268ms. The task is to say it, and to check that saying it does not cost the
 * attribution we keep the answers for.
 *
 * Three renderings, same windows, same budget:
 *   current   — chronological `--- 消息 i（角色：r）---` blocks, instructions unchanged
 *   marker    — chronological, but every line is labelled 可分段 / 仅背景
 *   sections  — the person's messages in one section, the answers in another
 *
 * Run: `DSH_LIVE_ROUTE=yes node eval/segment-prompt-ab.ts` (about 3 calls per window).
 * `AB_WINDOWS=4` limits the sample; `AB_MODEL` overrides the route.
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildSegmentPrompt, explainSegments, SEGMENT_DEFAULTS, SEGMENT_SYSTEM, type SegmentMessage } from '../dsh/lib/segment.ts'

if (process.env.DSH_LIVE_ROUTE !== 'yes') {
  console.log('refusing to run: this makes real model calls. Set DSH_LIVE_ROUTE=yes to continue.')
  process.exit(0)
}

const model = process.env.AB_MODEL?.trim() || 'deepseek-flash'
const limit = Number(process.env.AB_WINDOWS ?? '4')
const cred = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const key = /DEEPSEEK_API_KEY:\s*(\S+)/u.exec(cred)?.[1] ?? ''

/** The instruction, with the one sentence the variants exist to test. */
const SOURCE_RULE =
  '窗口中标注为「仅背景」的消息**不是提取源**：它们只用来判断用户是不是在粘贴/引用，' +
  '**不要从里面切分片段，也不要为它们返回任何 JSON 项**。只有标注为「可分段」的消息才允许出现在结果里。'

const markerRender = (messages: readonly SegmentMessage[]): string => {
  const body = messages
    .map(
      (message, index) =>
        `--- 消息 ${index}（角色：${message.role}）${message.role === 'user' ? '【可分段：这是提取源】' : '【仅背景：不要分段】'} ---\n${message.text}`,
    )
    .join('\n')
  return `以下是对话窗口，共 ${messages.length} 条消息。请按要求输出 JSON 数组。\n\n${body}`
}

const sectionsRender = (messages: readonly SegmentMessage[]): string => {
  const own = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user')
    .map(({ message, index }) => `--- 消息 ${index}（角色：${message.role}）---\n${message.text}`)
    .join('\n')
  const back = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role !== 'user')
    .map(({ message, index }) => `--- 消息 ${index}（角色：${message.role}）---\n${message.text}`)
    .join('\n')
  // Indexes stay the ones the answer must refer to, so grouping the sections cannot invalidate them.
  return (
    `以下是对话窗口，共 ${messages.length} 条消息。请按要求输出 JSON 数组。\n\n` +
    `## 待分段的消息（提取源，只有这里可以被切分）\n${own || '（无）'}\n\n` +
    `## 背景对话（只用来判断粘贴/引用，禁止切分，禁止出现在结果里）\n${back || '（无）'}`
  )
}

const variants: Array<{ name: string; system: string; render: (messages: readonly SegmentMessage[]) => string }> = [
  { name: 'current', system: SEGMENT_SYSTEM, render: buildSegmentPrompt },
  { name: 'marker', system: `${SEGMENT_SYSTEM}\n${SOURCE_RULE}`, render: markerRender },
  { name: 'sections', system: `${SEGMENT_SYSTEM}\n${SOURCE_RULE}`, render: sectionsRender },
]

const dir = join(homedir(), '.dsh', 'jev-memory', 'l0')
const archived: Array<{ sessionId?: string; role?: string; text?: string }> = []
for (const file of (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort()) {
  for (const line of (await readFile(join(dir, file), 'utf8')).trim().split('\n')) {
    if (line.trim() !== '') archived.push(JSON.parse(line))
  }
}
const usable = archived.filter((entry) => typeof entry.text === 'string' && entry.text.trim() !== '')
const session = usable[usable.length - 1]?.sessionId
const log = usable.filter((entry) => entry.sessionId === session)

// Round-shaped windows, as the plugin builds them: the person's message plus the final answer that
// followed it, the answer capped the way `conversationWindow.answerChars` caps it.
const rounds: Array<{ user: string; answers: string[] }> = []
for (const entry of log) {
  if (entry.role === 'user') rounds.push({ user: entry.text ?? '', answers: [] })
  else if (rounds.length > 0 && entry.role === 'assistant') rounds[rounds.length - 1]!.answers.push(entry.text ?? '')
}
const windows: SegmentMessage[][] = []
for (let end = rounds.length; end >= 1 && windows.length < limit; end -= 1) {
  const slice = rounds.slice(Math.max(0, end - 5), end)
  if (slice.length < 2) continue
  windows.push(
    slice.flatMap((round, index) => [
      { seq: index * 2, role: 'user', text: round.user },
      { seq: index * 2 + 1, role: 'assistant', text: (round.answers[round.answers.length - 1] ?? '').slice(0, 200) },
    ]),
  )
}
console.log(`windows: ${windows.length}（每个 ${windows[0]?.length ?? 0} 条消息，共 ${rounds.length} 轮可选）\n`)

const rows: string[] = []
for (const [index, messages] of windows.entries()) {
  const chars = messages.reduce((total, message) => total + message.text.length, 0)
  for (const variant of variants) {
    const started = Date.now()
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: variant.system },
          { role: 'user', content: variant.render(messages) },
        ],
        temperature: 0,
        max_tokens: 2500,
        thinking: { type: 'disabled' },
      }),
    })
    const payload = (await response.json()) as Record<string, any>
    const choice = payload.choices?.[0]
    const text = String(choice?.message?.content ?? '')
    const explained = explainSegments(text, messages, SEGMENT_DEFAULTS)
    const segments = explained.segments ?? []
    // The number this change is about: spans returned for messages that are not the person's, which
    // the caller drops anyway — they cost tokens and latency and buy nothing.
    const spurious = segments.filter((segment) => messages[segment.messageIndex]?.role !== 'user').length
    const kept = segments.filter((segment) => messages[segment.messageIndex]?.role === 'user').length
    rows.push(
      `| ${index} | ${chars} | ${variant.name} | ${explained.reason} | ${kept} | ${spurious} | ${text.length} | ${Date.now() - started} |`,
    )
    console.log(rows[rows.length - 1] ?? '')
  }
}

// The regression risk the split introduces: the assistant's answers are in the window for exactly one
// reason — telling a block the person pasted apart from their own words. A prompt that says "never
// segment the background" could plausibly make the model stop *reading* it. So this case is built by
// hand: the person's message states a requirement and then pastes the model's previous answer, and the
// only acceptable outcome is that the pasted half comes back marked `pasted`.
const attributionProbe: SegmentMessage[] = [
  { seq: 0, role: 'user', text: '端口怎么配？' },
  {
    seq: 1,
    role: 'assistant',
    text: '建议把服务端口固定成 8000，避免和其它服务冲突。另外记得写进 README。',
  },
  {
    seq: 2,
    // The person's message contains a **verbatim** copy of the assistant's sentence above, which is the
    // case the background exists for. The first version of this probe merely referred to it ("就按这个
    // 来") — nothing was pasted, so it measured nothing and both variants looked fine.
    role: 'user',
    text: '这是我记下来的：建议把服务端口固定成 8000，避免和其它服务冲突。另外日志要按天切分，别写进同一个文件。',
  },
]
console.log('\n## 归属检查（粘贴块能不能认出来）')
const attributionRows: string[] = []
for (const variant of [variants[0]!, variants[1]!]) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: variant.system },
        { role: 'user', content: variant.render(attributionProbe) },
      ],
      temperature: 0,
      max_tokens: 2500,
      thinking: { type: 'disabled' },
    }),
  })
  const payload = (await response.json()) as Record<string, any>
  const text = String(payload.choices?.[0]?.message?.content ?? '')
  const explained = explainSegments(text, attributionProbe, SEGMENT_DEFAULTS)
  const described = (explained.segments ?? [])
    .map((segment) => `${segment.attribution}:${attributionProbe[segment.messageIndex]!.text.slice(segment.start, segment.end).slice(0, 14)}`)
    .join(' | ')
  attributionRows.push(`| ${variant.name} | ${explained.reason} | ${explained.segments?.length ?? 0} | ${described} |`)
  console.log(attributionRows[attributionRows.length - 1] ?? '')
}

const table = [
  '| 窗口 | 窗口字数 | 写法 | 判定 | 你的片段 | **背景片段（白花）** | 答案字数 | 耗时ms |',
  '|---|---|---|---|---|---|---|---|',
  ...rows,
]
console.log(`\n${table.join('\n')}`)
console.log(`\n| 写法 | 判定 | 段数 | 归属结果 |\n|---|---|---|---|\n${attributionRows.join('\n')}`)
await (await import('node:fs/promises')).writeFile(
  new URL('../.scratch/segment-prompt-ab.md', import.meta.url).pathname,
  `${table.join('\n')}\n`,
  'utf8',
)
