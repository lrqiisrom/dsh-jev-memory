/**
 * Ask Jev, row by row, whether the memory a row describes is worth keeping.
 *
 * The proposal this exists to test: the write path's model writes the summary, and Jev — a service
 * built for exactly this kind of verdict — decides whether to keep it. What it would replace is the
 * current rule, which is a **conjunction** (the model said it was worth it *and* the type is in a
 * whitelist). The last attempt to compose a conjunction like that is on record: two independent
 * thresholds had to line up, and when the judge was given more context its scores shifted down until
 * none of the eighteen positives cleared the second one and the gate wrote nothing at all.
 *
 * Three deliberate choices, each with a reason that is not "it was easy":
 *
 *  - **The question is the shipped one, verbatim.** `REMEMBER_QUESTION` is what the frozen
 *    sentence-level baseline was measured against, so this column is comparable with it. What changes
 *    is the input, not the standard — a new question would move the score distribution and make every
 *    threshold on the old table meaningless.
 *  - **The input is the summary *plus the verbatim span it quotes*.** Judging the summary alone asks
 *    whether it reads like a fact; the standard is whether *this person* asserted it, and only the
 *    source can show that. The source travels in `recent_conversation`, which is the field for "what
 *    was being discussed", so the question's subject stays the summary exactly as the shipped question
 *    expects it. Measured context for that choice: feeding the judge a *cleaned* sentence instead of
 *    the raw one did not help it (AUC 0.62 → 0.61, positives clearing the threshold 15/18 → 12/18), so
 *    whatever this column earns has to come from the summary being a better unit to judge, not from it
 *    being tidier prose.
 *  - **The answer is stored as the probability, not a verdict.** The shipped threshold (0.12) was
 *    tuned on a different input; baking it in here would hide the one thing worth looking at. The
 *    scorer sweeps it.
 *
 * Resumable: rows that already carry a value are skipped, so an interrupted run does not pay twice.
 *
 * Run:
 *   TYPESAFE_API_KEY=... node eval/jev-column.ts
 *   REVIEW_FILE=review-xxx.csv JEV_LIMIT=20 node eval/jev-column.ts
 *
 * @module eval/jev-column
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createJevClient, JEV_DEFAULTS, REMEMBER_QUESTION } from '../dsh/lib/jev.ts'
import { csvField, parseCsv } from './lib/csv.ts'
import { readSessions } from './lib/sessions.ts'

const labelDir = new URL('./labels/', import.meta.url).pathname
const requested = process.env.REVIEW_FILE?.trim() ?? ''
const available = (await readdir(labelDir)).filter((name) => /^review.*\.csv$/u.test(name)).sort()
const file = requested === '' ? available[available.length - 1] : requested
if (file === undefined || !available.includes(file)) {
  console.log(`没有找到复核表。现有：${available.join('、') || '（无）'}`)
  process.exit(0)
}
const limit = Number(process.env.JEV_LIMIT ?? '0') || 0

/**
 * The question, in two versions, so the two can be compared on the same rows and labels.
 *
 * The shipped one piles on exclusions — questions, chit-chat, the model's own words, someone else's,
 * a paste, anything that only applied once. Measured against the extraction stage's own answers, that
 * pile is doing almost nothing: of the 65 rows the extraction model called "not worth remembering", Jev
 * disagreed with **one**. And the attribution half (its own words / someone else's / a paste) fires on
 * 5 rows in 305 — where the *code* is what rejects them, and Jev overrode the clause twice anyway.
 *
 * What the pile does do is push the whole scale down: the shipped threshold is 0.12 while the positives
 * in a labelled batch only reach 0.19-0.46, so the cut sits at the floor of the distribution and a small
 * shift moves a batch of rows across it.
 *
 * So the trimmed version keeps the definition and drops the emphasis. Whether that changes *decisions*
 * rather than just the scale is the thing to measure — hence two columns, never a replacement. The
 * guarantee that a model's own words are not stored as the person's does not rest on this question: it
 * rests on `who === 'user'` being enforced in code.
 */
function trimQuestion(question: string): string {
  const cut = '发生在这一次对话里的事不算：提问、寒暄、状态汇报、临时安排。'
  const emphasis = '特别注意——即使内容是对的、即使确实和这个项目有关，只要它是**模型的回答**、**别人写的**、或者**粘贴进来的转录**，就不算；只要它**只管这一次**，也不算。'
  if (!question.includes(cut) || !question.includes(emphasis)) {
    throw new Error('删减失败：线上问句的措辞变了，先核对再改这一版')
  }
  return question.replace(cut, '').replace(emphasis, '').trim()
}

const VARIANTS: Record<string, { column: string; question: string; withSource: boolean }> = {
  /** The question as shipped, with the verbatim span attached — more than the plugin sends. */
  shipped: { column: 'jev_noul', question: REMEMBER_QUESTION, withSource: true },
  /** The question with the emphasis removed, source still attached. */
  trimmed: { column: 'jev_trim', question: trimQuestion(REMEMBER_QUESTION), withSource: true },
  /**
   * What the plugin actually sends: the shipped question, and **only the summary**.
   *
   * The verbatim span is not part of the live request — it is kept as provenance on the record and
   * never travels to the judge. Attaching it was my addition, and it makes the judge's task easier in
   * a way the plugin does not: judging a summary asks whether it reads like a fact, while judging the
   * summary *against the sentence it came from* asks whether the person actually asserted it. The
   * three reasons for dropping it back out: it costs tokens; the summary is the thing being stored and
   * the thing that will be recalled, so it is the honest unit to judge; and the raw span is extra
   * material the judge was not asked about, which is a source of noise.
   *
   * What is given up is stated rather than hidden: without the span, the judge cannot notice a summary
   * that drifted from its source. That check then rests entirely on the code — the summary's
   * identifiers must appear in a span that appears verbatim in the message — which was measured to
   * catch long Latin identifiers and little else.
   */
  live: { column: 'jev_live', question: REMEMBER_QUESTION, withSource: false },
}
const variant = VARIANTS[process.env.JEV_VARIANT?.trim() ?? 'shipped']
if (variant === undefined) throw new Error(`未知的问句版本：${process.env.JEV_VARIANT}（可选 shipped / trimmed）`)

