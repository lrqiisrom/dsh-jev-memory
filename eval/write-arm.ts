/**
 * The shipped write path, on real windows: how much it produces, how much of it lands on a labelled
 * sentence, and what the rest is.
 *
 * Why this exists. Everything measured so far scores **sentences**: "given this candidate, should it
 * be remembered?" That is not what ships. What ships is one model call per conversation window, which
 * returns a set of memories, each with a source span it chose itself. So the first question is not the
 * precision — it is whether the output can be compared to the labels at all.
 *
 * Three numbers, in this order, because the later ones are only meaningful after the earlier ones:
 *
 *  1. **产出** — how many memories the path produced per window, and how many windows produced none.
 *  2. **对得上** — of those memories, how many overlap a labelled sentence by at least half. A memory
 *     that maps is scored exactly as before (`label=1` → 记对, `label=0` → 误记).
 *  3. **对不上** — the rest. Printed, not counted as an error: the model reads the window directly, so
 *     it can surface a sentence the harvesting extractor never proposed, and that is either a find or a
 *     fabrication. Nothing here decides which; a person has to look.
 *
 * Fidelity matters more than convenience, so nothing about the request is re-invented: the same system
 * prompt, the same window shape (5 rounds, answers capped at 200 characters), the same
 * `thinking: disabled`, the same 1500-token budget, and the same parser the plugin uses. A harness with
 * its own prompt would measure the harness.
 *
 * What the first run found (2026-10-06, 6 windows, 6 calls). Recorded because it changed what the
 * next measurement should be, which is the only reason to keep a number:
 *
 *  - **Production was the bottleneck, not mapping.** 21 items came back and survived the parser across
 *    the six windows; 2 were kept. So there was almost nothing to map (1 of 2 landed on a labelled
 *    sentence), and a mapping rate measured on n=2 is not a measurement.
 *  - **14 of the 21 were refused as `worth=false`, and the refusals are almost all questions**
 *    ("用户询问…", "用户在追问…"). That is the model following its instructions: the prompt says
 *    questions are not memories. It also means these windows genuinely had little to keep.
 *  - **The sample, not the path, produced the zeros.** Windows containing a labelled row come mostly
 *    from the study/interview corpus, where only 13% of rows are positives. The live ledger over the
 *    same period shows `items` 1-5 with `kept` almost equal to `items` — the coding windows this
 *    plugin actually runs on behave differently. A sample drawn by "contains a label" is a sample of
 *    the labelled corpus, not of what the plugin sees.
 *  - **One window was truncated at the token ceiling**: a 15,233-character window produced a
 *    3,462-character answer with `finish=length`, the JSON array never closed, and the whole window
 *    wrote nothing. `answerFailure` already reports that as `truncated` rather than `unparsable`, so
 *    the shipped ledger distinguishes it; this harness simply was not asking for `finish_reason`.
 *
 * Run:
 *   DSH_LIVE_ROUTE=yes node eval/write-arm.ts           # WRITE_ARM_LIMIT windows (default 6)
 *   DSH_LIVE_ROUTE=yes WRITE_ARM_LIMIT=12 node eval/write-arm.ts
 *
 * Output goes to `.scratch/write-arm.md`, which is gitignored: the windows are real sessions.
 *
 * @module eval/write-arm
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { MODEL_WRITE_SYSTEM, WRITE_TYPES, buildModelWritePrompt, explainModelWrite } from '../dsh/lib/modelwrite.ts'
import { parseCsvRecords } from './lib/csv.ts'
import { readSessions, type Session } from './lib/sessions.ts'

if (process.env.DSH_LIVE_ROUTE !== 'yes') {
  console.log('refusing to run: this makes real model calls. Set DSH_LIVE_ROUTE=yes to continue.')
  process.exit(0)
}

const limit = Number(process.env.WRITE_ARM_LIMIT ?? '6') || 6
const endpoint = process.env.LIVE_ENDPOINT?.trim() || 'https://api.deepseek.com/chat/completions'
/** The route the plugin is handed on this machine, per the ledger's `write-path` lines. */
const model = process.env.LIVE_MODEL?.trim() || 'deepseek-flash'
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const labelDir = new URL('./labels/', import.meta.url).pathname
const outFile = new URL('../.scratch/write-arm.md', import.meta.url).pathname
/** The shipped window: `conversationWindow` in the plugin's defaults. */
const ROUNDS = 5
const ANSWER_CHARS = 200
/** Overlap at or above this share of the shorter side counts as "this memory is about that sentence". */
const MATCH_FLOOR = 0.5

