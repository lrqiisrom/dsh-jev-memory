/**
 * Does giving the judge the surrounding conversation, and a better question, improve it?
 *
 * The labelled corpus says the write side misses half of what should be remembered, and that the
 * misses cluster in one class: sentences that carry no type signal (113 of 200 rows), of which 8
 * of the 21 positives are marked "remember". They are judgements — "我觉得…应该…不合理" — not
 * imperatives, and they cannot be recognised by a regex or, apparently, from one sentence alone.
 * A person reading them has something the judge does not: what was being discussed.
 *
 * So this is a three-arm experiment on the same sentences, paired so the only difference is what
 * the judge is shown:
 *
 *   A. the sentence alone, the shipped question          (the baseline the plugin runs today)
 *   B. the sentence inside its five-message window, same question
 *   C. the window, with a question that tells the judge to use it
 *
 * Arms B and C separate two explanations for a null result: the context does not help, or the
 * question never told the model to look at it.
 *
 *   node eval/judge-context.ts
 *   CONTEXT_LIMIT=60 node eval/judge-context.ts
 *
 * Windows are reconstructed by scanning the session logs and reproducing the extractor's ids — the
 * labelled CSVs predate the `session_id`/`seq` columns, so the join has to be rebuilt from the
 * sessions themselves. Writes `.scratch/judge-context.md` (private).
 *
 * @module eval/judge-context
 */

import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { EXTRACT_DEFAULTS, extractCandidates } from '../dsh/lib/extract.ts'
import { createJevClient, REMEMBER_QUESTION, type JevCandidate } from '../dsh/lib/jev.ts'
import { createJudge, type Judgement } from '../dsh/lib/judge.ts'

import { signatureOf } from '../dsh/lib/signals.ts'
import { parseCsvRecords } from './lib/csv.ts'

const batch = process.env.CONTEXT_BATCH?.trim() || 'round5.csv'
const limit = Number(process.env.CONTEXT_LIMIT ?? '60') || 60
const windowSize = Number(process.env.CONTEXT_WINDOW ?? '5') || 5
const labelDir = new URL('./labels/', import.meta.url).pathname
const outFile = new URL('../.scratch/judge-context.md', import.meta.url).pathname
const types = ['constraint', 'pitfall', 'decision']

/** The question that tells the judge the window is there to be used. */
const QUESTION_WITH_WINDOW =
  '结合 `recent_conversation` 里的对话上下文回答：上一条 `candidate` 是这个人**对他自己项目的长期主张**吗？' +
  '注意：他说的意思以**上下文里的意图**为准，不要只看这一句的字面措辞——' +
  '「就用刚才那个项目」这种看着没有内容的句子，在上下文里可能是一条明确的要求。' +
  '约定、禁忌、取舍及原因、踩过的坑、项目事实都算。发生在这一次对话里的事不算：提问、寒暄、状态汇报、临时安排。' +
  '特别注意——即使内容是对的、即使确实和这个项目有关，只要它是**模型的回答**、**别人写的**、或者**粘贴进来的转录**，就不算；' +
  '只要它**只管这一次**，也不算。'

