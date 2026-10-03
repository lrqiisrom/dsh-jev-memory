/**
 * One call that does all of it: boundaries, attribution, worthiness and type — with the text taken
 * from the original rather than written by the model.
 *
 * This is the proposal, minus the one part that cannot be given up. The model still reads the whole
 * window and does every semantic judgement in a single request; what it is *not* allowed to do is
 * produce the sentence that gets stored. It returns a verbatim span, we slice it out, and the memory
 * is byte-identical to something the person wrote.
 *
 * Why the distinction was worth an experiment rather than a rule: measuring the same idea without it
 * — the model writing the memory text — tied the pipeline on accuracy (F1 0.37 both) while 22% of its
 * output was not verbatim anyone's words, including one substitution that changed what the memory
 * said (继承 → 集成). Same accuracy, and the evaluation's premise gone.
 *
 * Decision rule per labelled row, identical in shape to the pipeline's:
 *   written ⇔ some accepted item has who=user, worth=true, type ∈ {constraint,pitfall,decision},
 *             and its span covers this row (normalised containment, either direction).
 *
 *   node eval/one-call-judge.ts
 *   ONE_LIMIT=120 node eval/one-call-judge.ts
 *
 * Writes `.scratch/one-call-judge.md` (private).
 *
 * @module eval/one-call-judge
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { applyGate, heuristicRow } from '../dsh/lib/judge.ts'
import { normalizeForEcho } from '../dsh/lib/echo.ts'
import { candidateScore } from '../dsh/lib/extract.ts'
import { matchTypeSignals } from '../dsh/lib/signals.ts'
import { readSessions, windowEndingAt, type Session } from './lib/sessions.ts'
import { parseCsvRecords } from './lib/csv.ts'

const labelDir = new URL('./labels/', import.meta.url).pathname
const outFile = new URL('../.scratch/one-call-judge.md', import.meta.url).pathname
const limit = Number(process.env.ONE_LIMIT ?? '120') || 120
const windowSize = Number(process.env.ONE_WINDOW ?? '10') || 10
const endpoint = process.env.ONE_ENDPOINT?.trim() || 'https://api.deepseek.com/chat/completions'
const model = process.env.ONE_MODEL?.trim() || 'deepseek-chat'
const TYPES = ['constraint', 'pitfall', 'decision']
const WHO = ['user', 'pasted', 'quoted', 'tool-output', 'assistant']
const GATE = { types: TYPES, minImportance: 0.6, minRemember: 0.12, reviewOnConflict: true }

const SYSTEM =
  '你在为一个人维护跨会话的长期记忆。下面是一段真实对话，每条消息前面有编号和角色。\n' +
  '请找出其中**值得长期记住**的片段。判断标准：换个会话、换一天，这段内容还有用吗？\n' +
  '值得记的是**这个人自己**表达的、以后仍然适用的内容：约定、禁忌、取舍及原因、踩过的坑、项目事实。\n' +
  '不值得记的：一次性任务指令、提问、寒暄、状态汇报、临时状态、与项目无关的闲聊、没有项目特异性的通用常识。\n' +
  '注意：用户消息里可能混着**他粘贴或引用的别人的内容、模型自己的回答**——那些不算他说的。\n' +
  '输出一个 JSON 数组，每项形如：\n' +
  '{"message": 0, "text": "就用刚才那个项目。", "who": "user", "worth": true, "type": "decision"}\n' +
  '字段含义：\n' +
  '- `message`：消息编号\n' +
  '- `text`：**必须是那条消息里一字不差的原文片段**（直接复制，不要改写、不要补标点、不要翻译、不要省略口水词）。\n' +
  '  **不要输出字符下标**，也不要输出你自己写的句子。\n' +
  `- \`who\`：只能是 ${WHO.join(' / ')} 之一\n` +
  '- `worth`：true / false，只在这是这个人自己的长期主张时为 true\n' +
  `- \`type\`：只能是 ${[...TYPES, 'other'].join(' / ')} 之一\n` +
  '只输出 JSON 数组，不要任何解释。没有值得记的就输出 []。'

/** One item the model returned, after validation. */
interface Item {
  messageIndex: number
  text: string
  who: string
  worth: boolean
  type: string
}

