/**
 * Harvest a labelled evaluation set from real session logs.
 *
 * Why this exists: `write-precision.ts` scores the judge against twenty
 * hand-picked cases — enough to catch a regression, far too little to claim a
 * number. The real distribution lives in the session logs already on disk, and
 * this tool turns it into a CSV a person can label in half an hour.
 *
 * Five deliberate choices, each of which came from looking at the data:
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
 *  - **One log per session, whichever generation it is.** A session directory may
 *    hold `session.jsonl.zstd` (the format before it gained a version suffix),
 *    `session.v3.jsonl.zstd` (what the harness writes now), or both after a
 *    migration. Hard-coding the v3 name silently dropped the 8 un-migrated
 *    sessions on this machine (92 human messages); reading both names for a
 *    migrated session would instead count one conversation twice — verified, the
 *    two files carry the same 207 human messages. So the newest generation in
 *    each directory is read, and nothing else.
 *
 * Dependency note: the logs are multi-frame zstd, which Node's
 * `zstdDecompressSync` refuses to read past the first frame, so this shells out
 * to the `zstd` CLI. Evaluation-time only — the plugin stays dependency-free.
 *
 * @module eval/harvest-candidates
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { extractCandidates } from '../dsh/lib/extract.ts'
import { signatureOf } from '../dsh/lib/signals.ts'
import { carriedLabels, csvField as field, parseCsv } from './lib/csv.ts'
import { readCodexTurns, readCursorTurns } from './lib/source.ts'
import { taskClassOf, type TaskClass } from './lib/task-class.ts'

/**
 * Sample sizes per stratum.
 *
 * Coding rows are split by whether they carry a type signal, because the two halves
 * behave differently and the headline is their weighted combination. Study and
 * office rows are not split: neither answers the primary question, they only show
 * whether a rate differs by what the session was about.
 */
const SAMPLE = {
  'coding-signal': 120,
  'coding-plain': 60,
  study: 60,
  office: 40,
  other: 40,
  vetoed: 30,
  /**
   * Sentences the question screen threw away, sampled separately.
   *
   * They used to be invisible: the extractor filtered them out before the harvester could
   * see them, so the one screen with the widest reach could not be checked against a
   * person's judgement at all. Twenty rows is enough to notice a rule that kills
   * requirements; a bigger quota would crowd out the strata that answer other questions.
   */
  question: 20,
}

type Stratum = keyof typeof SAMPLE


/**
 * The sample seed. Fixed, so the same pool and seed always choose the same rows;
 * with hash ranking the choice also survives the pool growing.
 */
const SAMPLE_SEED = 20260928

interface Row {
  key: string
  stratum: Stratum
  taskClass: TaskClass
  workspace: string
  kind: string
  hinted: string
  /** the extractor's own score, or '' for a screened-out sentence (no candidate). */
  score: string
  vetoReason: string
  seen: number
  text: string
}

/**
 * A stable 32-bit rank for a string (FNV-1a), so a row's fate depends only on itself.
 *
 * @param value - the string to rank.
 * @returns a rank in [0, 2^32).
 */
