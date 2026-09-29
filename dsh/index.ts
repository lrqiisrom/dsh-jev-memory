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

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createCredentialFileReader } from './lib/credentials.ts'
import {
  buildConflictQuestion,
  choiceFromAnswer,
  createBm25Scorer,
  findConflictPartner,
  rankConflictPartners,
  type ConflictPair,
  type ConflictScorer,
} from './lib/conflict.ts'
import { extractCandidates, EXTRACT_DEFAULTS } from './lib/extract.ts'
import { applyGate, createJudge, JUDGE_MODES, type Judgement } from './lib/judge.ts'
import {
  EMBEDDING_DEFAULTS,
  cosineSimilarity,
  createEmbeddingClient,
  createVectorCache,
  vectorKey,
  type EmbeddingClient,
  type EmbeddingSettings,
} from './lib/embedding.ts'
import { createJevClient, JEV_DEFAULTS } from './lib/jev.ts'
import { DEFAULT_QUOTA, inScope, renderRecall, searchMemories, selectMemories } from './lib/recall.ts'
import { signatureOf } from './lib/signals.ts'
import { createMemoryStore, MEMORY_TYPES, type MemoryRecord } from './lib/store.ts'
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
  /** the preset that composed this session, recorded when suppression is detected. */
  agentPreset?: string
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
  /** queue model-facing context for the next pre-step (used by the fallback path). */
  inject?(message: RecallMessage): void
}

/** A user-role message carrying plugin-supplied context. */
export interface RecallMessage {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'plugin'; plugin: string; form: 'recall' }
}

/** The part of a prompt assembly this plugin inspects. */
export interface PromptAssemblyLike {
  contexts?: ReadonlyArray<{ name?: string; text?: string }>
}

/** The `agent/pre-step` decision this plugin returns. */
export type PreStepDecisionLike =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: RecallMessage[]; startsRequestSeries?: true }

/** The name this plugin registers its runtime context under. */
export const RECALL_CONTEXT_NAME = 'jev-memory:recall'

/**
 * The session id behind an agent, or null when it cannot be read.
 *
 * @param agent - the agent handle.
 * @returns the id, or null.
 */
export function sessionIdOf(agent: AgentLike | null | undefined): string | null {
  const id = agent?.session?.header?.id ?? agent?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Narrow a pre-step decision to the "enter a step" variant.
 *
 * The harness hands the decision back as `unknown` through this plugin's reduced
 * `on` signature, so the shape is checked rather than asserted: a listener that
 * guessed wrong here would either drop somebody else's veto or corrupt the batch.
 *
 * @param value - whatever `next()` returned.
 * @returns whether the value is an enter decision with a message list.
 */
export function isEnterDecision(
  value: unknown,
): value is { kind: 'enter'; messages: RecallMessage[]; startsRequestSeries?: true } {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
  return record?.kind === 'enter' && Array.isArray(record.messages)
}

/**
 * Build the plugin-sourced message that carries a recall block.
 *
 * `form: 'recall'` is the harness's own tag for exactly this case, and the source
 * keeps it distinguishable from anything the user typed — the difference the
 * whole fallback depends on, since a memory that looked like a user message would
 * be memorised again on the next turn.
 *
 * @param text - the rendered recall block.
 * @returns a user-role message the agent can queue.
 */
export function recallMessage(text: string): RecallMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'jev-memory', form: 'recall' },
  }
}

/** The payload of `agent/turn-stopping`. */
export interface TurnStoppingPayload {
  agent?: AgentLike | null
  turn?: number
  signal?: AbortSignal
  /** present on `agent/pre-step`, which is also how that event is told apart. */
  step?: number
}

/** The continuation a waterfall listener must call. */
export type NextCallback = () => Promise<unknown>

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
  userQuestions?: UserQuestionsService
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
  resolve(ref: string): Promise<{ value: string; source?: string } | undefined>
}

