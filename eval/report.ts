/**
 * Report: what the labelled candidates say about the plugin's decisions.
 *
 * The labelling batches are the only source of a real write-precision number; this
 * turns them into one. It answers three questions and refuses to answer a fourth:
 *
 *  1. **只过筛子** — of the sentences the deterministic screens let through, how many
 *     did the person mark "should be remembered"?
 *  2. **规则判定** — the same, after the offline judge's type and score gate.
 *  3. **Jev 判定** — the same, after the model judge.
 *  4. **Hit@K / Recall@K** — *not* measured here, and printed as such. They need
 *     labelled queries, which do not exist yet.
 *
 * Four things this harness refuses to smooth over, each of which was found by
 * measuring rather than by reasoning:
 *
 *  - **The model judge is stochastic.** Over ten identical runs, 15 of 16 candidates
 *    changed score and one crossed the threshold both ways, which moves precision
 *    between 0.86 and 1.00 on its own. So the Jev arm is repeated and its spread is
 *    reported; a single run would present a coin flip as a measurement.
 *  - **The shipped configuration caps the model at 6 candidates per request**
 *    (`jev.maxCandidates`), and beyond that it degrades to the offline judge. Judging
 *    all rows in one request would measure a configuration that never runs, and the
 *    client would silently truncate the list anyway. So requests are cap-sized, and
 *    their latency is compared against the shipped 1800ms budget.
 *  - **A batch records the rules that produced it.** `round1.csv` was drawn before
 *    the transcript screen existed; comparing its veto rate with `round3.csv` is
 *    comparing two different plugins unless that is stated.
 *  - **`?` labels are not a soft "1" or "0".** They are excluded and counted, because
 *    they are the rows where the standard itself is ambiguous — the most informative
 *    rows in the set, and the ones a threshold must not be tuned on.
 *
 * Run:
 *   node eval/report.ts
 *   TYPESAFE_API_KEY=... node eval/report.ts          # adds the Jev arm
 *   REPORT_REPEAT=3 node eval/report.ts               # more repeats of a stochastic judge
 *
 * @module eval/report
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { TOOL_FAILURE_SIGNAL_SCORE, candidateScore, toolFailureKept } from '../dsh/lib/extract.ts'
import { applyGate, createJudge, type GateConfig, type Judgement } from '../dsh/lib/judge.ts'
import { createJevClient, type JevCandidate } from '../dsh/lib/jev.ts'
import { matchTypeSignals, screenSentence, signatureOf } from '../dsh/lib/signals.ts'
import { parseCsvRecords } from './lib/csv.ts'
import { taskClassOf, type TaskClass } from './lib/task-class.ts'

/**
 * The gate the plugin ships. These are the values in `dsh/index.ts`; if that file
 * changes them and this does not, this report measures a plugin nobody is running.
 */
const GATE: GateConfig = {
  types: ['constraint', 'pitfall', 'decision'],
  minImportance: 0.6,
  minRemember: 0.6,
  reviewOnConflict: true,
}

/** Shipped caps, so the report measures what the plugin actually does. */
const SHIPPED_MAX_CANDIDATES = 6
const SHIPPED_JUDGE_TIMEOUT_MS = 1800

/** Set when the run swaps the gate question, so the report says which one it used. */
const questionOverride = process.env.REPORT_REMEMBER_QUESTION?.trim() ?? ''
const labelDir = process.env.REPORT_DIR?.trim() || new URL('./labels/', import.meta.url).pathname
// Every batch in the directory unless told otherwise. The list used to be hardcoded, so
// a batch added later was silently left out of the report — the numbers would look fine
// and simply not include the rows someone had just labelled.
const batches =
  process.env.REPORT_BATCHES?.trim() !== undefined && process.env.REPORT_BATCHES?.trim() !== ''
    ? String(process.env.REPORT_BATCHES)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '')
    : (await readdir(labelDir).catch(() => [] as string[]))
        // `round<N>.csv` exactly: `round1.orphaned-labels.csv` is a safety copy, not a batch,
        // and pulling it in would double-count its rows and show a batch with no frame.
        .filter((name) => /^round\d+\.csv$/u.test(name))
        .sort()
