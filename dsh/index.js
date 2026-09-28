/**
 * dsh-jev-memory — typed, auditable long-term memory for the DeepSeek Harness.
 *
 * One sentence of positioning: `AGENTS.md` is memory a human writes; this is
 * memory that grows by itself, is recalled on demand, and can be audited line by
 * line. The harness persists sessions, searches them with FTS, and compacts
 * them — none of that survives as "what this project taught us"; that is the gap
 * this plugin fills.
 *
 * Four moving parts, and nothing else:
 *  1. a write hook on `agent/turn-stopping` that extracts candidates from the
 *     turn that just finished and persists the ones that pass a deterministic gate;
 *  2. a judgement layer (`lib/judge.js`) whose preferred implementation is Jev
 *     and whose fallback is deterministic signals, so the plugin works with no
 *     key and no network;
 *  3. a local, human-readable store plus an append-only ledger (`lib/store.js`);
 *  4. a prompt context (`systemPrompt.context`) that injects the top memories
 *     for the *current working directory* into every model step.
 *
 * Explicitly not in scope, and deliberately so: no UI, no vector store, no
 * "grow rules from failures" (that is a different plugin), no HITL triage, and
 * nothing that overlaps what `dsh-jev-tools` already covers (tool-output
 * trimming, injection screening, skill recommendation, delivery gates).
 *
 * @module dsh-jev-memory
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { extractCandidates, EXTRACT_DEFAULTS } from './lib/extract.js'
import { applyGate, createJudge, JUDGE_MODES } from './lib/judge.js'
import { createJevClient, JEV_DEFAULTS } from './lib/jev.js'
import { DEFAULT_QUOTA, inScope, renderRecall, searchMemories, selectMemories } from './lib/recall.js'
import { signatureOf } from './lib/signals.js'
import { createMemoryStore, MEMORY_TYPES } from './lib/store.js'
import { estimateTokens, excerpt } from './lib/text.js'

/** Plugin id; must match the `id` used by the composition row. */
export const name = 'jev-memory'

/**
 * Bumped on every behaviour change that the live process must pick up.
 *
 * It is written into the store's `start` ledger line so that "is the running
 * process using the code I just edited?" is answerable from the ledger alone —
 * a hot-reloaded module and a cached one otherwise look identical.
 */
export const version = '0.2.0'

/** Hard dependencies: without them there is nothing to register or inject into. */
export const inject = ['tools', 'systemPrompt']

/** Plugin defaults; every field is overridable from the composition row's `config`. */
export const DEFAULT_CONFIG = {
  /** Master switch. */
  enabled: true,
  /** Store directory; empty means `$DSH_HOME/jev-memory`. */
  root: '',
  /** Types the plugin will store. Start narrow: constraint / pitfall / decision. */
  types: ['constraint', 'pitfall', 'decision'],
  /** `auto` uses Jev when a key is configured, otherwise the heuristic. */
  judge: 'auto',
  /** Deterministic write threshold; replaces any "ask the model to decide". */
  minImportance: 0.6,
  /** A suspected conflict is stored but withheld from recall until a human confirms. */
  reviewOnConflict: true,
  /** Whether turn-end writes happen at all. */
  writeEnabled: true,
  /**
   * Skip delegated child sessions when learning.
   *
   * Measured reason, not caution: in a child session the `user/message` carrying
   * `source.kind === 'user'` is the *parent agent's* prompt, not a human's words.
   * The first live run wrote three of those task instructions as constraints
   * (write precision 1/4). A child's turns are still visible to the parent's own
   * hook, so nothing real is lost.
   */
  writeSkipSubagents: true,
  /** Budget for the whole turn-end write path; the hook is fail-open on expiry. */
  writeTimeoutMs: 2500,
  /** Per-call budget for the Jev request inside that path. */
  judgeTimeoutMs: 1800,
  /** How many known memories are shown to the judge for the conflict question. */
  knownForConflict: 20,
  /** Extraction overrides (see lib/extract.js). */
  extract: {},
  /** Recall (injection) settings. */
  recall: {
    enabled: true,
    /** Skip subagents: they inherit the parent's context anyway, and pay the tokens. */
    skipSubagents: true,
    /** Per-type ceiling and total token budget. */
    quota: { ...DEFAULT_QUOTA },
    maxTokens: 600,
  },
  /** Prompt context ordering; the harness runtime contexts occupy 110–120. */
  contextOrder: 130,
  /** Whether the agent-facing `memory_*` tools are registered. */
  tools: true,
  /** Jev transport settings (see lib/jev.js). */
  jev: {},
}

