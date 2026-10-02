/**
 * Does Jev judge a cleaned sentence better than the raw one?
 *
 * The question is worth a measurement because it decides an architecture. Cleaning currently runs
 * *after* the write decision, on records that were already accepted — so it can make injection
 * nicer but cannot inform the judgement. If Jev scores a cleaned sentence markedly better, the
 * async pass should clean first and judge second; if it does not, the idea is dropped with evidence
 * instead of being built on a hunch.
 *
 * Paired design on purpose: the same label, the same sentence, two renderings, so the only
 * difference between the two arms is the text the judge reads. Unpaired comparisons across runs
 * would be swamped by the judge's own run-to-run variance, which is how "the numbers moved" gets
 * mistaken for "the change worked".
 *
 *   TYPESAFE_API_KEY=... node eval/judge-rendering.ts
 *   RENDERING_LIMIT=40 node eval/judge-rendering.ts
 *
 * Writes `.scratch/judge-rendering.md`, gitignored because the sentences are private.
 *
 * @module eval/judge-rendering
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createJevClient, type JevCandidate } from '../dsh/lib/jev.ts'
import { createJudge, type Judgement } from '../dsh/lib/judge.ts'
import { buildNormalizePrompt, explainCanonical, NORMALIZE_SYSTEM, NORMALIZE_DEFAULTS } from '../dsh/lib/normalize.ts'
import { parseCsvRecords } from './lib/csv.ts'

const batch = process.env.RENDERING_BATCH?.trim() || 'round5.csv'
const limit = Number(process.env.RENDERING_LIMIT ?? '40') || 40
const labelDir = new URL('./labels/', import.meta.url).pathname
const outFile = new URL('../.scratch/judge-rendering.md', import.meta.url).pathname
const endpoint = process.env.RENDERING_ENDPOINT?.trim() || 'https://api.deepseek.com/chat/completions'
const model = process.env.RENDERING_MODEL?.trim() || 'deepseek-chat'
const TYPES = ['constraint', 'pitfall', 'decision']
const CREDENTIALS = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), '.credentials.yaml')

/** One credential out of the document the plugin itself falls back to. */
async function credential(name: string): Promise<string> {
  const document = await readFile(CREDENTIALS, 'utf8')
  const match = new RegExp(`${name}:\\s*(\\S+)`, 'u').exec(document)
  if (!match?.[1]) throw new Error(`${name} is not in the credential document`)
  return match[1]
}

/** The canonical form of one sentence, through the plugin's own prompt and gate. */
async function canonical(key: string, text: string): Promise<{ text: string; reason: string }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: NORMALIZE_SYSTEM },
        { role: 'user', content: buildNormalizePrompt(text) },
      ],
      temperature: 0,
      max_tokens: 400,
    }),
  })
  if (!response.ok) return { text, reason: `http-${response.status}` }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const decided = explainCanonical(text, body.choices?.[0]?.message?.content ?? '', NORMALIZE_DEFAULTS)
  // A refusal keeps the original, which is the plugin's behaviour too: fail-open means "keep the
  // sentence", never "keep what the model guessed".
  return decided.text === null ? { text, reason: decided.reason } : { text: decided.text, reason: 'ok' }
}

/** Ask the judge about one rendering of the rows, in the plugin's own batches. */
async function judgeAll(judge: ReturnType<typeof createJudge>, entries: Array<{ id: string; text: string }>): Promise<Map<string, Judgement>> {
  const out = new Map<string, Judgement>()
  for (let start = 0; start < entries.length; start += 6) {
    const slice = entries.slice(start, start + 6)
    const candidates: JevCandidate[] = slice.map((entry) => ({
      key: entry.id,
      text: entry.text,
      hintedType: null,
      signalScore: 0.5,
      signals: [],
    }))
    const result = await judge.judge(candidates, { known: [], project: null })
    for (const row of result.rows) out.set(row.key, row)
  }
  return out
}

const rows = parseCsvRecords(await readFile(join(labelDir, batch), 'utf8'))
const decided = rows.filter((row) => (row.label ?? '').trim() === '1' || (row.label ?? '').trim() === '0')
// Deterministic selection: every positive, then negatives in file order until the limit.
const positives = decided.filter((row) => row.label === '1')
const negatives = decided.filter((row) => row.label === '0')
const selected = [...positives, ...negatives.slice(0, Math.max(0, limit - positives.length))]

console.log(`批次 ${batch}：${selected.length} 条（该记 ${positives.length}）`)

const deepseek = await credential('DEEPSEEK_API_KEY')
const typesafe = await credential('TYPESAFE_API_KEY')
const jev = createJevClient({ config: { maxCandidates: 6 }, env: { ...process.env, TYPESAFE_API_KEY: typesafe } })
if (!(await jev.isAvailable())) throw new Error('jev is not reachable with the credential document key')
const judge = createJudge({ config: { judge: 'jev', types: TYPES, judgeTimeoutMs: 20_000 }, jev })

