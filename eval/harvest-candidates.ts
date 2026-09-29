/**
 * Harvest a labelled evaluation set from real session logs.
 *
 * Why this exists: `write-precision.ts` scores the judge against twenty
 * hand-picked cases — enough to catch a regression, far too little to claim a
 * number. The real distribution lives in the session logs already on disk, and
 * this tool turns it into a CSV a person can label in half an hour.
 *
 * Four deliberate choices, each of which came from looking at the data:
 *
 *  - **The plugin's own extractor does the work**, so a row is exactly what the
 *    plugin saw (`extractCandidates` + `screenSentence`). A separate parser would
 *    drift, and the labels would answer a question nobody asks.
 *  - **Screened-out sentences get their own stratum.** They are the only way to
 *    measure whether the deterministic screens kill good memories — a recall loss
 *    no write-side metric can see.
 *  - **Sessions are partitioned by task type** (an input from the person who ran
 *    them, not an inference). Mixing chat with coding flatters precision.
 *  - **Candidates are stratified by whether they carry a type signal.** Measured
 *    on this corpus: only 23% of coding candidates do. The rest are generic
 *    sentences that are *easy* to reject, so a sample dominated by them reports a
 *    precision that no one should believe. The headline number is the weighted
 *    combination, and both slices are reported.
 *
 * Dependency note: the logs are multi-frame zstd, which Node's
 * `zstdDecompressSync` refuses to read past the first frame, so this shells out
 * to the `zstd` CLI. Evaluation-time only — the plugin stays dependency-free.
 *
 * @module eval/harvest-candidates
 */

import { spawnSync } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { extractCandidates } from '../dsh/lib/extract.ts'
import { signatureOf } from '../dsh/lib/signals.ts'

/** Workspaces the user identified as coding work. Everything else is a control. */
const CODING_WORKSPACES = new Set(['/Users/rom/Documents/ProjectLab/interview', '/Users/rom/Documents/projectSDK'])

/**
 * Sample sizes per stratum.
 *
 * The signal-bearing coding slice is nearly exhausted on purpose: 155 rows exist,
 * so labelling 120 measures that slice almost exactly instead of estimating it.
 */
const SAMPLE = {
  'coding-signal': 120,
  'coding-plain': 40,
  control: 50,
  vetoed: 30,
}

type Stratum = keyof typeof SAMPLE

interface Row {
  key: string
  stratum: Stratum
  workspace: string
  kind: string
  hinted: string
  vetoReason: string
  seen: number
  text: string
}