/**
 * Resolve user config into a complete, validated config object.
 *
 * Validation is manual rather than schemastery-based on purpose: the plugin is
 * zero-dependency so that its source can be mounted straight from a workspace
 * path with `--patch`. Invalid values fall back to defaults and are reported by
 * the caller rather than throwing, because a bad memory config must not stop the
 * harness from booting.
 *
 * @param {unknown} raw - the composition row's `config` value.
 * @returns {{config: typeof DEFAULT_CONFIG, problems: string[]}} resolved config and validation complaints.
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const problems = []
  const config = { ...DEFAULT_CONFIG, ...source, recall: { ...DEFAULT_CONFIG.recall, ...(source.recall ?? {}) }, jev: { ...source.jev } }

  if (!Array.isArray(source.types)) config.types = [...DEFAULT_CONFIG.types]
  else {
    const requested = source.types.filter((type) => MEMORY_TYPES.includes(type))
    if (requested.length !== source.types.length) problems.push('types: unknown type names were dropped')
    config.types = requested.length > 0 ? requested : [...DEFAULT_CONFIG.types]
  }

  if (!JUDGE_MODES.includes(config.judge)) {
    problems.push(`judge: unknown mode "${config.judge}"; using auto`)
    config.judge = 'auto'
  }
  for (const field of ['minImportance', 'writeTimeoutMs', 'judgeTimeoutMs', 'knownForConflict', 'contextOrder']) {
    if (!Number.isFinite(config[field])) {
      problems.push(`${field}: not a finite number; using the default`)
      config[field] = DEFAULT_CONFIG[field]
    }
  }
  config.minImportance = Math.min(1, Math.max(0, config.minImportance))
  config.extract = { ...EXTRACT_DEFAULTS, ...(source.extract ?? {}) }
  config.recall.quota = { ...DEFAULT_QUOTA, ...(source.recall?.quota ?? {}) }
  return { config, problems }
}

/**
 * Resolve the store root the same way the harness resolves its home:
 * an explicit config path, then `$DSH_HOME`, then `~/.dsh`.
 *
 * The harness's own helper (`dshHomePath`) would be the obvious call, but
 * importing it would make this plugin non-zero-dependency, and the resolution
 * rule is three lines. Kept in one place so the tradeoff stays visible.
 *
 * @param {string} configured - the configured root, possibly empty.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} an absolute store root.
 */
export function resolveStoreRoot(configured, env = process.env) {
  // A blank value is unset, mirroring how the harness treats an empty DSH_HOME
  // (so a blank override can never resolve the store to the current directory).
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit) return explicit
  const home = env?.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'jev-memory')
}

