/**
 * Write-precision harness: does the plugin remember the right things?
 *
 * The metric this exists for is the one the design promised and could not
 * measure: **write precision on real candidates**. The labelled set below is
 * drawn from what actually happened in live sessions — every "skip" case marked
 * `real` is a sentence the plugin really did write before the screens existed —
 * plus crafted positives so a judge that rejects everything cannot score well.
 *
 * Labels are human judgement, so they are debatable; each case carries the
 * reason it is labelled that way so the disagreement is inspectable rather than
 * hidden in a number.
 *
 * Run with a key to compare the model judge against the heuristic:
 *   TYPESAFE_API_KEY=... node eval/write-precision.ts
 * Without a key it reports the deterministic screens and the heuristic only.
 *
 * @module eval/write-precision
 */

import { candidateScore } from '../dsh/lib/extract.ts'
import { applyGate, createJudge, type Judgement } from '../dsh/lib/judge.ts'
import { createJevClient } from '../dsh/lib/jev.ts'
import { screenSentence, signatureOf } from '../dsh/lib/signals.ts'
import { matchTypeSignals } from '../dsh/lib/signals.ts'

/** One labelled candidate. `real` means it came out of a live session verbatim. */
interface Case {
  text: string
  should: 'remember' | 'skip'
  why: string
  real?: boolean
}

const CASES: Case[] = [
  // ---- positives: project-specific knowledge a future session needs ----
  { text: '必须用 pnpm 管理依赖，不要用 npm。', should: 'remember', why: '本项目的工具选型' },
  { text: '不要改动 data/ 目录下的任何文件。', should: 'remember', why: '本项目的硬约束' },
  { text: '我们决定用 SQLite 而不是 Postgres，因为只在自己机器上跑。', should: 'remember', why: '取舍及其原因' },
  { text: '提交前必须保证 node --test test/*.test.ts 全绿。', should: 'remember', why: '本项目的交付约定' },
  { text: '这个项目的测试要设 HOME=/tmp/dsh-test 才能跑，否则会被沙箱拒绝。', should: 'remember', why: '踩过的坑，可复现' },
  { text: '预发环境的数据库是只读的，只能查不能写。', should: 'remember', why: '环境事实 + 约束' },
  { text: '服务端口固定 8000，不要改。', should: 'remember', why: '项目事实' },
  { text: 'sqlite 写入失败：EDQUOT，磁盘配额用尽，要先清 .pnpm-store。', should: 'remember', why: '会重复出现的坑' },

  // ---- negatives: task instructions, chatter, one-off state, secrets ----
  { text: '请严格按下面步骤操作，不要做任何额外的事。', should: 'skip', why: '一次性任务指令', real: true },
  {
    text: '把第 2、3 步两个工具调用返回的原始结果（JSON 或文本，原样）贴出来，不要改写、不要总结成自己的话。',
    should: 'skip',
    why: '一次性任务指令',
    real: true,
  },
  { text: '- **不要动**：`README.md`、`docs/**`、`.gitignore`、`cordis.patch.yml`。', should: 'skip', why: '任务范围说明', real: true },
  { text: '- 新增 `tsconfig.json`，目标配置：', should: 'skip', why: '被截断的任务清单片段', real: true },
  { text: 'edit 失败：FS_SANDBOX_DENIED', should: 'skip', why: '一次性环境失败，不是可复现的坑', real: true },
  { text: 'web_fetch 失败：WEB_REDIRECT_BLOCKED', should: 'skip', why: '一次性环境失败', real: true },
  { text: '这个 dsh 的插件难道只能用 js 写吗', should: 'skip', why: '提问，不是结论', real: true },
  {
    text: 'TypeSafe key: apikey_0123456789abcdef0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    should: 'skip',
    why: '密钥，绝不能进记忆',
    real: true,
  },
  { text: '好的，继续。', should: 'skip', why: '寒暄' },
  { text: '今天下午开了个会。', should: 'skip', why: '与项目无关' },
  { text: '先跑一遍测试看看。', should: 'skip', why: '一次性指令' },
  { text: '这个函数有 3 个参数。', should: 'skip', why: '读代码即得，无项目特异性' },
]

const GATE = { types: ['constraint', 'pitfall', 'decision'], minImportance: 0.6, minRemember: 0.6, reviewOnConflict: true }

/**
 * Build the candidate shape the judge port expects.
 *
 * The score comes from the extractor itself rather than a copy of its formula, so
 * this harness cannot measure a judge against different inputs than the plugin
 * produces.
 */
function candidateOf(text: string) {
  const signals = matchTypeSignals(text)
  return { key: signatureOf(text), text, hintedType: signals.type, signalScore: candidateScore(text), signals: signals.hits }
}

interface Score {
  tp: number
  fp: number
  fn: number
  tn: number
}

/** Precision/recall from a confusion matrix, guarding the empty cases. */
function metrics(score: Score) {
  const precision = score.tp + score.fp === 0 ? 1 : score.tp / (score.tp + score.fp)
  const recall = score.tp + score.fn === 0 ? 1 : score.tp / (score.tp + score.fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1 }
}

const survivors: Case[] = []
let screened = 0
let positiveLostToScreens = 0
for (const item of CASES) {
  const screen = screenSentence(item.text)
  if (!screen.keep) {
    screened += 1
    if (item.should === 'remember') positiveLostToScreens += 1
    console.log(`  [screen:${screen.reason}] ${item.text.slice(0, 60)}`)
    continue
  }
  survivors.push(item)
}

