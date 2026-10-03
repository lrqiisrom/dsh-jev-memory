/**
 * One model call that extracts the memories, against the pipeline that does it in nine steps.
 *
 * The proposal is a fair one and this script exists to answer it with a number rather than an
 * argument: it is what memsearch and TencentDB-Agent-Memory do, and it would plausibly fix the thing
 * the pipeline is worst at — the rows that carry no type signal (102 of 165) and the 8 positives
 * among them, which the deterministic rule can never see.
 *
 * Same rows, same windows, same labels, so the two are comparable:
 *   - **single call**: one request per conversation window, asking for the memories directly;
 *   - **the pipeline**: the local type whitelist and score, which is what the shipped gate reads.
 *
 * It also counts how much of the model's output matches *no* labelled row at all, which is the part
 * a person would have to read: text the model produced that nobody said.
 *
 *   node eval/single-call.ts
 *   SINGLE_LIMIT=60 node eval/single-call.ts
 *
 * Writes `.scratch/single-call.md` (private).
 *
 * @module eval/single-call
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { applyGate, heuristicRow } from '../dsh/lib/judge.ts'
import { normalizeForEcho } from '../dsh/lib/echo.ts'
import { readSessions, windowEndingAt, type Session } from './lib/sessions.ts'
import { parseCsvRecords } from './lib/csv.ts'

const labelDir = new URL('./labels/', import.meta.url).pathname
const outFile = new URL('../.scratch/single-call.md', import.meta.url).pathname
const limit = Number(process.env.SINGLE_LIMIT ?? '120') || 120
const windowSize = Number(process.env.SINGLE_WINDOW ?? '10') || 10
const endpoint = process.env.SINGLE_ENDPOINT?.trim() || 'https://api.deepseek.com/chat/completions'
const model = process.env.SINGLE_MODEL?.trim() || 'deepseek-chat'
const TYPES = ['constraint', 'pitfall', 'decision']
const GATE = { types: TYPES, minImportance: 0.6, minRemember: 0.12, reviewOnConflict: true }

/**
 * The instruction. Deliberately the best version of the proposal rather than a straw man: the
 * person's own standard, the exclusion of the model's words and of pasted text, and an explicit
 * permission to output nothing.
 */
const SYSTEM =
  '你在为一个人维护跨会话的长期记忆。给你一段真实对话，你要判断里面有哪些内容值得**长期记住**。\n' +
  '标准：换个会话、换一天，这句话还有用吗？\n' +
  '值得记的是**这个人自己**表达的东西：约定、禁忌、取舍及原因、踩过的坑、项目事实。\n' +
  '不值得记的：一次性任务指令、提问、寒暄、状态汇报、临时状态、与项目无关的闲聊、没有项目特异性的通用知识。\n' +
  '特别注意：**助手自己说的话**、以及**这个人粘贴/引用的别人的内容**，即使内容正确、即使和项目有关，也不算——记忆必须是这个人自己的主张。\n' +
  '输出：每行一条，用 `- ` 开头，**逐字摘录原文**（可以只摘其中一句，但不要改写、不要总结、不要补标点）。\n' +
  '没有值得记的就只输出 `NONE`。不要输出任何解释。'

async function credential(): Promise<string> {
  const document = await readFile(
    join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), '.credentials.yaml'),
    'utf8',
  )
  return /DEEPSEEK_API_KEY:\s*(\S+)/u.exec(document)?.[1] ?? ''
}

/** One extraction call over a window. */
async function extract(key: string, window: Array<{ role: string; text: string }>): Promise<string[]> {
  const body = window.map((message, index) => `[${index}] 角色=${message.role}\n${message.text}`).join('\n\n')
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
      max_tokens: 1200,
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = payload.choices?.[0]?.message?.content ?? ''
  if (/^\s*NONE\s*$/iu.test(text.trim())) return []
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/u, '').trim())
    .filter((line) => line !== '' && line !== 'NONE')
}