const credential = await readFile(join(home, '.credentials.yaml'), 'utf8')
const key = /DEEPSEEK_API_KEY:\s*(\S+)/u.exec(credential)?.[1] ?? ''
if (key === '') throw new Error('DEEPSEEK_API_KEY is not in the credential document')

// ---------------------------------------------------------------------------------------------
// The labelled rows, and where in the sessions they came from.

const byKey = new Map<string, { text: string; label: string }>()
for (const name of (await readdir(labelDir)).filter((entry) => /^round\d+\.csv$/u.test(entry)).sort()) {
  for (const record of parseCsvRecords(await readFile(join(labelDir, name), 'utf8'))) {
    const label = (record.label ?? '').trim()
    if (label !== '1' && label !== '0') continue
    const id = (record.id ?? '').trim()
    if (id !== '' && !byKey.has(id)) byKey.set(id, { text: record.text ?? '', label })
  }
}

const sessions = await readSessions()
/** Every labelled row, by session and seq — the mapping needs all of them, not just the sampled ones. */
const rowsAt = new Map<string, Array<{ text: string; label: string }>>()
const located: Array<{ session: Session; seq: number; text: string; label: string }> = []
for (const session of sessions) {
  for (const [key_, seq] of session.keyToSeq) {
    const row = byKey.get(key_)
    if (!row) continue
    const bucket = rowsAt.get(`${session.id}:${seq}`) ?? []
    bucket.push(row)
    rowsAt.set(`${session.id}:${seq}`, bucket)
    located.push({ session, seq, text: row.text, label: row.label })
  }
}

/**
 * The window the plugin would have handed the model, ending at `endSeq`.
 *
 * A faithful copy of `conversationWindowOf` in `dsh/index.ts`, which is a closure and cannot be
 * imported. Walking backwards: an assistant message is a candidate answer, and the first user message
 * ends a round, taking the *newest* answer collected so far as that round's reply. Copied rather than
 * approximated because the window shape was measured, and a different shape measures a different thing.
 */
function shippedWindow(session: Session, endSeq: number, rounds: number, answerChars: number): Array<{ seq: number; role: string; text: string }> {
  const upto = session.messages.filter((message) => message.seq <= endSeq)
  const collected: Array<{ seq: number; role: string; text: string }> = []
  let answers: Array<{ seq: number; text: string }> = []
  let found = 0
  for (let index = upto.length - 1; index >= 0 && found < rounds; index -= 1) {
    const message = upto[index]!
    if (message.role === 'assistant') {
      answers.push({ seq: message.seq, text: message.text })
      continue
    }
    if (message.role !== 'user') continue
    collected.push({ seq: message.seq, role: 'user', text: message.text })
    const answer = answers[0]
    if (answer && answerChars > 0) collected.push({ seq: answer.seq, role: 'assistant', text: answer.text.slice(0, answerChars) })
    answers = []
    found += 1
  }
  return collected.reverse()
}

/** Character overlap between two strings, by the longest common run — enough here, and symmetric. */
function overlapLength(left: string, right: string): number {
  const short = left.length <= right.length ? left : right
  const long = left.length <= right.length ? right : left
  let best = 0
  for (let start = 0; start < short.length; start += 1) {
    for (let end = short.length; end > start + best; end -= 1) {
      if (long.includes(short.slice(start, end))) {
        best = end - start
        break
      }
    }
  }
  return best
}

/** One entry per distinct window, so the same request is never paid for twice. */
const windowIdOf = (entry: { session: Session; seq: number }): string =>
  `${entry.session.id}:${shippedWindow(entry.session, entry.seq, ROUNDS, ANSWER_CHARS)[0]?.seq ?? entry.seq}`

const allWindows: typeof located = []
const seenWindows = new Set<string>()
for (const entry of located) {
  const windowId = windowIdOf(entry)
  if (seenWindows.has(windowId)) continue
  seenWindows.add(windowId)
  allWindows.push(entry)
}

// Round-robin across sessions rather than taking the first N in reading order. The first version did
// the latter and the whole sample came out of one session's last fifty messages: a "first look" that
// only ever looks at one conversation is a first look at one conversation.
const bySession = new Map<string, typeof located>()
for (const entry of allWindows) {
  const bucket = bySession.get(entry.session.id) ?? []
  bucket.push(entry)
  bySession.set(entry.session.id, bucket)
}
const sample: typeof located = []
for (let round = 0; sample.length < limit; round += 1) {
  let added = false
  for (const bucket of bySession.values()) {
    const entry = bucket[round]
    if (!entry) continue
    sample.push(entry)
    added = true
    if (sample.length >= limit) break
  }
  if (!added) break
}