interface Item {
  id: string
  label: string
  raw: string
  cleaned: string
  reason: string
  rawScore: number | null
  cleanedScore: number | null
  rawType: string
  cleanedType: string
}

const items: Item[] = []
for (const [index, row] of selected.entries()) {
  const text = row.text ?? ''
  const id = (row.id ?? `r${index}`).trim()
  const result = await canonical(deepseek, text)
  items.push({ id, label: row.label!, raw: text, cleaned: result.text, reason: result.reason, rawScore: null, cleanedScore: null, rawType: '—', cleanedType: '—' })
  process.stdout.write(`\r规范化 ${index + 1}/${selected.length}`)
}
console.log('')

// Two arms, one run each: the pairing is what makes the comparison readable, not repetition.
const rawRows = await judgeAll(judge, items.map((item) => ({ id: `raw:${item.id}`, text: item.raw })))
const cleanedRows = await judgeAll(judge, items.map((item) => ({ id: `clean:${item.id}`, text: item.cleaned })))
for (const item of items) {
  const raw = rawRows.get(`raw:${item.id}`)
  const cleaned = cleanedRows.get(`clean:${item.id}`)
  item.rawScore = raw?.remember ?? null
  item.cleanedScore = cleaned?.remember ?? null
  item.rawType = raw?.type ?? '—'
  item.cleanedType = cleaned?.type ?? '—'
}

/** AUC over one arm's scores. */
const auc = (arm: 'rawScore' | 'cleanedScore'): number | null => {
  const pos = items.filter((item) => item.label === '1').map((item) => item[arm]).filter((value): value is number => typeof value === 'number')
  const neg = items.filter((item) => item.label === '0').map((item) => item[arm]).filter((value): value is number => typeof value === 'number')
  if (pos.length === 0 || neg.length === 0) return null
  let wins = 0
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0
  return wins / (pos.length * neg.length)
}
const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
const scores = (label: string, arm: 'rawScore' | 'cleanedScore'): number[] =>
  items.filter((item) => item.label === label).map((item) => item[arm]).filter((value): value is number => typeof value === 'number')

const lines: string[] = ['# Jev 读原句 vs 读规范化后的句子', '']
lines.push(`批次 ${batch}｜${items.length} 条（该记 ${positives.length}）｜配对实验：同一句、同一模型、两种渲染`)
lines.push('')
lines.push('| 渲染 | 该记的中位分 | 不该记的中位分 | AUC | 该记里 ≥0.12 的 | 该记里判成三类 |')
lines.push('|---|---|---|---|---|---|')
for (const [name, arm] of [['原句', 'rawScore'], ['规范化后', 'cleanedScore']] as const) {
  const pos = scores('1', arm)
  const neg = scores('0', arm)
  const hits = items.filter((item) => item.label === '1' && (item[arm] ?? 0) >= 0.12).length
  const typed = items.filter((item) => item.label === '1' && TYPES.includes(arm === 'rawScore' ? item.rawType : item.cleanedType)).length
  lines.push(
    `| ${name} | ${median(pos).toFixed(2)} | ${median(neg).toFixed(2)} | ${auc(arm)?.toFixed(2) ?? '—'} | ${hits}/${pos.length} | ${typed}/${pos.length} |`,
  )
}
lines.push('')
const improved = items.filter((item) => (item.cleanedScore ?? 0) > (item.rawScore ?? 0) + 0.01).length
const worsened = items.filter((item) => (item.cleanedScore ?? 0) < (item.rawScore ?? 0) - 0.01).length
const same = items.length - improved - worsened
lines.push(`分数变化：变高 ${improved} 条｜变低 ${worsened} 条｜基本不动 ${same} 条`)
lines.push('')
const reasons = new Map<string, number>()
for (const item of items) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1)
lines.push(`规范化结果：${[...reasons.entries()].map(([reason, count]) => `${reason} ${count}`).join('、')}`)
lines.push('')
lines.push('## 逐条')
lines.push('')
lines.push('| 标注 | 原句分 | 规范化后分 | 原句 | 规范化后 |')
lines.push('|---|---|---|---|---|')
for (const item of items) {
  const cell = (value: string): string => value.replace(/\|/gu, '\\|').slice(0, 70)
  lines.push(
    `| ${item.label} | ${(item.rawScore ?? 0).toFixed(2)} | ${(item.cleanedScore ?? 0).toFixed(2)} | ${cell(item.raw)} | ${cell(item.cleaned)} |`,
  )
}

await mkdir(new URL('../.scratch/', import.meta.url).pathname, { recursive: true })
await writeFile(outFile, `${lines.join('\n')}\n`, 'utf8')
console.log(lines.slice(0, 14).join('\n'))
console.log(`\n已写出 ${outFile}`)