async function credential(): Promise<string> {
  const document = await readFile(
    join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), '.credentials.yaml'),
    'utf8',
  )
  return /DEEPSEEK_API_KEY:\s*(\S+)/u.exec(document)?.[1] ?? ''
}

/**
 * Validate one model answer against the messages it was given.
 *
 * The verbatim requirement is the whole point: an item whose text is not in the message it names is
 * the model writing the memory, which is the failure this design exists to avoid.
 *
 * @param raw - the model's text.
 * @param messages - the window.
 * @returns the accepted items and the rejection tally.
 */
function validate(
  raw: string,
  messages: ReadonlyArray<{ role: string; text: string }>,
): { items: Item[]; rejected: Record<string, number> } {
  const rejected: Record<string, number> = {}
  const bump = (reason: string): void => {
    rejected[reason] = (rejected[reason] ?? 0) + 1
  }
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) {
    bump('unparsable')
    return { items: [], rejected }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    bump('unparsable')
    return { items: [], rejected }
  }
  if (!Array.isArray(parsed)) {
    bump('unparsable')
    return { items: [], rejected }
  }
  const items: Item[] = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') {
      bump('shape')
      continue
    }
    const item = entry as Record<string, unknown>
    const messageIndex = Number(item.message)
    const text = typeof item.text === 'string' ? item.text : ''
    const who = String(item.who ?? '')
    const type = String(item.type ?? '')
    const message = messages[messageIndex]
    if (!message) {
      bump('out-of-range')
      continue
    }
    if (!WHO.includes(who)) {
      bump('unknown-who')
      continue
    }
    if (text.trim() === '' || !message.text.includes(text)) {
      bump('not-verbatim')
      continue
    }
    items.push({ messageIndex, text, who, worth: item.worth === true, type })
  }
  return { items, rejected }
}

/** Whether an accepted item covers this row. */
function covered(rowText: string, items: readonly Item[]): boolean {
  const needle = normalizeForEcho(rowText)
  if (needle.length < 8) return false
  return items.some((item) => {
    const hay = normalizeForEcho(item.text)
    return item.who === 'user' && item.worth && TYPES.includes(item.type) && (hay.includes(needle) || needle.includes(hay))
  })
}

// ---------------------------------------------------------------------------------------------
const byId = new Map<string, { text: string; label: string }>()
for (const name of (await readdir(labelDir)).filter((entry) => /^round\d+\.csv$/u.test(entry)).sort()) {
  for (const record of parseCsvRecords(await readFile(join(labelDir, name), 'utf8'))) {
    const label = (record.label ?? '').trim()
    if (label !== '1' && label !== '0') continue
    const id = (record.id ?? '').trim()
    if (id !== '' && !byId.has(id)) byId.set(id, { text: record.text ?? '', label })
  }
}
const sessions = await readSessions()
const located: Array<{ session: Session; seq: number; text: string; label: string }> = []
for (const session of sessions) {
  for (const [key, seq] of session.keyToSeq) {
    const row = byId.get(key)
    if (row) located.push({ session, seq, text: row.text, label: row.label })
  }
}
const sample = located.slice(0, limit)
console.log(`已定行 ${byId.size} 条，定位到 ${located.length} 条，取前 ${sample.length} 条（该记 ${sample.filter((entry) => entry.label === '1').length}）`)

const key = await credential()
if (key === '') throw new Error('DEEPSEEK_API_KEY is not in the credential document')

let tp = 0
let fp = 0
let fn = 0
let itemsTotal = 0
let worthTrue = 0
const rejections: Record<string, number> = {}
const details: string[] = []