const maxCandidates = Number(process.env.REPORT_MAX_CANDIDATES ?? SHIPPED_MAX_CANDIDATES) || SHIPPED_MAX_CANDIDATES
const repeats = Math.max(1, Number(process.env.REPORT_REPEAT ?? '3') || 3)

/** One labelled row, with everything the three arms need. */
interface Labelled {
  /** the sentence's signature, shared across batches that carry the same label. */
  id: string
  batch: string
  stratum: string
  taskClass: TaskClass
  kind: string
  workspace: string
  text: string
  hinted: string
  label: '1' | '0' | '?'
  /** what the screens did at harvest time: a row left in the vetoed stratum was rejected. */
  screensKept: boolean
  /** what the screens in this working tree do with the same sentence today. */
  screensKeptNow: boolean
  signalScore: number
  /** `csv` when the batch recorded the extractor's own score, `derived` when rebuilt. */
  scoreSource: 'csv' | 'derived'
}

/** What a batch's corpus snapshot says about itself. */
interface Frame {
  batch: string
  generatedAt: string
  rulesHash: string
  population: Record<string, number>
  sample: Record<string, number>
  humanMessages: number
  logs: Record<string, number>
}

/**
 * Read one batch and its snapshot.
 *
 * @param name - file name inside the label directory.
 * @returns the labelled rows and the frame, or nulls when the file is absent.
 */
async function loadBatch(name: string): Promise<{ rows: Labelled[]; frame: Frame | null; unlabelled: number }> {
  let text = ''
  try {
    text = await readFile(join(labelDir, name), 'utf8')
  } catch {
    return { rows: [], frame: null, unlabelled: 0 }
  }
  const rows: Labelled[] = []
  let unlabelled = 0
  for (const record of parseCsvRecords(text)) {
    const label = (record.label ?? '').trim()
    if (label !== '1' && label !== '0' && label !== '?') {
      unlabelled += 1
      continue
    }
    const text_ = record.text ?? ''
    const recorded = (record.signal_score ?? '').trim()
    rows.push({
      id: (record.id ?? '').trim(),
      batch: name,
      stratum: record.stratum ?? '',
      taskClass: (record.task_class as TaskClass | undefined) || taskClassOf(record.workspace ?? ''),
      kind: record.kind ?? '',
      workspace: record.workspace ?? '',
      text: text_,
      hinted: (record.hinted_type ?? '').trim(),
      label,
      screensKept: (record.stratum ?? '') !== 'vetoed',
      // The current deterministic pipeline for this row's kind, not just the sentence
      // screens: a tool failure is refused by the extractor when it carries no
      // diagnostic, and asking only `screenSentence` reported two rows as newly
      // accepted when today's plugin still refuses them.
      screensKeptNow:
        record.kind === 'tool-failure' ? toolFailureKept(text_) : screenSentence(text_).keep,
      signalScore: recorded === ''
        ? record.kind === 'tool-failure'
          ? TOOL_FAILURE_SIGNAL_SCORE
          : candidateScore(text_)
        : Number(recorded),
      scoreSource: recorded === '' ? 'derived' : 'csv',
    })
  }
  let frame: Frame | null = null
  try {
    const parsed = JSON.parse(await readFile(join(labelDir, name.replace(/\.csv$/u, '.frame.json')), 'utf8'))
    frame = { batch: name, ...parsed } as Frame
  } catch {
    /* a batch without a snapshot is older than the snapshot; reported as unknown */
  }
  return { rows, frame, unlabelled }
}

/** A confusion matrix and its derived metrics. */
interface Score {
  tp: number
  fp: number
  fn: number
  tn: number
}

/**
 * Precision/recall from a confusion matrix, guarding the empty cases.
 *
 * @param score - the matrix.
 * @returns precision, recall and F1 in 0..1.
 */