/**
 * Mount the plugin.
 *
 * @param {any} ctx - the Cordis plugin context.
 * @param {unknown} rawConfig - the composition row's `config`.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const { config, problems } = resolveConfig(rawConfig)
  const log = (level, message, detail) => {
    const sink = ctx.logger?.[level] ?? ctx.logger?.info
    try {
      sink?.call(ctx.logger, detail === undefined ? `jev-memory: ${message}` : `jev-memory: ${message} ${JSON.stringify(detail)}`)
    } catch {
      /* logging must never be the reason a turn fails */
    }
  }
  for (const problem of problems) log('warn', `config problem (${problem})`)

  if (!config.enabled) {
    log('info', 'disabled by config')
    return
  }

  const store = createMemoryStore({ root: resolveStoreRoot(config.root), log })
  const jev = createJevClient({ config: config.jev, log })
  const judge = createJudge({ config: { ...config, judgeTimeoutMs: config.judgeTimeoutMs }, jev, log })
  let ready = false

  void store
    .load()
    .then(({ loaded, recovered }) => {
      ready = true
      log('info', `ready: ${loaded} memories from ${store.root}${recovered ? ' (corrupt document was set aside)' : ''}`, {
        judge: judge.kind,
        types: config.types,
      })
      return store.ledger({ kind: 'start', version, judge: judge.kind, model: config.jev.model ?? JEV_DEFAULTS.model, loaded, recovered })
    })
    .catch((error) => log('warn', 'store load failed; memory stays empty this session', { error: String(error) }))

  // A stop or update must not drop an accepted write: flush the queue, then let
  // the fiber unwind.
  ctx.effect(() => () => {
    void store.flush()
  })

  // ---------------------------------------------------------------------------
  // Recall: inject the top memories for this session's workspace on every step.
  //
  // The callback is synchronous (the assembler cannot await), which is exactly
  // why the store keeps its whole index in memory: recall is a pure function of
  // that index plus the clock.
  // ---------------------------------------------------------------------------
  /** @type {Map<string, string>} last injected id-set per session, to avoid ledger spam. */
  const lastRecall = new Map()

  const recallText = (assembleCtx) => {
    if (!ready || !config.recall.enabled) return ''
    try {
      const agent = assembleCtx?.agent
      const header = agent?.session?.header
      if (config.recall.skipSubagents && (header?.delegationDepth ?? 0) > 0) return ''
      const cwd = header?.cwd ?? null
      const chosen = selectMemories(store.all(), {
        cwd,
        types: config.types,
        quota: config.recall.quota,
        maxTokens: config.recall.maxTokens,
        now: Date.now(),
      })
      if (chosen.length === 0) return ''

      const sessionId = String(header?.id ?? agent?.id ?? 'unknown')
      const signature = chosen.map((entry) => entry.record.id).join(',')
      if (lastRecall.get(sessionId) !== signature) {
        lastRecall.set(sessionId, signature)
        store.noteRecalled(chosen.map((entry) => entry.record.id))
        void store.ledger({
          kind: 'recall',
          sessionId,
          cwd,
          ids: chosen.map((entry) => entry.record.id),
          tokens: estimateTokens(renderRecall(chosen, { includeHelp: false })),
        })
      }
      return renderRecall(chosen)
    } catch (error) {
      log('warn', 'recall failed; injecting nothing', { error: String(error) })
      return ''
    }
  }

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'jev-memory:recall',
      order: config.contextOrder,
      text: recallText,
    })
  })

  // ---------------------------------------------------------------------------
  // Write: judge and persist candidates from the turn that just closed.
  //
  // `agent/turn-stopping` is serial and awaited before the boundary commits,
  // which is what makes a durable write possible at all — but it also means a
  // slow judge would sit in the user's critical path. Hence: a hard deadline, a
  // fail-open catch, and an abort signal borrowed from the turn.
  // ---------------------------------------------------------------------------
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!config.writeEnabled || !ready) return
    const turnHeader = agent?.session?.header
    if (config.writeSkipSubagents && (turnHeader?.delegationDepth ?? 0) > 0) {
      void store.ledger({ kind: 'skip', reason: 'subagent-session', sessionId: turnHeader?.id ?? null, turn })
      return
    }
    try {
      const outcome = await withDeadline(handleTurn(), config.writeTimeoutMs)
      if (outcome?.written) log('info', `remembered ${outcome.written} item(s) from turn ${turn}`, { model: outcome.model })
    } catch (error) {
      log('warn', `turn-end write skipped (fail-open): ${String(error)}`)
      void store.ledger({ kind: 'hook-error', turn, error: String(error) })
    }

    /** Read the turn's events, judge the candidates, and persist what passes the gate. */
    async function handleTurn() {
      const session = agent?.session
      const events = collectTurnEvents(session)
      const candidates = extractCandidates(events, {
        ...config.extract,
        onVeto: (sentence, reason) => void store.ledger({ kind: 'skip', reason: `veto:${reason}`, quote: excerpt(sentence, 120) }),
      })
      if (candidates.length === 0) return { written: 0, candidates: 0 }

      const fresh = []
      for (const candidate of candidates) {
        if (store.has(candidate.key)) {
          void store.ledger({ kind: 'skip', reason: 'duplicate', id: candidate.key, quote: candidate.quote })
          continue
        }
        fresh.push(candidate)
      }
      if (fresh.length === 0) return { written: 0, candidates: candidates.length, duplicates: candidates.length }

      const header = session?.header
      const cwd = header?.cwd ?? null
      const known = store
        .all()
        .filter((record) => inScope(record, cwd))
        .slice(0, config.knownForConflict)
        .map((record) => `[${record.type}] ${record.text}`)

      const { rows, model, degraded } = await judge.judge(fresh, { known, signal })
      let written = 0
      for (const candidate of fresh) {
        const judgement = rows.find((row) => row.key === candidate.key)
        const gate = applyGate(judgement, config)
        if (!gate.write) {
          void store.ledger({ kind: 'skip', reason: gate.reason, id: candidate.key, quote: excerpt(candidate.quote, 120) })
          continue
        }
        const now = Date.now()
        await store.put({
          id: candidate.key,
          type: judgement.type,
          text: candidate.text,
          cwd,
          importance: judgement.importance,
          status: gate.review ? 'needs-review' : 'active',
          source: { sessionId: header?.id ?? agent?.id ?? null, seq: candidate.seq, quote: candidate.quote, at: now },
          createdAt: now,
          updatedAt: now,
          recalls: 0,
          lastRecalledAt: null,
          judge: { kind: judgement.by, confidence: judgement.confidence, conflict: judgement.conflict, mode: judge.mode, model },
        })
        void store.ledger({
          kind: 'write',
          id: candidate.key,
          type: judgement.type,
          importance: judgement.importance,
          by: judgement.by,
          model,
          conflict: judgement.conflict,
          status: gate.review ? 'needs-review' : 'active',
          cwd,
          source: { sessionId: header?.id ?? null, seq: candidate.seq, quote: excerpt(candidate.quote, 160) },
          signals: judgement.signals,
        })
        written += 1
      }
      return { written, candidates: candidates.length, duplicates: candidates.length - fresh.length, model, degraded }
    }
  })

  // ---------------------------------------------------------------------------
  // Tools: the agent's own handles on its long-term memory.
  // ---------------------------------------------------------------------------
  if (!config.tools) return

  /** @returns {string|null} the calling agent's working directory. */
  const cwdOf = (exec) => exec?.agent?.session?.header?.cwd ?? null

  ctx.tools.register({
    name: 'memory_search',
    description:
      '在长期记忆里查找已经记住的硬约束、踩过的坑、已定决策。想确认“之前是不是定过什么约定”时用它，不要靠猜。只返回当前工作区范围内的记忆。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，例如 pnpm、测试、端口' },
        type: { type: 'string', enum: MEMORY_TYPES, description: '只查某一类记忆' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回多少条，默认 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                text: { type: 'string' },
                importance: { type: 'number' },
                createdAt: { type: 'integer' },
                status: { type: 'string' },
              },
              required: ['id', 'type', 'text'],
              additionalProperties: false,
            },
          },
          total: { type: 'integer' },
        },
        required: ['query', 'matches', 'total'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value) }],
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const { query, type, limit } = /** @type {any} */ (args) ?? {}
      const hits = searchMemories(store.all(), String(query ?? ''), { cwd: cwdOf(exec), limit: limit ?? 20 })
        .filter((hit) => (type ? hit.record.type === type : true))
        .map((hit) => ({
          id: hit.record.id,
          type: hit.record.type,
          text: hit.record.text,
          importance: hit.record.importance,
          createdAt: hit.record.createdAt,
          status: hit.record.status,
        }))
      return { query: String(query ?? ''), matches: hits, total: store.stats().total }
    },
  })

  ctx.tools.register({
    name: 'memory_write',
    description:
      '把一条值得跨会话记住的信息写进长期记忆（硬约束、踩过的坑、已定决策）。只在用户明确要求记住、或当场确认了某条结论时使用；不要用它记录一次性任务细节。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的句子，尽量用用户的原话' },
        type: { type: 'string', enum: MEMORY_TYPES, description: '记忆类型' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: '重要性，默认 0.8' },
      },
      required: ['text', 'type'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          stored: { type: 'boolean' },
          replaced: { type: 'boolean' },
        },
        required: ['id', 'stored', 'replaced'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value?.stored ? `已写入长期记忆 (${value.id})${value.replaced ? '，覆盖了同内容的旧条目' : ''}` : '未写入' },
      ],
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const { text, type, importance } = /** @type {any} */ (args) ?? {}
      const normalized = String(text ?? '').trim()
      if (!normalized) return { id: '', stored: false, replaced: false }
      const id = signatureOf(normalized)
      const replaced = store.has(id)
      const now = Date.now()
      const cwd = cwdOf(exec)
      await store.put({
        id,
        type: MEMORY_TYPES.includes(type) ? type : 'fact',
        text: normalized.slice(0, 400),
        cwd,
        importance: Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.8,
        status: 'active',
        source: { sessionId: exec?.agent?.id ?? null, seq: null, quote: normalized.slice(0, 200), at: now },
        createdAt: now,
        updatedAt: now,
        recalls: 0,
        lastRecalledAt: null,
        judge: { kind: 'explicit', confidence: null, conflict: 'unknown', mode: 'explicit' },
      })
      void store.ledger({ kind: 'write', id, type, by: 'explicit', cwd, quote: excerpt(normalized, 160) })
      return { id, stored: true, replaced }
    },
  })

  ctx.tools.register({
    name: 'memory_forget',
    description:
      '撤销长期记忆：按 id 删除一条，或按关键词删除一批。用于修正记错的条目，或用户明确说“别再记着这个”。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（注入的每条记忆后面都带 id）' },
        query: { type: 'string', description: '按关键词删除，匹配到的全部删除' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          removed: { type: 'array', items: { type: 'string' } },
          count: { type: 'integer' },
        },
        required: ['removed', 'count'],
        additionalProperties: false,
      },
      render: (_args, value) =>
        value?.count
          ? [{ type: 'text', text: `已撤销 ${value.count} 条记忆：\n${value.removed.map((id) => `- ${id}`).join('\n')}` }]
          : [{ type: 'text', text: '没有匹配到可撤销的记忆。' }],
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const { id, query } = /** @type {any} */ (args) ?? {}
      /** @type {string[]} */
      let removed = []
      if (typeof id === 'string' && id) {
        removed = (await store.remove(id)) ? [id] : []
      } else if (typeof query === 'string' && query) {
        const hits = searchMemories(store.all(), query, { cwd: null, limit: 100 })
        removed = (await store.removeWhere((record) => hits.some((hit) => hit.record.id === record.id))).map((record) => record.id)
      }
      for (const removedId of removed) void store.ledger({ kind: 'forget', id: removedId, by: 'tool' })
      return { removed, count: removed.length }
    },
  })
}

