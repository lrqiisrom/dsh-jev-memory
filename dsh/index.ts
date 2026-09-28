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
 * Types, and why `ctx` is a local structural interface instead of an imported
 * one: this package declares no `dependencies` at all, so `@deepseek-ai/*` is
 * not installed and must not be imported — a workspace copy has to mount with
 * `--patch` and no install step, which is the same reason the plugin does not
 * use `ctx.storageDomain` (see lib/store.ts). Importing the harness's own
 * `Context` type would also make this file fail to resolve outside a full DSH
 * checkout. The interfaces below therefore name only the surface this plugin
 * actually touches — `logger`, `on`, `inject`, `tools.register`, `effect`, and
 * the session accessors on an assembly context — and they double as the contract
 * the plugin's own fake-context test mounts against. Everything that crosses the
 * boundary as untyped data (the composition row's `config`, a tool's arguments,
 * a session's event payloads) is `unknown` and is narrowed at its use site.
 *
 * @module dsh-jev-memory
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { extractCandidates, EXTRACT_DEFAULTS } from './lib/extract.ts'
import { applyGate, createJudge, JUDGE_MODES } from './lib/judge.ts'
import { createJevClient, JEV_DEFAULTS } from './lib/jev.ts'
import { DEFAULT_QUOTA, inScope, renderRecall, searchMemories, selectMemories } from './lib/recall.ts'
import { signatureOf } from './lib/signals.ts'
import { createMemoryStore, MEMORY_TYPES } from './lib/store.ts'
import { estimateTokens, excerpt } from './lib/text.ts'
import type { Candidate, ExtractOptions, TurnEvent } from './lib/extract.ts'
import type { Judge } from './lib/judge.ts'
import type { JevSettings } from './lib/jev.ts'

// ---------------------------------------------------------------------------
// The host surface this plugin uses, described structurally.
// ---------------------------------------------------------------------------

/** A host logger: one method per level; only `info`/`warn` are used here. */
export interface Logger {
  info?(message: string, detail?: unknown): void
  warn?(message: string, detail?: unknown): void
  error?(message: string, detail?: unknown): void
  [level: string]: ((message: string, detail?: unknown) => void) | undefined
}

/** The logger-shaped callback every lib module accepts. */
export type LogSink = (level: string, message: string, detail?: unknown) => void

/** The session header fields this plugin reads. */
export interface SessionHeader {
  id?: string
  cwd?: string | null
  delegationDepth?: number
  [key: string]: unknown
}

/** A live session, as far as this plugin touches it. */
export interface SessionLike {
  seq?: number
  header?: SessionHeader | null
  eventAt?: (seq: number) => TurnEvent | null | undefined
}

/** The agent handle carried by assembly contexts and turn-stopping payloads. */
export interface AgentLike {
  id?: string
  session?: SessionLike | null
}

/** The payload of `agent/turn-stopping`. */
export interface TurnStoppingPayload {
  agent?: AgentLike | null
  turn?: number
  signal?: AbortSignal
}

/** What the prompt assembler passes to a context callback (synchronously). */
export interface AssembleContext {
  agent?: AgentLike | null
}

/** A `systemPrompt.context` definition. */
export interface PromptContextDefinition {
  name: string
  order: number
  text: (context: AssembleContext) => string
}

/** The `systemPrompt` service, reduced to the one method used here. */
export interface SystemPromptService {
  context(definition: PromptContextDefinition): unknown
}

/** What `inject(['systemPrompt'], cb)` hands its callback. */
export interface InjectedScope {
  systemPrompt: SystemPromptService
  credentials?: CredentialService
}

/** What a tool's `execute` receives about its caller. */
export interface ToolExecContext {
  agent?: AgentLike | null
}

/** A tool definition, as `tools.register` receives it. */
export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: TResult) => Array<{ type: string; text: string }>
  }
  timeoutMs: number
  isConcurrencySafe: () => boolean
  execute: (args: TArgs, exec?: ToolExecContext) => Promise<TResult>
}

/** The tool registry service, reduced to `register`. */
export interface ToolRegistry {
  register<TArgs, TResult>(definition: ToolDefinition<TArgs, TResult>): unknown
}