function metrics(score: Score): { precision: number; recall: number; f1: number } {
  const precision = score.tp + score.fp === 0 ? 1 : score.tp / (score.tp + score.fp)
  const recall = score.tp + score.fn === 0 ? 1 : score.tp / (score.tp + score.fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1 }
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`

const loaded = await Promise.all(batches.map((name) => loadBatch(name)))
const frames = loaded.map((entry) => entry.frame).filter((frame): frame is Frame => frame !== null)
const unlabelled = loaded.reduce((total, entry) => total + entry.unlabelled, 0)

// One row per sentence. A label is carried across batches by row id, so the same
// sentence can sit in several files, and counting it once per file inflates every
// rate: with these three batches, 10 of 48 labelled rows were duplicates. When a
// sentence appears twice the batch drawn under the *newer* rules wins, because its
// stratum records what today's screens would do with that sentence — the same
// sentence is a candidate in round1 and a screened-out row in round3.
const byId = new Map<string, Labelled>()
for (const entry of loaded) {
  for (const row of entry.rows) if (row.id !== '') byId.set(row.id, row)
}
const rows = [...byId.values()]
const duplicates = loaded.reduce((total, entry) => total + entry.rows.length, 0) - rows.length

if (rows.length === 0) {
  console.error(`${labelDir} 里还没有任何标注。先标 ${batches.join('、')}。`)
  process.exit(0)
}

const decided = rows.filter((row) => row.label === '1' || row.label === '0')
const unsure = rows.filter((row) => row.label === '?')
const positives = decided.filter((row) => row.label === '1').length

// The three arms. The screens arm needs no judgement: a row in the vetoed stratum was
// rejected by them, and every other row reached the judge.
const candidates: JevCandidate[] = rows.map((row) => ({
  key: signatureOf(row.text),
  text: row.text,
  hintedType: row.hinted === '' ? null : row.hinted,
  signalScore: row.signalScore,
  signals: matchTypeSignals(row.text).hits,
}))

const heuristicJudge = createJudge({ config: { judge: 'heuristic', types: GATE.types } })
const heuristicRows: Judgement[] = heuristicJudge.heuristics(candidates)

// `REPORT_REMEMBER_QUESTION` swaps the gate question, so two wordings can be measured
// back to back on the same labels instead of argued about.
const jev = createJevClient({
  config: {
    maxCandidates,
    ...(process.env.REPORT_REMEMBER_QUESTION?.trim()
      ? { rememberQuestion: process.env.REPORT_REMEMBER_QUESTION }
      : {}),
  },
  env: process.env,
})
let jevRuns: Judgement[][] = []
let jevLatency: number[] = []
let jevModel: string | null = null
let jevDegraded: string | null = null
if (await jev.isAvailable()) {
  const judge = createJudge({ config: { judge: 'jev', types: GATE.types, judgeTimeoutMs: 20_000 }, jev })
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const collected: Judgement[] = []
    for (let start = 0; start < candidates.length; start += maxCandidates) {
      const started = Date.now()
      const result = await judge.judge(candidates.slice(start, start + maxCandidates), { known: [], project: null })
      jevLatency.push(Date.now() - started)
      jevModel = result.model ?? jevModel
      jevDegraded = result.degraded ?? jevDegraded
      collected.push(...result.rows)
    }
    jevRuns.push(collected)
  }
}

/** One arm's per-row decision. */
interface Arm {
  name: string
  write: (index: number) => boolean
  note: string
}

const arms: Arm[] = [
  {
    name: '只过筛子（当前规则）',
    write: (index) => rows[index]!.screensKeptNow,
    note: '用当前工作区的筛子重跑同一个句子',
  },
  {
    name: '只过筛子（当时）',
    write: (index) => rows[index]!.screensKept,
    note: '确定性筛子（密钥/任务指令/载荷/噪音/问句/转录）',
  },
  {
    name: '规则判定',
    write: (index) => rows[index]!.screensKeptNow && applyGate(heuristicRows[index], GATE).write,
    note: `离线判定：类型 ∈ {${GATE.types.join(', ')}} 且 分数 ≥ ${GATE.minImportance}`,
  },
  ...(jevRuns.length > 0
    ? [
        {
          name: 'Jev 判定',
          write: (index: number) => rows[index]!.screensKeptNow && applyGate(jevRuns[0]![index], GATE).write,
          note: `模型判定：remember ≥ ${GATE.minRemember}，每次最多 ${maxCandidates} 个候选，跑 ${repeats} 次`,
        },
      ]
    : []),
]

/**
 * Score one arm over a subset of rows.
 *
 * @param arm - the arm.
 * @param subset - the rows to score (already filtered to 0/1 labels).
 * @param indices - the row's index in `rows`, which the arms are indexed by.
 * @returns the confusion matrix.
 */
function scoreArm(arm: Arm, subset: Labelled[], indices: Map<Labelled, number>): Score {
  const score: Score = { tp: 0, fp: 0, fn: 0, tn: 0 }
  for (const row of subset) {
    const wrote = arm.write(indices.get(row)!)
    const want = row.label === '1'
    if (want && wrote) score.tp += 1
    else if (want) score.fn += 1
    else if (wrote) score.fp += 1
    else score.tn += 1
  }
  return score
}

const indexOf = new Map(rows.map((row, index) => [row, index]))

/**
 * The type the model judge assigned to one row, for the diagnosis table.
 *
 * @param index - the row's index.
 * @returns the type, or a dash when the judge did not answer for it.
 */
function hevRuns0Type(index: number): string {
  return jevRuns[0]?.[index]?.type ?? '—'
}
const out: string[] = []
const say = (line: string): void => {
  console.log(line)
  out.push(line)
}

say('# 评测报告：写入侧')
say('')
say(
  `生成时间 ${new Date().toISOString()}｜批次 ${batches.join('、')}｜已标注 **${rows.length}** 句（另有 ${unlabelled} 行未标${duplicates > 0 ? `；跨批次重复 ${duplicates} 行已按句子合并` : ''}）`,
)
say('')

// Frames first: a reader who does not know which rules drew each batch cannot tell a
// plugin change from a corpus change, and round1 was drawn before the transcript
// screen existed.
say('## 每批的语料快照')
say('')
say('| 批次 | 生成时间 | 规则指纹 | 人类消息 | 日志代数 | 通过筛子的候选 | 被筛 |')
say('|---|---|---|---|---|---|---|')
for (const frame of frames) {
  const candidates_ = Object.entries(frame.population ?? {})
    .filter(([stratum]) => stratum !== 'vetoed')
    .reduce((total, [, count]) => total + count, 0)
  say(
    `| ${frame.batch} | ${String(frame.generatedAt).slice(0, 16).replace('T', ' ')} | \`${frame.rulesHash ?? '未记录'}\` | ${frame.humanMessages ?? '?'} | ${Object.entries(frame.logs ?? {}).map(([generation, count]) => `${generation}×${count}`).join(' ')} | ${candidates_} | ${frame.population?.vetoed ?? '?'} |`,
  )
}
const hashes = new Set(frames.map((frame) => frame.rulesHash).filter(Boolean))
if (hashes.size > 1) {
  say('')
  say('> ⚠️ **这些批次的规则指纹不同**：它们是不同版本的插件抽出来的。跨批次的比率（尤其"被筛"）不可直接比较，只能各自看。')
}
say('')