/**
 * Render a search result for the model.
 *
 * @param {any} value - the tool's structured result.
 * @returns {string} human/model-readable text.
 */
function renderSearchResult(value) {
  const matches = value?.matches ?? []
  if (matches.length === 0) return `长期记忆里没有匹配「${value?.query ?? ''}」的条目（共 ${value?.total ?? 0} 条记忆）。`
  const lines = matches.map((match) => `- [${match.type}] ${match.text} (${match.id}, ${new Date(match.createdAt).toISOString().slice(0, 10)})`)
  return `匹配「${value.query}」的长期记忆：\n${lines.join('\n')}`
}

/**
 * Read the events of the turn that just closed.
 *
 * Walks backwards from the last event to the matching `turn/start` — the same
 * fold the harness itself uses — so the hook never needs the projection cache
 * or a second subscription keeping a buffer alive.
 *
 * @param {any} session - the live session.
 * @returns {Array<{seq: number, type: string, data: any}>} events, oldest first.
 */
export function collectTurnEvents(session) {
  if (!session || !Number.isFinite(session.seq)) return []
  const events = []
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt?.(seq)
    if (!event) continue
    if (event.type === 'turn/start') break
    events.push({ seq, type: event.type, data: event.data })
  }
  return events.reverse()
}

/**
 * Reject when `promise` has not settled inside `ms`.
 *
 * The rejected promise is not cancelled — the Jev client owns its own abort
 * handling — but the hook stops waiting, which is what keeps a slow judge out
 * of the user's critical path.
 *
 * @param {Promise<any>} promise - the work to bound.
 * @param {number} ms - the budget.
 * @returns {Promise<any>} the work's result, or a rejection on timeout.
 */
export function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`memory write exceeded ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
