/**
 * The measurement behind the `reasoningEffort: 'off'` change: thinking on vs off, on the live route.
 *
 * Three shipped calls were failing for a reason no test could see, because it is a property of the
 * route rather than of the code: the model thinks, and thinking tokens come out of the same
 * `max_tokens` budget as the answer. Two failure modes, both of which looked like a bad prompt:
 *
 *  - the budget runs out mid-answer → a half-written JSON array → the ledger said `unparsable`;
 *  - the budget runs out while thinking → no answer text at all → the ledger said `empty`.
 *
 * The live ledger before this change: `segment` 5/5 `unparsable`, `normalize` 12 lines with zero
 * successes (9 `empty`, 1 `refused`, 2 `unchanged`).
 *
 * This script replays the shipped prompts against the shipped route, over real archived windows, and
 * prints the fields the port used to discard — `finish_reason` and the reasoning character count. Run
 * with `LIVE_LIMIT=6 node eval/thinking-budget.ts`; it costs about 40 model calls.
 *
 * Two samplings are deliberate, because getting them wrong is what produced a false result once
 * already:
 *
 *  - The segmentation table uses consecutive five-message windows. The only question there is whether
 *    the call parses inside the budget, which is about size, not about who said what.
 *  - The write table anchors every window on a message the **person** wrote, which is the shape the
 *    turn-end hook builds. Slicing the archive blindly produced windows that were almost entirely the
 *    assistant's own text (this archive is 7 user messages to 36 assistant ones), the model answered
 *    `who: assistant` for every span — correctly — and it read as "the write path finds nothing".
 *
 * Not a quality measurement. Whether the model's picks are *right* is `eval/one-call-judge.ts`, and
 * that one ran on `deepseek-chat`; see the README for the gap this leaves.
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildSegmentPrompt, explainSegments, SEGMENT_DEFAULTS, SEGMENT_SYSTEM } from '../dsh/lib/segment.ts'
import { explainModelWrite, MODEL_WRITE_SYSTEM, WRITE_TYPES } from '../dsh/lib/modelwrite.ts'
import { NORMALIZE_SYSTEM } from '../dsh/lib/normalize.ts'

const endpoint = process.env.LIVE_ENDPOINT?.trim() || 'https://api.deepseek.com/chat/completions'
/** The route the plugin is handed on the machine this was developed against. */
const model = process.env.LIVE_MODEL?.trim() || 'deepseek-flash'
const limit = Number(process.env.LIVE_LIMIT ?? '6')

if (process.env.DSH_LIVE_ROUTE !== 'yes') {
  console.log('refusing to run: this makes real model calls. Set DSH_LIVE_ROUTE=yes to continue.')
  process.exit(0)
}

const credential = await readFile(
  join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), '.credentials.yaml'),
  'utf8',
)
const key = /DEEPSEEK_API_KEY:\s*(\S+)/u.exec(credential)?.[1] ?? ''
if (key === '') throw new Error('DEEPSEEK_API_KEY is not in the credential document')

/** One call, with the two fields the shipped port discards. */
async function ask(
  system: string,
  user: string,
  maxTokens: number,
  thinking: boolean,
): Promise<{ ms: number; finish: string; reasoning: number; content: string }> {
  const started = Date.now()
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      ...(thinking ? {} : { thinking: { type: 'disabled' } }),
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const payload = (await response.json()) as Record<string, any>
  const choice = payload.choices?.[0]
  return {
    ms: Date.now() - started,
    finish: String(choice?.finish_reason ?? 'unknown'),
    reasoning: Number(payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
    content: String(choice?.message?.content ?? ''),
  }
}

/** Median, and the worst case, because the budget is a tail question. */
function spread(values: readonly number[]): string {
  const sorted = [...values].sort((left, right) => left - right)
  return `median ${sorted[Math.floor(sorted.length / 2)]}ms, max ${sorted[sorted.length - 1]}ms`
}

// The archived turns are the only real windows available offline: the store keeps every message,
// including the ones the write gate refused, which is exactly the corpus this needs.
const archiveDir = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'jev-memory', 'l0')
const files = (await readdir(archiveDir)).filter((name) => name.endsWith('.jsonl')).sort()
const all: Array<{ role: string; text: string }> = []
for (const file of files) {
  for (const line of (await readFile(join(archiveDir, file), 'utf8')).trim().split('\n')) {
    if (line.trim() === '') continue
    const entry = JSON.parse(line) as { role?: string; text?: string }
    if (typeof entry.text === 'string' && entry.text.trim() !== '') all.push({ role: entry.role ?? 'user', text: entry.text })
  }
}
const roles = all.reduce<Record<string, number>>((counts, entry) => {
  counts[entry.role] = (counts[entry.role] ?? 0) + 1
  return counts
}, {})
console.log(`archived messages: ${all.length} ${JSON.stringify(roles)}`)
if (all.length < 6) throw new Error('not enough archived messages to build windows')