/** Read one multi-frame zstd log through the CLI the harvester depends on. */
function readLog(path: string): string {
  const result = spawnSync('zstdcat', [path], { maxBuffer: 1024 * 1024 * 512, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout ?? '') : ''
}

interface Message {
  seq: number
  role: string
  text: string
}

/** Every message and every extractor id of one session, in order. */
function readSession(raw: string): { messages: Message[]; keyToSeq: Map<string, number> } {
  const messages: Message[] = []
  const keyToSeq = new Map<string, number>()
  let turn: Array<{ seq: number; type: string; data: unknown }> = []
  let seq = 0

  const textOf = (content: unknown): string =>
    Array.isArray(content)
      ? content
          .map((block) =>
            (block as { type?: string; text?: string })?.type === 'text' ? String((block as { text?: string }).text ?? '') : '',
          )
          .join('\n')
          .trim()
      : ''

  const flush = (): void => {
    if (turn.length > 0) {
      const candidates = extractCandidates(turn as never, {
        ...EXTRACT_DEFAULTS,
        onVeto: (sentence, _reason, vetoSeq) => keyToSeq.set(signatureOf(sentence), vetoSeq ?? 0),
      })
      for (const candidate of candidates) keyToSeq.set(candidate.key, candidate.seq)
    }
    turn = []
  }

  for (const line of raw.split('\n')) {
    if (line === '') continue
    let event: { type?: string; data?: unknown }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const data = event.data as { source?: { kind?: string }; content?: unknown; message?: { content?: unknown } } | null
    if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'session') {
      flush()
      seq = 0
      continue
    }
    // The extractor is fed the turn's events, not the line stream: `turn` is what it walks, and
    // forgetting to fill it is a silent zero — the first run of this script scanned 48 sessions,
    // produced no candidates and reported "no windows recovered" with no hint why.
    turn.push({ seq, type: event.type ?? '', data: event.data })
    if (event.type === 'user/message') {
      const text = textOf(data?.content)
      const kind = data?.source?.kind
      if (text !== '') messages.push({ seq, role: typeof kind === 'string' && kind !== '' ? kind : 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = textOf(data?.message?.content)
      if (text !== '') messages.push({ seq, role: 'assistant', text })
    }
    seq += 1
  }
  flush()
  return { messages, keyToSeq }
}

/** Every session log under the harness home, newest generation per session. */
async function sessionFiles(): Promise<string[]> {
  const root = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sessions')
  const found: string[] = []
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
      if (best) found.push(join(dir, best))
    }
  }
  return found
}

/** One labelled row, with the window that surrounded it. */
interface Sample {
  id: string
  label: string
  text: string
  /** the five messages ending at the candidate's own message, oldest first. */
  window: string[]
}

const rows = parseCsvRecords(await readFile(join(labelDir, batch), 'utf8'))
const wanted = new Map(
  rows
    .filter((row) => (row.label ?? '').trim() === '1' || (row.label ?? '').trim() === '0')
    .map((row) => [(row.id ?? '').trim(), row]),
)

const recovered: Sample[] = []
let scanned = 0
for (const file of await sessionFiles()) {
  scanned += 1
  const raw = readLog(file)
  if (raw === '') continue
  let session: { messages: Message[]; keyToSeq: Map<string, number> }
  try {
    session = readSession(raw)
  } catch {
    continue
  }
  for (const [key, seq] of session.keyToSeq) {
    const row = wanted.get(key)
    if (!row) continue
    if (recovered.some((sample) => sample.id === key)) continue
    const at = session.messages.findIndex((message) => message.seq === seq)
    if (at < 0) continue
    const window = session.messages.slice(Math.max(0, at - windowSize + 1), at + 1)
    recovered.push({
      id: key,
      label: (row.label ?? '').trim(),
      text: row.text ?? '',
      window: window.map((message) => `[${message.role}] ${message.text.slice(0, 400)}`),
    })
  }
}
// Positives first, then negatives. Scanning in session order and stopping at the limit gave six
// positives out of eighteen, and an AUC computed on six items cannot separate a real improvement
// from noise — which is the whole question this script exists to answer.
const samples: Sample[] = [
  ...recovered.filter((sample) => sample.label === '1'),
  ...recovered.filter((sample) => sample.label === '0').slice(0, Math.max(0, limit - recovered.filter((s) => s.label === '1').length)),
]
console.log(
  `扫了 ${scanned} 个会话日志，还原出 ${recovered.length} 条标注行的窗口；取正例 ${samples.filter((s) => s.label === '1').length} 条、负例 ${samples.filter((s) => s.label === '0').length} 条`,
)
if (samples.length === 0) {
  console.error('一条都没还原出来：标注批次里的 id 在这些会话里找不到。')
  process.exit(1)
}

