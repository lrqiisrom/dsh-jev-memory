/**
 * What the segmenter would do to real conversation windows, before it is switched on.
 *
 * The canonical pass was reviewed this way and stayed off until a person had read samples; the
 * segmenter gets the same treatment. It reads real DSH session logs, builds the window a turn would
 * see (the last N messages, oldest first), and prints the model's units next to the deterministic
 * split. The interesting lines are the ones where it finds a `pasted` or `quoted` span, because
 * those are the cases no punctuation rule can see.
 *
 *   SAMPLES_LIMIT=20 node eval/segment-samples.ts
 *   SEGMENT_WINDOW=5 node eval/segment-samples.ts
 *
 * Writes `.scratch/segment-samples.md` (gitignored: the sessions are private) and prints a summary.
 *
 * @module eval/segment-samples
 */

import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { splitSentences } from '../dsh/lib/text.ts'
import { createSegmenter, SEGMENT_DEFAULTS, type SegmentMessage } from '../dsh/lib/segment.ts'
import type { LlmStreamPort } from '../dsh/lib/normalize.ts'

const limit = Number(process.env.SAMPLES_LIMIT ?? '20') || 20
const windowSize = Number(process.env.SEGMENT_WINDOW ?? String(SEGMENT_DEFAULTS.window)) || 5
const maxSessions = Number(process.env.SAMPLES_SESSIONS ?? '12') || 12
const endpoint = process.env.SAMPLES_ENDPOINT?.trim() || 'https://api.deepseek.com/chat/completions'
const model = process.env.SAMPLES_MODEL?.trim() || 'deepseek-chat'
const outFile = new URL('../.scratch/segment-samples.md', import.meta.url).pathname

/** The bearer token, from the same document the plugin falls back to. */
async function apiKey(): Promise<string> {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const document = await readFile(join(home, '.credentials.yaml'), 'utf8')
  const match = /DEEPSEEK_API_KEY:\s*(\S+)/u.exec(document)
  if (!match?.[1]) throw new Error('DEEPSEEK_API_KEY is not in the credential document')
  return match[1]
}

/** The harness's `llm` port, spoken to over HTTP because a script has no host context. */
function httpPort(key: string): LlmStreamPort {
  return {
    async *stream(options): AsyncIterable<{ type: string; text?: string }> {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: options.system ?? '' },
            { role: 'user', content: options.messages[0]?.content?.[0]?.text ?? '' },
          ],
          temperature: 0,
          max_tokens: options.maxTokens ?? 1200,
        }),
        signal: options.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      yield { type: 'text-delta', text: body.choices?.[0]?.message?.content ?? '' }
      yield { type: 'finish' }
    },
  }
}

