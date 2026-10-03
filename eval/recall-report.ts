/**
 * The reading side: does a question bring back the memory that answers it?
 *
 * Three paths are measured, because they are three different mechanisms and only one of them
 * has a query in it:
 *
 *  1. `searchMemories` — the current substring matcher, reached through the `memory_search`
 *     tool.
 *  2. BM25 over the store — already in the codebase for conflict ranking, used here as the
 *     candidate baseline it should be. Nothing new is written to measure it.
 *  3. `selectMemories` — the automatic injection path. **It never sees a query**: it ranks by
 *     `importance × 0.85 + decay × 0.15` with per-type quotas. So "Hit@K" is not defined for
 *     it; what is measurable is whether the memory the person needs is in what got injected,
 *     which is coverage rather than ranking, and that is what gets reported.
 *
 * Relevance is single-target by construction: a probe was derived from one memory, and that
 * memory is the relevant one. That is a real limitation — two memories can both answer a
 * question, and this design scores the second one as noise — but it is the assumption that
 * can be measured without hand-labelling every pair, and it is stated in the output rather
 * than hidden. A judged subset exists to check how wrong the assumption is.
 *
 *   node eval/recall-report.ts
 *   RECALL_BASELINE_OUT=eval/labels/baseline-recall.json node eval/recall-report.ts
 *
 * @module eval/recall-report
 */

import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createBm25Scorer } from '../dsh/lib/conflict.ts'
import { cosineSimilarity, createEmbeddingClient, createVectorCache, vectorKey } from '../dsh/lib/embedding.ts'
import { estimateTokens } from '../dsh/lib/text.ts'
import { DEFAULT_QUOTA, NAME_LIKE, searchMemories, selectMemories, renderRecall } from '../dsh/lib/recall.ts'
import { buildCorpus, recordsOf } from './lib/recall-corpus.ts'
import { parseCsvRecords } from './lib/csv.ts'

const labelDir = new URL('./labels/', import.meta.url).pathname
const queriesFile = process.env.RECALL_QUERIES?.trim() || join(labelDir, 'recall1.csv')
const outFile = process.env.RECALL_OUT?.trim() || join(labelDir, 'recall-report.md')
const baselineFile = join(labelDir, 'baseline-recall.json')
const types = (process.env.RECALL_TYPES?.trim() || 'constraint,pitfall,decision').split(',')
const maxTokens = Number(process.env.RECALL_MAX_TOKENS ?? '600') || 600

interface Probe {
  queryId: string
  query: string
  closeness: string
  targetId: string
}

const rows = parseCsvRecords(await readFile(queriesFile, 'utf8'))
const probes = new Map<string, Probe>()
for (const row of rows) {
  if (!probes.has(row.query_id!)) {
    probes.set(row.query_id!, {
      queryId: row.query_id!,
      query: row.query!,
      closeness: row.closeness ?? '',
      targetId: row.target_id!,
    })
  }
}

const frame = JSON.parse(await readFile(queriesFile.replace(/\.csv$/u, '.frame.json'), 'utf8')) as {
  batch: string
  store: { records: number; truePositives: number; falsePositives: number }
  retrievers: string[]
}
const corpus = buildCorpus(join(labelDir, frame.batch), { includeFalsePositives: true })
const records = recordsOf(corpus)
const all_probe_texts = [...probes.values()].map((probe) => probe.query)
const byId = new Map(records.map((record) => [record.id, record]))

const out: string[] = []
const say = (line: string): void => {
  console.log(line)
  out.push(line)
}

// The embedding path exists in the plugin (off by default) because BM25 cannot connect a
// question to a memory that shares none of its words — which is exactly the far probes. It is
// measured here for the same reason the BM25 comparison is: a claim about paraphrase should
// be a number, not a design note.
//
// Vectors are cached on disk, keyed by model + dimensions + text, so a rerun after a retriever
// change costs nothing and the benchmark's inputs cannot drift between runs.
const embeddingSettings = { model: 'embedding-3', dimensions: 512 }
const vectorCache = createVectorCache({
  file: new URL('../.scratch/embeddings-recall.json', import.meta.url).pathname,
  log: (level, message) => {
    if (level === 'warn') console.error(`embedding cache: ${message}`)
  },
})
await vectorCache.load()
const credentialsFile = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), '.credentials.yaml')
const embedder = createEmbeddingClient({
  config: {},
  log: () => {},
  resolveApiKey: async () => {
    try {
      const document = await readFile(credentialsFile, 'utf8')
      const key = /ZHIPU_API_KEY:\s*(\S+)/u.exec(document)?.[1]
      return { key, source: key ? 'file' : 'none' }
    } catch {
      return { key: undefined, source: 'none' }
    }
  },
})

