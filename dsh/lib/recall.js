/**
 * Recall: choose which memories enter a session's prompt, and render them.
 *
 * Selection is deterministic on purpose. The judgement layer may rank, but the
 * quota per type, the recency decay, and the token budget are code — a memory
 * that is important stays in even when a model would have dropped it, and a
 * memory that is not in the configured types never appears at all.
 *
 * @module dsh/lib/recall
 */

import { estimateTokens } from './text.js'

/** Default per-type quota; the sum is the effective injection ceiling. */
export const DEFAULT_QUOTA = { constraint: 4, pitfall: 3, decision: 2 }

/** Age is a tie-breaker, not a filter: a 300-day-old constraint still beats a fresh fact. */
const HALF_LIFE_DAYS = 180

/**
 * @typedef {object} RecalledMemory
 * @property {import('./store.js').MemoryRecord} record - the chosen record.
 * @property {number} score - deterministic ranking score.
 * @property {number} ageDays - age in days at recall time.
 */

/**
 * Choose the memories a session should see.
 *
 * @param {import('./store.js').MemoryRecord[]} records - every live record.
 * @param {object} options - selection inputs.
 * @param {string|null} options.cwd - the session's working directory.
 * @param {string[]} options.types - enabled types.
 * @param {Record<string, number>} [options.quota] - per-type ceiling.
 * @param {number} [options.maxTokens] - total injection budget.
 * @param {number} [options.now] - clock.
 * @param {boolean} [options.includeNeedsReview] - whether suspected conflicts may enter.
 * @returns {RecalledMemory[]} the chosen memories, highest score first.
 */
export function selectMemories(records, options) {
  const {
    cwd,
    types,
    quota = DEFAULT_QUOTA,
    maxTokens = 600,
    now = Date.now(),
    includeNeedsReview = false,
  } = options

  const eligible = []
  for (const record of records) {
    if (!types.includes(record.type)) continue
    if (record.status !== 'active' && !(includeNeedsReview && record.status === 'needs-review')) continue
    if (!inScope(record, cwd)) continue
    const ageDays = Math.max(0, (now - record.createdAt) / 86_400_000)
    const decay = 0.5 ** (ageDays / HALF_LIFE_DAYS)
    // Importance dominates; decay only breaks near-ties, so a stale constraint
    // is never displaced by a trivial recent note.
    const score = record.importance * 0.85 + decay * 0.15
    eligible.push({ record, score, ageDays })
  }

  eligible.sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt)

  const perType = new Map()
  const chosen = []
  let tokens = 0
  for (const entry of eligible) {
    const used = perType.get(entry.record.type) ?? 0
    const limit = quota[entry.record.type] ?? 0
    if (limit <= 0 || used >= limit) continue
    const rendered = renderLine(entry)
    const cost = estimateTokens(rendered)
    if (tokens + cost > maxTokens) continue
    perType.set(entry.record.type, used + 1)
    tokens += cost
    chosen.push(entry)
  }
  return chosen
}

/**
 * Render the injection block. Returns an empty string when there is nothing to
 * add, which is how the prompt assembler learns to contribute no context at all.
 *
 * Every line carries its type, its id, and its date: a model that is told where
 * a memory came from can weigh it, and a human reading the transcript can audit
 * it. The trailing note tells the model how to retract one, because a memory
 * the user cannot get rid of is worse than no memory.
 *
 * @param {RecalledMemory[]} chosen - selection output.
 * @param {object} [options] - rendering options.
 * @param {boolean} [options.includeHelp] - append the retraction hint.
 * @returns {string} the prompt context text, or ''.
 */
export function renderRecall(chosen, options = {}) {
  if (!chosen || chosen.length === 0) return ''
  const lines = chosen.map((entry) => renderLine(entry))
  const header = '## 长期记忆（自动积累，按会话工作区召回）'
  const help = options.includeHelp === false ? '' : '\n（这些记忆由插件自动写入，可随时用 `memory_forget` 撤销或修正。）'
  return `${header}\n${lines.join('\n')}${help}`
}

/**
 * One injected line: `- [type] text (id, date)`.
 *
 * @param {RecalledMemory} entry - one selection entry.
 * @returns {string} the rendered line.
 */
export function renderLine(entry) {
  const date = new Date(entry.record.createdAt).toISOString().slice(0, 10)
  return `- [${entry.record.type}] ${entry.record.text} (${entry.record.id}, ${date})`
}

/**
 * Scope rule: a memory belongs to the workspace it was learned in, and global
 * memories (no cwd) belong to every workspace. Cross-workspace recall is what
 * would inject one project's conventions into another project's session, so it
 * is excluded by default rather than merged.
 *
 * @param {import('./store.js').MemoryRecord} record - the record.
 * @param {string|null} cwd - the session's working directory.
 * @returns {boolean} whether the record is in scope.
 */
export function inScope(record, cwd) {
  if (record.cwd === null || record.cwd === undefined) return true
  if (!cwd) return false
  return record.cwd === cwd
}

/**
 * Rank records for the `memory_search` tool: a cheap, deterministic substring
 * and token-overlap score. This is not semantic search and does not pretend to
 * be — the tool exists so a model can check its own long-term memory on demand,
 * and the store is small enough that exact matching is honest and fast.
 *
 * @param {import('./store.js').MemoryRecord[]} records - candidate records.
 * @param {string} query - the search text.
 * @param {object} [options] - search options.
 * @param {string|null} [options.cwd] - session working directory.
 * @param {number} [options.limit] - maximum results.
 * @returns {Array<{record: import('./store.js').MemoryRecord, score: number}>} ranked matches.
 */
export function searchMemories(records, query, options = {}) {
  const { cwd = null, limit = 20 } = options
  const needle = String(query ?? '').trim().toLowerCase()
  const tokens = needle.split(/[\s,，。、;；]+/u).filter((token) => token.length >= 2)
  const matches = []
  for (const record of records) {
    if (!inScope(record, cwd)) continue
    const haystack = `${record.text} ${record.type}`.toLowerCase()
    let score = 0
    if (needle && haystack.includes(needle)) score += 1
    for (const token of tokens) if (haystack.includes(token)) score += 0.3
    if (score > 0) matches.push({ record, score: score * record.importance })
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit)
}