const path = join(labelDir, file)
const records = parseCsv(await readFile(path, 'utf8'))
const header = records[0] ?? []
const at = (name: string): number => header.indexOf(name)
if (at('text') < 0 || at('window') < 0) throw new Error(`${file} 里找不到 text / window 列`)
// `let`, and assigned after the column is appended. The first version kept the `-1` from "the column is
// not there yet" and wrote every answer to `cells[-1]` — an array property that is not an element. The
// file therefore received nothing while the tool's own tally, read from that same property, happily
// reported 305 filled. A tool that reports success while writing nothing is worse than one that fails,
// so the write is now read back and checked.
let valueAt = at(variant.column)
if (valueAt < 0) {
  header.push(variant.column)
  valueAt = header.length - 1
  for (const cells of records.slice(1)) while (cells.length < header.length) cells.push('')
}

/** The workspace, so the judge applies the standard it applies live: *this project's* conventions. */
const sessions = await readSessions()
const cwdBySuffix = new Map<string, string | null>()
for (const session of sessions) cwdBySuffix.set(session.id.slice(-8), session.cwd)

// The credential document, which is how the plugin itself resolves this key when the environment does
// not carry it. Without this the tool only works if the caller exports the variable — and a harness
// that needs a variable the plugin does not need is a harness that silently reports "not configured".
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const credentials = await readFile(join(home, '.credentials.yaml'), 'utf8').catch(() => '')
const documentKey = /TYPESAFE_API_KEY:\s*(\S+)/u.exec(credentials)?.[1] ?? ''

const jev = createJevClient({
  config: { model: JEV_DEFAULTS.model, rememberQuestion: variant.question },
  env: process.env,
  resolveApiKey: async () => {
    const fromEnv = process.env.TYPESAFE_API_KEY?.trim()
    if (fromEnv) return fromEnv
    return documentKey === '' ? undefined : { key: documentKey, source: 'credential-document' }
  },
})

let filled = 0
let skipped = 0
let failed = 0
for (const cells of records.slice(1)) {
  const index = records.indexOf(cells)
  const already = (cells[valueAt] ?? '').trim()
  if (already !== '') {
    skipped += 1
    continue
  }
  if (limit > 0 && filled >= limit) break
  const summary = cells[at('text')] ?? ''
  const source = cells[at('source')] ?? ''
  const suffix = (cells[at('window')] ?? '').split(':')[0] ?? ''
  const project = cwdBySuffix.get(suffix) ?? null
  try {
    const result = await jev.decide({
      candidates: [{ key: `r${index}`, text: summary, hintedType: cells[at('type')] || null, signalScore: 1, signals: [] }],
      types: ['constraint', 'pitfall', 'decision'],
      known: [],
      partners: [],
      project,
      // The person's own words, when the variant carries them: the question becomes "did they assert
      // this", not "does this read like a fact". `live` omits them, as the plugin does.
      conversation: !variant.withSource || source === '' ? [] : [source],
    })
    const probability = result.rows[0]?.remember
    if (typeof probability !== 'number' || !Number.isFinite(probability)) {
      failed += 1
      continue
    }
    while (cells.length < header.length) cells.push('')
    cells[valueAt] = probability.toFixed(3)
    filled += 1
    process.stdout.write(`\r已问 ${filled} 条（跳过 ${skipped}、失败 ${failed}）`)
  } catch (error) {
    failed += 1
    console.log(`\n第 ${index} 行失败：${String(error).slice(0, 120)}`)
  }
}

console.log('')
await writeFile(path, `${records.map((cells) => cells.map((value) => csvField(value ?? '')).join(',')).join('\n')}\n`)
console.log(`已写回 ${path}（版本 ${process.env.JEV_VARIANT?.trim() ?? 'shipped'}，列 ${variant.column}）新填 ${filled}、跳过 ${skipped}、失败 ${failed}`)

const values = records
  .slice(1)
  .map((cells) => Number((cells[valueAt] ?? '').trim()))
  .filter((value) => Number.isFinite(value))
const share = (threshold: number): string => {
  const kept = values.filter((value) => value >= threshold).length
  return `${kept}/${values.length}`
}
console.log(`\nJev 判"值得"的比例，按不同门槛：0.12 → ${share(0.12)}｜0.3 → ${share(0.3)}｜0.5 → ${share(0.5)}`)
// Read the file back. The tally above comes from memory, and memory is exactly what was wrong the first
// time: it agreed with itself and disagreed with the file.
const written = parseCsv(await readFile(path, 'utf8'))
const persisted = written.slice(1).filter((cells) => (cells[valueAt] ?? '').trim() !== '').length
if (persisted !== values.length) {
  console.log(`\n⚠️ 写回后回读只看到 ${persisted} 个值，内存里是 ${values.length} 个 —— 这次结果不可信，请勿据此判断。`)
  process.exitCode = 1
} else {
  console.log(`复核表当前插件留下的比例，可以对照着看 arm 列。（已回读校验：${persisted} 个值都在文件里）`)
}