for (const [index, entry] of sample.entries()) {
  const window = windowEndingAt(entry.session, entry.seq, windowSize)
  if (window.length === 0 || !window.some((message) => message.seq === entry.seq)) continue
  const body = window.map((message, at) => `[${at}] 角色=${message.role}\n${message.text}`).join('\n\n')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `以下是一段对话：\n\n${body}` },
      ],
      temperature: 0,
      max_tokens: 1500,
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const raw = payload.choices?.[0]?.message?.content ?? ''
  const { items, rejected } = validate(raw, window.map((message) => ({ role: message.role, text: message.text })))
  for (const [reason, count] of Object.entries(rejected)) rejections[reason] = (rejections[reason] ?? 0) + count
  itemsTotal += items.length
  worthTrue += items.filter((item) => item.who === 'user' && item.worth).length
  process.stdout.write(`\r${index + 1}/${sample.length}`)

  const keep = covered(entry.text, items)
  const want = entry.label === '1'
  if (keep && want) tp += 1
  else if (keep && !want) fp += 1
  else if (!keep && want) fn += 1
  details.push(`| ${entry.label} | ${keep ? '保留' : '丢掉'} | ${items.filter((i) => i.who === 'user' && i.worth).length} | ${entry.text.replace(/\|/gu, '\\|').slice(0, 56)} |`)
}
console.log('')

let pTp = 0
let pFp = 0
let pFn = 0
for (const entry of sample) {
  const signal = matchTypeSignals(entry.text)
  const local = heuristicRow(
    { key: entry.text, text: entry.text, hintedType: signal.type, signalScore: 0, signals: signal.hits },
    { types: TYPES },
  )
  const write = applyGate({ ...local, importance: candidateScore(entry.text), remember: null }, GATE).write
  const want = entry.label === '1'
  if (write && want) pTp += 1
  else if (write && !want) pFp += 1
  else if (!write && want) pFn += 1
}

const metrics = (a: number, b: number, c: number): { p: number; r: number; f: number } => {
  const precision = a + b === 0 ? 0 : a / (a + b)
  const recall = a + c === 0 ? 0 : a / (a + c)
  return { p: precision, r: recall, f: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) }
}
const one = metrics(tp, fp, fn)
const pipeline = metrics(pTp, pFp, pFn)
const positives = sample.filter((entry) => entry.label === '1').length

const lines: string[] = ['# 一次调用做完全部判断，但正文取自原文', '']
lines.push(
  `同一批标注行 ${sample.length} 条（该记 ${positives}）｜每行一个窗口（${windowSize} 条消息）｜同一个模型、同一批标签`,
)
lines.push('')
lines.push('| 做法 | 写对率 | 该记覆盖率 | F1 | 抓到的正例 | 放进的负例 | 漏掉的正例 |')
lines.push('|---|---|---|---|---|---|---|')
lines.push(
  `| **一次调用（判断+位置，正文取自原文）** | ${(one.p * 100).toFixed(0)}% | ${(one.r * 100).toFixed(0)}% | ${one.f.toFixed(2)} | ${tp} | ${fp} | ${fn} |`,
)
lines.push(
  `| 现在的流程（筛子 + 类型信号 + 闸门） | ${(pipeline.p * 100).toFixed(0)}% | ${(pipeline.r * 100).toFixed(0)}% | ${pipeline.f.toFixed(2)} | ${pTp} | ${pFp} | ${pFn} |`,
)
lines.push('')
lines.push(`模型每个窗口平均返回 ${(itemsTotal / Math.max(1, sample.length)).toFixed(1)} 项，其中 who=user 且 worth=true 的 ${(worthTrue / Math.max(1, sample.length)).toFixed(1)} 项。`)
lines.push('')
lines.push('## 校验拒收的原因分布')
lines.push('')
for (const [reason, count] of Object.entries(rejections).sort((left, right) => right[1] - left[1])) {
  lines.push(`- \`${reason}\`：${count}`)
}
if (Object.keys(rejections).length === 0) lines.push('-（没有拒收）')
lines.push('')
lines.push('## 逐条')
lines.push('')
lines.push('| 标注 | 判断 | 该窗口 worth 项数 | 句子 |')
lines.push('|---|---|---|---|')
lines.push(...details)

await mkdir(new URL('../.scratch/', import.meta.url).pathname, { recursive: true })
await writeFile(outFile, `${lines.join('\n')}\n`, 'utf8')
console.log(lines.slice(0, 14).join('\n'))
console.log(`\n已写出 ${outFile}`)