console.log(
  `标注行 ${byKey.size} 条，定位到 ${located.length} 条，去重成 ${allWindows.length} 个窗口（分布在 ${bySession.size} 个会话），` +
    `跨会话轮流取 ${sample.length} 个（含该记行 ${sample.filter((entry) => entry.label === '1').length} 条）`,
)

// Everything above this line is free and offline, so it can be checked before paying for calls. The
// dry run prints the sample's shape and stops: a harness that only reveals its sample after spending
// money makes the sample the last thing anyone inspects.
if (process.env.WRITE_ARM_DRY === 'yes') {
  for (const entry of sample) {
    const window = shippedWindow(entry.session, entry.seq, ROUNDS, ANSWER_CHARS)
    const chars = window.reduce((sum, message) => sum + message.text.length, 0)
    const rows = window.flatMap((message) => rowsAt.get(`${entry.session.id}:${message.seq}`) ?? [])
    console.log(
      `  窗口 会话 ${entry.session.id.slice(-12)}… 结束于 seq ${entry.seq}｜${window.length} 条消息 ${chars} 字｜` +
        `该记行 ${rows.filter((row) => row.label === '1').length}、不该记行 ${rows.filter((row) => row.label === '0').length}`,
    )
  }
  console.log('\n试跑结束（WRITE_ARM_DRY=yes，没有调用模型）。')
  process.exit(0)
}

// ---------------------------------------------------------------------------------------------

const lines: string[] = ['# 发货路径跑一发：产出、对得上、对不上', '']
lines.push(`模型 \`${model}\`｜窗口 ${ROUNDS} 轮、答案截 ${ANSWER_CHARS} 字｜样本 ${sample.length} 个窗口`)
lines.push('')

let produced = 0
let windowsEmpty = 0
let refusals = 0
let kept = 0
/** Why an item the parser accepted is still not written. Three very different stories, kept apart. */
const whyNotWritten = { who: 0, worth: 0, type: 0 }
const rejectedExamples: string[] = []
/** Answers that hit the token ceiling instead of finishing: a budget fault, not a prompt fault. */
const cutOff: string[] = []
const wholeRefusals: string[] = []
let matchedPositive = 0
let matchedNegative = 0
const unmatched: Array<{ summary: string; source: string; why: string }> = []
const missed: Array<{ text: string; session: string; seq: number }> = []
const rowLines: string[] = []