/** One question item, as the harness's ask service accepts it. */
export interface AskQuestionItem {
  id: string
  header?: string
  question: string
  detail?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

/** One answer item, as the harness's ask service returns it. */
export interface AskAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/**
 * The harness's ask-the-human service, reduced to the one call this plugin makes.
 *
 * Reusing it — rather than inventing a notification path — is the whole reason
 * this feature cannot conflict with the harness's existing human interaction:
 * approvals stay approvals, model questions stay model questions, and this is
 * simply one more *producer* of questions on the same channel and the same UI.
 *
 * The service's documented constraint is load-bearing here: with an `agent`, only
 * the exact live runtime root can be asked — an owned child has no answerer and
 * would block forever — so the caller passes the agent and treats every refusal
 * as "unanswered".
 */
export interface UserQuestionsService {
  ask(request: { questions: AskQuestionItem[]; agent?: unknown; signal?: AbortSignal }): Promise<{ answers?: AskAnswerItem[] }>
}

/** The Cordis plugin context, reduced to the members this plugin calls. */
export interface PluginContext {
  logger?: Logger
  inject(names: string[], callback: (scope: InjectedScope) => void): unknown
  on(event: string, handler: (payload: TurnStoppingPayload, next: NextCallback) => unknown): unknown
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
  /** whether a suspected conflict is put to the human instead of only being withheld. */
  askOnConflict: boolean
  /** how long to wait for that answer before leaving the record in `needs-review`. */
  askOnConflictTimeoutMs: number
  /** how many times one unresolved conflict may be asked about, in total. */
  askOnConflictMaxAttempts: number
  /** how many times a tool failure must repeat before it is worth remembering at all. */
  repeatFailuresToWrite: number
  writeEnabled: boolean
  writeSkipSubagents: boolean
  writeTimeoutMs: number
  judgeTimeoutMs: number
  knownForConflict: number
  /**
   * How to rank the memories the conflict question draws on.
   *
   * `lexical` (default): BM25, no dependency, nothing leaves the machine.
   * `embedding`: cosine similarity from an embedding provider — better on paraphrase,
   * but the stored sentences are sent to that provider and a cache of derived vectors
   * is kept beside the store. See `embedding` below.
   */
  conflictRanking: 'lexical' | 'embedding'
  embedding: Partial<EmbeddingSettings>
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
  /** conflicts the judge raised, paired with the record they contradict. */
  pendingConflicts?: ConflictAsk[]
}

/** One suspected contradiction, waiting for a human's answer. */
/**
 * One suspected contradiction, ready to be put to the human.
 *
 * Deliberately not the raw candidate: the retry path resumes from a *stored
 * record* (whose original candidate object is long gone), so both paths describe
 * the question in the same small shape.
 */
interface ConflictAsk {
  incomingId: string
  pair: ConflictPair
  /** how the partner was chosen: `jev` (the model picked) or `overlap` (lexical). */
  via: 'jev' | 'overlap'
  /** which judge raised the conflict, for the ledger. */
  by: string
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
 *
 * Kept in sync with `package.json` by hand: nothing reads the manifest at
 * runtime (importing JSON would break the zero-dependency mount), so the two
 * are a convention rather than a derivation. Bump both together.
 */
export const version = '0.12.0'

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
  /**
   * Put a suspected conflict to the human.
   *
   * The whole point of the judgement layer is to avoid writing something wrong;
   * discovering a contradiction and then silently swallowing it would leave the
   * user with a memory that answers "I don't know" forever. Asking is the only
   * honest resolution, and the answer is the ground truth that measures how good
   * the judge's conflict calls are.
   */
  askOnConflict: true,
  /**
   * Budget for that answer, in milliseconds.
   *
   * Ten minutes: long enough that a present user is never cut off mid-thought,
   * short enough that a session whose user walked away resumes instead of hanging.
   * Expiry is not the end of the question — the record stays `needs-review` and is
   * re-asked at the start of the next turn (see `askOnConflictMaxAttempts`).
   */
  askOnConflictTimeoutMs: 600_000,
  /**
   * How many times one unresolved conflict may be put to the human.
   *
   * The retry is what makes a long first timeout safe: a missed question is
   * resumed rather than lost. The bound is what keeps it from becoming nagging —
   * after the last attempt the record simply stays withheld.
   */
  askOnConflictMaxAttempts: 3,
  /**
   * How many times a tool failure must be seen before it counts as a pitfall.
   *
   * A one-off environment failure (a sandbox denial, a blocked redirect) is not a
   * durable lesson; a failure that keeps happening is. Without this rule the
   * heuristic judge records every transient error as a `pitfall`, which is what
   * the first live runs did.
   */
  repeatFailuresToWrite: 2,
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
  conflictRanking: 'lexical',
  embedding: {},
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
  for (const field of [
    'minImportance',
    'minRemember',
    'writeTimeoutMs',
    'judgeTimeoutMs',
    'knownForConflict',
    'contextOrder',
    'askOnConflictTimeoutMs',
    'askOnConflictMaxAttempts',
    'repeatFailuresToWrite',
  ] as const) {
    if (!Number.isFinite(config[field])) {
      problems.push(`${field}: not a finite number; using the default`)
      config[field] = DEFAULT_CONFIG[field]
    }
  }
  config.minImportance = Math.min(1, Math.max(0, config.minImportance))
  config.minRemember = Math.min(1, Math.max(0, config.minRemember))
  config.extract = { ...EXTRACT_DEFAULTS, ...((source.extract ?? {}) as Partial<ExtractOptions>) }
  if (config.conflictRanking !== 'lexical' && config.conflictRanking !== 'embedding') {
    problems.push(`conflictRanking: unknown value "${String(config.conflictRanking)}"; using lexical`)
    config.conflictRanking = 'lexical'
  }
  for (const field of ['dimensions', 'timeoutMs', 'maxInputs'] as const) {
    const value = config.embedding[field]
    if (value !== undefined && !Number.isFinite(value)) {
      problems.push(`embedding.${field}: not a finite number; using the default`)
      delete config.embedding[field]
    }
  }
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
  return join(resolveDshHome(env), 'jev-memory')
}

/**
 * Resolve the harness home the way the harness does: `$DSH_HOME`, else `~/.dsh`.
 *
 * @param env - environment to read.
 * @returns the absolute harness home.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env?.DSH_HOME?.trim() || join(homedir(), '.dsh')
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
  // The bearer token comes from the harness's credential store, not from this
  // composition file: a secret in a patch layer is a secret in a diff.
  //
  // Two paths, because reachability is not something a plugin can assume. The
  // service is authoritative and tried first, but it is reached through the
  // Cordis context, and `ctx.get` returns only providers whose fiber is already
  // active — a plugin that mounts early therefore observes `undefined` (measured:
  // the startup ledger said `ready:false`, while a probe in the same process
  // resolved the very same reference successfully moments later). The second path
  // reads the provider's own document, so a timing difference can no longer
  // decide whether the model judge is used. The ledger records which one answered.
  let credentials: CredentialService | undefined
  const credentialOf = (): CredentialService | undefined => credentials ?? (ctx.get?.('credentials') as CredentialService | undefined)
  ctx.inject(['credentials'], (scope) => {
    credentials = scope.credentials
  })
  // Same reactive pattern, same reason: the ask service is what turns a suspected
  // conflict into a question instead of a silent withholding.
  let userQuestions: UserQuestionsService | undefined
  const userQuestionsOf = (): UserQuestionsService | undefined =>
    userQuestions ?? (ctx.get?.('userQuestions') as UserQuestionsService | undefined)
  ctx.inject(['userQuestions'], (scope) => {
    userQuestions = scope.userQuestions
  })
  const credentialRef = config.jev.apiKeyEnv ?? JEV_DEFAULTS.apiKeyEnv
  const credentialFromFile = createCredentialFileReader({ home: resolveDshHome(), ref: credentialRef })
  const jev = createJevClient({
    config: config.jev,
    log,
    resolveApiKey: async () => {
      try {
        const resolved = await credentialOf()?.resolve(credentialRef)
        if (resolved?.value) return { key: resolved.value, source: `service:${resolved.source ?? 'unknown'}` }
      } catch (error) {
        log('warn', 'credential service lookup failed; reading the credential document instead', { error: String(error) })
      }
      const fromFile = await credentialFromFile()
      return fromFile ? { key: fromFile, source: 'file' } : undefined
    },
  })
  const judge: Judge = createJudge({ config: { ...config, judgeTimeoutMs: config.judgeTimeoutMs }, jev, log })

  // The embedding path is optional and off by default. It exists because BM25 scores a
  // paraphrase near zero, and the person running this asked for the semantic case to be
  // coverable. Enabled, the stored sentences are sent to the provider below — that is
  // the trade, so it is a deliberate switch rather than a default.
  const embeddingRef = config.embedding.apiKeyEnv ?? EMBEDDING_DEFAULTS.apiKeyEnv
  const embeddingCredentialFromFile = createCredentialFileReader({ home: resolveDshHome(), ref: embeddingRef })
  const embedding: EmbeddingClient = createEmbeddingClient({
    config: config.embedding,
    log,
    resolveApiKey: async () => {
      try {
        const resolved = await credentialOf()?.resolve(embeddingRef)
        if (resolved?.value) return { key: resolved.value, source: `service:${resolved.source ?? 'unknown'}` }
      } catch (error) {
        log('warn', 'credential service lookup failed for embeddings; reading the credential document instead', {
          error: String(error),
        })
      }
      const fromFile = await embeddingCredentialFromFile()
      return fromFile ? { key: fromFile, source: 'file' } : { key: undefined, source: 'missing' }
    },
  })
  const vectorCache = createVectorCache({
    file: join(store.root, 'embeddings.json'),
    log,
  })
  void vectorCache.load()

  /**
   * Rank memories by cosine similarity, or give up and let BM25 do it.
   *
   * Returns null on any shortfall — no key, a provider error, a timeout, vectors that
   * do not line up — because ranking is an optimisation and the write path must not
   * depend on it. The caller falls back to lexical.
   */
  const embeddingRanker =
    config.conflictRanking !== 'embedding'
      ? undefined
      : async (
          incoming: string,
          records: readonly MemoryRecord[],
          limit: number,
        ): Promise<MemoryRecord[] | null> => {
          const settings: Partial<EmbeddingSettings> = { ...EMBEDDING_DEFAULTS, ...config.embedding }
          await vectorCache.load()
          const wanted = [incoming, ...records.map((record) => record.text)]
          const missing: string[] = []
          for (const text of wanted) {
            if (vectorCache.get(vectorKey(settings as EmbeddingSettings, text)) === undefined && !missing.includes(text)) {
              missing.push(text)
            }
          }
          if (missing.length > 0) {
            const fresh = await embedding.embed(missing)
            if (fresh === null) return null
            for (const [index, text] of missing.entries()) {
              const vector = fresh[index]
              if (vector === undefined) return null
              vectorCache.set(vectorKey(settings as EmbeddingSettings, text), vector)
            }
            void vectorCache.persist()
          }
          const incomingVector = vectorCache.get(vectorKey(settings as EmbeddingSettings, incoming))
          if (incomingVector === undefined) return null
          const scored = records.map((record) => {
            const vector = vectorCache.get(vectorKey(settings as EmbeddingSettings, record.text))
            return { record, score: vector === undefined ? 0 : cosineSimilarity(incomingVector, vector) }
          })
          return scored
            .sort((left, right) => {
              if (right.score !== left.score) return right.score - left.score
              return (right.record.updatedAt ?? 0) - (left.record.updatedAt ?? 0)
            })
            .slice(0, limit)
            .map((entry) => entry.record)
        }

