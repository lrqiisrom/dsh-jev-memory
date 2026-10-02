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
import { createJevClient, REMEMBER_QUESTION, type JevCandidate } from '../dsh/lib/jev.ts'
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
  // Follows the shipped default. It moved with the remember question on 2026-10-01: a
  // stricter question shifts every score down, so the two are one change, not two.
  minRemember: 0.12,
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
    note:
      `**线上闸门**：类型 ∈ {${GATE.types.join(', ')}} 且 抽取器分数 ≥ ${GATE.minImportance}。` +
      '（这两个量都来自**本地抽取器**，不是模型的答案——`writeGate: deterministic` 就取这一行；' +
      '判定层的 `conflict` 仍然参与冲突复核。）' +
      '不需要网络也不需要 key，并且和原文归档配套：被它拒掉的句子不是丢弃，而是留在 L0 里可检索。',
  },
  ...(jevRuns.length > 0
    ? [
        {
          name: 'Jev 判定',
          write: (index: number) => rows[index]!.screensKeptNow && applyGate(jevRuns[0]![index], GATE).write,
          note:
            `模型判定：remember ≥ ${GATE.minRemember}，每次最多 ${maxCandidates} 个候选，跑 ${repeats} 次。` +
            '**线上已不用它决定写入**（配置 `writeGate: deterministic`）：在这批标注上它的 F1 是 0.33，上一条免模型的规则是 0.34；' +
            '两者"独有贡献"的命中率一样低（它独有的 14 行里 2 行对，规则独有的 12 行里也是 2 行）。' +
            '花一次网络调用去追平一条本地规则不划算，所以它被移出闸门，保留在冲突/重复判定那一步——那里用的是它的排序能力（AUC 0.75）。',
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
 * Ranking quality of one run's `remember` scores over one subset.
 *
 * Threshold-free on purpose: it is the only Jev number that stayed put across repeats, so
 * it is what "did the change help" has to be read from. Ties count half.
 *
 * @param run - one repeat's judgements, indexed like `rows`.
 * @param subset - the rows to score.
 * @returns the AUC, or null when the subset has no positives or no negatives.
 */
function aucForRun(run: Judgement[], subset: Labelled[]): number | null {
  const positive: number[] = []
  const negative: number[] = []
  for (const row of subset) {
    const value = run[indexOf.get(row)!]?.remember
    if (typeof value !== 'number') continue
    if (row.label === '1') positive.push(value)
    else negative.push(value)
  }
  if (positive.length === 0 || negative.length === 0) return null
  let wins = 0
  for (const p of positive) for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0
  return wins / (positive.length * negative.length)
}

/** One frozen measurement, for comparing a later run against it. */
interface Baseline {
  name: string
  frozenAt: string
  /** the gate question that produced it, so a wording change is visible in the file. */
  rememberQuestion: string
  minRemember: number
  dataset: { batches: string[]; decided: number; positives: number }
  arms: Record<string, { written: number; tp: number; fp: number; fn: number; precision: number; recall: number }>
  jev: { auc: number | null; aucPerRun: Array<number | null>; flips: number | null }
}

let baseline: Baseline | null = null
try {
  baseline = JSON.parse(await readFile(join(labelDir, 'baseline.json'), 'utf8')) as Baseline
} catch {
  // No baseline yet. The comparison section is skipped rather than faked.
}
// A baseline is only comparable against the same rows. Comparing a round5 baseline with a
// run over every batch would silently mix in the study rows and read as a regression.
const baselineApplies =
  baseline !== null &&
  baseline.dataset.batches.join(',') === batches.join(',') &&
  baseline.dataset.decided === decided.length

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

say('## 四臂对照：写入侧')

say('')
say('这张表量的是**写入侧**：给你抽出来的每一句候选，判定是"把它写成一条记忆"还是"丢掉它"。')
say('**这里没有检索**——"召回几条第几条记忆"是读取侧的事，见本节末尾。')
say('')
say(
  `怎么读：${decided.length} 句已定的候选里，你标了 **${positives} 句"该记"**、**${decided.length - positives} 句"不该记"**。` +
    `下面每一行是"一种判定方式"，看它拿这 ${decided.length} 句各做了什么。`,
)
say('')
say('| 判定 | 它记下了几条 | 记对的 | 记错的 | 该记却漏掉的 | 写对率 | 该记覆盖率 |')
say('|---|---|---|---|---|---|---|')
for (const arm of arms) {
  const score = scoreArm(arm, decided, indexOf)
  const m = metrics(score)
  say(
    `| ${arm.name} | ${score.tp + score.fp} / ${decided.length} | ${score.tp} | ${score.fp} | ${score.fn} | **${percent(m.precision)}** | ${percent(m.recall)} |`,
  )
}
say('')
say('四列白话解释：')
say('')
say('- **记对的**（TP）：你标"该记"，它写了。')
say('- **记错的**（FP）：你标"不该记"，它还是写了。**这一类最贵**——它会进入此后每一个会话的提示。')
say('- **该记却漏掉的**（FN）：你标"该记"，它没写。')
say('- **写对率** = 记对的 ÷ 它记下的条数。**低了说明它在乱记**：写下来的东西里大部分不该记。')
say(`- **该记覆盖率** = 记对的 ÷ ${positives}（你标"该记"的总数）。**低了说明它记不住东西**：该记的大部分被漏掉。`)
say('')
say('这两个率必须一起看，原因在下一节。')
say('')

// A single "accuracy" is the most natural thing to ask for and the worst thing to report
// here, because the classes are lopsided: 13% of the decided rows are things worth
// remembering. Doing nothing scores 87%. This table exists to make that trap visible
// before anyone quotes a number out of the section above.
say('### 为什么不能只报一个"准确率"')
say('')
say(
  `"准确率" = 判对的条数 ÷ 总条数，听起来最直观。但你这批数据里**该记的只有 ${positives}/${decided.length} = ${percent(positives / decided.length)}**，` +
    '所以什么都不做的做法天然高分。把几种极端做法和真判定放在一张表里就看得出来了：',
)
say('')
say('| 做法 | 它记下了几条 | 记对 | 记错 | 漏掉 | 准确率 |')
say('|---|---|---|---|---|---|')
say(
  `| 一条都不记（什么都不做） | 0 | 0 | 0 | ${positives} | **${percent((decided.length - positives) / decided.length)}** |`,
)
say(
  `| 全部都记（来者不拒） | ${decided.length} | ${positives} | ${decided.length - positives} | 0 | **${percent(positives / decided.length)}** |`,
)
for (const arm of arms) {
  const score = scoreArm(arm, decided, indexOf)
  say(
    `| ${arm.name} | ${score.tp + score.fp} | ${score.tp} | ${score.fp} | ${score.fn} | **${percent((score.tp + score.tn) / decided.length)}** |`,
  )
}
say('')
say(
  '看最上面两行：**什么都不做有 ' +
    `${percent((decided.length - positives) / decided.length)}，来者不拒只有 ${percent(positives / decided.length)}**。` +
    '所以只报一个"准确率"，会让"干脆别记"赢过所有真在干活的判定。这就是上面那张表要分开给"写对率"和"该记覆盖率"的原因——',
)
say('**一个回答"它记的东西干不干净"，一个回答"该记的东西它记住没有"。**')
say('')
for (const arm of arms) say(`- **${arm.name}**：${arm.note}`)
say('')

/** Jev's ranking quality over the decided rows; the baseline section needs it here. */
const aucValue = jevRuns[0] ? aucForRun(jevRuns[0], decided) : null

// The question every later change has to answer is "did the numbers move", and comparing
// against a number someone remembers from a previous message is not a comparison. The
// baseline is a file: it records the rows, the gate question and the threshold alongside
// the result, so a difference can be attributed instead of merely noticed.
if (baselineApplies && baseline) {
  const current = new Map(
    arms.map((arm) => {
      const score = scoreArm(arm, decided, indexOf)
      const m = metrics(score)
      return [arm.name, { written: score.tp + score.fp, tp: score.tp, fp: score.fp, fn: score.fn, precision: m.precision, recall: m.recall }]
    }),
  )
  const delta = (now: number, then: number, asPercent = false): string => {
    // Compared at the precision the table prints, so a 23.7% → 24.2% move is not reported as
    // a one-point gain next to two cells that both read "24%".
    if (asPercent) {
      const before = Math.round(then * 100)
      const after = Math.round(now * 100)
      if (before === after) return '持平'
      return `${after > before ? '+' : ''}${after - before} 个点`
    }
    const difference = now - then
    if (Math.abs(difference) < 0.5) return '持平'
    return `${difference > 0 ? '+' : ''}${difference.toFixed(0)}`
  }
  say(`## 与基线对比（基线：${baseline.name}）`)
  say('')
  say(
    `基线冻结于 ${baseline.frozenAt.slice(0, 10)}：同样的 ${baseline.dataset.batches.join('、')}、` +
      `${baseline.dataset.decided} 行已定、${baseline.dataset.positives} 条该记；阈值 ${baseline.minRemember}。` +
      (baseline.rememberQuestion === REMEMBER_QUESTION ? '' : ' **注意：这次的判定问法和基线不同**，下面每一格都同时含"问法变了"和"阈值变了"两个原因。'),
  )
  say('')
  say('| 判定 | 指标 | 基线 | 现在 | 变化 |')
  say('|---|---|---|---|---|')
  for (const arm of arms) {
    const then = baseline.arms[arm.name]
    const now = current.get(arm.name)
    if (!then || !now) continue
    const rows_: Array<[string, string, string, string]> = [
      ['记对的（抓到的该记 / 该记总数）', `${then.tp} / ${baseline.dataset.positives}`, `${now.tp} / ${decided.filter((row) => row.label === '1').length}`, delta(now.tp, then.tp)],
      ['写对率', percent(then.precision), percent(now.precision), delta(now.precision, then.precision, true)],
      ['该记覆盖率', percent(then.recall), percent(now.recall), delta(now.recall, then.recall, true)],
    ]
    for (const [metric, before, after, movement] of rows_) {
      say(`| ${arm.name} | ${metric} | ${before} | ${after} | ${movement} |`)
    }
  }
  say('')
  say(`**判定排序能力（AUC，与阈值无关）**：基线 ${baseline.jev.auc === null ? '—' : baseline.jev.auc.toFixed(2)} → 现在 ${aucValue === null ? '—' : aucValue.toFixed(2)}。`)
  if (baseline.jev.auc !== null && aucValue !== null) {
    const movement = aucValue - baseline.jev.auc
    const spread = baseline.jev.aucPerRun.filter((value): value is number => value !== null)
    const noise = spread.length > 1 ? Math.max(...spread) - Math.min(...spread) : 0
    // The judge is stochastic, so a difference smaller than its own run-to-run spread is
    // not evidence of anything. The spread is printed rather than merely used, because the
    // reader is the one who has to decide whether the next change cleared it.
    say(
      Math.abs(movement) <= Math.max(noise, 0.02)
        ? `这个差距（${(movement * 100).toFixed(0)} 个百分点）**没有超出重复跑本身的波动**（基线三跑 ${spread.map((value) => value.toFixed(2)).join('、')}），所以还不能说判定变强或变弱了。`
        : `这个差距超出了重复跑的波动范围（基线三跑 ${spread.map((value) => value.toFixed(2)).join('、')}），所以是判定本身的变化，不是随机。`,
    )
  }
  say('')
}

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
say('> **读取侧一件都没测。** Hit@K / Recall@K（"问某件事的时候，前 K 条里有没有那条记忆"）需要你把')
say('> "查询 → 应该想起哪几条"也标出来，目前**没有数据、没有测量**，本报告的任何数字都不能当它用。')
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
say('（每格是 **写对率 / 该记覆盖率**。编码类才是主指标：学习类是复习问答，办公类是文档工作。）')
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
  say('（每格是 **写对率 / 该记覆盖率**。`round1.csv` 的句子是在转录筛子存在之前抽的，它的"只过筛子"反映旧筛子。）')
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

// "Is the model judge any good" is the question this project turns on, and a
// write/no-write matrix at one threshold answers it badly: at 0.6 the judge writes a
// handful of rows, so both rates rest on tiny counts and the reader cannot tell "the
// scores do not separate the two classes" from "the threshold is in the wrong place".
// Two numbers pull those apart. AUC uses every pair of a positive and a negative and asks
// how often the judge scores them the right way round — no threshold in it at all. The
// type hit rate asks whether the judge read the sentence, which it can do while still
// giving it a low remember score. Both are reported twice: once over everything the judge
// was asked, once only over the rows the screens let through, because the screens decide
// which sentences ever reach it.
const firstRun = jevRuns[0]
if (firstRun) {
  const scored = decided
    .map((row) => ({ row, judgement: firstRun[indexOf.get(row)!] }))
    .filter((entry): entry is { row: Labelled; judgement: Judgement } => typeof entry.judgement?.remember === 'number')
  const posScores = scored.filter((entry) => entry.row.label === '1').map((entry) => entry.judgement.remember!)
  const negScores = scored.filter((entry) => entry.row.label === '0').map((entry) => entry.judgement.remember!)

  // Scores are shown as buckets rather than as 最低/中位/最高: a reader asked what those
  // three words meant, which is the sign that they were the wrong presentation. Counting
  // how many rows land in each band answers "can the score tell the two apart" directly,
  // and it shows *where* the two classes overlap instead of hiding it in one number.
  const bandNames = ['0 ~ 0.2', '0.2 ~ 0.4', '0.4 ~ 0.6', '0.6 ~ 0.8', '0.8 ~ 1.0']
  const bandNote = ['基本判"不记"', '偏低', '模糊地带', '线上（≥0.6）会记', '线上（≥0.6）会记']
  const bandOf = (value: number): number => Math.min(bandNames.length - 1, Math.max(0, Math.floor(value / 0.2)))
  const bandCounts = bandNames.map((_, band) => ({
    one: scored.filter((entry) => entry.row.label === '1' && bandOf(entry.judgement.remember!) === band).length,
    zero: scored.filter((entry) => entry.row.label === '0' && bandOf(entry.judgement.remember!) === band).length,
  }))
  const auc = aucForRun(firstRun, decided)
  // AUC is reported for every repeat, not just the first: it is the one Jev number that
  // came out identical across runs on this set, so a prompt change that moves it can be
  // trusted, while a change that only moves the write count cannot.
  const aucPerRun = jevRuns.map((run) => aucForRun(run, decided))

  const typeHits = (entries: typeof scored): number =>
    entries.filter((entry) => GATE.types.includes(entry.judgement.type)).length
  const passed = scored.filter((entry) => entry.row.screensKeptNow)
  const passedPos = passed.filter((entry) => entry.row.label === '1')

  say('## Jev 判得准不准（把阈值和筛子剥开看）')
  say('')
  say('前面那张表的 Jev 一行是**一个阈值（0.6）之下的写入结果**。它把两件事混在一起了：')
  say('① 模型给的分数本身有没有用；② 0.6 这个线画得对不对。分开看才知道该改哪一个。')
  say('')
  say(`### ① 它给分给在哪（它一共经手 ${scored.length} 行）`)
  say('')
  say('Jev 对每句话给一个 0~1 的 `remember` 分，≥ 0.6 就写。把这个分数分成五档，看你的标注落在哪：')
  say('')
  say('| Jev 给的分 | 含义 | 你标"该记"的 | 你标"不该记"的 |')
  say('|---|---|---|---|')
  for (const [band, name] of bandNames.entries()) {
    say(`| ${name} | ${bandNote[band] ?? ''} | ${bandCounts[band]!.one} | ${bandCounts[band]!.zero} |`)
  }
  say(
    `| **合计** | | **${posScores.length}** | **${negScores.length}** |`,
  )
  say('')
  say(
    '一眼就能看出的问题：**你标"该记"的句子里，大多数（' +
      `${bandCounts[0]!.one + bandCounts[1]!.one + bandCounts[2]!.one} 条）落在 0.6 以下**，所以在线上它们根本不会被写；` +
      '而 0.6 以上那一档里，不该记的反而比该记的多。',
  )
  say('')
  say('### ② 它排序排得准不准（AUC）')
  say('')
  say('**AUC 是什么**：不看 0.6 这条线，只问"给它两条句子，一条是你标该记的、一条是你标不该记的，它能给该记的那条打更高的分吗"。')
  say('把所有这样的配对都试一遍，它押对的百分比就是 AUC。')
  say('')
  say('- **50%** = 和抛硬币一样，这个分数完全没用；')
  say('- **100%** = 它给的分数永远把该记排在前面，完美；')
  say('- **70%** = 明显有用，但十次里还会错三次。')
  say('')
  say(
    auc === null
      ? '**这次样本不足，算不出来。**'
      : `**这次的 AUC = ${auc.toFixed(2)}，也就是 ${percent(auc)}。**` +
          (aucPerRun.length > 1
            ? ` 重复跑的每一遍分别是 ${aucPerRun.map((value) => (value === null ? '—' : value.toFixed(2))).join('、')}——**这个数几乎不随重复漂**，而"写了几条"每次都在跳，所以判断"改问法有没有用"要看它。`
            : ''),
  )
  say('')
  say(
    `**③ 它有没有看懂内容**：和分数无关，只看它把句子判成了什么类型。Jev 把句子判成 ${GATE.types.join(' / ')} 时说明它认出了"这是一条要求/一个坑/一个决定"。` +
      `结果：你标"该记"的 ${posScores.length} 行里认出了 **${typeHits(scored.filter((entry) => entry.row.label === '1'))}** 行；` +
      `但你标"不该记"的 ${negScores.length} 行里，**也有 ${typeHits(scored.filter((entry) => entry.row.label === '0'))} 行**被认成这三类——所以"认出类型"本身不等于"该记"。`,
  )
  say('')
  say(
    `**④ 筛子有没有挡它的路**：筛子先替它丢掉 ${scored.length - passed.length} 行，剩下 ${passed.length} 行才是 Jev 真正看得到的。` +
      `这 ${passed.length} 行里有 ${passedPos.length} 条是你标该记的——**所以它一条都没被筛子误伤**，覆盖率低是它自己判的，不是筛子挡的。`,
  )
  say('')
  if (auc !== null && auc < 0.8) {
    say(
      auc < 0.6
        ? '> 读法：AUC 贴着 0.5，说明分数几乎排不出顺序——这时调阈值救不回多少，换阈值只是换一组错法。'
        : `> 读法：AUC ${auc.toFixed(2)} 是"有区分力但很弱"：正例大部分压不过负例，所以无论阈值定在哪里，多写就一定多错、少错就一定漏记。` +
            '调阈值只是在这条曲线上挪位置，要把曲线整体抬起来得改问法或改判定，不是改配置。',
    )
    say('')
  }
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
  say(`这一次的每一跑：${perRun.join('、')}（写对率/该记覆盖率）——**模型判定的数字必须带上这个区间读**。`)
  say('')
  say('所以 Jev 那一栏必须连同这个数字一起读：单次运行的写对率会随这些行上下浮动。')
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
  say('| minRemember / minImportance | Jev 写对率 | Jev 该记覆盖率 | Jev 写入数 | 规则判定 写对率 | 规则判定 该记覆盖率 |')
  say('|---|---|---|---|---|---|')
  for (const threshold of [0.1, 0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
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
  // The count is computed rather than written down: the previous fixed sentence said
  // "30 行已定标注" long after the labelled set had grown past 100, and a stale number
  // like that is exactly what a reader would use to dismiss the whole sweep.
  say(
    decided.length < 100
      ? `（阈值是配置，不是模型能力：同一批评分在低阈值下写得更多、写对率更低。扫描只有 ${decided.length} 行已定标注，**不要照单挑一个最好看的点**；等标注到 100 行以上再定。）`
      : `（阈值是配置，不是模型能力：同一批评分在低阈值下写得更多、写对率更低。这一次扫描有 ${decided.length} 行已定标注，其中**该记只有 ${positives} 句**——低阈值那几个点的该记覆盖率是由很小的分母撑起来的，所以看的是整条曲线的形状，不是单点。）`,
  )
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

// `REPORT_OUT` exists so a narrower report can be written *beside* the full one instead of
// over it: "just round5" was asked for, and the only way to produce it was to clobber the
// report covering every batch.
const outFile = process.env.REPORT_OUT?.trim() || join(labelDir, 'report.md')
await writeFile(outFile, `${out.join('\n')}\n`, 'utf8')

// Freezing a baseline is a deliberate act, not a side effect of running the report: if every
// run overwrote it, "compare against the baseline" would mean "compare against five minutes
// ago". `REPORT_BASELINE_OUT` names the file to freeze.
const baselineOut = process.env.REPORT_BASELINE_OUT?.trim()
if (baselineOut) {
  let flips: number | null = null
  if (jevRuns.length > 1) {
    flips = 0
    for (const [index, row] of rows.entries()) {
      const writes = jevRuns.map((run) => row.screensKept && applyGate(run[index]!, GATE).write)
      const yes = writes.filter(Boolean).length
      if (yes > 0 && yes < jevRuns.length) flips += 1
    }
  }
  await writeFile(
    baselineOut,
    `${JSON.stringify(
      {
        name: `${batches.join('+').replace(/\.csv/gu, '')}-${new Date().toISOString().slice(0, 10)}`,
        frozenAt: new Date().toISOString(),
        // Recorded so a later run can tell "the numbers moved because the question changed"
        // from "the numbers moved because the judge is stochastic".
        rememberQuestion: REMEMBER_QUESTION,
        minRemember: GATE.minRemember,
        dataset: {
          batches,
          labelled: rows.length,
          decided: decided.length,
          positives,
        },
        arms: Object.fromEntries(
          arms.map((arm) => {
            const score = scoreArm(arm, decided, indexOf)
            const m = metrics(score)
            return [arm.name, { written: score.tp + score.fp, tp: score.tp, fp: score.fp, fn: score.fn, precision: m.precision, recall: m.recall }]
          }),
        ),
        jev: {
          auc: aucValue,
          aucPerRun: jevRuns.map((run) => aucForRun(run, decided)),
          flips,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`已写出基线 ${baselineOut}`)
}
// The raw per-row scores go next to the report so the Jev numbers can be re-sliced (a
// different threshold, a different subset, an AUC over one task class) without paying for
// another round of model calls. Calling the judge is the expensive and stochastic part;
// reading its output should not require repeating it.
await writeFile(
  outFile.replace(/\.md$/u, '.scores.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      batches,
      repeats,
      model: jevModel,
      degraded: jevDegraded,
      rows: rows.map((row, index) => ({
        id: row.id,
        batch: row.batch,
        stratum: row.stratum,
        taskClass: row.taskClass,
        label: row.label,
        screensKeptNow: row.screensKeptNow,
        heuristic: heuristicRows[index] ? { type: heuristicRows[index]!.type, importance: heuristicRows[index]!.importance } : null,
        jev: jevRuns.map((run) => {
          const judgement = run[index]
          return judgement
            ? { type: judgement.type, remember: judgement.remember, importance: judgement.importance, by: judgement.by }
            : null
        }),
      })),
    },
    null,
    2,
  )}\n`,
  'utf8',
)
console.log(`\n已写出 ${outFile}`)