/** Whether a labelled row's text appears among the model's extracted lines. */
function kept(rowText: string, extracted: string[]): boolean {
  const needle = normalizeForEcho(rowText)
  if (needle.length < 8) return false
  // Direction matters: the model may quote a longer span that contains the row, or quote exactly it.
  return extracted.some((line) => {
    const hay = normalizeForEcho(line)
    return hay.includes(needle) || (needle.includes(hay) && hay.length >= needle.length * 0.6)
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
let extractedTotal = 0
let extraLines = 0
/** Where each extracted line's text actually came from — the question the proposal turns on. */
let fromUser = 0
let fromAssistant = 0
let fromNowhere = 0
const nowhereSamples: string[] = []
const details: string[] = []
const { matchTypeSignals } = await import('../dsh/lib/signals.ts')
const { candidateScore } = await import('../dsh/lib/extract.ts')

for (const [index, entry] of sample.entries()) {
  // One call per row, showing *that row's* window. Grouping by session and testing every row of the
  // session against the last window asked the model about sentences it had never been shown — a
  // first version did exactly that and reported 5% recall, which measured the design of the test
  // rather than the proposal.
  const window = windowEndingAt(entry.session, entry.seq, windowSize)
  if (window.length === 0 || !window.some((message) => message.seq === entry.seq)) continue
  const extracted = await extract(key, window.map((message) => ({ role: message.role, text: message.text })))
  extractedTotal += extracted.length
  process.stdout.write(`\r${index + 1}/${sample.length}`)

  // Attribution of every line the model produced: a verbatim quote of a user message, a verbatim
  // quote of an assistant message (which the prompt forbids), or neither — meaning it rewrote or
  // invented, which is the one thing the evidence layer cannot allow.
  for (const line of extracted) {
    const needle = normalizeForEcho(line)
    if (needle.length < 6) continue
    const inUser = window.some((message) => message.role === 'user' && normalizeForEcho(message.text).includes(needle))
    const inAssistant = window.some(
      (message) => message.role !== 'user' && normalizeForEcho(message.text).includes(needle),
    )
    if (inUser) fromUser += 1
    else if (inAssistant) fromAssistant += 1
    else {
      fromNowhere += 1
      if (nowhereSamples.length < 10) nowhereSamples.push(line.slice(0, 70))
    }
  }

  const keep = kept(entry.text, extracted)
  const want = entry.label === '1'
  if (keep && want) tp += 1
  else if (keep && !want) fp += 1
  else if (!keep && want) fn += 1
  // Output lines beyond the one row under test: verbosity, and the surface a person would have to
  // read. Not automatically "fabricated" — the window may genuinely contain other memories.
  extraLines += Math.max(0, extracted.length - (keep ? 1 : 0))
  details.push(`| ${entry.label} | ${keep ? '保留' : '丢掉'} | ${extracted.length} | ${entry.text.replace(/\|/gu, '\\|').slice(0, 58)} |`)
}
console.log('')

// The pipeline, on exactly the same rows: the local type signal and the local score, which is what
// the shipped gate reads. Passing `hintedType: null` here — as a first version did — types every row
// as `fact` and reports 0% for the arm that is actually running in production.
let pTp = 0
let pFp = 0
let pFn = 0
for (const entry of sample) {
  const signal = matchTypeSignals(entry.text)
  const local = heuristicRow(
    { key: entry.text, text: entry.text, hintedType: signal.type, signalScore: 0, signals: signal.hits },
    { types: TYPES },
  )
  const scored = { ...local, importance: candidateScore(entry.text) }
  const write = applyGate({ ...scored, remember: null }, GATE).write
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
const single = metrics(tp, fp, fn)
const pipeline = metrics(pTp, pFp, pFn)

const lines: string[] = ['# 一次调用直接抽记忆 vs 现在的九步流程', '']
lines.push(
  `同一批标注行 ${sample.length} 条（该记 ${sample.filter((entry) => entry.label === '1').length}）｜每行一个窗口（${windowSize} 条消息）｜同一个模型｜同一批标签`,
)
lines.push('')
lines.push('| 做法 | 写对率 | 该记覆盖率 | F1 | 抓到的正例 | 放进的负例 | 漏掉的正例 |')
lines.push('|---|---|---|---|---|---|---|')
lines.push(
  `| **一次调用直接抽** | ${(single.p * 100).toFixed(0)}% | ${(single.r * 100).toFixed(0)}% | ${single.f.toFixed(2)} | ${tp} | ${fp} | ${fn} |`,
)
lines.push(
  `| 现在的流程（本地闸门） | ${(pipeline.p * 100).toFixed(0)}% | ${(pipeline.r * 100).toFixed(0)}% | ${pipeline.f.toFixed(2)} | ${pTp} | ${pFp} | ${pFn} |`,
)
lines.push('')
lines.push(
  `模型每条行平均输出 ${(extractedTotal / Math.max(1, sample.length)).toFixed(1)} 条，其中**除被测那一行之外的 ${extraLines} 条**是要人额外读的（窗口里可能确实还有别的记忆，所以这不能直接算编造，但它就是"模型自己产出正文"的量）。`,
)
lines.push('')
lines.push('## 它输出的那些话，是谁说的')
lines.push('')
lines.push('| 来源 | 条数 | 占比 |')
lines.push('|---|---|---|')
const total = Math.max(1, fromUser + fromAssistant + fromNowhere)
lines.push(`| **逐字来自用户消息**（可接受） | ${fromUser} | ${((fromUser / total) * 100).toFixed(0)}% |`)
lines.push(`| 逐字来自助手消息（**提示词明令禁止**） | ${fromAssistant} | ${((fromAssistant / total) * 100).toFixed(0)}% |`)
lines.push(`| **两边都不是**（改写或编造，证据层不允许） | ${fromNowhere} | ${((fromNowhere / total) * 100).toFixed(0)}% |`)
lines.push('')
lines.push('「两边都不是」的样例：')
lines.push('')
for (const sample of nowhereSamples) lines.push(`- ${sample}`)
lines.push('')
lines.push('## 逐条')
lines.push('')
lines.push('| 标注 | 一次调用的判断 | 该行输出条数 | 句子 |')
lines.push('|---|---|---|---|')
lines.push(...details)

await mkdir(new URL('../.scratch/', import.meta.url).pathname, { recursive: true })
await writeFile(outFile, `${lines.join('\n')}\n`, 'utf8')
console.log(lines.slice(0, 12).join('\n'))
console.log(`\n已写出 ${outFile}`)