  let ready = false

  void store
    .load()
    .then(async ({ loaded, recovered }) => {
      ready = true
      const jevState = await jev.describe()
      log('info', `ready: ${loaded} memories from ${store.root}${recovered ? ' (corrupt document was set aside)' : ''}`, {
        judge: jevState.ready ? 'jev' : judge.kind,
        conflictRanking: config.conflictRanking,
        types: config.types,
      })
      const embeddingState =
        config.conflictRanking === 'embedding'
          ? await embedding.describe()
          : { mode: 'lexical', note: 'BM25 over the memories; nothing leaves the machine' }
      return store.ledger({
        kind: 'start',
        version,
        judge: judge.kind,
        conflictRanking: config.conflictRanking,
        embedding: embeddingState,
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

  /**
   * The recall block for one agent, plus the identities it covered.
   *
   * Extracted from the prompt-context callback because the block is now delivered
   * two ways — as runtime context normally, and as a plain message when a preset
   * suppresses runtime context — and both must select, render, count and audit
   * identically. A second copy of this logic would drift within a week.
   *
   * @param agent - the agent whose session is being served.
   * @param via - how this block will be delivered, recorded in the ledger.
   * @returns the rendered block ('' when there is nothing to say) and the ids.
   */
  const renderRecallFor = (agent: AgentLike | null | undefined, via: 'context' | 'message'): { text: string; ids: string[] } => {
    if (!ready || !config.recall.enabled) return { text: '', ids: [] }
    try {
      const header = agent?.session?.header
      if (config.recall.skipSubagents && (header?.delegationDepth ?? 0) > 0) return { text: '', ids: [] }
      const cwd = header?.cwd ?? null
      const chosen = selectMemories(store.all(), {
        cwd,
        types: config.types,
        quota: config.recall.quota,
        maxTokens: config.recall.maxTokens,
        now: Date.now(),
      })
      if (chosen.length === 0) return { text: '', ids: [] }

      const sessionId = String(header?.id ?? agent?.id ?? 'unknown')
      const ids = chosen.map((entry) => entry.record.id)
      const signature = `${via}:${ids.join(',')}`
      if (lastRecall.get(sessionId) !== signature) {
        lastRecall.set(sessionId, signature)
        store.noteRecalled(ids)
        void store.ledger({
          kind: 'recall',
          sessionId,
          cwd,
          via,
          ids,
          tokens: estimateTokens(renderRecall(chosen, { includeHelp: false })),
        })
      }
      return { text: renderRecall(chosen), ids }
    } catch (error) {
      log('warn', 'recall failed; injecting nothing', { error: String(error) })
      return { text: '', ids: [] }
    }
  }

  const recallText = (assembleCtx: AssembleContext): string => renderRecallFor(assembleCtx?.agent, 'context').text

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: RECALL_CONTEXT_NAME,
      order: config.contextOrder,
      text: recallText,
    })
  })