/** Read one multi-frame zstd log through the CLI the harvester already depends on. */
function readLog(path: string): string {
  const result = spawnSync('zstdcat', [path], { maxBuffer: 1024 * 1024 * 512, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout ?? '') : ''
}

/** The newest session logs, one per session directory. */
async function sessionFiles(): Promise<string[]> {
  const root = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sessions')
  const found: Array<{ file: string; at: number }> = []
  for (const workspace of await readdir(root)) {
    let ids: string[] = []
    try {
      ids = await readdir(join(root, workspace))
    } catch {
      continue
    }
    for (const id of ids) {
      const dir = join(root, workspace, id)
      let entries: string[] = []
      try {
        entries = await readdir(dir)
      } catch {
        continue
      }
      const logs = entries.filter((name) => name.startsWith('session') && name.endsWith('.jsonl.zstd')).sort()
      const best = logs[logs.length - 1]
      if (!best) continue
      const stat = spawnSync('stat', ['-f', '%m', join(dir, best)], { encoding: 'utf8' })
      found.push({ file: join(dir, best), at: Number(String(stat.stdout ?? '0').trim()) || 0 })
    }
  }
  return found.sort((left, right) => right.at - left.at).slice(0, maxSessions).map((entry) => entry.file)
}

/** Every message of one session, in order. */
function messagesOf(raw: string): SegmentMessage[] {
  const out: SegmentMessage[] = []
  let seq = 0
  for (const line of raw.split('\n')) {
    if (line === '') continue
    let event: { type?: string; data?: unknown }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const data = event.data as {
      source?: { kind?: string }
      content?: unknown
      message?: { content?: unknown }
    } | null
    const textOf = (content: unknown): string =>
      Array.isArray(content)
        ? content
            .map((block) => (block as { type?: string; text?: string })?.type === 'text' ? String((block as { text?: string }).text ?? '') : '')
            .join('\n')
            .trim()
        : ''
    if (event.type === 'user/message') {
      // Every `user/message`, whatever its `source.kind`: the archive keeps them all, and the
      // window should show the model what actually arrived. Filtering on `kind === 'user'` here
      // is what made two of four sampled windows contain no user text at all — the kind is also
      // `session-reference` and others. The real shape, verified against a live log:
      // `{ type: 'user/message', seq, time, data: { content: [...], source: { kind }, role, id } }`.
      const text = textOf(data?.content)
      const kind = data?.source?.kind
      if (text !== '') out.push({ seq, role: typeof kind === 'string' && kind !== '' ? kind : 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = textOf(data?.message?.content)
      if (text !== '') out.push({ seq, role: 'assistant', text })
    }
    seq += 1
  }
  return out
}

const key = await apiKey()
const segmenter = createSegmenter({
  llm: httpPort(key),
  settings: { ...SEGMENT_DEFAULTS, enabled: true },
  resolveRoute: async () => ({ provider: 'deepseek', model }),
})

const lines: string[] = ['# 分段抽样：模型切出来的边界与归属', '']
const reasons = new Map<string, number>()
let windows = 0
let pasted = 0
let quoted = 0
let changed = 0

for (const file of await sessionFiles()) {
  if (windows >= limit) break
  const raw = readLog(file)
  // Child sessions are skipped: their "user" message is the parent agent's own prompt, so asking a
  // model to segment them would be judging words the person never wrote. Same rule as the harvester.
  try {
    const head: unknown = JSON.parse(raw.slice(0, raw.indexOf('\n')))
    if (((head as { delegationDepth?: number } | null)?.delegationDepth ?? 0) > 0) continue
  } catch {
    /* a log without a readable header is treated as a normal session */
  }
  const messages = messagesOf(raw)
  if (messages.length < 2) continue
  // One window per session, at the newest end: that is what the next turn would see.
  const window = messages.slice(-windowSize)
  // A window with no user text is not a refusal: there is nothing to segment, and the model is
  // right to return nothing. Counting those as failures would make the refusal rate meaningless.
  if (!window.some((message) => message.role === 'user')) continue
  windows += 1
  const result = await segmenter.segment(window)
  const reason = segmenter.lastReason()
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  lines.push(`<!-- lastReason=${reason} -->`)
  lines.push(`## 窗口 ${windows}｜${window.length} 条消息｜判定：${reason}`)
  lines.push('')
  lines.push('**确定性切句（现状）**')
  for (const message of window) {
    if (message.role !== 'user') continue
    for (const sentence of splitSentences(message.text)) lines.push(`- [user] ${sentence}`)
  }
  if (!window.some((message) => message.role === 'user')) lines.push('-（这个窗口里没有真实用户消息，只有注入的上下文，跳过比较）')
  lines.push('')
  if (result === null) {
    lines.push('模型没给出可用的分段（回退到确定性切句）。')
    lines.push('')
    continue
  }
  lines.push(`**模型的切分**（覆盖 ${(result.coverage * 100).toFixed(0)}%）`)
  const deterministic = new Set(
    window.filter((message) => message.role === 'user').flatMap((message) => splitSentences(message.text)),
  )
  for (const segment of result.segments) {
    const message = window[segment.messageIndex]!
    const text = message.text.slice(segment.start, segment.end)
    if (segment.attribution === 'pasted') pasted += 1
    if (segment.attribution === 'quoted') quoted += 1
    if (segment.attribution === 'user' && !deterministic.has(text)) changed += 1
    lines.push(`- [${segment.attribution}] ${text}`)
  }
  lines.push('')
}

lines.push('## 汇总')
lines.push('')
lines.push(`- 窗口数：${windows}`)
lines.push(`- 判定分布：${[...reasons.entries()].map(([reason, count]) => `${reason} ${count}`).join('、')}`)
lines.push(`- 标为 \`pasted\` 的片段：${pasted}｜标为 \`quoted\` 的片段：${quoted}`)
lines.push(`- 与确定性切句不同、且归为用户的片段：${changed}`)
lines.push('')
lines.push('**怎么读**：`pasted` / `quoted` 是正则看不见的两类——它们正是"用户把模型的输出粘进自己的消息"')
lines.push('这种情况。判定分布里的 `low-coverage` 表示模型漏掉了太多内容，被拒绝（宁可回退，也不接受静默丢失）。')

await mkdir(new URL('../.scratch/', import.meta.url).pathname, { recursive: true })
await writeFile(outFile, `${lines.join('\n')}\n`, 'utf8')
console.log(lines.slice(-9).join('\n'))
console.log(`\n已写出 ${outFile}`)
