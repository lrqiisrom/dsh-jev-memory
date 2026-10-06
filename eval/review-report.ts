/**
 * Score the review sheet: of everything the model proposed, what did it get right?
 *
 * This is a different measurement from `eval/report.ts`, and the difference is the point. That harness
 * scores the **extractor's candidates** — sentences, keyed by the extractor's own identity — which is
 * what the pipeline path consumes. This one scores the **model's own output** on the shipped path:
 * every item it wanted to keep and every item it threw away, with a person's verdict on each.
 *
 * Two things follow, one good and one honest:
 *
 *  - It reaches the miss rate. Nothing else can. A `worth=false` refusal looks identical whether the
 *    model correctly discarded a question or destroyed a convention, and only a person can say which.
 *  - It **cannot** find a memory the model never mentioned at all. A window where the model proposed
 *    nothing produces no rows, so a silent blank is invisible here. That is what the labelled sentence
 *    batches are for, and the two have to be read together.
 *
 * The buckets are the frozen definition in `eval/labels/README.md`, applied to the model's proposal set
 * instead of the extractor's:
 *
 *   |              | 人判该留 | 人判不该留 |
 *   | 插件留了     | 记对     | 误记       |
 *   | 插件丢了     | 漏记     | 判对（丢弃正确） |
 *
 * Run:
 *   node eval/review-report.ts                    # all review*.csv
 *   REVIEW_OUT=.scratch/review.md node eval/review-report.ts
 *
 * @module eval/review-report
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { parseCsvRecords } from './lib/csv.ts'

const labelDir = new URL('./labels/', import.meta.url).pathname
const outFile = process.env.REVIEW_OUT?.trim() || new URL('../.scratch/review-report.md', import.meta.url).pathname

interface Row {
  file: string
  row: string
  arm: string
  why: string
  text: string
  label: string
}

// One sheet at a time, and it says which. Summing `review*.csv` would add up two runs over the same
// windows and count them twice, and after a scope change the two runs are not even the same question.
const requested = process.env.REVIEW_FILE?.trim() ?? ''
const available = (await readdir(labelDir)).filter((name) => /^review.*\.csv$/u.test(name)).sort()
const files = requested === '' ? available.slice(-1) : available.filter((name) => name === requested)
if (files.length === 0) {
  console.log(requested === '' ? '没有找到复核表。' : `没有找到 ${requested}。现有：${available.join('、') || '（无）'}`)
  process.exit(0)
}

const rows: Row[] = []
for (const name of files) {
  for (const record of parseCsvRecords(await readFile(join(labelDir, name), 'utf8'))) {
    rows.push({
      file: name,
      row: record.row ?? '',
      arm: (record.arm ?? '').trim(),
      why: (record.why ?? '').trim(),
      text: record.text ?? '',
      label: (record.label ?? '').trim(),
    })
  }
}

const decided = rows.filter((row) => row.label === '1' || row.label === '0')
const unsure = rows.filter((row) => row.label === '?')
const blank = rows.filter((row) => row.label !== '1' && row.label !== '0' && row.label !== '?')

console.log(`复核表 ${files.join('、')}｜共 ${rows.length} 行`)
console.log(`已判 ${decided.length}（该留 ${decided.filter((row) => row.label === '1').length}、不该留 ${decided.filter((row) => row.label === '0').length}）｜拿不准 ${unsure.length}｜还没填 ${blank.length}`)

if (decided.length === 0) {
  console.log('\n还没有已判的行，先填 `label` 列（1 该留、0 不该留、? 拿不准）。')
  process.exit(0)
}

/** Where the plugin's decision and the person's verdict landed, for the four boxes. */
let keptRight = 0
let keptWrong = 0
let droppedRight = 0
let droppedWrong = 0
const wrong: string[] = []
for (const row of decided) {
  const want = row.label === '1'
  const kept = row.arm === 'written'
  if (want && kept) keptRight += 1
  else if (!want && kept) {
    keptWrong += 1
    wrong.push(`误记｜${row.text}`)
  } else if (want && !kept) {
    droppedWrong += 1
    wrong.push(`漏记（${row.why}）｜${row.text}`)
  } else droppedRight += 1
}

const shouldKeep = keptRight + droppedWrong
const keptTotal = keptRight + keptWrong
const pct = (part: number, whole: number): string => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(0)}%`)

const lines: string[] = ['# 复核表计分：模型提出的那些条目，判得对不对', '']
lines.push(`复核表 ${files.join('、')}｜已判 ${decided.length} 行（该留 ${shouldKeep}、不该留 ${decided.length - shouldKeep}）`)
lines.push('')
lines.push('| | 人判该留 | 人判不该留 |')
lines.push('|---|---|---|')
lines.push(`| **插件留了** | 记对 ${keptRight} | 误记 ${keptWrong} |`)
lines.push(`| **插件丢了** | 漏记 ${droppedWrong} | 丢弃正确 ${droppedRight} |`)
lines.push('')
lines.push(`- **写对率** = 记对 / 插件留的 = ${keptRight} / ${keptTotal} = **${pct(keptRight, keptTotal)}**（沉淀下来的里面有多少是对的）`)
lines.push(`- **该留覆盖率** = 记对 / 人判该留的 = ${keptRight} / ${shouldKeep} = **${pct(keptRight, shouldKeep)}**`)
lines.push('')
lines.push('## 判错的那些')
lines.push('')
for (const item of wrong) lines.push(`- ${item}`)
lines.push('')
lines.push('## 方法与局限')
lines.push('')
lines.push('- 只在**模型提出了条目**的窗口上有行。一个什么都没提出的窗口在这里没有行，所以**模型完全没想到的记忆，这张表查不出来**——那要靠句子级标注批次，两边要一起读。')
lines.push('- `?`（拿不准）不参与任何比率计算，单独计数。')
lines.push('- 报数时看绝对条数：分母还很小时，百分比会把 1 条的差别说成趋势。')

console.log(`\n记对 ${keptRight}、误记 ${keptWrong}、漏记 ${droppedWrong}、丢弃正确 ${droppedRight}`)
console.log(`写对率 ${pct(keptRight, keptTotal)}｜该留覆盖率 ${pct(keptRight, shouldKeep)}`)
if (blank.length > 0) console.log(`\n还有 ${blank.length} 行没填。`)
await mkdir(new URL('../.scratch/', import.meta.url).pathname, { recursive: true })
await writeFile(outFile, lines.join('\n'))
console.log(`详细写在 ${outFile}`)