const credentials = await readFile(
  join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), '.credentials.yaml'),
  'utf8',
)
const typesafe = /TYPESAFE_API_KEY:\s*(\S+)/u.exec(credentials)?.[1]
if (!typesafe) throw new Error('TYPESAFE_API_KEY is not in the credential document')

/** One arm: which question, and whether the window is sent. */
interface Arm {
  name: string
  question: string
  withWindow: boolean
}

/** A shorter question: ask for the person's own commitment and stop enumerating. */
const QUESTION_SHORT =
  '结合 `recent_conversation`：上一条 `candidate` 里，**这个人自己**表达了一条以后还要遵守的约定、做过的取舍、踩过的坑或项目事实吗？' +
  '只按**他自己说的话**算——引用、转述、粘贴进来的内容都不算，只管这一次的任务安排也不算。'

const arms: Arm[] = [
  { name: 'A 只给句子（现状）', question: REMEMBER_QUESTION, withWindow: false },
  { name: 'B 句子 + 五条窗口', question: REMEMBER_QUESTION, withWindow: true },
  { name: 'C 窗口 + 明确让模型用上下文', question: QUESTION_WITH_WINDOW, withWindow: true },
  { name: 'D 窗口 + 短问法（只问"他自己说了什么"）', question: QUESTION_SHORT, withWindow: true },
]

const scores = new Map<string, Map<string, Judgement>>()
for (const arm of arms) {
  const jev = createJevClient({
    config: { maxCandidates: 6, rememberQuestion: arm.question },
    env: { ...process.env, TYPESAFE_API_KEY: typesafe },
  })
  if (!(await jev.isAvailable())) throw new Error('jev is not reachable')
  const judge = createJudge({ config: { judge: 'jev', types, judgeTimeoutMs: 20_000 }, jev })
  const collected = new Map<string, Judgement>()
  const chunks: Sample[][] = []
  // One request per window: the window belongs to one candidate's position in the conversation, so
  // batching unrelated sentences from different sessions into one request would give them all the
  // same context — which is exactly the variable under test.
  for (const sample of samples) chunks.push([sample])
  for (const [index, chunk] of chunks.entries()) {
    const candidates: JevCandidate[] = chunk.map((sample) => ({
      key: sample.id,
      text: sample.text,
      hintedType: null,
      signalScore: 0.5,
      signals: [],
    }))
    const result = await judge.judge(candidates, {
      known: [],
      project: null,
      conversation: arm.withWindow ? chunk[0]!.window : [],
    })
    for (const row of result.rows) collected.set(row.key, row)
    process.stdout.write(`\r${arm.name} ${index + 1}/${chunks.length}`)
  }
  console.log('')
  scores.set(arm.name, collected)
}

/** AUC over one arm. */
const auc = (arm: Arm): number | null => {
  const table = scores.get(arm.name)!
  const pick = (label: string): number[] =>
    samples
      .filter((sample) => sample.label === label)
      .map((sample) => table.get(sample.id)?.remember)
      .filter((value): value is number => typeof value === 'number')
  const pos = pick('1')
  const neg = pick('0')
  if (pos.length === 0 || neg.length === 0) return null
  let wins = 0
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0
  return wins / (pos.length * neg.length)
}