say('## 标注的构成')
say('')
say('| 任务类 | 已定 1 | 已定 0 | 该记比例 | 拿不准 `?` |')
say('|---|---|---|---|---|')
for (const taskClass of ['coding', 'study', 'office', 'other'] as TaskClass[]) {
  const subset = decided.filter((row) => row.taskClass === taskClass)
  if (subset.length === 0) continue
  const ones = subset.filter((row) => row.label === '1').length
  const unsureHere = unsure.filter((row) => row.taskClass === taskClass).length
  say(`| \`${taskClass}\` | ${ones} | ${subset.length - ones} | ${percent(ones / subset.length)} | ${unsureHere} |`)
}
say(`| **合计** | ${positives} | ${decided.length - positives} | **${percent(positives / decided.length)}** | ${unsure.length} |`)
say('')
say(`拿不准的 ${unsure.length} 行占已标 ${percent(unsure.length / rows.length)}——它们是标准本身有歧义的地方，**不参与任何阈值计算**。`)
say('')

say('## 三种判定的对照')
say('')
say('| 判定 | 精确率 | 召回率 | F1 | TP | FP | FN | TN |')
say('|---|---|---|---|---|---|---|---|')
for (const arm of arms) {
  const score = scoreArm(arm, decided, indexOf)
  const m = metrics(score)
  say(`| ${arm.name} | **${percent(m.precision)}** | ${percent(m.recall)} | ${m.f1.toFixed(2)} | ${score.tp} | ${score.fp} | ${score.fn} | ${score.tn} |`)
}
say('')
for (const arm of arms) say(`- **${arm.name}**：${arm.note}`)
say('')

