/**
 * Normalization samples: what the canonical pass would do to real sentences.
 *
 * The canonical form is off for injection by default, on purpose — it changes what the
 * model is shown — and the deal was that a person reads samples before that switch is
 * turned on. This produces those samples from a batch, using the plugin's own prompt and
 * its own acceptance gate, so what is reviewed is what the plugin would actually do rather
 * than a second implementation of the idea.
 *
 * Offline and eval-only. The live pass goes through the host's `llm` service; this calls the
 * same provider over HTTP because there is no host context in a script.
 *
 *   node eval/normalize-samples.ts                     # round5.csv, the primary batch
 *   SAMPLES_BATCH=round4.csv SAMPLES_LIMIT=40 node eval/normalize-samples.ts
 *
 * Writes `.scratch/normalize-samples.md`, which is gitignored because the sentences are
 * private. The summary line is printed either way.
 *
 * @module eval/normalize-samples
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildNormalizePrompt, explainCanonical, NORMALIZE_DEFAULTS, NORMALIZE_SYSTEM } from '../dsh/lib/normalize.ts'
import { parseCsvRecords } from './lib/csv.ts'

const batch = process.env.SAMPLES_BATCH?.trim() || 'round5.csv'
const limit = Number(process.env.SAMPLES_LIMIT ?? '200') || 200
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const labelDir = new URL('./labels/', import.meta.url).pathname
const outFile = new URL('../.scratch/normalize-samples.md', import.meta.url).pathname
const endpoint = process.env.SAMPLES_ENDPOINT?.trim() || 'https://api.deepseek.com/chat/completions'
const model = process.env.SAMPLES_MODEL?.trim() || 'deepseek-chat'

/** The bearer token, read from the same document the plugin falls back to. */
async function apiKey(): Promise<string> {
  const document = await readFile(join(home, '.credentials.yaml'), 'utf8')
  const match = /DEEPSEEK_API_KEY:\s*(\S+)/u.exec(document)
  if (!match?.[1]) throw new Error('DEEPSEEK_API_KEY is not in the credential document')
  return match[1]
}

/**
 * One canonical-form attempt, exactly as the plugin makes it.
 *
 * @param key - the bearer token.
 * @param text - the sentence.
 * @returns the raw model output, or an error marker.
 */
async function normalize(key: string, text: string): Promise<{ output: string; error?: string }> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        system: NORMALIZE_SYSTEM,
        messages: [{ role: 'user', content: buildNormalizePrompt(text) }],
        max_tokens: 400,
      }),
    })
    if (!response.ok) return { output: '', error: `HTTP ${response.status}` }
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return { output: body.choices?.[0]?.message?.content ?? '' }
  } catch (error) {
    return { output: '', error: String(error) }
  }
}

const rows = parseCsvRecords(await readFile(join(labelDir, batch), 'utf8')).slice(0, limit)
const key = await apiKey()
const lines: string[] = [
  `# 规范化样例（${batch}，${rows.length} 行）`,
  '',
  `模型 \`${model}\`（线上走宿主 \`llm\` 服务，本脚本直连同一家）。闸门与插件完全一致：词元重叠 ≥ ${NORMALIZE_DEFAULTS.minOverlap}、长度 ≤ 原句 × ${NORMALIZE_DEFAULTS.maxRatio}。`,
  '',
  '**怎么看**：只关心「整理后有没有添加原句没有的信息」。有添加 = 闸门或 prompt 要收紧；把原句改得看不懂 = 同样要收紧。',
  '',
  '| 行 | 层 | 你之前标 | 原句 | 整理后 | 闸门 |',
  '|---|---|---|---|---|---|',
]
let accepted = 0
let refused = 0
const reasons: Record<string, number> = {}
const grew: number[] = []

for (const row of rows) {
  const result = await normalize(key, row.text ?? '')
  const decided =
    result.error === undefined
      ? explainCanonical(row.text ?? '', result.output, NORMALIZE_DEFAULTS)
      : { text: null, reason: result.error }
  const cell = (value: string): string => value.replace(/\|/gu, '\\|').replace(/\n/gu, ' ').slice(0, 150)
  if (decided.text === null) {
    refused += 1
    const why = decided.reason
    reasons[why] = (reasons[why] ?? 0) + 1
    lines.push(
      `| ${row.row} | ${row.stratum} | ${row.label || ''} | ${cell(row.text ?? '')} | ${cell(result.output)} | ❌ ${why} |`,
    )
  } else {
    accepted += 1
    grew.push(decided.text.length / Math.max(1, (row.text ?? '').length))
    lines.push(
      `| ${row.row} | ${row.stratum} | ${row.label || ''} | ${cell(row.text ?? '')} | ${cell(decided.text)} | ✅ |`,
    )
  }
}

const mean = grew.length === 0 ? 0 : grew.reduce((sum, value) => sum + value, 0) / grew.length
lines.push(
  '',
  `**合计**：接受 ${accepted}／拒绝 ${refused}`,
  refused === 0 ? '' : `拒绝原因：${Object.entries(reasons).map(([why, count]) => `${why} ${count}`).join('｜')}`,
  `接受后的长度比（整理后／原句）平均 ${mean.toFixed(2)}`,
  '',
)
await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, `${lines.filter((line) => line !== '').join('\n')}\n`, 'utf8')
console.log(`接受 ${accepted}／拒绝 ${refused}｜长度比均值 ${mean.toFixed(2)}｜已写出 ${outFile}`)