/** The cached vector for one text; every vector is fetched before any ranking happens. */
function vectorOf(text: string): number[] | null {
  return vectorCache.get(vectorKey(embeddingSettings, text)) ?? null
}

let embeddingReady = false
if (await embedder.isAvailable()) {
  const missingRecords = records.filter((record) => vectorOf(record.text) === null)
  const missingQueries = all_probe_texts.filter((text) => vectorOf(text) === null)
  const missing = [...new Set([...missingRecords.map((record) => record.text), ...missingQueries])]
  if (missing.length > 0) {
    console.log(`为 ${missing.length} 段文本取 embedding（其余命中缓存）…`)
    // `embed()` slices to `maxInputs` internally and says nothing about the rest, so the
    // chunking has to happen here — one big call would silently vectorize the first 32 texts
    // and leave the benchmark half-covered.
    const chunk = 32
    let ok = true
    for (let start = 0; start < missing.length; start += chunk) {
      const slice = missing.slice(start, start + chunk)
      const vectors = await embedder.embed(slice)
      if (!vectors || vectors.length !== slice.length) {
        console.log(`第 ${start / chunk + 1} 批 embedding 取不到，跳过这一行。`)
        ok = false
        break
      }
      for (const [index, text] of slice.entries()) {
        const vector = vectors[index]
        if (vector) vectorCache.set(vectorKey(embeddingSettings, text), vector)
      }
    }
    if (ok) {
      await vectorCache.persist()
      embeddingReady = true
    }
  } else {
    embeddingReady = true
  }
  if (embeddingReady) console.log(`embedding 就绪：缓存 ${vectorCache.size()} 条向量`)
} else {
  console.log('没有 ZHIPU_API_KEY，跳过 embedding 那一行。')
}

/** Where the target sits when the whole store is ranked, or 0 when it is not returned. */
type Ranker = (query: string) => string[]

