/**
 * Is this sentence the model's own words, pasted into the person's message?
 *
 * The labelled corpus says this is the largest single reason a row is marked "don't remember": 30
 * rows carry a note saying the text came from the model, and **none of them is marked "remember"**.
 * 24 of those 30 would still be let through today, because the role on the envelope is `user` —
 * pasting a model's answer into your own message is indistinguishable from writing it, at the level
 * of message metadata.
 *
 * Patterns cannot do it, and that was measured rather than assumed: over those 30 rows the best of
 * four candidate regexes caught 4, while the markdown one caught 2 and the assistant-voice one 0.
 * What distinguishes the text is not how it looks but that *the same session already said it*, which
 * is why the archive now keeps the assistant's messages.
 *
 * This script measures the detector before anything depends on it: how many of the 30 it finds, and
 * how many rows marked "remember" it would kill. The second number has to be zero.
 *
 *   node eval/echo-screen.ts
 *
 * Writes `.scratch/echo-screen.md` (private).
 *
 * @module eval/echo-screen
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { earlierMessages, readSessions, type Session } from './lib/sessions.ts'
import { parseCsvRecords } from './lib/csv.ts'

const labelDir = new URL('./labels/', import.meta.url).pathname
const outFile = new URL('../.scratch/echo-screen.md', import.meta.url).pathname
/** Below this many normalised characters a match is coincidence, not a quote. */
const MIN_CHARS = Number(process.env.ECHO_MIN_CHARS ?? '12') || 12
/** How much of the candidate has to appear in an earlier assistant message. */
const MIN_COVERAGE = Number(process.env.ECHO_MIN_COVERAGE ?? '0.6') || 0.6

/**
 * Collapse text for comparison: drop whitespace and punctuation, fold case.
 *
 * Whitespace goes because a paste is re-wrapped, and punctuation because the assistant's rendering
 * and the person's paste rarely agree on it. Chinese and latin both survive untouched otherwise.
 *
 * @param text - the raw text.
 * @returns the comparable form.
 */