// A row drawn before a screen existed keeps that screen's verdict in its file, so the
// two screens arms differ exactly by the fixes made since. Showing both is the only
// way to tell "the plugin is imprecise" from "the plugin was imprecise".
const changed = rows.filter((row) => row.screensKept !== row.screensKeptNow)
if (changed.length > 0) {
  const nowRejects = changed.filter((row) => row.screensKeptNow && !row.screensKept).length
  say(
    `**两次筛子判定不同的行：${changed.length}**（当时放行、现在拒掉 ${changed.length - nowRejects} 行；当时拒掉、现在放行 ${nowRejects} 行）。差异来自抽这批之后加的筛子，所以两行"只过筛子"指的是两个不同版本的插件。`,
  )
  say('')
}
say('')
say('> 这里的"召回率"是**写入侧召回**：在你标为该记的句子里，插件写了几条。它和 **Hit@K / Recall@K 无关**，后者需要标注过的查询，目前**没有数据、没有测量**。')
say('')

say('## 按任务类拆开')
say('')
say(`| 任务类 | 已定行数 | ${arms.map((arm) => arm.name).join(' | ')} |`)
say(`|---|---|${arms.map(() => '---').join('|')}|`)
for (const taskClass of ['coding', 'study', 'office', 'other'] as TaskClass[]) {
  const subset = decided.filter((row) => row.taskClass === taskClass)
  if (subset.length === 0) continue
  const cells = arms.map((arm) => {
    const m = metrics(scoreArm(arm, subset, indexOf))
    return `${percent(m.precision)} / ${percent(m.recall)}`
  })
  say(`| \`${taskClass}\` | ${subset.length} | ${cells.join(' | ')} |`)
}
say('')
say('（每格是 **精确率 / 召回率**。编码类才是主指标：学习类是复习问答，办公类是文档工作。）')
say('')

say('## 按分层拆开')
say('')
say('| 分层 | 已定行数 | 批次 | 该记比例 |')
say('|---|---|---|---|')
for (const stratum of [...new Set(decided.map((row) => row.stratum))].sort()) {
  const subset = decided.filter((row) => row.stratum === stratum)
  const ones = subset.filter((row) => row.label === '1').length
  const where = [...new Set(subset.map((row) => row.batch))].join('、')
  say(`| \`${stratum}\` | ${subset.length} | ${where} | ${percent(ones / subset.length)} |`)
}
say('')

// Read against the screens in this working tree, not the ones that drew the row: the
// question "does the current plugin throw away memories" is about today's rules.
const vetoed = rows.filter((row) => !row.screensKeptNow && (row.label === '1' || row.label === '0'))
if (vetoed.length > 0) {
  const ones = vetoed.filter((row) => row.label === '1').length
  say(`**筛子误杀（按当前规则）**：${vetoed.length} 行会被筛子挡下，其中 ${ones} 行你标了"该记"（${percent(ones / vetoed.length)}）。`)
  say('')
}

const batchesPresent = [...new Set(rows.map((row) => row.batch))]
if (batchesPresent.length > 1) {
  say('## 按批次拆开（规则版本不同，不要合并读）')
  say('')
  say(`| 批次 | 规则指纹 | 已定行数 | ${arms.map((arm) => arm.name).join(' | ')} |`)
  say(`|---|---|---|${arms.map(() => '---').join('|')}|`)
  for (const batch of batchesPresent) {
    const subset = decided.filter((row) => row.batch === batch)
    if (subset.length === 0) continue
    const hash = frames.find((frame) => frame.batch === batch)?.rulesHash ?? '未记录'
    const cells = arms.map((arm) => {
      const m = metrics(scoreArm(arm, subset, indexOf))
      return `${percent(m.precision)} / ${percent(m.recall)}`
    })
    say(`| ${batch} | \`${hash}\` | ${subset.length} | ${cells.join(' | ')} |`)
  }
  say('')
  say('（每格是 **精确率 / 召回率**。`round1.csv` 的句子是在转录筛子存在之前抽的，它的"只过筛子"反映旧筛子。）')
  say('')
}