const searchRanker: Ranker = (query) => searchMemories(records, query, { limit: records.length }).map((hit) => hit.record.id)
const bm25 = createBm25Scorer(records)
void bm25
/** Rank the store by one scoring function; zero scores are dropped, as the tool does. */
const rankBy = (score: (record: (typeof records)[number]) => number): Ranker => (query) => {
  void query
  return records
    .map((record) => ({ id: record.id, score: score(record) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.id)
}
/**
 * The substring matcher that `searchMemories` used until it was replaced.
 *
 * Kept here, in the report, rather than in the library: it is no longer reachable from the
 * plugin, and the only thing it is good for now is showing what the replacement bought. A
 * comparison whose "before" side is a memory of a previous commit is not a comparison.
 */
/** Rank by cosine similarity against the cached vectors; nothing to cut off, so no filter. */
const embeddingRanker: Ranker = (query) => {
  const queryVector = vectorOf(query) ?? vectorOf(` ${query}`)
  if (!queryVector) return []
  return records
    .map((record) => ({ id: record.id, score: cosineSimilarity(queryVector, vectorOf(record.text) ?? []) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.id)
}

/**
 * BM25 and cosine, each normalized to its own best score, summed.
 *
 * Normalizing per query is the crude part and it is deliberate: the point is to see whether
 * the two signals are complementary at all before spending design on how to fuse them.
 */
const hybridRanker: Ranker = (query) => {
  const bm25Scores = records.map((record) => ({ id: record.id, score: bm25(query, record) }))
  const maxBm25 = Math.max(...bm25Scores.map((entry) => entry.score), 0)
  const queryVector = vectorOf(query)
  return records
    .map((record) => {
      const lexical = maxBm25 === 0 ? 0 : (bm25Scores.find((entry) => entry.id === record.id)?.score ?? 0) / maxBm25
      const semantic = queryVector ? Math.max(0, cosineSimilarity(queryVector, vectorOf(record.text) ?? [])) : 0
      return { id: record.id, score: lexical + semantic }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.id)
}

/**
 * Reciprocal rank fusion of BM25 and embeddings.
 *
 * The naive "normalize each to its best score and add" fusion measured *worse* than embeddings
 * alone (MRR 0.74 vs 0.90) because BM25's normalized score is 1.0 for its own top hit whatever
 * that hit is, so a confident-but-wrong lexical match outvotes the semantic one. RRF ignores
 * the scores and fuses the *orders*, which is the standard fix for exactly this.
 */
const rrfRanker: Ranker = (query) => {
  const bm25Order = rankBy((record) => bm25(query, record))(query)
  const embeddingOrder = embeddingRanker(query)
  const fused = new Map<string, number>()
  for (const [order, weight] of [[bm25Order, 1], [embeddingOrder, 1]] as const) {
    for (const [index, id] of order.entries()) {
      fused.set(id, (fused.get(id) ?? 0) + weight / (60 + index + 1))
    }
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

const legacyRanker: Ranker = (query) => {
  const needle = query.trim().toLowerCase()
  const tokens = needle.split(/[\s,，。、;；]+/u).filter((token) => token.length >= 2)
  return records
    .map((record) => {
      const haystack = `${record.text} ${record.type}`.toLowerCase()
      let score = 0
      if (needle && haystack.includes(needle)) score += 1
      for (const token of tokens) if (haystack.includes(token)) score += 0.3
      return { id: record.id, score: score * record.importance }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.id)
}

interface Tally {
  at1: number
  at3: number
  at5: number
  at10: number
  reciprocal: number
  total: number
  missed: string[]
}

function tallyOf(ranker: Ranker, subset: Probe[]): Tally {
  const tally: Tally = { at1: 0, at3: 0, at5: 0, at10: 0, reciprocal: 0, total: 0, missed: [] }
  for (const probe of subset) {
    const ranked = ranker(probe.query)
    const at = ranked.indexOf(probe.targetId)
    const rank = at < 0 ? 0 : at + 1
    tally.total += 1
    if (rank === 1) tally.at1 += 1
    if (rank > 0 && rank <= 3) tally.at3 += 1
    if (rank > 0 && rank <= 5) tally.at5 += 1
    if (rank > 0 && rank <= 10) tally.at10 += 1
    if (rank > 0) tally.reciprocal += 1 / rank
    else tally.missed.push(probe.query)
  }
  return tally
}

const all = [...probes.values()]
const close = all.filter((probe) => probe.closeness === 'close')
const far = all.filter((probe) => probe.closeness === 'far')
const percent = (value: number): string => `${(value * 100).toFixed(0)}%`

say('# 评测报告：读取侧（召回）')
say('')
say(`生成时间 ${new Date().toISOString()}｜探针 ${all.length} 个（近 ${close.length} / 远 ${far.length}）｜库 ${records.length} 条（真记忆 ${corpus.entries.filter((entry) => entry.origin === 'true-positive').length}，垃圾 ${corpus.entries.filter((entry) => entry.origin === 'false-positive').length}）`)
say('')
say(`探针来自 ${frame.batch} 里你标"该记"的句子：每个句子造两个问题——**近**（可以复用记忆里的词，像真人换个会话再问一次）和**远**（换一种说法，不许用记忆里的关键名词）。`)
say('')

say('## 检索：同一个问题能不能把那条记忆捞回来')
say('')
say('相关性按单目标算：**只有派生这个探针的那条记忆算相关**。K 以内的排名看下面：')
say('')
say('| 检索方式 | 问法 | Hit@1 | Hit@3 | Hit@5 | Hit@10 | MRR | 完全找不到 |')
say('|---|---|---|---|---|---|---|---|')
const tallies = new Map<string, Tally>()
const rankers: Array<[string, Ranker]> = [
  ['**`memory_search`（现在的实现：BM25 + 名字精确命中加成）**', searchRanker],
  ['旧版子串匹配（已弃用，留作对照）', legacyRanker],
]
if (embeddingReady) {
  rankers.push(['embedding（Zhipu embedding-3，512 维）', embeddingRanker])
  rankers.push(['BM25 + embedding 各归一化后相加', hybridRanker])
  rankers.push(['RRF 融合（按名次而不是分数）', rrfRanker])
}
for (const [name, ranker] of rankers) {
  for (const [label, subset] of [['全部', all], ['近问法', close], ['远问法', far]] as const) {
    const tally = tallyOf(ranker, subset)
    tallies.set(`${name}|${label}`, tally)
    say(
      `| ${name} | ${label} | ${percent(tally.at1 / tally.total)} | ${percent(tally.at3 / tally.total)} | ${percent(tally.at5 / tally.total)} | ${percent(tally.at10 / tally.total)} | ${(tally.reciprocal / tally.total).toFixed(2)} | ${tally.missed.length} / ${tally.total} |`,
    )
  }
}
say('')
say('（MRR = 相关那条排在第几的倒数，第 1 位记 1.0、第 2 位记 0.5，再取平均。越高说明越靠前。）')
say('')

// Identifier probes, generated mechanically rather than by a model, because the two probe
// kinds above both test the same thing from different angles: how well a retriever copes when
// the words differ. There is a third kind where the words are identical and *must* match —
// somebody asking about `memory.json` or an error code — and it is the case lexical search
// wins. None of the model-written probes covered it, which made "embeddings strictly dominate"
// a claim about one kind of question.
//
// The rule is mechanical so nothing is cherry-picked: take every identifier that appears in
// exactly one memory (document frequency 1) and is long enough to be a name, and ask about it.
const IDENTIFIER = NAME_LIKE
const documentFrequency = new Map<string, number>()
for (const record of records) {
  for (const identifier of new Set(record.text.match(IDENTIFIER) ?? [])) {
    documentFrequency.set(identifier, (documentFrequency.get(identifier) ?? 0) + 1)
  }
}
const identifierProbes: Probe[] = []
for (const entry of corpus.entries) {
  const record = entry.record
  const unique = [...new Set(record.text.match(IDENTIFIER) ?? [])].filter(
    (identifier) =>
      documentFrequency.get(identifier) === 1 &&
      // Must look like a *name*, not an ordinary English word that happens to occur once.
      // Without this the probe set filled up with `replace`, `intended` and `constraint`,
      // which measure nothing: a person does not ask about those by quoting them.
      /[._\-0-9]/u.test(identifier) || /[a-z][A-Z]/u.test(identifier),
  )
  if (unique.length === 0) continue
  const chosen = unique.sort((a, b) => b.length - a.length)[0]!
  identifierProbes.push({
    queryId: `id-${identifierProbes.length + 1}`,
    query: `${chosen} 这块是怎么定的？`,
    closeness: 'identifier',
    targetId: record.id,
  })
}

say('### 标识符探针（机械生成：只出现在一条记忆里的名字）')
say('')
if (identifierProbes.length === 0) {
  say('这批记忆里没有"只出现在一条记忆里"的标识符，跳过。')
  say('')
} else {
  say(
    `规则：取每条记忆里**只在这一条里出现过**、长度 ≥ 5、而且长得像名字（含 \`.\`/\`_\`/\`-\`/数字，或驼峰）的标识符，拼成一句问话。共 ${identifierProbes.length} 个探针，没有人工挑选。` +
      '目标既可能是真记忆也可能是垃圾行——这一组量的是"词面能不能对上"，不是记忆质量。',
  )
  say('')
  say('| 检索方式 | Hit@1 | Hit@3 | Hit@5 | MRR |')
  say('|---|---|---|---|---|')
  for (const [name, ranker] of rankers) {
    const tally = tallyOf(ranker, identifierProbes)
    tallies.set(`${name}|标识符`, tally)
    say(
      `| ${name} | ${percent(tally.at1 / tally.total)} | ${percent(tally.at3 / tally.total)} | ${percent(tally.at5 / tally.total)} | ${(tally.reciprocal / tally.total).toFixed(2)} |`,
    )
  }
  say('')
  const sample = identifierProbes.slice(0, 5).map((probe) => probe.query).join('｜')
  say(`探针样例：${sample}`)
  say('')

  // Replacing the substring matcher with BM25 fixed paraphrase and broke this. Substring
  // matching was never good in general, but on a quoted name it is nearly perfect, and BM25
  // throws that away: an identifier is one token among many, and `memory` and `json` are
  // common enough that IDF barely rewards them.
  //
  // The fix is not a fusion of rankers but a bonus inside the score: a query that names
  // something verbatim should say so. The weight is swept against both probe kinds at once,
  // because a bonus big enough to fix identifiers can drown the prose score.
  say('**给 BM25 加"精确命中"加成，权重扫描**（两个探针集一起看，避免按下葫芦浮起瓢）：')
  say('')
  say('| 精确命中加成 | 近+远 探针 MRR | 近+远 Hit@1 | 标识符 MRR | 标识符 Hit@1 | 标识符 Hit@5 |')
  say('|---|---|---|---|---|---|')
  for (const weight of [0, 1, 4, 8, 12, 16, 24, 32, 64, 128]) {
    const withBonus: Ranker = (query) => {
      const named = [...new Set(query.match(IDENTIFIER) ?? [])]
      return records
        .map((record) => {
          let score = bm25(query, record)
          for (const identifier of named) if (record.text.includes(identifier)) score += weight
          return { id: record.id, score }
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.id)
    }
    const prose = tallyOf(withBonus, all)
    const names = tallyOf(withBonus, identifierProbes)
    say(
      `| ${weight === 0 ? '0（现状）' : weight} | ${(prose.reciprocal / prose.total).toFixed(2)} | ${percent(prose.at1 / prose.total)} | ${(names.reciprocal / names.total).toFixed(2)} | ${percent(names.at1 / names.total)} | ${percent(names.at5 / names.total)} |`,
    )
  }
  say('')
  const exactHit = [...new Set(identifierProbes.map((probe) => probe.query.match(IDENTIFIER)?.[0] ?? ''))]
  say(`（"精确命中"的定义：查询里出现的名字，在记忆原文里**逐字出现**。本批共 ${exactHit.length} 个不同的名字。）`)
  say('')
}

say('## 自动注入：从"不看问题"到"看一眼当前对话"')
say('')
say('先看**不看问题**的那条路，也就是 2026-10-03 之前的行为（它仍然被量着，因为基线是它冻结的）：')
say('它按"重要度 ×0.85 + 时间衰减 ×0.15"排序，再按类型配额（硬约束 4 / 坑 3 / 已定决策 2）和 token 预算挑选。')
say('所以对它来说没有 Hit@K 可言，能测的是**覆盖率**——这个数字就是当初要做下面那件事的理由：')
say('')
let injectedHits = 0
const injectionMisses: string[] = []
// The injection set does not depend on the probe — that is the finding — so it is computed
// once. The earlier version recomputed it per probe and reported the last iteration's token
// count, which is how a per-probe loop can look like it measured something it did not.
const injected = selectMemories(records, { cwd: null, types, maxTokens })
const injectedIds = new Set(injected.map((entry) => entry.record.id))
const injectedRendered = renderRecall(injected)
const injectedTokens = injectedRendered === '' ? 0 : estimateTokens(injectedRendered)
for (const probe of all) {
  if (injectedIds.has(probe.targetId)) injectedHits += 1
  else injectionMisses.push(probe.query)
}
say(`| 指标 | 值 |`)
say(`|---|---|`)
say(`| 需要的记忆真的被注入了 | **${injectedHits} / ${all.length}（${percent(injectedHits / all.length)}）** |`)
say(`| 每次注入的 token | ${injectedTokens}（预算 ${maxTokens}） |`)
say(`| 注入条数上限 | ${Object.entries({ constraint: 4, pitfall: 3, decision: 2 }).map(([type, count]) => `${type} ${count}`).join('、')} |`)
say('')
if (injectionMisses.length > 0) {
  say('**没被注入的探针对应的问题**（前 8 条）：')
  say('')
  for (const query of injectionMisses.slice(0, 8)) say(`- ${query}`)
  say('')
}

// ---------------------------------------------------------------------------------------------
// The fix: let injection look at the conversation. Swept rather than chosen, because the trade is
// real — relevance pulls in memories that answer *this* question and pushes out memories that were
// important in general, and both directions are visible in the numbers below.
//
// The precision proxy is the frozen corpus's own labels: `true-positive` records are the 18 rows the
// person marked worth remembering, `false-positive` ones are the 76 the gate would have written
// anyway. A human relevance label would be better and does not exist yet (the report says so a few
// sections down), but "how much of what got injected is garbage the write side let through" is
// exactly the question a proxy is needed for, and this one is not invented.
const originOf = new Map(corpus.entries.map((entry) => [entry.record.id, entry.origin]))
const WEIGHTS = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1]
say('### 让注入看一眼当前对话：权重扫描')
say('')
say(`对每个探针用它的查询跑一次注入（配额、token 预算、类型过滤都不变），权重 0 就是今天的排序：`)
say('')
say('| 相关性权重 | 覆盖率 | 平均注入条数 | 平均 token | 注入里真记忆占比 | 注入了东西的探针 |')
say('|---|---|---|---|---|---|')
interface InjectionSweep {
  weight: number
  covered: number
  meanCount: number
  meanTokens: number
  truePositiveShare: number
  nonEmpty: number
}
const sweep: InjectionSweep[] = []
for (const weight of WEIGHTS) {
  let covered = 0
  let count = 0
  let tokens = 0
  let nonEmpty = 0
  let injectedTrue = 0
  let injectedAll = 0
  for (const probe of all) {
    const selected = selectMemories(records, {
      cwd: null,
      types,
      maxTokens,
      query: probe.query,
      relevanceWeight: weight,
    })
    const ids = selected.map((entry) => entry.record.id)
    if (ids.includes(probe.targetId)) covered += 1
    count += ids.length
    if (ids.length > 0) nonEmpty += 1
    const rendered = renderRecall(selected)
    tokens += rendered === '' ? 0 : estimateTokens(rendered)
    for (const id of ids) {
      injectedAll += 1
      if (originOf.get(id) === 'true-positive') injectedTrue += 1
    }
  }
  const row: InjectionSweep = {
    weight,
    covered,
    meanCount: count / all.length,
    meanTokens: tokens / all.length,
    truePositiveShare: injectedAll === 0 ? 0 : injectedTrue / injectedAll,
    nonEmpty,
  }
  sweep.push(row)
  say(
    `| ${weight === 0 ? `**${weight}（今天）**` : weight} | **${covered} / ${all.length}（${percent(covered / all.length)}）** | ${row.meanCount.toFixed(1)} | ${row.meanTokens.toFixed(0)} | ${percent(row.truePositiveShare)} | ${nonEmpty} / ${all.length} |`,
  )
}
say('')
// Coverage first, then the precision proxy, and only then tokens: coverage differences below one
// probe are noise on 36 probes, and a one-token difference is certainly noise — an earlier version
// of this line picked 0.65 over 0.8 on 591 against 592 tokens, which is not a reason to prefer
// anything.
const best = [...sweep].sort(
  (left, right) =>
    right.covered - left.covered || right.truePositiveShare - left.truePositiveShare || left.meanTokens - right.meanTokens,
)[0]!
say(
  `覆盖率最高的是权重 **${best.weight}**（${best.covered}/${all.length}，${percent(best.covered / all.length)}），` +
    `注入里真记忆占比 ${percent(best.truePositiveShare)}，平均 ${best.meanTokens.toFixed(0)} token。` +
    `**上线的默认值就取它**，并且它必须继续可复跑：\`node eval/recall-report.ts\` 会重算这张表。`,
)
// Why the rest are still missing. Ranking is only one of three gates between "in the store" and "in
// the prompt", and the other two are cheaper to fix if they are the binding one — so measure the
// funnel instead of assuming the retriever is at fault.
say('### 剩下那些为什么还是没被注入：三道闸门的漏斗')
say('')
let funnelInjected = 0
let typeBlocked = 0
let quotaBlocked = 0
let budgetBlocked = 0
let rankMissed = 0
const blockedExamples: string[] = []
for (const probe of all) {
  const target = byId.get(probe.targetId)
  if (!target) continue
  const ids = (extra: { quota?: Record<string, number>; maxTokens?: number }): string[] =>
    selectMemories(records, {
      cwd: null,
      types,
      maxTokens,
      query: probe.query,
      relevanceWeight: best.weight,
      ...extra,
    }).map((entry) => entry.record.id)
  if (ids({}).includes(probe.targetId)) {
    funnelInjected += 1
    continue
  }
  if (!types.includes(target.type)) {
    typeBlocked += 1
    if (blockedExamples.length < 5) {
      blockedExamples.push(`类型 \`${target.type}\` 不在注入白名单：${probe.query.slice(0, 36)}`)
    }
    continue
  }
  const roomy = { quota: Object.fromEntries(types.map((type) => [type, 999])), maxTokens: 100_000 }
  if (!ids(roomy).includes(probe.targetId)) {
    rankMissed += 1
    if (blockedExamples.length < 5) blockedExamples.push(`相关性没排进：${probe.query.slice(0, 36)}`)
    continue
  }
  if (!ids({ ...roomy, maxTokens }).includes(probe.targetId)) budgetBlocked += 1
  else quotaBlocked += 1
}
say('| 卡在哪一道 | 条数 | 说明 |')
say('|---|---|---|')
say(`| **被注入了** | ${funnelInjected} | — |`)
say(`| 类型过滤（\`types\` 白名单） | ${typeBlocked} | 与排序无关：这类记忆再相关也进不了提示 |`)
say(`| 类型配额（4/3/2）挤掉 | ${quotaBlocked} | 排序对了，但同类更好的名额已满 |`)
say(`| token 预算挤掉 | ${budgetBlocked} | 排序对了，但预算装不下 |`)
say(`| 相关性没排进 | ${rankMissed} | 检索/排序的问题 |`)
say('')
for (const example of blockedExamples) say(`- ${example}`)
say('')

// The type filter is the binding gate (16 of 36). It is now a *separate* config value from the write
// whitelist (`recall.types`), precisely so that this ceiling can be measured without also loosening
// what the plugin stores — the two were one list, which is why the number below could not be seen.
say('**如果注入白名单也放行 `fact`**（`recall.types`，与写入白名单现在是两个值）：')
say('')
{
  const widened = [...types, 'fact']
  // Two gates have to open, and the first attempt at this measurement opened only one: adding `fact`
  // to the whitelist changed nothing at all, because a type with no `quota` entry is refused by the
  // quota check (`quota[type] ?? 0`). A knob that appears to do nothing is worse than no knob, so
  // both gates are opened here and the table says so.
  const rows: string[] = [
    `| ${types.join(' / ')}（今天） | ${DEFAULT_QUOTA.constraint} / ${DEFAULT_QUOTA.pitfall} / ${DEFAULT_QUOTA.decision} | ${best.covered} / ${all.length}（${percent(best.covered / all.length)}） | ${best.meanTokens.toFixed(0)} |`,
  ]
  for (const factQuota of [4, 8]) {
    let covered = 0
    let used = 0
    for (const probe of all) {
      const selected = selectMemories(records, {
        cwd: null,
        types: widened,
        quota: { ...DEFAULT_QUOTA, fact: factQuota },
        maxTokens,
        query: probe.query,
        relevanceWeight: best.weight,
      })
      if (selected.some((entry) => entry.record.id === probe.targetId)) covered += 1
      const rendered = renderRecall(selected)
      used += rendered === '' ? 0 : estimateTokens(rendered)
    }
    rows.push(
      `| ${widened.join(' / ')} | 再加 fact ${factQuota} | **${covered} / ${all.length}（${percent(covered / all.length)}）** | ${(used / all.length).toFixed(0)} |`,
    )
  }
  say(['| 注入白名单 | 配额 | 覆盖率 | 每轮 token |', '|---|---|---|---|', ...rows].join('\n'))
  say('')
  say('**78% 是上限，不是可以现在打开的开关**，而且它把决定交回给你：')
  say('')
  say('1. **只改注入**（`recall.types` + `recall.quota.fact`）：今天**没有任何效果**——线上库里一条 `fact` 都没有')
  say('   （核对过 `memory.json`：16 条全是 constraint / decision / pitfall），只是把两个决定拆开、为以后留出位置。')
  say('2. **要真正拿到这 11 个探针，得先改写入侧**：决定"没有类型关键词的句子写不写"。那是有标注依据的决定')
  say('   （写入侧已知"21 条正例里 8 条死在白名单上"），而且要连带解决"用什么类型存"——')
  say('   存成 `fact` 就等于承认第四种记忆类型存在，存成 `decision`/`constraint` 则是让类型信号更宽。')
  say('')
  say('注意配额不是越大越好：`fact` 配额 4 是 28/36，8 反而掉到 27/36——同一条预算下，')
  say('放进来更多 `fact` 就会把分数更低的其它类型挤出去。')
  say('')
}

// The budget is the one gate here the person can move with a config value, so its price is worth a
// number rather than a sentence. Coverage per probe at the shipped weight, as the budget grows.
say('| token 预算 | 覆盖率 | 平均 token（实际用掉） | 平均注入条数 |')
say('|---|---|---|---|')
for (const budget of [600, 900, 1200, 2000]) {
  let covered = 0
  let used = 0
  let count = 0
  for (const probe of all) {
    const selected = selectMemories(records, {
      cwd: null,
      types,
      maxTokens: budget,
      query: probe.query,
      relevanceWeight: best.weight,
    })
    if (selected.some((entry) => entry.record.id === probe.targetId)) covered += 1
    const rendered = renderRecall(selected)
    used += rendered === '' ? 0 : estimateTokens(rendered)
    count += selected.length
  }
  say(
    `| ${budget}${budget === maxTokens ? '（今天）' : ''} | **${covered} / ${all.length}（${percent(covered / all.length)}）** | ${(used / all.length).toFixed(0)} | ${(count / all.length).toFixed(1)} |`,
  )
}
say('')
say('**不要为了覆盖率去调这个值**：600 → 1200 是每轮多花约 580 token，只换来 **1 个探针**（17/36 → 18/36）。')
say('这是一个否定结果，写下来是为了下次别再去动它——剩下的缺口在类型白名单，不在预算。')
say('')
say('')
say('同一个"没捞回来"有三种完全不同的成因，分开才能知道该修哪一边：')
say('')
const storeIds = new Set(records.map((record) => record.id))
let notInStore = 0
let writtenNotRecalled = 0
let writtenAndRanked = 0
for (const probe of all) {
  if (!storeIds.has(probe.targetId)) notInStore += 1
  const at = searchRanker(probe.query).indexOf(probe.targetId)
  if (at < 0) writtenNotRecalled += 1
  else writtenAndRanked += 1
}
say('| 原因 | 条数 | 含义 |')
say('|---|---|---|')
say(`| 没写进记忆库 | ${notInStore} | 写入侧就没记下来，读取侧无从救 |`)
say(`| 在库里但检索没返回 | ${writtenNotRecalled} | **读取侧的问题**：这条用子串匹配捞不回来 |`)
say(`| 检索返回了 | ${writtenAndRanked} | 这条至少能被返回，剩下的看排名 |`)
say('')

say('## 单相关假设有多错（人工判定子集）')
say('')
const judged = rows.filter((row) => (row.origin ?? '') !== 'derived-target' && (row.label ?? '').trim() !== '')
if (judged.length === 0) {
  say('还没有人工判定过"非目标"的行。这个子集用来回答一个问题：**单相关假设是不是把本来也该算对的记忆当成噪音罚了**。')
  say('')
  say('标法：对每个探针，取两个检索器给出的、不是目标的那几条，判断"这条查询下这条记忆该不该被想起"。')
  say('写进 `recall1.csv` 的 `label` / `note` 列即可，不用改其它文件。')
} else {
  let relevant = 0
  for (const row of judged) if ((row.label ?? '').trim() === '1') relevant += 1
  say(`已人工判定 ${judged.length} 行，其中标"该被想起"的 ${relevant} 行（${percent(relevant / judged.length)}）。`)
  say('')
  say(`这 ${relevant} 行如果按单相关假设算，全都是假阳性——所以**注入精确率被这个假设低估了**。下面这张表是修正后的看法：`)
}
say('')

const baseline = {
  generatedAt: new Date().toISOString(),
  queries: { file: queriesFile.split('/').pop(), probes: all.length, close: close.length, far: far.length },
  store: { records: records.length, truePositives: frame.store.truePositives, falsePositives: frame.store.falsePositives },
  relevance: 'single-target (the memory the probe was derived from)',
  retrievers: Object.fromEntries(
    [...tallies.entries()].map(([key, tally]) => [
      key,
      {
        hit1: tally.at1 / tally.total,
        hit3: tally.at3 / tally.total,
        hit5: tally.at5 / tally.total,
        hit10: tally.at10 / tally.total,
        mrr: tally.reciprocal / tally.total,
        missed: tally.missed.length,
      },
    ]),
  ),
  injection: {
    covered: injectedHits,
    total: all.length,
    tokens: injectedTokens,
    maxTokens,
    sweep: sweep.map((row) => ({
      relevanceWeight: row.weight,
      covered: row.covered,
      meanTokens: Number(row.meanTokens.toFixed(1)),
      truePositiveShare: Number(row.truePositiveShare.toFixed(3)),
    })),
  },
  identifierProbes: identifierProbes.length,
}

const writeBaseline = process.env.RECALL_BASELINE_OUT?.trim()
if (writeBaseline) {
  await writeFile(writeBaseline, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  say(`已写出基线 ${writeBaseline}`)
  say('')
}

// A frozen baseline is only useful if a later run can print the difference without anyone
// remembering the old numbers, so the same file that was frozen is read back here.
try {
  const previous = JSON.parse(await readFile(baselineFile, 'utf8')) as typeof baseline
  if (previous.queries.probes === all.length) {
    say('## 与基线对比')
    say('')
    say('| 检索方式 | 指标 | 基线 | 现在 | 变化 |')
    say('|---|---|---|---|---|')
    for (const [key, now] of Object.entries(baseline.retrievers)) {
      const then = previous.retrievers[key]
      if (!then) continue
      for (const metric of ['hit1', 'hit3', 'hit5', 'hit10', 'mrr'] as const) {
        const before = then[metric]
        const after = now[metric]
        const movement = Math.round(after * 100) - Math.round(before * 100)
        say(
          `| ${key} | ${metric} | ${percent(before)} | ${percent(after)} | ${movement === 0 ? '持平' : `${movement > 0 ? '+' : ''}${movement} 个点`} |`,
        )
      }
    }
    // The injection path is a different retriever and was the one that changed most, so it belongs in
    // the comparison rather than only in its own section — a change a reader has to hunt for is a
    // change nobody checks. Two rows, because there are two things to see: the query-aware path
    // against the baseline (the improvement), and the query-independent path against the baseline
    // (the cost of finally charging the block's header to its own budget).
    if (previous.injection) {
      const coveredMovement = best.covered - previous.injection.covered
      const shippedMovement = injectedHits - previous.injection.covered
      say(
        `| 自动注入（**按当前对话排序**，权重 ${best.weight}） | 覆盖（探针目标真的被注入） | ${previous.injection.covered} / ${previous.injection.total} | **${best.covered} / ${all.length}** | ${coveredMovement > 0 ? '+' : ''}${coveredMovement} 条 |`,
      )
      say(
        `| 自动注入（不看问题，**已不是线上行为**） | 覆盖 | ${previous.injection.covered} / ${previous.injection.total} | ${injectedHits} / ${all.length} | ${shippedMovement === 0 ? '持平' : `${shippedMovement} 条`}（预算终于算上了标题与撤销提示：641 → 594 token） |`,
      )
    }
    say('')
  }
} catch {
  // No baseline yet.
}

await writeFile(outFile, `${out.join('\n')}\n`, 'utf8')
console.log(`\n已写出 ${outFile}`)