export function normalizeForEcho(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[.,;:!?，。；：！？、"'"'“”‘’（）()\[\]{}<>《》—–-]/gu, '')
}

/**
 * Whether `text` is (mostly) something the session already said, before this point.
 *
 * Coverage is directional on purpose: the candidate has to be *contained* in what came earlier, not
 * the other way round. A long assistant answer that happens to contain a short phrase of the
 * person's is not an echo of the person.
 *
 * @param text - the candidate sentence.
 * @param earlier - everything the session said before it.
 * @param options - thresholds, injectable for tests.
 * @returns the match, or null.
 */
export function findEcho(
  text: string,
  earlier: ReadonlyArray<{ role: string; text: string }>,
  options: { minChars?: number; minCoverage?: number } = {},
): { role: string; coverage: number } | null {
  const minChars = options.minChars ?? MIN_CHARS
  const minCoverage = options.minCoverage ?? MIN_COVERAGE
  const needle = normalizeForEcho(text)
  if (needle.length < minChars) return null

  // Longest window first: the more of the candidate that matches, the less likely it is a
  // coincidence. A sliding window would be O(n·m); the sizes that matter here are small.
  for (let size = needle.length; size >= Math.max(minChars, Math.ceil(needle.length * minCoverage)); size -= 4) {
    for (let start = 0; start + size <= needle.length; start += 4) {
      const window = needle.slice(start, start + size)
      for (const message of earlier) {
        if (message.role === 'user') continue
        if (normalizeForEcho(message.text).includes(window)) {
          return { role: message.role, coverage: size / needle.length }
        }
      }
    }
  }
  return null
}

const rows: Array<{ id: string; text: string; label: string; note: string }> = []
for (const name of (await readdir(labelDir)).filter((entry) => /^round\d+\.csv$/u.test(entry)).sort()) {
  for (const record of parseCsvRecords(await readFile(join(labelDir, name), 'utf8'))) {
    const label = (record.label ?? '').trim()
    if (label !== '1' && label !== '0' && label !== '?') continue
    const id = (record.id ?? '').trim()
    if (id !== '') rows.push({ id, text: record.text ?? '', label, note: record.note ?? '' })
  }
}
const unique = new Map(rows.map((row) => [row.id, row]))
const labelled = [...unique.values()]
console.log(`已标行 ${labelled.length} 条，正在从会话里找它们的位置…`)

const sessions = await readSessions()
const located = new Map<string, { session: Session; seq: number }>()
for (const session of sessions) {
  for (const [key, seq] of session.keyToSeq) {
    if (unique.has(key) && !located.has(key)) located.set(key, { session, seq })
  }
}
console.log(`扫了 ${sessions.length} 个会话，定位到 ${located.size}/${labelled.length} 条`)

interface Finding {
  row: (typeof labelled)[number]
  verdict: 'echo' | 'clear' | 'unlocated'
  coverage: number
  /** the note says the text came from the model — the ground truth for this screen. */
  modelNote: boolean
}

const MODEL_NOTE = /模型的输出|模型的回答|模型先说的|模型给了|粘贴的模型|引用的模型|是模型说的/u
const findings: Finding[] = []
for (const row of labelled) {
  const place = located.get(row.id)
  const modelNote = MODEL_NOTE.test(row.note)
  if (!place) {
    findings.push({ row, verdict: 'unlocated', coverage: 0, modelNote })
    continue
  }
  // Self-check first: the located message has to actually contain this row's text. Without it, a
  // broken join looks exactly like a detector that finds nothing — which is what happened, with
  // `seq` resetting per turn so every row was located in the session's first turn.
  const here = place.session.messages.find((message) => message.seq === place.seq)
  const anchored = here !== undefined && normalizeForEcho(here.text).includes(normalizeForEcho(row.text).slice(0, 24))
  if (!anchored) {
    findings.push({ row, verdict: 'unlocated', coverage: 0, modelNote })
    continue
  }
  const match = findEcho(row.text, earlierMessages(place.session, place.seq))
  findings.push({ row, verdict: match ? 'echo' : 'clear', coverage: match?.coverage ?? 0, modelNote })
}

const locatedFindings = findings.filter((finding) => finding.verdict !== 'unlocated')
const noteRows = locatedFindings.filter((finding) => finding.modelNote)
const caught = noteRows.filter((finding) => finding.verdict === 'echo')
const positives = locatedFindings.filter((finding) => finding.row.label === '1')
const killed = positives.filter((finding) => finding.verdict === 'echo')
const falseAlarm = locatedFindings.filter((finding) => finding.verdict === 'echo' && finding.row.label === '0')

const lines: string[] = ['# 回显检测：这句话是不是模型自己说过的', '']
lines.push(`已标 ${labelled.length} 条，定位到 ${locatedFindings.length} 条｜阈值：≥${MIN_CHARS} 字、覆盖 ≥${MIN_COVERAGE}`)
lines.push('')
lines.push('| 指标 | 数值 |')
lines.push('|---|---|')
lines.push(`| note 说"这是模型的输出"的行（在可定位范围内） | ${noteRows.length} |`)
lines.push(`| 其中被检测出来的 | **${caught.length}** |`)
lines.push(`| 被误杀的"该记"行 | **${killed.length}**（必须为 0） |`)
lines.push(`| 被拦下的"不该记"行（它的价值所在） | ${falseAlarm.length} |`)
lines.push('')
lines.push('## note 说"模型的输出"、但**没**被检测出来的')
lines.push('')
for (const finding of noteRows.filter((entry) => entry.verdict !== 'echo')) {
  lines.push(`- [${finding.row.label}] ${finding.row.text.replace(/\|/gu, '\\|').slice(0, 70)}`)
  lines.push(`  - note: ${finding.row.note.slice(0, 80)}`)
}
lines.push('')
lines.push('## 被检测出来的（逐条）')
lines.push('')
for (const finding of caught) {
  lines.push(`- [cover ${(finding.coverage * 100).toFixed(0)}%] ${finding.row.text.replace(/\|/gu, '\\|').slice(0, 70)}`)
}
lines.push('')
lines.push('## 会误杀的高价值行（必须为空）')
lines.push('')
for (const finding of killed) lines.push(`- ${finding.row.text.replace(/\|/gu, '\\|').slice(0, 70)}`)
if (killed.length === 0) lines.push('（无）')

await mkdir(new URL('../.scratch/', import.meta.url).pathname, { recursive: true })
await writeFile(outFile, `${lines.join('\n')}\n`, 'utf8')
console.log(lines.slice(0, 12).join('\n'))
console.log(`\n已写出 ${outFile}`)