say('## 不一致的条目（人 vs 判定）')
say('')
for (const arm of arms) {
  const wrong = decided.filter((row) => arm.write(indexOf.get(row)!) !== (row.label === '1'))
  say(`### ${arm.name}：${wrong.length} 行不一致`)
  say('')
  if (wrong.length === 0) {
    say('（无）')
    say('')
    continue
  }
  for (const row of wrong.slice(0, 20)) {
    const direction = row.label === '1' ? '漏记（该记没记）' : '误记（不该记却记了）'
    say(`- **${direction}**｜\`${row.batch}\` ${row.stratum}/${row.taskClass}｜${row.text.slice(0, 70).replace(/\n/gu, ' ')}`)
  }
  if (wrong.length > 20) say(`- …另有 ${wrong.length - 20} 行`)
  say('')
}

if (jevRuns.length > 1) {
  say('## 模型判定的稳定性')
  say('')
  let flips = 0
  let moved = 0
  for (const [index, row] of rows.entries()) {
    const writes = jevRuns.map((run) => row.screensKept && applyGate(run[index], GATE).write)
    const yes = writes.filter(Boolean).length
    if (yes > 0 && yes < jevRuns.length) flips += 1
    const remembers = jevRuns
      .map((run) => run[index]?.remember)
      .filter((value): value is number => typeof value === 'number')
    if (remembers.length > 1 && Math.max(...remembers) - Math.min(...remembers) > 0.01) moved += 1
  }
  say(`${repeats} 次重复：**${flips}/${rows.length}** 行的判定结果不一致，**${moved}/${rows.length}** 行的分数有波动。`)
  say('')
  // The arm's own numbers move with those flips, so they are printed per run rather
  // than as one figure: on this set the model writes none or one of the positives
  // depending on the run, which is a recall of 0% or 11%.
  const perRun = jevRuns.map((run) => {
    const score: Score = { tp: 0, fp: 0, fn: 0, tn: 0 }
    for (const row of decided) {
      const index = indexOf.get(row)!
      const wrote = row.screensKeptNow && applyGate(run[index], GATE).write
      const want = row.label === '1'
      if (want && wrote) score.tp += 1
      else if (want) score.fn += 1
      else if (wrote) score.fp += 1
      else score.tn += 1
    }
    const m = metrics(score)
    return `${percent(m.precision)}/${percent(m.recall)}`
  })
  say(`这一次的每一跑：${perRun.join('、')}（精确率/召回率）——**模型判定的数字必须带上这个区间读**。`)
  say('')
  say('所以 Jev 那一栏必须连同这个数字一起读：单次运行的精确率会随这些行上下浮动。')
  say('')
}

if (jevLatency.length > 0) {
  const over = jevLatency.filter((value) => value > SHIPPED_JUDGE_TIMEOUT_MS).length
  const sorted = [...jevLatency].sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  say('## 线上超时预算')
  say('')
  say(
    `${jevLatency.length} 次请求（每次 ≤${maxCandidates} 个候选）：中位 ${median}ms，最慢 ${sorted.at(-1)}ms；其中 ${over} 次超过线上 ${SHIPPED_JUDGE_TIMEOUT_MS}ms 的预算。`,
  )
  say('')
  say('超过预算的请求在线上会降级为规则判定（台账记 `kind:"degraded"`），所以这条线决定了模型判定实际覆盖多少候选。')
  say('')
}