console.log(`\n标注集 ${CASES.length} 条：确定性筛掉 ${screened} 条（其中正例 ${positiveLostToScreens} 条），进入判定 ${survivors.length} 条\n`)

const candidates = survivors.map((item) => candidateOf(item.text))
const jev = createJevClient({ config: { model: 'jev-latest', maxCandidates: 50 }, env: process.env })
const heuristic = createJudge({ config: { judge: 'heuristic', types: GATE.types } })

/** Run one judge over the survivors and print the confusion matrix. */
async function evaluate(name: string, rows: Judgement[], thresholds: number[]) {
  console.log(`==== ${name} (${rows.length} 行) ====`)
  for (const threshold of thresholds) {
    const score: Score = { tp: 0, fp: 0, fn: 0, tn: 0 }
    for (const [index, item] of survivors.entries()) {
      const gate = applyGate(rows[index], { ...GATE, minRemember: threshold })
      const wrote = gate.write
      if (item.should === 'remember' && wrote) score.tp += 1
      else if (item.should === 'remember' && !wrote) score.fn += 1
      else if (item.should === 'skip' && wrote) score.fp += 1
      else score.tn += 1
    }
    const m = metrics(score)
    const label = name.startsWith('Jev') ? `minRemember=${threshold}` : 'heuristic'
    console.log(
      `  ${label.padEnd(18)} TP=${score.tp} FP=${score.fp} FN=${score.fn} TN=${score.tn}  precision=${m.precision.toFixed(2)} recall=${m.recall.toFixed(2)} F1=${m.f1.toFixed(2)}`,
    )
  }
  for (const [index, item] of survivors.entries()) {
    const row = rows[index]
    const gate = applyGate(row, GATE)
    const verdict = gate.write ? 'write' : 'skip '
    const flag = (item.should === 'remember') === gate.write ? '  ' : '!!'
    console.log(
      `  ${flag} ${verdict} | want=${item.should.padEnd(8)} | remember=${row?.remember === null || row?.remember === undefined ? ' n/a' : row.remember.toFixed(2)} importance=${row?.importance.toFixed(2) ?? 'n/a'} type=${row?.type ?? 'n/a'}${gate.reason === 'ok' ? '' : ` (${gate.reason})`} | ${item.text.slice(0, 42)}`,
    )
  }
  console.log()
}

await evaluate('heuristic judge', heuristic.heuristics(candidates), [GATE.minRemember])
if (await jev.isAvailable()) {
  const judge = createJudge({ config: { judge: 'jev', types: GATE.types, judgeTimeoutMs: 5000 }, jev })
  // The model judge is not deterministic, which a second run of this script made
  // obvious: one candidate changed verdict between two identical runs, moving
  // precision by six points on a sixteen-row set. A single run therefore reports a
  // coin flip as a measurement, so repeats are supported and the flip rate is shown.
  const repeats = Math.max(1, Number(process.env.WP_REPEAT ?? '1') || 1)
  const runs: Judgement[][] = []
  for (let index = 0; index < repeats; index += 1) {
    const started = Date.now()
    const result = await judge.judge(candidates, { known: [], project: '/Users/rom/Documents/projectSDK/dsh-jev-memory' })
    console.log(
      `Jev 第 ${index + 1}/${repeats} 次：耗时 ${Date.now() - started}ms，应答模型 ${result.model ?? '(未知)'}，降级=${result.degraded ?? '无'}`,
    )
    runs.push(result.rows)
  }
  console.log()
  await evaluate('Jev judge', runs[0] ?? [], [0.3, 0.5, 0.6, 0.7])

  if (repeats > 1) {
    // A candidate sitting next to the threshold is the reason a single run is not a
    // measurement: one candidate here scored 0.58 in one run and crossed 0.6 in
    // another, which alone moved precision from 0.86 to 1.00. The spread is printed
    // for every candidate rather than only the ones that happened to flip, because
    // "did not flip in six runs" is not the same as "is stable".
    console.log(`==== 判定稳定性（${repeats} 次，阈值 ${GATE.minRemember}）====`)
    const spread = survivors.map((item, index) => {
      const remembers = runs.map((rows) => rows[index]?.remember).filter((value): value is number => typeof value === 'number')
      const writes = runs.map((rows) => applyGate(rows[index], GATE).write).filter(Boolean).length
      const low = remembers.length > 0 ? Math.min(...remembers) : Number.NaN
      const high = remembers.length > 0 ? Math.max(...remembers) : Number.NaN
      return { item, low, high, width: high - low, writes }
    })
    spread.sort((left, right) => right.width - left.width)
    for (const entry of spread.slice(0, 6)) {
      console.log(
        `  remember ${entry.low.toFixed(2)}–${entry.high.toFixed(2)}（波动 ${entry.width.toFixed(2)}）｜写入 ${entry.writes}/${repeats} 次｜${entry.item.text.slice(0, 34)}`,
      )
    }
    const flips = spread.filter((entry) => entry.writes > 0 && entry.writes < repeats).length
    const unstable = spread.filter((entry) => entry.width > 0).length
    console.log(`  越过阈值次数不一致的候选 ${flips}/${survivors.length}；分数有波动的候选 ${unstable}/${survivors.length}\n`)
  }
} else {
  console.log('未配置 TYPESAFE_API_KEY：只跑了启发式与确定性筛查。')
}