for (const entry of sample) {
  const window = shippedWindow(entry.session, entry.seq, ROUNDS, ANSWER_CHARS)
  if (window.length === 0) continue
  const messages = window.map((message) => ({ seq: message.seq, role: message.role, text: message.text }))
  const started = Date.now()
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: MODEL_WRITE_SYSTEM },
        { role: 'user', content: buildModelWritePrompt(messages) },
      ],
      temperature: 0,
      max_tokens: 1500,
      thinking: { type: 'disabled' },
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const payload = (await response.json()) as Record<string, any>
  const raw = String(payload.choices?.[0]?.message?.content ?? '')
  const ms = Date.now() - started
  // `unparsable` and `truncated` are different faults with different fixes — one is the prompt, the
  // other is the budget — and they were conflated on the segmentation path once already. The provider
  // says which one this is; not asking it means guessing.
  const finish = String(payload.choices?.[0]?.finish_reason ?? 'unknown')
  if (finish !== 'stop') cutOff.push(`seq ${entry.seq}｜finish=${finish}｜窗口 ${window.reduce((sum, message) => sum + message.text.length, 0)} 字｜回答 ${raw.length} 字`)

  // Two counts, so every item is attributable: what the model returned, what survived the parser, and
  // what survived the filters the plugin applies afterwards. The gap between them is the refusal rate.
  let rawCount = 0
  try {
    const bracket = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)
    const parsed: unknown = JSON.parse(bracket)
    if (Array.isArray(parsed)) rawCount = parsed.length
  } catch {
    rawCount = 0
  }
  const decided = explainModelWrite(raw, messages)
  const accepted = decided.items ?? []
  if (decided.items === null) {
    refusals += 1
    // What a whole-answer refusal actually looked like, because `unparsable` covers "no JSON at all"
    // and "JSON that one escaping slip broke" and they need different fixes.
    wholeRefusals.push(`seq ${entry.seq}｜${decided.reason}｜${raw.slice(0, 220).replace(/\s+/gu, ' ')}`)
  }
  const writeable: typeof accepted = []
  for (const item of accepted) {
    // The three refusals mean different things and fixing them would take different work: `who` says
    // the model attributed the line to itself or to a paste, `worth` says the model judged it not
    // worth keeping, and `type` says the type whitelist refused a line the model *did* call worth
    // keeping. Reporting one combined number hides which of the three is doing the damage.
    if (item.who !== 'user') {
      whyNotWritten.who += 1
      if (rejectedExamples.length < 8) rejectedExamples.push(`who=${item.who}｜${item.summary.slice(0, 60)}`)
      continue
    }
    if (!item.worth) {
      whyNotWritten.worth += 1
      if (rejectedExamples.length < 8) rejectedExamples.push(`worth=false｜${item.summary.slice(0, 60)}`)
      continue
    }
    if (!(WRITE_TYPES as readonly string[]).includes(item.type)) {
      whyNotWritten.type += 1
      if (rejectedExamples.length < 8) rejectedExamples.push(`type=${item.type}｜${item.summary.slice(0, 60)}`)
      continue
    }
    writeable.push(item)
  }
  produced += writeable.length
  if (writeable.length === 0) windowsEmpty += 1
  kept += writeable.length

  rowLines.push(
    `\n## 窗口 ${entry.session.id.slice(-12)}… 结束于 seq ${entry.seq}｜${ms}ms｜带回 ${rawCount} 条 → 解析留 ${accepted.length} → 该写 ${writeable.length}` +
      (decided.items === null ? `（整份被拒：${decided.reason}）` : ''),
  )

  const touched = new Set<string>()
  for (const item of writeable) {
    const message = messages[item.messageIndex]
    const source = message ? message.text.slice(item.start, item.end) : ''
    const seq = item.seq
    const rows = rowsAt.get(`${entry.session.id}:${seq}`) ?? []
    // Longest overlap more than half of the shorter side: a memory that quotes most of a labelled
    // sentence, or that a labelled sentence mostly covers, is about it. Anything less is not claimed.
    let best: { text: string; label: string } | null = null
    let bestShare = 0
    for (const row of rows) {
      if (row.text === '') continue
      const share = overlapLength(source, row.text) / Math.min(source.length, row.text.length)
      if (share > bestShare) {
        bestShare = share
        best = row
      }
    }
    if (best && bestShare >= MATCH_FLOOR) {
      touched.add(`${seq}:${best.text}`)
      if (best.label === '1') matchedPositive += 1
      else matchedNegative += 1
      rowLines.push(`  - 对得上（标 ${best.label}，重叠 ${(bestShare * 100).toFixed(0)}%）：${item.summary.slice(0, 70)}`)
    } else {
      unmatched.push({
        summary: item.summary,
        source,
        why: rows.length === 0 ? '这个位置没有任何标注行' : `最近的重叠只有 ${(bestShare * 100).toFixed(0)}%`,
      })
    }
  }

  // 漏记: a labelled positive in this window that no produced memory landed on.
  for (const message of window) {
    for (const row of rowsAt.get(`${entry.session.id}:${message.seq}`) ?? []) {
      if (row.label !== '1') continue
      if (touched.has(`${message.seq}:${row.text}`)) continue
      missed.push({ text: row.text, session: entry.session.id, seq: message.seq })
    }
  }
}

/** Every labelled row inside the sampled windows, and how many of them are positives. */
const rowsInSample = sample.flatMap((entry) =>
  shippedWindow(entry.session, entry.seq, ROUNDS, ANSWER_CHARS).flatMap(
    (message) => rowsAt.get(`${entry.session.id}:${message.seq}`) ?? [],
  ),
)
const totalRows = rowsInSample.length
const positiveRows = rowsInSample.filter((row) => row.label === '1').length