/** Deterministic PRNG so the same corpus yields the same sample. */
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Read one multi-frame zstd log through the CLI. */
function readLog(path: string): string {
  const result = spawnSync('zstdcat', [path], { maxBuffer: 1024 * 1024 * 512, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout ?? '') : ''
}

/** Every session log under the harness home. */
async function sessionFiles(): Promise<string[]> {
  const root = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sessions')
  const files: string[] = []
  for (const workspace of await readdir(root)) {
    let ids: string[] = []
    try {
      ids = await readdir(join(root, workspace))
    } catch {
      continue
    }
    for (const id of ids) files.push(join(root, workspace, id, 'session.v3.jsonl.zstd'))
  }
  return files
}

const rows = new Map<string, Row>()
const population = { 'coding-signal': 0, 'coding-plain': 0, control: 0, vetoed: 0 } as Record<Stratum, number>
let turns = 0
let humanMessages = 0
let rawCandidates = 0
let rawVetoes = 0

let skippedChildSessions = 0

for (const file of await sessionFiles()) {
  const raw = readLog(file)
  if (raw === '') continue
  // Child sessions are skipped outright. In a delegated child the "user" message
  // is the parent agent's own prompt — the plugin's live rule already refuses to
  // learn from those, so harvesting them would ask a person to label sentences
  // they never wrote. That contamination is what made the first CSV confusing.
  try {
    const head: unknown = JSON.parse(raw.slice(0, raw.indexOf('\n')))
    const depth = (head as { delegationDepth?: number } | null)?.delegationDepth ?? 0
    if (depth > 0) {
      skippedChildSessions += 1
      continue
    }
  } catch {
    /* a log without a readable header is treated as a normal session */
  }
  let workspace = '?'
  let turn: Array<{ seq: number; type: string; data: unknown }> = []
  let seq = 0
  const isCoding = (): boolean => CODING_WORKSPACES.has(workspace)
  const flush = () => {
    if (turn.length === 0) return
    turns += 1
    const candidates = extractCandidates(turn as never, {
      onVeto: (sentence: string, reason: string | null) => {
        rawVetoes += 1
        const key = signatureOf(sentence)
        const existing = rows.get(key)
        if (existing) {
          existing.seen += 1
          return
        }
        population.vetoed += 1
        rows.set(key, {
          key,
          stratum: 'vetoed',
          workspace,
          kind: 'vetoed',
          hinted: '',
          vetoReason: reason ?? 'unknown',
          seen: 1,
          text: sentence,
        })
      },
    })
    for (const candidate of candidates) {
      rawCandidates += 1
      const existing = rows.get(candidate.key)
      if (existing) {
        existing.seen += 1
        continue
      }
      const stratum: Stratum = !isCoding() ? 'control' : candidate.hintedType ? 'coding-signal' : 'coding-plain'
      population[stratum] += 1
      rows.set(candidate.key, {
        key: candidate.key,
        stratum,
        workspace,
        kind: candidate.kind,
        hinted: candidate.hintedType ?? '',
        vetoReason: '',
        seen: 1,
        text: candidate.text,
      })
    }
    turn = []
  }

  for (const line of raw.split('\n')) {
    if (line === '') continue
    let event: { type?: string; cwd?: string; data?: unknown }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const type = event.type ?? ''
    if (type === 'session') {
      flush()
      workspace = String(event.cwd ?? '?')
      seq = 0
      continue
    }
    if (type === 'turn/start' || type === 'turn/end') {
      flush()
      seq = 0
      continue
    }
    if (type === 'user/message') {
      const source = (event.data as { source?: { kind?: string } } | undefined)?.source
      if (source?.kind === 'user') humanMessages += 1
    }
    if (type === 'user/message' || type === 'tool/call' || type === 'tool/result') {
      turn.push({ seq: seq++, type, data: event.data })
    }
  }
  flush()
}

/** Sample `count` rows from one pool, deterministically. */
function sample(pool: Row[], count: number, random: () => number): Row[] {
  const copy = [...pool].sort((a, b) => (a.key < b.key ? -1 : 1))
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const held = copy[index]
    copy[index] = copy[swap]
    copy[swap] = held
  }
  return copy.slice(0, count)
}

const random = mulberry32(20260928)
const chosen: Row[] = []
for (const stratum of Object.keys(SAMPLE) as Stratum[]) {
  const pool = [...rows.values()].filter((row) => row.stratum === stratum)
  chosen.push(...sample(pool, SAMPLE[stratum], random))
}

/** One CSV field, quoted when it contains a comma, a quote or a newline. */
function field(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

const header = 'row,stratum,workspace,kind,hinted_type,veto_reason,seen,id,text,label,note'
const lines = chosen.map((row, index) =>
  [String(index + 1), row.stratum, row.workspace, row.kind, row.hinted, row.vetoReason, String(row.seen), row.key, row.text, '', '']
    .map((cell) => field(cell))
    .join(','),
)

const outDir = new URL('./labels/', import.meta.url).pathname
await mkdir(outDir, { recursive: true })
const outFile = join(outDir, 'round1.csv')
await writeFile(outFile, [header, ...lines].join('\n') + '\n', 'utf8')

console.log(`跳过子会话 ${skippedChildSessions} 个（父代理的提示词不是人的话）`)
console.log(`回合 ${turns}｜人类消息 ${humanMessages}｜原始候选 ${rawCandidates} → 去重 ${population['coding-signal'] + population['coding-plain'] + population.control}｜原始被筛 ${rawVetoes} → 去重 ${population.vetoed}`)
console.log('\n总体（去重后）与抽样：')
for (const stratum of Object.keys(SAMPLE) as Stratum[]) {
  console.log(`  ${stratum.padEnd(14)} 总体 ${String(population[stratum]).padStart(4)}  抽样 ${SAMPLE[stratum]}`)
}
const codingTotal = population['coding-signal'] + population['coding-plain']
console.log(
  `\n编码组权重：带信号 ${(population['coding-signal'] / codingTotal * 100).toFixed(1)}%、不带信号 ${(population['coding-plain'] / codingTotal * 100).toFixed(1)}%（报告里按此加权）`,
)
console.log(`\n已写出 ${outFile}`)