function hashRank(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Read one multi-frame zstd log through the CLI. */
function readLog(path: string): string {
  const result = spawnSync('zstdcat', [path], { maxBuffer: 1024 * 1024 * 512, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout ?? '') : ''
}

/**
 * A session log file name. `session.jsonl.zstd` carries no version suffix and is
 * generation 0; `session.v3.jsonl.zstd` is generation 3.
 */
const SESSION_LOG = /^session(?:\.v(\d+))?\.jsonl\.zstd$/u

/** One session log to read, with the format generation it belongs to. */
interface SessionLog {
  file: string
  generation: number
}

/** Session directories that could not be listed, instead of skipping them mutely. */
let skippedUnreadableDirs = 0
/** Session directories holding no log at all. */
let skippedLoglessSessions = 0
/** How many logs of each generation were read. */
const logsByGeneration: Record<number, number> = {}

/**
 * Every session log under the harness home, newest generation per session.
 *
 * The unsuffixed `session.jsonl.zstd` is generation 0, `session.vN.` is generation
 * N. Only the highest generation present in a directory is returned, so a migrated
 * session is counted once and an un-migrated one is no longer invisible.
 *
 * @returns one log per session directory, with its generation.
 */
async function sessionFiles(): Promise<SessionLog[]> {
  const root = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sessions')
  const files: SessionLog[] = []
  for (const workspace of await readdir(root)) {
    let ids: string[] = []
    try {
      ids = await readdir(join(root, workspace))
    } catch {
      skippedUnreadableDirs += 1
      continue
    }
    for (const id of ids) {
      const dir = join(root, workspace, id)
      let entries: string[] = []
      try {
        entries = await readdir(dir)
      } catch {
        skippedUnreadableDirs += 1
        continue
      }
      let best: { name: string; generation: number } | undefined
      for (const name of entries) {
        const match = SESSION_LOG.exec(name)
        if (match === null) continue
        const generation = match[1] === undefined ? 0 : Number(match[1])
        if (best === undefined || generation > best.generation) best = { name, generation }
      }
      if (best === undefined) {
        skippedLoglessSessions += 1
        continue
      }
      logsByGeneration[best.generation] = (logsByGeneration[best.generation] ?? 0) + 1
      files.push({ file: join(dir, best.name), generation: best.generation })
    }
  }
  return files
}

function ingest(scope: string, events: Array<{ seq: number; type: string; data: unknown }>): void {
  if (events.length === 0) return
  const taskClass = (): TaskClass => taskClassOf(scope)
  const workspace = scope
  turns += 1
    const candidates = extractCandidates(events as never, {
      onVeto: (sentence: string, reason: string | null) => {
        rawVetoes += 1
        const key = signatureOf(sentence)
        const existing = rows.get(key)
        if (existing) {
          existing.seen += 1
          return
        }
        // `noise` is chatter — sampling it would spend labelling time on "好的" — while
        // `question` gets its own stratum precisely so a widened rule can be checked.
        const stratum: Stratum = reason === 'question' ? 'question' : 'vetoed'
        population[stratum] += 1
        classPopulation[taskClass()] += 1
        rows.set(key, {
          key,
          stratum,
          taskClass: taskClass(),
          workspace,
          // The row keeps its real kind: writing `vetoed` here lost whether the line
          // came from a person or from a tool, and the report needs that to re-run
          // today's rules over a batch drawn under older ones.
          kind: reason === 'tool-failure-no-detail' ? 'tool-failure' : 'user',
          hinted: '',
          score: '',
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
      const cls = taskClass()
      const stratum: Stratum =
        cls === 'coding' ? (candidate.hintedType ? 'coding-signal' : 'coding-plain') : cls
      population[stratum] += 1
      classPopulation[cls] += 1
      classCandidates[cls] += 1
      rows.set(candidate.key, {
        key: candidate.key,
        stratum,
        taskClass: cls,
        workspace,
        kind: candidate.kind,
        hinted: candidate.hintedType ?? '',
        score: candidate.signalScore.toFixed(3),
        vetoReason: '',
        seen: 1,
        text: candidate.text,
      })
    }
}

const rows = new Map<string, Row>()
const population = {
  'coding-signal': 0,
  'coding-plain': 0,
  study: 0,
  office: 0,
  other: 0,
  vetoed: 0,
  question: 0,
} as Record<Stratum, number>
/** Deduped rows per task class, so the report can weight by what the corpus holds. */
const classPopulation: Record<TaskClass, number> = { coding: 0, study: 0, office: 0, other: 0 }
/** Rows that passed the screens, per class — the number worth quoting, unlike the one above. */
const classCandidates: Record<TaskClass, number> = { coding: 0, study: 0, office: 0, other: 0 }
/** `legacy` = only pre-versioned logs; anything else = every session. */
const frame = process.env.HARVEST_FRAME?.trim() ?? ''
let turns = 0
let humanMessages = 0
let rawCandidates = 0
let rawVetoes = 0

let skippedChildSessions = 0
/** DSH turns and human messages, captured before the other sources are added. */
let dshTurns = 0
let dshHumanMessages = 0
/** What each adapter read, so the "three agents" claim is checkable. */
let sourceReads: Record<string, unknown> = {}

for (const log of await sessionFiles()) {
  // `HARVEST_FRAME=legacy` restricts the run to sessions that only ever existed in
  // the pre-versioned format. They are the ones the old hard-coded file name could
  // not see, so they are labelled as their own batch instead of being folded into a
  // sample whose frame was a different corpus.
  if (frame === 'legacy' && log.generation !== 0) continue
  const raw = readLog(log.file)
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
  const flush = () => {
    ingest(workspace, turn)
    turn = []
  }
/**
 * Extract one turn, whichever agent it came from.
 *
 * One entry point on purpose: Codex and Cursor turns are converted into the same event
 * shape their adapters produce and then run through *this* extractor and *these*
 * screens, so a sentence is never judged by a second, subtler set of rules.
 *
 * @param scope - the workspace the turn belongs to.
 * @param events - the turn's events.
 */


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
dshTurns = turns
dshHumanMessages = humanMessages

/**
 * The other two agents on this machine.
 *
 * Skipped under `HARVEST_FRAME=legacy`: that frame means "the DSH sessions the old
 * filename bug hid", and these stores have no generations to reason about. Their skip
 * accounting travels into the snapshot, because an undocumented format that silently
 * returns nothing is indistinguishable from a store with nothing in it.
 */
if (frame !== 'legacy') {
  // Overridable so a test can point them at empty directories: without this the harness
  // tests read the developer's real Codex and Cursor stores, which makes them slow and
  // makes their outcome depend on the machine they run on.
  const codex = readCodexTurns({ codex: process.env.HARVEST_CODEX_DIR?.trim() || undefined })
  const cursor = readCursorTurns({ cursorDb: process.env.HARVEST_CURSOR_DB?.trim() || undefined })
  for (const turn of [...codex.turns, ...cursor.turns]) {
    humanMessages += turn.events.length
    ingest(turn.workspace ?? '?', turn.events)
  }
  sourceReads = {
    dsh: { turns: dshTurns, humanMessages: dshHumanMessages, skipped: {} },
    codex: { turns: codex.turns.length, humanMessages: codex.humanMessages, skipped: codex.skipped },
    cursor: { turns: cursor.turns.length, humanMessages: cursor.humanMessages, skipped: cursor.skipped },
  }
}

/**
 * Sample `count` rows from one pool, deterministically and stably.
 *
 * Rows are ranked by a hash of (seed, row key) and the lowest ranks win. The first
 * version shuffled the sorted pool with a single PRNG stream instead. That is
 * deterministic for a frozen corpus and worthless for a growing one: the log
 * directory gains sessions every day, one new row shifts the whole stream, and a
 * re-run replaces roughly half of the rows a person has already labelled —
 * measured at 50.4% here. Ranking each row independently means growth only
 * displaces the rows a newcomer actually outranks.
 *
 * @param pool - the stratum's rows.
 * @param count - how many to take.
 * @param seed - the sample seed, fixed per round.
 * @returns the chosen rows.
 */
function sample(pool: Row[], count: number, seed: number): Row[] {
  return [...pool]
    .map((row) => ({ row, rank: hashRank(`${seed}:${row.key}`) }))
    .sort((left, right) =>
      left.rank === right.rank ? (left.row.key < right.row.key ? -1 : 1) : left.rank - right.rank,
    )
    .slice(0, count)
    .map((entry) => entry.row)
}

/**
 * `HARVEST_ONLY_CLASS=coding` draws the sample from one task class only.
 *
 * A batch restricted to coding exists because the classes are wildly uneven in this
 * corpus: coding is about 150 rows while study is over 800, so one shared sample
 * either drowns the primary metric in revision questions or spends the person's
 * time on rows that do not answer it. A class-restricted batch is a census of what
 * matters, and each batch keeps its own file.
 */
const onlyClass = process.env.HARVEST_ONLY_CLASS?.trim() ?? ''

const chosen: Row[] = []
/** How many rows the sample was actually drawn from, per stratum. */
const poolSizes: Record<string, number> = {}
/** Screened-out rows per reason, so the vetoed pool can be read rather than trusted. */
const vetoedByReason: Record<string, number> = {}
/** Pasted-transcript lines, excluded from the vetoed pool (see below). */
let transcriptVetoes = 0
for (const stratum of Object.keys(SAMPLE) as Stratum[]) {
  const eligible = [...rows.values()].filter(
    (row) => row.stratum === stratum && (onlyClass === '' || row.taskClass === onlyClass),
  )
  // Transcript lines are excluded from the vetoed sample on purpose. They are 3,129
  // sentences of pasted ASR interview text — by far the largest veto reason, and the
  // person labelled 9 of them without a single "remember". Sampling 30 rows from a
  // pool they dominate would spend the labelling budget confirming what is already
  // known, and would crowd out the vetoes that are genuinely ambiguous
  // (task-instruction, payload, noise, question, tool-failure-no-detail). Their count
  // is still reported, because a screen that rejects thousands of sentences is a
  // claim worth being able to check.
  const pool =
    stratum === 'vetoed'
      ? eligible.filter((row) => row.vetoReason !== 'transcript')
      : stratum === 'question'
        ? eligible.filter((row) => row.vetoReason === 'question')
        : eligible
  if (stratum === 'vetoed') {
    transcriptVetoes = eligible.length - pool.length
    for (const row of pool) vetoedByReason[row.vetoReason] = (vetoedByReason[row.vetoReason] ?? 0) + 1
  }
  poolSizes[stratum] = pool.length
  chosen.push(...sample(pool, SAMPLE[stratum], SAMPLE_SEED))
}

const header = 'row,stratum,task_class,workspace,kind,hinted_type,signal_score,veto_reason,seen,id,text,label,note'

// `HARVEST_OUT_DIR` exists so a test can harvest into a temporary directory
// instead of writing under `eval/labels/`, where it would sit beside a real batch.
const outDir = process.env.HARVEST_OUT_DIR?.trim() || new URL('./labels/', import.meta.url).pathname
await mkdir(outDir, { recursive: true })
const outFile = join(outDir, process.env.HARVEST_OUT?.trim() || 'round1.csv')

let previous = ''
try {
  previous = await readFile(outFile, 'utf8')
} catch {
  /* no previous file: nothing to carry */
}
/** Labels already in the target file. Losing one of these is what must never happen. */
const own = carriedLabels(previous)
/** Own labels plus imported ones; own wins on a conflict. */
const carried = new Map(own)

// Labels from sibling batches are imported opportunistically: a person may already
// have judged the same sentence in `round1.csv`, and judging is the expensive part.
// They are not protected the way this file's own labels are — a batch that does not
// contain a row keeps that row's label in the file it came from.
const importedFrom = (process.env.HARVEST_CARRY_FROM?.trim() ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '')
const imported: string[] = []
for (const name of importedFrom) {
  let text = ''
  try {
    text = await readFile(join(outDir, name), 'utf8')
  } catch {
    continue
  }
  for (const [id, label] of carriedLabels(text)) {
    if (carried.has(id)) continue
    carried.set(id, label)
    imported.push(id)
  }
}

// A re-harvest is safe by construction: every label moves to the row with the same
// id. A label whose row does not survive the new sample would be destroyed, and
// that is the one thing this tool must never do quietly, so it stops instead.
//
// Only this file's own labels are protected. A label imported from a sibling batch
// stays in that batch, so a coding-only batch is not blocked by the study rows that
// a previous batch happens to contain.
const orphaned = [...own.keys()].filter((id) => !chosen.some((row) => row.key === id))
if (orphaned.length > 0 && process.env.HARVEST_FORCE?.trim() !== '1') {
  console.error(`重抽后有 ${orphaned.length} 行已标注的句子不在样本里，继续会丢掉这些标注：`)
  for (const id of orphaned.slice(0, 10)) console.error(`  ${id}`)
  console.error('确认要丢就设 HARVEST_FORCE=1。')
  process.exit(1)
}

/** How many of the sampled rows kept a label, from this file and from siblings. */
const keptOwn = chosen.filter((row) => own.has(row.key)).length
const keptImported = chosen.filter((row) => !own.has(row.key) && carried.has(row.key)).length

const lines = chosen.map((row, index) => {
  const kept = carried.get(row.key)
  return [
    String(index + 1),
    row.stratum,
    row.taskClass,
    row.workspace,
    row.kind,
    row.hinted,
    row.score,
    row.vetoReason,
    String(row.seen),
    row.key,
    row.text,
    kept?.label ?? '',
    kept?.note ?? '',
  ]
    .map((cell) => field(cell))
    .join(',')
})

await writeFile(outFile, [header, ...lines].join('\n') + '\n', 'utf8')

// Which version of the rules produced this batch, as a content hash of the two
// modules that decide it. Without it, a batch drawn before a screen changed and one
// drawn after look identical, and the difference is exactly what the person
// labelling is being asked to judge.
const ruleSource = await Promise.all(
  ['../dsh/lib/signals.ts', '../dsh/lib/extract.ts'].map((name) =>
    readFile(new URL(name, import.meta.url), 'utf8'),
  ),
)
const rulesHash = createHash('sha256').update(ruleSource.join('\n')).digest('hex').slice(0, 12)

// The snapshot is what makes a labelled batch reproducible: a later run can show
// whether the pool moved, instead of the report quietly resting on a frame that no
// longer exists. Row ids are recorded as hashes so the snapshot can be committed —
// a signature is the lowercased sentence itself, and the sentences are private.
const rowHashes = chosen.map((row) => createHash('sha256').update(row.key).digest('hex').slice(0, 16))
const snapshot = {
  generatedAt: new Date().toISOString(),
  frame: frame === 'legacy' ? 'legacy-only' : 'all-sessions',
  sampler: 'hash-rank-fnv1a',
  /** sha256 of signals.ts + extract.ts: the rules that produced this batch. */
  rulesHash,
  seed: SAMPLE_SEED,
  logs: Object.fromEntries(
    Object.entries(logsByGeneration).map(([generation, count]) => [`v${generation}`, count]),
  ),
  skippedChildSessions,
  skippedUnreadableDirs,
  skippedLoglessSessions,
  turns,
  humanMessages,
  candidates: {
    raw: rawCandidates,
    deduped:
      population['coding-signal'] +
      population['coding-plain'] +
      population.study +
      population.office +
      population.other,
  },
  vetoes: { raw: rawVetoes, deduped: population.vetoed, transcriptExcluded: transcriptVetoes },
  vetoedByReason,
  population,
  classPopulation,
  classCandidates,
  sources: sourceReads,
  poolSizes,
  sample: SAMPLE,
  ...(onlyClass === '' ? {} : { onlyClasses: onlyClass }),
  importedFrom,
  importedLabels: imported.length,
  labelledCarried: chosen.filter((row) => carried.has(row.key)).length,
  ownLabelsCarried: keptOwn,
  /** sha256(signature)[:16] per sampled row, in CSV order. */
  rowHashes,
}
const frameFile = outFile.replace(/\.csv$/u, '.frame.json')
await writeFile(frameFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

if (transcriptVetoes > 0) {
  console.log(`拼接转录被筛 ${transcriptVetoes} 行（不计入 vetoed 抽样池）；vetoed 池按原因：${Object.entries(vetoedByReason).map(([reason, count]) => `${reason} ${count}`).join('｜')}`)
}
// Printed as well as snapshotted: "the corpus is three agents" is a claim about the data,
// and a claim is worth being able to read off a run rather than only off a JSON file.
if (Object.keys(sourceReads).length > 0) {
  const parts = Object.entries(sourceReads).map(([name, entry]) => {
    const value = entry as { turns: number; humanMessages: number; skipped: Record<string, number> }
    const skipped = Object.entries(value.skipped ?? {})
      .map(([reason, count]) => `${reason} ${count}`)
      .join('｜')
    return `${name} ${value.turns} 回合/${value.humanMessages} 条${skipped === '' ? '' : `（跳过 ${skipped}）`}`
  })
  console.log(`来源：${parts.join('｜')}`)
}
console.log(`日志代数：${Object.entries(logsByGeneration).map(([gen, count]) => `v${gen} ${count} 个`).join('｜') || '无'}`)
if (skippedUnreadableDirs > 0) console.log(`无法列出的会话目录 ${skippedUnreadableDirs} 个（已计入上方代数之外）`)
if (skippedLoglessSessions > 0) console.log(`没有任何日志的会话目录 ${skippedLoglessSessions} 个`)
console.log(`跳过子会话 ${skippedChildSessions} 个（父代理的提示词不是人的话）`)
console.log(`回合 ${turns}｜人类消息 ${humanMessages}｜原始候选 ${rawCandidates} → 去重 ${population['coding-signal'] + population['coding-plain'] + population.study + population.office + population.other}｜原始被筛 ${rawVetoes} → 去重 ${population.vetoed}`)
console.log('\n总体（去重后）与抽样：')
for (const stratum of Object.keys(SAMPLE) as Stratum[]) {
  console.log(
    `  ${stratum.padEnd(14)} 总体 ${String(population[stratum]).padStart(4)}  可选 ${String(poolSizes[stratum] ?? 0).padStart(4)}  抽样 ${SAMPLE[stratum]}`,
  )
}
const codingTotal = population['coding-signal'] + population['coding-plain']
console.log(
  `\n编码组权重：带信号 ${(population['coding-signal'] / codingTotal * 100).toFixed(1)}%、不带信号 ${(population['coding-plain'] / codingTotal * 100).toFixed(1)}%（报告里按此加权）`,
)
console.log(
  `语料按任务类（通过筛子的候选）：${Object.entries(classCandidates).map(([cls, count]) => `${cls} ${count}`).join('｜')}`,
)

if (own.size > 0) console.log(`\n沿用本文件已有标注 ${keptOwn}/${own.size} 行`)
if (imported.length > 0) {
  console.log(`从 ${importedFrom.join('｜')} 导入标注 ${keptImported}/${imported.length} 行（按句子 id 对齐）`)
}
console.log(`\n已写出 ${outFile}`)
console.log(`语料快照 ${frameFile}`)