const pct = (part: number, whole: number): string => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(0)}%`)
console.log(`\n产出：${produced} 条记忆，来自 ${sample.length - windowsEmpty}/${sample.length} 个窗口（${windowsEmpty} 个窗口一条都没产出）`)
console.log(`拒收：${refusals} 个窗口整份被拒`)
console.log(`对得上：记对 ${matchedPositive}、误记 ${matchedNegative}、对不上 ${unmatched.length}`)
console.log(`窗口里的标注行：${totalRows} 条（其中该记 ${positiveRows} 条）；没被任何产出覆盖的该记行 ${missed.length} 条`)
console.log(`映射率（能对上的产出 ÷ 全部产出）：${pct(matchedPositive + matchedNegative, produced)}`)
console.log(
  `解析通过但没写进去：who≠user ${whyNotWritten.who}、worth=false ${whyNotWritten.worth}、类型被拒 ${whyNotWritten.type}`,
)
if (cutOff.length > 0) {
  console.log(`\n没答完就被截断的窗口 ${cutOff.length} 个（这是预算问题，不是提示词问题）：`)
  for (const item of cutOff) console.log(`  · ${item}`)
}
if (wholeRefusals.length > 0) {
  console.log('\n整份被拒的原始回答（前 8 条）：')
  for (const item of wholeRefusals.slice(0, 8)) console.log(`  · ${item}`)
}
if (rejectedExamples.length > 0) {
  console.log('\n被过滤掉的例子：')
  for (const item of rejectedExamples.slice(0, 8)) console.log(`  · ${item}`)
}
if (unmatched.length > 0) {
  console.log('\n对不上的长这样（前 5 条）：')
  for (const item of unmatched.slice(0, 5)) console.log(`  · [${item.why}] ${item.summary.slice(0, 70)}`)
}
if (missed.length > 0) {
  console.log('\n该记却没被任何产出覆盖（前 3 条）：')
  for (const item of missed.slice(0, 3)) console.log(`  · ${item.text.slice(0, 70)}`)
}

lines.push('## 数出来的')
lines.push('')
lines.push(`| 量 | 值 |`)
lines.push(`|---|---|`)
lines.push(`| 产出记忆 | ${produced} 条 |`)
lines.push(`| 一条都没产出的窗口 | ${windowsEmpty} / ${sample.length} |`)
lines.push(`| 整份被拒的窗口 | ${refusals} |`)
lines.push(`| 其中被 token 上限截断 | ${cutOff.length} |`)
lines.push(`| 解析通过但 who≠user | ${whyNotWritten.who} |`)
lines.push(`| 解析通过但 worth=false | ${whyNotWritten.worth} |`)
lines.push(`| 解析通过但类型被拒 | ${whyNotWritten.type} |`)
lines.push(`| 对得上·记对 | ${matchedPositive} |`)
lines.push(`| 对得上·误记 | ${matchedNegative} |`)
lines.push(`| **对不上（新发现桶）** | **${unmatched.length}** |`)
lines.push(`| 映射率 | ${pct(matchedPositive + matchedNegative, produced)} |`)
lines.push(`| 窗口内标注行 | ${totalRows}（该记 ${positiveRows}） |`)
lines.push(`| 该记却没被覆盖 | ${missed.length} |`)
lines.push('')
lines.push('## 对不上的（要人看一眼：是真发现了，还是在编）')
lines.push('')
for (const item of unmatched) lines.push(`- [${item.why}] 总结：${item.summary}\n  - 它指的原文：${item.source.slice(0, 120)}`)
lines.push('')
lines.push('## 该记却没被任何产出覆盖')
lines.push('')
for (const item of missed) lines.push(`- ${item.text.slice(0, 120)}`)
lines.push('')
lines.push('## 整份被拒的原始回答')
lines.push('')
for (const item of wholeRefusals) lines.push(`- ${item}`)
lines.push('')
lines.push('## 被过滤掉的例子（who / worth / type）')
lines.push('')
for (const item of rejectedExamples) lines.push(`- ${item}`)
lines.push('')
lines.push('## 每个窗口')
lines.push(...rowLines)
lines.push('')
lines.push('## 方法与局限')
lines.push('')
lines.push(`- 请求与发货路径同形：同一 system、同 ${ROUNDS} 轮窗口、答案截 ${ANSWER_CHARS} 字、\`thinking: disabled\`、1500 token、\`temperature: 0\`。`)
lines.push('- 窗口按"结束于某条标注行所在的位置"取，所以样本必然含标注；随机窗口的映射率不适用这个口径。')
lines.push(`- 对上与否用"最长公共片段 ÷ 较短一方 ≥ ${MATCH_FLOOR}"判定，纯机械、可复现；换阈值会改变映射率，所以阈值写在报告里。`)
lines.push('- 只跑一发，样本小，**这些数不能当结论**；它要回答的是"映射率能不能支撑后面的评测"。')
await mkdir(new URL('../.scratch/', import.meta.url).pathname, { recursive: true })
await writeFile(outFile, lines.join('\n'))
console.log(`\n详细写在 ${outFile}`)