// The threshold is the one knob a human owns, so the report shows the curve rather
// than a single point on it. It matters here: on the labelled rows the model judge
// writes 1 of 9 positives at the shipped 0.6, and the positives it drops are
// project-specific *requirements* ("请你按照这个格式去写简历", "我要求你说设计是怎么
// 设计的…就说流程就行了") — instructions, which a judge asked "is this worth
// remembering" reads as one-off task chatter.
if (jevRuns.length > 0) {
  say('## 阈值扫描')
  say('')
  say('| minRemember / minImportance | Jev 精确率 | Jev 召回率 | Jev 写入数 | 规则判定 精确率 | 规则判定 召回率 |')
  say('|---|---|---|---|---|---|')
  for (const threshold of [0.2, 0.3, 0.4, 0.5, 0.55, 0.6, 0.7]) {
    const jevScore: Score = { tp: 0, fp: 0, fn: 0, tn: 0 }
    const heurScore: Score = { tp: 0, fp: 0, fn: 0, tn: 0 }
    let writes = 0
    for (const row of decided) {
      const index = indexOf.get(row)!
      const want = row.label === '1'
      const jevWrite = row.screensKeptNow && applyGate(jevRuns[0]![index], { ...GATE, minRemember: threshold }).write
      const heurWrite =
        row.screensKeptNow && applyGate(heuristicRows[index], { ...GATE, minImportance: threshold }).write
      if (jevWrite) writes += 1
      if (want && jevWrite) jevScore.tp += 1
      else if (want) jevScore.fn += 1
      else if (jevWrite) jevScore.fp += 1
      else jevScore.tn += 1
      if (want && heurWrite) heurScore.tp += 1
      else if (want) heurScore.fn += 1
      else if (heurWrite) heurScore.fp += 1
      else heurScore.tn += 1
    }
    const j = metrics(jevScore)
    const h = metrics(heurScore)
    say(
      `| ${threshold.toFixed(2)}${Math.abs(threshold - GATE.minRemember) < 1e-9 ? ' ← 线上' : ''} | ${percent(j.precision)} | ${percent(j.recall)} | ${writes}/${decided.length} | ${percent(h.precision)} | ${percent(h.recall)} |`,
    )
  }
  say('')
  say('（阈值是配置，不是模型能力：同一批评分在低阈值下召回更高、精确率更低。扫描只有 30 行已定标注，**不要照单挑一个最好看的点**；等标注到 100 行以上再定。）')
  say('')
}

// Why the misses happen, sentence by sentence. A recall number says the judge drops
// project requirements; the scores say whether that is a threshold (fixable in config)
// or a disagreement about what the sentence *is* (not fixable in config). On this set
// it is the second: even at 0.20 the model scores them below the threshold.
if (jevRuns.length > 0) {
  const missed = decided.filter((row) => row.label === '1' && !arms.at(-1)!.write(indexOf.get(row)!))
  if (missed.length > 0) {
    say('## 被漏记的句子，判定层怎么看')
    say('')
    say('| 句子 | Jev `remember`（3 次区间） | 类型 | 规则判定分数 |')
    say('|---|---|---|---|')
    for (const row of missed.slice(0, 12)) {
      const index = indexOf.get(row)!
      const scores = jevRuns
        .map((run) => run[index]?.remember)
        .filter((value): value is number => typeof value === 'number')
      const range = scores.length === 0 ? 'n/a' : `${Math.min(...scores).toFixed(2)}–${Math.max(...scores).toFixed(2)}`
      say(
        `| ${row.text.slice(0, 44).replace(/\n/gu, ' ')} | ${range} | ${hevRuns0Type(index)} | ${row.signalScore.toFixed(2)} |`,
      )
    }
    say('')
  }
}

const derived = rows.filter((row) => row.scoreSource === 'derived' && row.kind !== 'tool-failure').length
say('## 方法与局限')
say('')
say(`- 分数来源：${rows.length - derived} 行来自 CSV 里记录的抽取器分数，${derived} 行是按当前公式复算的（旧批次没有这一列）。`)
say(`- 模型判定按每次 ≤${maxCandidates} 个候选分批，与线上 \`jev.maxCandidates\` 一致；一次请求塞全部候选会绕过这个上限，测的是没人跑的配置。`)
say(`- 线上判定超时 ${SHIPPED_JUDGE_TIMEOUT_MS}ms，本报告用 20s：先量准判定质量，超时覆盖率单独报。`)
say('- 句子是**插件当时看到的正文**（可能已按 240 字裁剪），判定臂读的就是它，所以三者输入一致。')
say('- 分层抽样按配额，各层比例不等于语料比例；比较不同来源时要看上面的池子大小。')
say('- 未测：**Hit@K / Recall@K**（需要标注查询）、多轮对话里的重复写入、以及记忆被读回后对回答质量的影响。')
say('')

const outFile = join(labelDir, 'report.md')
await writeFile(outFile, `${out.join('\n')}\n`, 'utf8')
console.log(`\n已写出 ${outFile}`)