const consecutive: Array<Array<{ role: string; text: string }>> = []
for (let at = 0; at + 5 <= all.length; at += 4) consecutive.push(all.slice(at, at + 5))
const anchored = all
  .map((entry, at) => ({ entry, at }))
  .filter(({ entry }) => entry.role === 'user')
  .map(({ at }) => all.slice(Math.max(0, at - 4), at + 1))

console.log('\n## segmentation (the shipped prompt, 2500-token budget)')
for (const thinking of [false, true]) {
  let ok = 0
  const times: number[] = []
  const outcomes: string[] = []
  for (const window of consecutive.slice(0, limit)) {
    const messages = window.map((entry, index) => ({ seq: index, role: entry.role, text: entry.text }))
    const answer = await ask(SEGMENT_SYSTEM, buildSegmentPrompt(messages), 2500, thinking)
    const explained = explainSegments(answer.content, messages, SEGMENT_DEFAULTS)
    if (explained.segments) ok += 1
    outcomes.push(`${explained.reason}/${answer.finish}`)
    times.push(answer.ms)
  }
  console.log(`thinking ${thinking ? 'on ' : 'off'}: ${ok}/${times.length} valid, ${spread(times)}`)
  console.log(`  ${outcomes.join('  ')}`)
}

console.log('\n## the write call (the shipped prompt, 1500-token budget)')
for (const thinking of [false, true]) {
  let kept = 0
  const counts: number[] = []
  const times: number[] = []
  const truncated: string[] = []
  for (const window of anchored.slice(0, limit)) {
    const body = window.map((entry, at) => `[${at}] 角色=${entry.role}\n${entry.text}`).join('\n\n')
    const answer = await ask(MODEL_WRITE_SYSTEM, `以下是一段对话：\n\n${body}`, 1500, thinking)
    const messages = window.map((entry, at) => ({ seq: at, role: entry.role, text: entry.text }))
    const decided = explainModelWrite(answer.content, messages)
    const writeable = (decided.items ?? []).filter(
      (item) => item.who === 'user' && item.worth && (WRITE_TYPES as readonly string[]).includes(item.type),
    )
    kept += writeable.length
    counts.push(decided.items?.length ?? -1)
    if (answer.finish === 'length') truncated.push(`${answer.ms}ms`)
    times.push(answer.ms)
  }
  console.log(
    `thinking ${thinking ? 'on ' : 'off'}: ${kept} writeable, ${spread(times)}, truncated ${truncated.length}/${times.length}`,
  )
  console.log(`  items per window (-1 = unusable answer): ${counts.join(', ')}`)
}

console.log('\n## the canonical form (the shipped prompt, 400-token budget)')
const sentences = [
  '必须用 pnpm 管理依赖，这是团队约定。',
  '语言不要选 java，DSH 的 java native 插件方案不考虑。',
  '另外把 git 仓库链接也带上，简历中不要带 memory.json。',
  '这个报错是因为 writeTimeoutMs 太小，分段调用被整轮放弃了。',
]
for (const thinking of [false, true]) {
  let nonEmpty = 0
  const times: number[] = []
  for (const sentence of sentences) {
    const answer = await ask(NORMALIZE_SYSTEM, sentence, 400, thinking)
    if (answer.content.trim() !== '') nonEmpty += 1
    times.push(answer.ms)
  }
  console.log(`thinking ${thinking ? 'on ' : 'off'}: ${nonEmpty}/${sentences.length} non-empty, ${spread(times)}`)
}