  // ---------------------------------------------------------------------------
  // Fallback: a preset can silently switch the runtime context off.
  //
  // Measured in the harness source, not guessed: with `includeRuntimeContext:
  // false` (the shipped `minimal` preset) `SystemPrompt.assemble` builds an empty
  // contexts array and never calls the callbacks — so this plugin would inject
  // nothing, log nothing, and report nothing. Silent, which is the one failure
  // mode this project keeps refusing to accept.
  //
  // Detection is a fact about the assembly, so it is read from the assembly: the
  // `system-prompt/assemble` waterfall still runs when contexts are suppressed
  // (the suppression only shapes the array), and seeing our own name absent while
  // we do have something to say is proof. Delivery then moves to a plugin-sourced
  // message on the same pre-step waterfall the competitors use.
  // ---------------------------------------------------------------------------
  /** Sessions proven to be running without runtime context. */
  const suppressedSessions = new Set<string>()
  /** The last turn a message-delivered block was queued for, per session. */
  const lastMessageTurn = new Map<string, number>()

  // The local PluginContext narrows `on` to the shapes the plugin registers
  // elsewhere; this event hands three arguments, so the listener is re-typed here
  // rather than widening that shared shape for one consumer.
  const onAssemble = ctx.on as unknown as (
    event: string,
    handler: (assembly: PromptAssemblyLike, context: AssembleContext, next: () => Promise<PromptAssemblyLike>) => unknown,
  ) => unknown
  onAssemble('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    try {
      if (!ready || !config.recall.enabled) return result
      const present = Array.isArray(result?.contexts) && result.contexts.some((entry) => entry?.name === RECALL_CONTEXT_NAME)
      if (present) return result
      const agent = context?.agent
      const sessionId = sessionIdOf(agent)
      if (sessionId === null || suppressedSessions.has(sessionId)) return result
      // Only a session that actually has something to inject is worth warning
      // about; an empty store must not look like a broken prompt.
      if (renderRecallFor(agent, 'message').text === '') return result
      suppressedSessions.add(sessionId)
      const preset = agent?.session?.header?.agentPreset ?? null
      log('warn', 'runtime context is suppressed for this session; recall moves to message injection', { sessionId, preset })
      void store.ledger({
        kind: 'context-suppressed',
        sessionId,
        agentPreset: preset,
        hint: 'a preset set includeRuntimeContext:false, so systemPrompt.context contributions never run',
      })
    } catch (error) {
      log('warn', 'recall suppression check failed (fail-open)', { error: String(error) })
    }
    return result
  })

  // ---------------------------------------------------------------------------
  // Write: judge and persist candidates from the turn that just closed, then put
  // any suspected contradiction to the human.
  //
  // Two phases with separate budgets, because they are different kinds of work.
  // The first — extract, judge, gate, persist — is bounded by `writeTimeoutMs`,
  // since `agent/turn-stopping` is serial and awaited before the boundary commits
  // and a slow judge would sit in the user's critical path. The second involves a
  // person and is therefore slow on purpose: it gets its own budget, and on
  // expiry the record simply stays withheld rather than being guessed at.
  // ---------------------------------------------------------------------------
  /**
   * Put one suspected contradiction to the human and apply the answer.
   *
   * Everything here is written to the ledger *before* the outcome is known, so
   * the audit trail shows the question even when nobody answers — that record is
   * what makes "how often was the judge right about conflicts?" answerable.
   *
   * @param pending - the contradiction to ask about.
   * @param owner - the live agent the question belongs to.
   * @param abort - the turn's abort signal.
   * @returns nothing.
   */
  async function askAboutConflict(ask: ConflictAsk, owner: AgentLike | null | undefined, abort: AbortSignal | undefined): Promise<void> {
    const incoming = ask.incomingId
    const existing = ask.pair.existing.id
    const service = userQuestionsOf()
    store.noteAsked(incoming)
    void store.ledger({
      kind: 'conflict-ask',
      id: incoming,
      with: existing,
      attempt: store.askedCount(incoming),
      via: ask.via,
      score: Number(ask.pair.score.toFixed(3)),
      shared: ask.pair.shared.slice(0, 8),
      by: ask.by,
    })
    if (service === undefined) {
      void store.ledger({ kind: 'conflict-resolved', id: incoming, with: existing, choice: 'unanswered', reason: 'no-answerer' })
      return
    }

    const question = buildConflictQuestion(ask.pair, incoming)
    log('info', `asking which side of a suspected conflict wins (${incoming} vs ${existing})`)
    const answer = await service.ask({ questions: [question], agent: owner, signal: abort })
    const choice = choiceFromAnswer(answer?.answers?.[0])
    if (choice === null) {
      void store.ledger({ kind: 'conflict-resolved', id: incoming, with: existing, choice: 'unanswered', reason: 'no-selection' })
      return
    }

    if (choice === 'keep-old') {
      await store.remove(incoming)
      void store.ledger({ kind: 'conflict-resolved', id: incoming, with: existing, choice })
      log('info', 'conflict resolved: kept the earlier memory, dropped the new one')
      return
    }

    // `superseded` rather than deleted: the old record keeps its text so a human who
    // changes their mind can read what the previous statement was — which is what the
    // question promises them. This used to call `store.remove` under a comment that
    // said exactly this, so the promise was being broken by the line below it.
    if (choice === 'replace') await store.supersede(existing, incoming)
    const record = store.get(incoming)
    if (record) {
      await store.put({
        ...record,
        status: 'active',
        supersedes: choice === 'replace' ? existing : (record.supersedes ?? null),
        updatedAt: Date.now(),
      })
    }
    void store.ledger({
      kind: 'conflict-resolved',
      id: incoming,
      with: existing,
      choice,
      superseded: choice === 'replace' ? existing : null,
    })
    log('info', `conflict resolved by the user: ${choice}`)
  }

  /**
   * Resume a question the human did not answer in time.
   *
   * Runs at the start of the next turn, before the model's first step: the user
   * is present by definition (they just typed), which is exactly what the
   * turn-end timeout could not assume. Bounded by `askOnConflictMaxAttempts`, so
   * an ignored question eventually stops asking instead of nagging.
   *
   * @param owner - the live agent whose turn is starting.
   * @param abort - that turn's abort signal.
   * @returns nothing.
   */
  async function retryPendingConflict(owner: AgentLike | null | undefined, abort: AbortSignal | undefined): Promise<void> {
    const header = owner?.session?.header
    if (config.writeSkipSubagents && (header?.delegationDepth ?? 0) > 0) return
    const cwd = header?.cwd ?? null
    const records = store.all()
    const pending = records.find(
      (record) =>
        record.status === 'needs-review' &&
        record.judge.conflict === 'yes' &&
        inScope(record, cwd) &&
        // asked at least once (the turn-end path already tried) but not too often
        store.askedCount(record.id) > 0 &&
        store.askedCount(record.id) < config.askOnConflictMaxAttempts,
    )
    if (!pending) return
    const partners = records.filter((record) => record.status === 'active' && inScope(record, cwd))
    const paired = await pairConflict(pending.text, partners, cwd, abort)
    if (!paired) {
      void store.ledger({ kind: 'conflict-resolved', id: pending.id, choice: 'unanswered', reason: 'no-partner-on-retry' })
      return
    }
    await askAboutConflict({ incomingId: pending.id, pair: paired.pair, via: paired.via, by: pending.judge.kind }, owner, abort)
  }

  /**
   * Choose which existing memory an incoming one contradicts.
   *
   * Two levels on purpose. The model already said *that* a conflict exists, so it
   * is the right party to ask *which* one — lexical overlap cannot see through a
   * paraphrase ("data 下的文件别碰" vs "不要改动 data/ 目录"). But the model can be
   * unavailable, and a question that cannot name the other side is unanswerable, so
   * the deterministic pairing stays as the floor rather than being replaced.
   *
   * @param incoming - the new memory's text.
   * @param partners - the active memories in scope.
   * @param cwd - the workspace, forwarded as framing.
   * @param signal - the turn's abort signal.
   * @returns the pairing plus how it was chosen, or null when nothing can be named.
   */
  /**
   * Rank the memories a conflict question may draw on.
   *
   * Two implementations behind one call, chosen by `conflictRanking`:
   *
   *  - `lexical` (default): BM25 over the memories. No dependency, no network, no
   *    stored state, and nothing leaves the machine.
   *  - `embedding`: cosine similarity from an embedding provider. Better at
   *    paraphrase ("data 下的文件别碰" vs "不要改动 data/ 目录"), which BM25 scores
   *    near zero — at the cost of a provider, a key, a cache of derived vectors, and
   *    sending the stored sentences to that provider.
   *
   * Both are *candidate* rankings. Whether two memories actually contradict each other
   * is still the judge's question or the person's; similarity cannot answer it.
   *
   * Any failure in the embedding path falls back to lexical rather than failing the
   * turn: a write hook that cannot rank must still write.
   *
   * @param incoming - the sentence(s) the window should be relevant to.
   * @param records - the memories in scope.
   * @param limit - how many to keep.
   * @returns up to `limit` memories, most relevant first.
   */
  async function rankPartners(
    incoming: string,
    records: readonly MemoryRecord[],
    limit: number,
  ): Promise<MemoryRecord[]> {
    if (records.length === 0 || limit <= 0) return []
    if (config.conflictRanking === 'embedding') {
      const ranked = await embeddingRanker?.(incoming, records, limit)
      if (ranked) return ranked
    }
    return rankConflictPartners(incoming, records, limit)
  }

  async function pairConflict(
    incoming: string,
    partners: readonly MemoryRecord[],
    cwd: string | null,
    signal: AbortSignal | undefined,
  ): Promise<{ pair: ConflictPair; via: 'jev' | 'overlap' } | null> {
    if (partners.length === 0) return null

    const ranked = await rankPartners(incoming, partners, config.knownForConflict)
    const known = rankConflictPartners(incoming, ranked, config.knownForConflict)
    const picked = await judge.choosePartner(
      incoming,
      known.map((record) => record.text),
      { project: cwd, signal },
    )
    if (picked) {
      // Asked, and the model named none of them. That is an answer, not a failure:
      // guessing a partner afterwards would put words in its mouth.
      if (picked.index === null) return null
      const chosen = known[picked.index]
      if (chosen) {
        // Score the model's pick with the same lexical measure anyway: it costs
        // nothing and makes a mismatched pairing visible in the ledger.
        const lexical = findConflictPartner(incoming, [chosen], 0)
        return { pair: lexical ?? { incoming, existing: chosen, score: 0, shared: [] }, via: 'jev' }
      }
    }

    const fallback = findConflictPartner(incoming, partners)
    return fallback ? { pair: fallback, via: 'overlap' } : null
  }

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!config.writeEnabled || !ready) return
    const turnHeader = agent?.session?.header
    if (config.writeSkipSubagents && (turnHeader?.delegationDepth ?? 0) > 0) {
      void store.ledger({ kind: 'skip', reason: 'subagent-session', sessionId: turnHeader?.id ?? null, turn })
      return
    }

    let pending: ConflictAsk[] = []
    try {
      const outcome = await withDeadline(handleTurn(), config.writeTimeoutMs)
      pending = outcome?.pendingConflicts ?? []
      if (outcome?.written) log('info', `remembered ${outcome.written} item(s) from turn ${turn}`, { model: outcome.model })
    } catch (error) {
      log('warn', `turn-end write skipped (fail-open): ${String(error)}`)
      void store.ledger({ kind: 'hook-error', turn, error: String(error) })
    }

    // One question per turn, and only the first: two questions in a row is an
    // interrogation, not a memory system.
    if (pending.length > 0 && config.askOnConflict) {
      try {
        await withDeadline(askAboutConflict(pending[0], agent, signal), config.askOnConflictTimeoutMs)
      } catch (error) {
        log('warn', `conflict question left unanswered (fail-open): ${String(error)}`)
        void store.ledger({ kind: 'conflict-resolved', id: pending[0].incomingId, choice: 'unanswered', error: String(error) })
      }
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
        // A tool failure is only a *pitfall* once it repeats. One sandbox denial is
        // an event; the same denial three times is a lesson. Observations are
        // counted in the ledger, so the rule survives a restart — and the line is
        // written even when the candidate is dropped, which is what makes the
        // count grow.
        if (candidate.kind === 'tool-failure') {
          const seen = store.observedCount(candidate.key)
          store.noteObserved(candidate.key)
          void store.ledger({ kind: 'observed', id: candidate.key, tool: candidate.tool, quote: excerpt(candidate.quote, 120) })
          if (seen + 1 < config.repeatFailuresToWrite) {
            void store.ledger({
              kind: 'skip',
              reason: 'failure-not-repeated',
              id: candidate.key,
              seen: seen + 1,
              quote: excerpt(candidate.quote, 120),
            })
            continue
          }
        }
        fresh.push(candidate)
      }
      if (fresh.length === 0) return { written: 0, candidates: candidates.length, duplicates: candidates.length }

      const header = session?.header
      const cwd = header?.cwd ?? null
      // Ranked, not sliced: `slice(0, 20)` handed the judge the first twenty memories
      // in store order, so a contradiction at position twenty-one was invisible and
      // the judge answered "no conflict" with nothing in the ledger to show for it.
      const inScopeRecords = store.all().filter((record) => inScope(record, cwd))
      const activePartners = inScopeRecords.filter((record) => record.status === 'active')
      // One window for the whole turn, ranked against every candidate's text: the
      // judge sees a single `known` list, so it should hold whatever any of this
      // turn's sentences might contradict.
      const shown = await rankPartners(
        fresh.map((candidate) => candidate.text).join('\n'),
        inScopeRecords,
        config.knownForConflict,
      )
      const known = shown.map((record) => `[${record.type}] ${record.text}`)

      const { rows, model, degraded } = await judge.judge(fresh, { known, signal, project: cwd })

      // The judge is asked "does this contradict anything you know" about a window of
      // memories. When it answers no, check the same question deterministically and
      // record what it finds — but do not interrupt the person for it: the point is to
      // learn how often the window and the model miss a contradiction, and only then
      // decide whether it deserves a question. Two sources of miss are covered, the
      // window (a partner outside the twenty) and the model (a pair it did not see).
      for (const candidate of fresh) {
        const judgement = rows.find((row) => row.key === candidate.key)
        if (judgement?.conflict === 'yes') continue
        const suspected = findConflictPartner(candidate.text, activePartners)
        if (!suspected) continue
        void store.ledger({
          kind: 'conflict-suspected',
          id: candidate.key,
          with: suspected.existing.id,
          score: Number(suspected.score.toFixed(3)),
          shared: suspected.shared.slice(0, 8),
          by: judgement?.by ?? 'none',
          model,
          note: 'the judge answered no; the lexical check disagrees',
        })
      }
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
      const pendingConflicts: ConflictAsk[] = []
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
        // A suspected conflict is written first, in `needs-review`, and only then
        // taken to the human. Writing first means an unanswered question leaves the
        // system exactly where it is today — the record exists, and it is withheld
        // from recall — instead of losing what the user said.
        if (gate.review && config.askOnConflict && pendingConflicts.length === 0) {
          const partners = store.all().filter((record) => record.status === 'active' && inScope(record, cwd))
          const paired = await pairConflict(candidate.text, partners, cwd, signal)
          if (paired) {
            pendingConflicts.push({ incomingId: candidate.key, pair: paired.pair, via: paired.via, by: judgement.by })
          } else {
            // A raised conflict nobody can be asked about is still a fact worth
            // recording: without this line the memory silently disappears from
            // recall and the ledger says nothing about why.
            void store.ledger({
              kind: 'skip',
              reason: 'conflict-unpaired',
              id: candidate.key,
              by: judgement.by,
              quote: excerpt(candidate.quote, 120),
            })
          }
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
      return { written, candidates: candidates.length, duplicates: candidates.length - fresh.length, model, degraded, pendingConflicts }
    }

  })

  // ---------------------------------------------------------------------------
  // Retry: resume a question the human did not answer before its budget expired.
  //
  // `agent/pre-step` is a waterfall, so it must call `next()`; the ask happens in
  // between, which is precisely "before this turn's first step" — the user is
  // present by definition, having just sent the message, which is the assumption
  // the turn-end timeout could not make. Fail-open in every direction: a broken
  // retry must never stop a turn from starting.
  // ---------------------------------------------------------------------------
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (config.askOnConflict && ready && (payload?.step ?? 1) === 1) {
        await withDeadline(retryPendingConflict(payload.agent, payload.signal), config.askOnConflictTimeoutMs)
      }
    } catch (error) {
      log('warn', `conflict retry skipped (fail-open): ${String(error)}`)
    }

    const decision = await next()
    try {
      if (!ready || !config.recall.enabled) return decision
      const agent = payload?.agent
      const sessionId = sessionIdOf(agent)
      // Only sessions *proven* to run without runtime context take this path, so
      // the normal case keeps the cheaper system-prompt delivery.
      if (sessionId === null || !suppressedSessions.has(sessionId)) return decision
      // Once per turn: the message then stays in the history for that turn's later
      // steps, which is the cadence the runtime context had anyway.
      const turn = payload?.turn ?? 0
      if (lastMessageTurn.get(sessionId) === turn) return decision
      const block = renderRecallFor(agent, 'message')
      if (block.text === '') return decision
      // A rejected step is somebody else's veto; attaching context to it would be
      // resurrecting a step that is not going to run.
      if (!isEnterDecision(decision)) return decision
      lastMessageTurn.set(sessionId, turn)
      return { ...decision, messages: [...decision.messages, recallMessage(block.text)] }
    } catch (error) {
      log('warn', `recall fallback injection failed (fail-open): ${String(error)}`)
      return decision
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