const lines: string[] = ['# 给判定层上下文 + 换提示词，指标会不会好转', '']
lines.push(`批次 ${batch}｜还原出 ${samples.length} 条（该记 ${samples.filter((s) => s.label === '1').length}）｜窗口 ${windowSize} 条｜配对实验`)
lines.push('')
lines.push('| 臂 | 该记中位分 | 不该记中位分 | AUC | 该记里 ≥0.12 | 该记里 ≥0.30 | 不该记里 ≥0.12 |')
lines.push('|---|---|---|---|---|---|---|')
for (const arm of arms) {
  const table = scores.get(arm.name)!
  const values = (label: string): number[] =>
    samples
      .filter((sample) => sample.label === label)
      .map((sample) => table.get(sample.id)?.remember)
      .filter((value): value is number => typeof value === 'number')
  const median = (list: number[]): number => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0
  const pos = values('1')
  const neg = values('0')
  lines.push(
    `| ${arm.name} | ${median(pos).toFixed(2)} | ${median(neg).toFixed(2)} | ${auc(arm)?.toFixed(2) ?? '—'} | ` +
      `${pos.filter((value) => value >= 0.12).length}/${pos.length} | ${pos.filter((value) => value >= 0.3).length}/${pos.length} | ` +
      `${neg.filter((value) => value >= 0.12).length}/${neg.length} |`,
  )
}
lines.push('')
// The gate the plugin ships reads `type` and `importance`, not `remember` — `writeGate:
// deterministic` strips the remember answer and falls through to the score. So a table of remember
// scores would measure something the write path no longer uses; these are the two fields that
// decide it.
lines.push('## 真正决定写入的两个量（`writeGate: deterministic` 读的是这两个）')
lines.push('')
lines.push('| 臂 | 正例判成三类 | 负例也判成三类 | 正例 importance≥0.6 | 负例 importance≥0.6 | 闸门结果 TP/FP/FN | 写对率 | 该记覆盖率 | F1 |')
lines.push('|---|---|---|---|---|---|---|---|---|')
for (const arm of arms) {
  const table = scores.get(arm.name)!
  const pos = samples.filter((sample) => sample.label === '1')
  const neg = samples.filter((sample) => sample.label === '0')
  const row = (sample: (typeof samples)[number]): Judgement | undefined => table.get(sample.id)
  const typed = (list: typeof samples): number => list.filter((sample) => types.includes(row(sample)?.type ?? '')).length
  const scored = (list: typeof samples): number => list.filter((sample) => (row(sample)?.importance ?? 0) >= 0.6).length
  const writes = (sample: (typeof samples)[number]): boolean => {
    const judgement = row(sample)
    return Boolean(judgement) && types.includes(judgement!.type) && judgement!.importance >= 0.6
  }
  let tp = 0
  let fp = 0
  let fn = 0
  for (const sample of samples) {
    if (sample.label === '1' && writes(sample)) tp += 1
    else if (sample.label === '1') fn += 1
    else if (writes(sample)) fp += 1
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  lines.push(
    `| ${arm.name} | ${typed(pos)}/${pos.length} | ${typed(neg)}/${neg.length} | ${scored(pos)}/${pos.length} | ${scored(neg)}/${neg.length} | ` +
      `${tp}/${fp}/${fn} | ${(precision * 100).toFixed(0)}% | ${(recall * 100).toFixed(0)}% | ${f1.toFixed(2)} |`,
  )
}
lines.push('')
lines.push('## 逐条')
lines.push('')
lines.push(`| 标注 | ${arms.map((arm) => arm.name.split(' ')[0]).join(' | ')} | 句子 |`)
lines.push(`|---|${arms.map(() => '---').join('|')}|---|`)
for (const sample of samples) {
  const cells = arms.map((arm) => {
    const judgement = scores.get(arm.name)?.get(sample.id)
    if (!judgement) return '—'
    const remember = typeof judgement.remember === 'number' ? judgement.remember.toFixed(2) : '—'
    return `${remember}/${judgement.type.slice(0, 4)}/${judgement.importance.toFixed(2)}`
  })
  lines.push(`| ${sample.label} | ${cells.join(' | ')} | ${sample.text.replace(/\|/gu, '\\|').slice(0, 60)} |`)
}
lines.push('')
lines.push('（逐条格子的格式：`remember / 类型 / importance`）')

await mkdir(new URL('../.scratch/', import.meta.url).pathname, { recursive: true })
await writeFile(outFile, `${lines.join('\n')}\n`, 'utf8')
console.log(lines.slice(0, 20).join('\n'))
console.log(`\n已写出 ${outFile}`)