/** The credential service, reduced to the one call this plugin makes. */
export interface CredentialService {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** The Cordis plugin context, reduced to the members this plugin calls. */
export interface PluginContext {
  logger?: Logger
  inject(names: string[], callback: (scope: InjectedScope) => void): unknown
  on(event: string, handler: (payload: TurnStoppingPayload) => unknown): unknown
  tools: ToolRegistry
  effect(factory: () => () => void): unknown
  /** optional service lookup; absent members are the caller's problem, not a failure. */
  get?(name: string): unknown
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Recall (injection) settings. */
export interface RecallConfig {
  enabled: boolean
  skipSubagents: boolean
  quota: Record<string, number>
  maxTokens: number
}

/** The fully resolved plugin config: every field present and validated. */
export interface PluginConfig {
  enabled: boolean
  root: string
  types: string[]
  judge: string
  minImportance: number
  /** threshold on the judge's "worth remembering" answer; the heuristic ignores it. */
  minRemember: number
  reviewOnConflict: boolean
  writeEnabled: boolean
  writeSkipSubagents: boolean
  writeTimeoutMs: number
  judgeTimeoutMs: number
  knownForConflict: number
  extract: Partial<ExtractOptions>
  recall: RecallConfig
  contextOrder: number
  tools: boolean
  jev: Partial<JevSettings>
}

/** One match in a `memory_search` result. */
export interface MemorySearchMatch {
  id: string
  type: string
  text: string
  importance: number
  createdAt: number
  status: string
}

/** The `memory_search` result. */
export interface MemorySearchResult {
  query: string
  matches: MemorySearchMatch[]
  total: number
}

/** The `memory_write` result. */
export interface MemoryWriteResult {
  id: string
  stored: boolean
  replaced: boolean
}

/** The `memory_forget` result. */
export interface MemoryForgetResult {
  removed: string[]
  count: number
}

/** Arguments of `memory_search`, as the harness validates them. */
export interface SearchArgs {
  query?: string
  type?: string
  limit?: number
}

/** Arguments of `memory_write`, as the harness validates them. */
export interface WriteArgs {
  text?: string
  type?: string
  importance?: number
}

/** Arguments of `memory_forget`, as the harness validates them. */
export interface ForgetArgs {
  id?: string
  query?: string
}

/** What the turn-end hook reports back to the ledger/log line. */
interface TurnWriteOutcome {
  written: number
  candidates: number
  duplicates?: number
  model?: string | null
  degraded?: string | null
}

/**
 * Read a value as a property bag, or `null` when it cannot be one.
 *
 * Local to this module on purpose: it is the one narrowing primitive used to
 * read untyped user input (a composition row's `config`) without `any`.
 *
 * @param value - any value.
 * @returns the value as a record, or null.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/** Plugin id; must match the `id` used by the composition row. */
export const name = 'jev-memory'

/**
 * Bumped on every behaviour change that the live process must pick up.
 *
 * It is written into the store's `start` ledger line so that "is the running
 * process using the code I just edited?" is answerable from the ledger alone —
 * a hot-reloaded module and a cached one otherwise look identical.
 */
export const version = '0.4.0'

/** Hard dependencies: without them there is nothing to register or inject into. */
export const inject = ['tools', 'systemPrompt']

/** Plugin defaults; every field is overridable from the composition row's `config`. */
export const DEFAULT_CONFIG: PluginConfig = {
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
  /**
   * Threshold on the judge's `remember` (Noul) answer — the primary write gate
   * whenever the judge answered that question. Kept separate from
   * `minImportance` because they gate different questions; see `applyGate`.
   */
  minRemember: 0.6,
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
 * The composition row's value is untyped user input, so this is the one place
 * where a narrowing assertion is unavoidable; everything the plugin later
 * depends on is either validated here (types, judge mode, the numeric budgets)
 * or read defensively at its use site.
 *
 * @param raw - the composition row's `config` value.
 * @returns resolved config and validation complaints.
 */
export function resolveConfig(raw: unknown): { config: PluginConfig; problems: string[] } {
  const source: Record<string, unknown> = asRecord(raw) ?? {}
  const recallSource = asRecord(source.recall)
  const problems: string[] = []
  // Every spread below is asserted rather than narrowed, because the original
  // contract is "whatever the row says wins" and object spread is deliberately
  // literal about it (a string block spreads into its character indices, an
  // absent one into nothing). Narrowing first would quietly change what a
  // malformed row resolves to.
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(source as Partial<PluginConfig>),
    recall: { ...DEFAULT_CONFIG.recall, ...((source.recall ?? {}) as Partial<RecallConfig>) },
    jev: { ...((source.jev ?? {}) as Partial<JevSettings>) },
  }

  if (!Array.isArray(source.types)) config.types = [...DEFAULT_CONFIG.types]
  else {
    const declared: unknown[] = source.types
    const requested = declared.filter((type): type is string => typeof type === 'string' && MEMORY_TYPES.includes(type))
    if (requested.length !== declared.length) problems.push('types: unknown type names were dropped')
    config.types = requested.length > 0 ? requested : [...DEFAULT_CONFIG.types]
  }

  if (!JUDGE_MODES.includes(config.judge)) {
    problems.push(`judge: unknown mode "${config.judge}"; using auto`)
    config.judge = 'auto'
  }
  for (const field of ['minImportance', 'minRemember', 'writeTimeoutMs', 'judgeTimeoutMs', 'knownForConflict', 'contextOrder'] as const) {
    if (!Number.isFinite(config[field])) {
      problems.push(`${field}: not a finite number; using the default`)
      config[field] = DEFAULT_CONFIG[field]
    }
  }
  config.minImportance = Math.min(1, Math.max(0, config.minImportance))
  config.minRemember = Math.min(1, Math.max(0, config.minRemember))
  config.extract = { ...EXTRACT_DEFAULTS, ...((source.extract ?? {}) as Partial<ExtractOptions>) }
  config.recall.quota = { ...DEFAULT_QUOTA, ...((recallSource?.quota ?? {}) as Record<string, number>) }
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
 * @param configured - the configured root, possibly empty.
 * @param env - environment to read.
 * @returns an absolute store root.
 */
export function resolveStoreRoot(configured: string, env: NodeJS.ProcessEnv = process.env): string {
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
 * @param ctx - the Cordis plugin context.
 * @param rawConfig - the composition row's `config`.
 * @returns nothing.
 */
export function apply(ctx: PluginContext, rawConfig: unknown = {}): void {
  const { config, problems } = resolveConfig(rawConfig)
  const log: LogSink = (level, message, detail) => {
    const logger = ctx.logger
    const sink = logger?.[level] ?? logger?.info
    try {
      if (logger !== undefined && sink !== undefined) {
        sink.call(logger, detail === undefined ? `jev-memory: ${message}` : `jev-memory: ${message} ${JSON.stringify(detail)}`)
      }
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
  // The bearer token comes from the harness's credential service, not from this
  // composition file: a secret in a patch layer is a secret in a diff.
  //
  // Reached *reactively* rather than with a one-shot `ctx.get` at mount, and that
  // distinction was a real bug: Cordis's `get` returns only providers whose fiber
  // is already active, so looking it up during `apply()` found nothing, the
  // plugin cached `undefined`, and it stayed on the heuristic judge forever while
  // the ledger said only `jevReady: false`. `inject` re-runs when the provider
  // becomes available; the late `ctx.get` covers a host that never fires it.
  let credentials: CredentialService | undefined
  const credentialOf = (): CredentialService | undefined => credentials ?? (ctx.get?.('credentials') as CredentialService | undefined)
  ctx.inject(['credentials'], (scope) => {
    credentials = scope.credentials
  })
  const credentialRef = config.jev.apiKeyEnv ?? JEV_DEFAULTS.apiKeyEnv
  const jev = createJevClient({
    config: config.jev,
    log,
    resolveApiKey: async () => (await credentialOf()?.resolve(credentialRef))?.value,
  })
  const judge: Judge = createJudge({ config: { ...config, judgeTimeoutMs: config.judgeTimeoutMs }, jev, log })
  let ready = false

  void store
    .load()
    .then(async ({ loaded, recovered }) => {
      ready = true
      const jevState = await jev.describe()
      log('info', `ready: ${loaded} memories from ${store.root}${recovered ? ' (corrupt document was set aside)' : ''}`, {
        judge: jevState.ready ? 'jev' : judge.kind,
        types: config.types,
      })
      return store.ledger({
        kind: 'start',
        version,
        judge: judge.kind,
        // `source` is the field whose absence cost a debugging round: `ready:false`
        // alone cannot distinguish a wrong ref name from an unreachable service.
        jev: jevState,
        credentialRef,
        model: config.jev.model ?? JEV_DEFAULTS.model,
        loaded,
        recovered,
      })
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
  /** last injected id-set per session, to avoid ledger spam. */
  const lastRecall = new Map<string, string>()

  const recallText = (assembleCtx: AssembleContext): string => {
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
    async function handleTurn(): Promise<TurnWriteOutcome> {
      const session = agent?.session
      const events = collectTurnEvents(session)
      const candidates = extractCandidates(events, {
        ...config.extract,
        onVeto: (sentence, reason) => void store.ledger({ kind: 'skip', reason: `veto:${reason}`, quote: excerpt(sentence, 120) }),
      })
      if (candidates.length === 0) return { written: 0, candidates: 0 }

      const fresh: Candidate[] = []
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

      const { rows, model, degraded } = await judge.judge(fresh, { known, signal, project: cwd })
      // A candidate the judge did not answer is judged heuristically instead. That
      // is a silent quality drop, so it is recorded rather than left to be inferred
      // from a `remember=null` row: the harness found it only by inspecting rows
      // by hand, and the cause was the per-request candidate cap.
      const unanswered = rows.filter((row) => row.note === 'jev-missing-row').length
      if (unanswered > 0) {
        log('warn', `${unanswered} candidate(s) beyond the per-request cap fell back to the heuristic judge`, {
          cap: config.jev.maxCandidates ?? undefined,
        })
        void store.ledger({ kind: 'degraded', reason: 'jev-missing-row', count: unanswered, cwd })
      }
      let written = 0
      for (const candidate of fresh) {
        const judgement = rows.find((row) => row.key === candidate.key)
        const gate = applyGate(judgement, config)
        if (!gate.write || !judgement) {
          // `by` on the skip line too: otherwise the ledger shows that something
          // was refused but not who refused it, and "is Jev actually deciding?"
          // becomes unanswerable without a second query.
          void store.ledger({
            kind: 'skip',
            reason: gate.reason,
            id: candidate.key,
            by: judgement?.by ?? 'none',
            model,
            quote: excerpt(candidate.quote, 120),
          })
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
          remember: judgement.remember,
          by: judgement.by,
          model,
          conflict: judgement.conflict,
          status: gate.review ? 'needs-review' : 'active',
          cwd,
          source: { sessionId: header?.id ?? null, seq: candidate.seq, quote: excerpt(candidate.quote, 160) },
          signals: judgement.signals,
          note: judgement.note,
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

  /** the calling agent's working directory. */
  const cwdOf = (exec: ToolExecContext | undefined): string | null => exec?.agent?.session?.header?.cwd ?? null

  ctx.tools.register<SearchArgs, MemorySearchResult>({
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
      render: (_args: unknown, value: MemorySearchResult) => [{ type: 'text', text: renderSearchResult(value) }],
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    execute: async (args: SearchArgs, exec?: ToolExecContext): Promise<MemorySearchResult> => {
      const { query, type, limit } = args ?? {}
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

  ctx.tools.register<WriteArgs, MemoryWriteResult>({
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
      render: (_args: unknown, value: MemoryWriteResult) => [
        { type: 'text', text: value?.stored ? `已写入长期记忆 (${value.id})${value.replaced ? '，覆盖了同内容的旧条目' : ''}` : '未写入' },
      ],
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => false,
    execute: async (args: WriteArgs, exec?: ToolExecContext): Promise<MemoryWriteResult> => {
      const { text, type, importance } = args ?? {}
      const normalized = String(text ?? '').trim()
      if (!normalized) return { id: '', stored: false, replaced: false }
      const id = signatureOf(normalized)
      const replaced = store.has(id)
      const now = Date.now()
      const cwd = cwdOf(exec)
      await store.put({
        id,
        type: type && MEMORY_TYPES.includes(type) ? type : 'fact',
        text: normalized.slice(0, 400),
        cwd,
        importance: typeof importance === 'number' && Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.8,
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

  ctx.tools.register<ForgetArgs, MemoryForgetResult>({
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
      render: (_args: unknown, value: MemoryForgetResult) =>
        value?.count
          ? [{ type: 'text', text: `已撤销 ${value.count} 条记忆：\n${value.removed.map((id) => `- ${id}`).join('\n')}` }]
          : [{ type: 'text', text: '没有匹配到可撤销的记忆。' }],
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => false,
    execute: async (args: ForgetArgs): Promise<MemoryForgetResult> => {
      const { id, query } = args ?? {}
      let removed: string[] = []
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
 * @param value - the tool's structured result.
 * @returns human/model-readable text.
 */
function renderSearchResult(value: MemorySearchResult): string {
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
 * @param session - the live session.
 * @returns events, oldest first.
 */
export function collectTurnEvents(session: SessionLike | null | undefined): TurnEvent[] {
  if (!session) return []
  const lastSeq = session.seq
  if (typeof lastSeq !== 'number' || !Number.isFinite(lastSeq)) return []
  const events: TurnEvent[] = []
  for (let seq = lastSeq - 1; seq >= 0; seq -= 1) {
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
 * @param promise - the work to bound.
 * @param ms - the budget.
 * @returns the work's result, or a rejection on timeout.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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
