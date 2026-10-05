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
import { EXTRACT_DEFAULTS, archiveMessages, extractCandidates } from './lib/extract.ts'
import {
  applyGate,
  applyModelGate,
  createJudge,
  heuristicRow,
  JUDGE_MODES,
  relationActionsDisagree,
  type Judgement,
} from './lib/judge.ts'
import {
  EMBEDDING_DEFAULTS,
  cosineSimilarity,
  createEmbeddingClient,
  createVectorCache,
  vectorKey,
  type EmbeddingClient,
  type EmbeddingSettings,
} from './lib/embedding.ts'
import { createJevClient, JEV_DEFAULTS, REMEMBER_QUESTION } from './lib/jev.ts'
import {
  createNormalizer,
  NORMALIZE_DEFAULTS,
  type LlmStreamPort,
  type NormalizeSettings,
} from './lib/normalize.ts'
import { createSegmenter, SEGMENT_DEFAULTS, type SegmentSettings } from './lib/segment.ts'
import { createModelWriter, MODEL_WRITE_DEFAULTS, WRITE_TYPES, type ModelWriteSettings } from './lib/modelwrite.ts'
import {
  DEFAULT_QUOTA,
  DEFAULT_RELEVANCE_WEIGHT,
  NAME_LIKE,
  inScope,
  renderRecall,
  searchMemories,
  selectMemories,
} from './lib/recall.ts'
import { isNoteworthyVeto, screenSentence, signatureOf } from './lib/signals.ts'
import { archiveId, createMemoryStore, MEMORY_TYPES, type L0Entry, type MemoryRecord } from './lib/store.ts'
import { ECHO_DEFAULTS, findEcho, type EchoSettings } from './lib/echo.ts'
import { estimateTokens, excerpt, hashText } from './lib/text.ts'
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

/**
 * How much token overlap makes two sentences "the same kind of thing" worth asking about.
 *
 * Half the shorter sentence: high enough that a shared word or two does not trigger the
 * question, low enough to catch a paraphrase whose wording was rearranged. The score is
 * `findConflictPartner`'s normalised overlap, so the number means something independent
 * of corpus size — unlike a raw BM25 score.
 */
const NEAR_DUPLICATE_MIN = 0.5

/**
 * How much of the person's recent text may become the injection query.
 *
 * BM25 divides by document length, so a very long query flattens every memory's score toward zero —
 * which would silently disable relevance while appearing to be more context. Four thousand characters
 * is a few turns of conversation, which is what "what are we working on" needs.
 */
const RECALL_QUERY_MAX_CHARS = 4000

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
  /**
   * How many of the person's recent messages form the injection query.
   *
   * 3 covers "what are we working on" without dragging in a finished topic from ten turns ago. `0`
   * turns the relevance ranking off entirely and restores the pre-2026-10-03 behaviour, which is kept
   * because it is the configuration the 6% coverage number was measured under.
   */
  queryMessages: number
  /** Importance against relevance; see `DEFAULT_RELEVANCE_WEIGHT` for the sweep. */
  relevanceWeight: number
  /**
   * Boost for a just-written memory, in score units; `0` disables it.
   *
   * Answers "was the sentence I just stated visible on the next turn". Measured on the synthetic
   * recency probe (a fresh record added to each probe, see `eval/recall-report.ts`): 0 → 9 of 36 fresh
   * memories injected; 0.4 → 32 of 36 with **no** coverage cost; 0.6 → 36 of 36 but coverage drops a
   * probe, which is the mechanism sliding back into being the hard reserve it was chosen over.
   */
  recencyBonus: number
  /** Slots reserved for the newest memories; measured and left off — see `recentSlots` in lib/recall. */
  recentSlots: number
  /**
   * Leave an id out of the injected line when it is only the sentence's own signature.
   *
   * On, and measured: the turn-end writer's ids *are* `signatureOf(text)` (16 of 16 records in the live
   * store), so the id was printing the memory a second time. Dropping it took the block from 4.4 to
   * **6.5 memories inside the same 591 tokens**, coverage 17/36 → 18/36, and the budget-blocked cases
   * in the funnel from 3 to 1.
   */
  omitRedundantId: boolean
  /**
   * Which types may be injected, when that should differ from which types may be written.
   *
   * These were one value, and they are two decisions. Widening what gets stored is a change to what
   * the plugin considers a memory; widening what gets injected is a change to how much of the store
   * the model sees. The funnel measurement showed the coupling has a cost: 16 of 36 probe targets are
   * typed `fact`, the injection filter refuses them, and *because the same list gates the write path*
   * there was no way to see what allowing them would buy without also loosening the writer.
   *
   * Absent means "the same as `types`", which is the shipped behaviour.
   */
  types?: string[]
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
  /**
   * The "unsure" band's lower edge on the judge's conflict probability; `0` turns the band off.
   *
   * Paired with the judge's own conflict threshold (0.7) as the upper edge: [this, 0.7) means "the model
   * did not call it a conflict and was not sure it isn't one", which is a question for the person rather
   * than a decision for the plugin.
   */
  conflictReviewMinScore: number
  /** whether a suspected conflict is put to the human instead of only being withheld. */
  askOnConflict: boolean
  /** how long to wait for that answer before leaving the record in `needs-review`. */
  /**
   * Deadline for one question, in ms. **0 means no deadline**, which is what the harness does: its ask
   * service has no timeout of its own and resolves only when the person answers (it throws if the signal
   * aborts or nothing accepts the request). The plugin's ten-minute limit was its own invention.
   */
  askOnConflictTimeoutMs: number
  /** how many times one unresolved conflict may be asked about, in total. */
  askOnConflictMaxAttempts: number
  /** how many times a tool failure must repeat before it is worth remembering at all. */
  repeatFailuresToWrite: number
  writeEnabled: boolean
  writeSkipSubagents: boolean
  /**
   * What decides whether an archived message becomes a memory.
   *
   * `deterministic` (default): the type whitelist plus the extractor's own score. Measured on
   * 140 labelled rows, the model judge at its re-tuned threshold scored F1 0.33 and the free
   * rule scored 0.34 — and each one's *unique* contribution was equally poor (2 correct out
   * of 14, and 2 out of 12). Paying a network call per candidate to tie a local rule is not a
   * trade worth making, so the judge was moved off the gate.
   *
   * `judge`: the previous behaviour, where the model's `remember` answer gates the write.
   * Kept because the measurement is 18 positives and a future model may earn it back.
   *
   * Note this does **not** disable the judge. Conflict and duplicate decisions still go to it
   * (`pairDecision`), which is where its ranking ability — AUC 0.75 — is actually used.
   */
  writeGate: 'deterministic' | 'judge'
  /**
   * Which of the two write paths reads the turn.
   *
   * `pipeline`: segment, then extract, then judge, then gate — the path the sections below describe,
   * where each step is a rule and the model is asked one bounded question per step.
   *
   * `model`: one call reads the window and answers, per span, whether it is worth remembering and
   * what kind of memory it is; the text is sliced from the message by offsets located in code. It
   * exists because it was measured first, on 120 labelled rows whose windows could be rebuilt, and
   * it beat the pipeline on precision *and* recall at once (56%/90%, F1 0.69, against 27%/60%,
   * F1 0.37).
   *
   * It is **not** free: the same call's latency had a median 1233ms and a 3701ms worst case inside a
   * 2500ms write budget, and 16 of 49 exceeded the 1600ms it would be given. When it times out the
   * turn falls back to the deterministic splitter and the local gate — a slower decision, never a
   * lost one, because the fallback deliberately does not then call the segmenter.
   */
  writeMode: 'pipeline' | 'model'
  /** Settings for the model write path; `window` is read by both paths. */
  modelWrite: Partial<ModelWriteSettings>
  /**
   * What "the recent conversation" means when a model reads it: **rounds**, not messages.
   *
   * A round is one thing the person said plus the final answer they got. Counting *messages* instead
   * was measured and is the wrong shape: a turn in this very session produced 47 messages, so the last
   * five were five of the assistant's own lines with nothing of the person's in them — the model was
   * asked to find their words in a window that could not contain any. Measured on the live log, on the
   * same session:
   *
   * | window | characters | their messages | segment call |
   * |---|---|---|---|
   * | last 5 messages (old) | 6779 | 1 (33 chars) | valid, **2807ms** |
   * | 5 rounds, answers untruncated | 12276 | 5 (239 chars) | valid, 1216ms |
   * | 5 rounds, answers capped at 150 | **989** | 5 | valid, **1268ms** |
   *
   * Counter-intuitive but consistent across the runs: the call's latency tracks the length of *its own
   * answer* (it quotes every span it keeps), not the size of the window. Capping each round's answer
   * therefore makes the window smaller *and* more informative at the same time.
   */
  conversationWindow: { rounds: number; answerChars: number }
  /**
   * Whether a sentence the session already said — by the model — may become a memory.
   *
   * On by default, and this is the one screen whose cost was measured against the person's own
   * notes: 15 of the 28 rows whose note says "this is the model's output" are caught, **none of the
   * positives is killed**, and 20 negatives are blocked. It needs no model and no network — the
   * archive keeps the assistant's messages, and the check is a substring comparison.
   */
  echo: EchoSettings & { enabled: boolean }
  /**
   * Whether a model reads the recent window and decides the sentence boundaries and who said what.
   *
   * On by default, because the deterministic splitter was measured against the labelled notes and
   * four of the sixteen badly-split rows are not mechanical at all: they are a message that mixes
   * the person's words with a block they pasted, which no punctuation rule can separate. The
   * fallback is the splitter, so a provider outage degrades to today's behaviour rather than to
   * nothing — see `dsh/lib/segment.ts` for the two properties that keep it from inventing text.
   */
  segment: Partial<SegmentSettings>
  /**
   * Whether `memory_search` also looks at the archive.
   *
   * On by default: content the gate passed over is exactly what a person is most likely to
   * search for, since the system already decided it was not worth surfacing on its own.
   */
  searchArchive: boolean
  writeTimeoutMs: number
  judgeTimeoutMs: number
  knownForConflict: number
  /**
   * Cleaned rendering of each memory, for injection.
   *
   * Records by default, injects only when `normalize.inject` is turned on — the verbatim
   * sentence is the evidence and this is a derived convenience on top of it.
   */
  normalize: NormalizeSettings
  /**
   * Ask the model what a near-duplicate sentence is, instead of assuming.
   *
   * The signature can only say "these look alike". Whether that means a restatement,
   * a correction, or two different rules is a judgement, and getting it wrong loses
   * something the person said (dropped as a duplicate) or leaves two memories for one
   * rule. So the model is asked — but only where determinism has already failed, and
   * only about one named memory, so the common path pays nothing.
   */
  pairDecision: boolean
  /**
   * How to rank the memories the conflict question draws on.
   *
   * `lexical` (default): BM25, no dependency, nothing leaves the machine.
   * `embedding`: cosine similarity from an embedding provider — better on paraphrase,
   * but the stored sentences are sent to that provider and a cache of derived vectors
   * is kept beside the store. See `embedding` below.
   */
  conflictRanking: 'lexical' | 'embedding'
  /**
   * How the `memory_search` tool ranks its hits.
   *
   * `lexical` (default): BM25 over the whole store, local, no dependency. Since 2026-10-01
   * this replaced a substring matcher — see `searchMemories` for the measurement.
   * `embedding`: cosine similarity instead, which measured much better on questions that do
   * not reuse the memory's words (MRR 0.71 → 0.90 overall, 0.46 → 0.83 on those). It sends
   * the query and every stored sentence to the provider, so it is not the default.
   */
  searchRanking: 'lexical' | 'embedding'
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
  /**
   * `memory` for a promoted record, `archive` for a message that was archived but never
   * promoted.
   *
   * The distinction is the whole point of the archive layer: a person searching for
   * something the gate passed over must be able to find it, and must be able to see that it
   * was never treated as a memory. Hiding the origin would make the two indistinguishable in
   * exactly the case where the difference matters.
   */
  origin: 'memory' | 'archive'
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
  /** ids written this turn, for the asynchronous canonical pass. */
  writtenIds: string[]
  candidates: number
  duplicates?: number
  model?: string | null
  degraded?: string | null
  /** conflicts the judge raised, paired with the record they contradict. */
  pendingConflicts?: ConflictAsk[]
}

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
  via: 'jev' | 'overlap' | 'known' | 'known'
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
export const version = '0.32.0'

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
   *
   * 0.12, not 0.6, and the two numbers have to move together with
   * `REMEMBER_QUESTION`. Measured on 140 labelled rows in `eval/labels/round5.csv`,
   * five-fold cross-validated (threshold chosen on the other folds, scored on the held-out
   * one, five repeats): the old wording with its threshold reached F1 0.21, catching 49% of
   * what should be remembered; this wording with 0.12 reaches F1 0.32 and catches 67%,
   * while writing *more* of them correctly (写对率 14% → 22%) rather than trading one for
   * the other. Cross-validation pulled the best threshold for this wording to 0.12–0.13 on
   * every repeat; the old wording's best threshold wandered between 0.23 and 0.32.
   *
   * The number is fitted to those 140 rows — cross-validation only rules out fitting the
   * *threshold*, not the question — so a fresh batch is owed before this is treated as
   * settled.
   */
  minRemember: 0.12,
  /** A suspected conflict is stored but withheld from recall until a human confirms. */
  reviewOnConflict: true,
  conflictReviewMinScore: 0.3,
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
  // Aligned with the harness, which imposes none: a question card sits until it is answered. The cost
  // is that the turn does not finish until then — the same trade the harness's own `ask` makes, on
  // purpose, for the person's sake.
  askOnConflictTimeoutMs: 0,
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
  writeGate: 'deterministic',
  // Shipped as `pipeline`, and that is a deliberate ordering rather than a verdict on the model
  // path: the two were measured against each other on the write side and `model` won, but its
  // latency (median 1233ms, worst 3701ms) sits too close to the write budget for a one-line default,
  // and it costs one call per turn on every install. Turning it on is a deliberate choice with the
  // ledger's `write-path` line as the thing to watch: `reason` there says `ok`, `unparsable` or an
  // abort, and a high share of the two latter means the budget, not the prompt, is the problem.
  writeMode: 'model',
  modelWrite: { ...MODEL_WRITE_DEFAULTS },
  // Five rounds is what the person asked for, and the cap is measured rather than chosen for tidiness:
  // at 400 characters the model started enumerating spans inside the assistant's answers too (10
  // segments, 5074ms), while at 150 it returned exactly the five human spans in 1268ms. 200 sits in
  // that regime with room for a longer reply.
  conversationWindow: { rounds: 5, answerChars: 200 },
  searchArchive: true,
  // The library defaults `segment.enabled` to false so consumers opt in deliberately; the shipped
  // plugin turns it on, because the deterministic splitter was measured against the labelled notes
  // and the rows it cannot handle are the ones where a message mixes the person's words with a block
  // they pasted. Every failure path still falls back to the splitter.
  segment: { ...SEGMENT_DEFAULTS, enabled: true },
  echo: { ...ECHO_DEFAULTS, enabled: true },
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
  /**
   * Budget for the whole turn-end write path; the hook is fail-open on expiry.
   *
   * Raised from 2500ms on request ("先 10s 内就行"). Verified first that nothing above it imposes a
   * shorter limit: `agent/turn-stopping` is a cordis `serial` dispatch, which awaits each listener with
   * no timeout of its own, so this number is the real ceiling. The cost is the wait: a slow model call
   * now holds the end of the turn for up to ten seconds instead of two and a half.
   */
  writeTimeoutMs: 12_000,
  /** Per-call budget for the Jev request inside that path. */
  judgeTimeoutMs: 1800,
  /** How many known memories are shown to the judge for the conflict question. */
  knownForConflict: 20,
  pairDecision: true,
  normalize: { ...NORMALIZE_DEFAULTS },
  conflictRanking: 'lexical',
  searchRanking: 'lexical',
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
    // Injection now reads the conversation. Measured on the 36-probe baseline: coverage 0/36 → 17/36,
    // and the share of injected records that are real memories 20% → 42%. The probing detail is in
    // `DEFAULT_RELEVANCE_WEIGHT`; the short version is that the old ranking spent the budget on
    // whatever looked important, and the store's important-looking records are mostly write-side
    // false positives.
    queryMessages: 3,
    relevanceWeight: DEFAULT_RELEVANCE_WEIGHT,
    // Just-written memories get a bounded boost rather than a reserved slot. Both were measured and the
    // bonus strictly dominated: 32/36 fresh memories injected with the coverage number untouched,
    // against 29/36 and coverage 17 → 16 (→ 11 at two slots) for the reserve, which pays by evicting
    // the lowest-ranked answer. See the recency table in the report.
    recencyBonus: 0.4,
    recentSlots: 0,
    omitRedundantId: true,
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
    conversationWindow: {
      ...DEFAULT_CONFIG.conversationWindow,
      ...((source.conversationWindow ?? {}) as Partial<PluginConfig['conversationWindow']>),
    },
    jev: { ...((source.jev ?? {}) as Partial<JevSettings>) },
    normalize: { ...DEFAULT_CONFIG.normalize, ...((source.normalize ?? {}) as Partial<NormalizeSettings>) },
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
  if (config.writeGate !== 'deterministic' && config.writeGate !== 'judge') {
    problems.push(`writeGate: unknown value "${String(config.writeGate)}"; using deterministic`)
    config.writeGate = 'deterministic'
  }
  if (config.writeMode !== 'pipeline' && config.writeMode !== 'model') {
    problems.push(`writeMode: unknown value "${String(config.writeMode)}"; using pipeline`)
    config.writeMode = 'pipeline'
  }
  if (config.searchRanking !== 'lexical' && config.searchRanking !== 'embedding') {
    problems.push(`searchRanking: unknown value "${String(config.searchRanking)}"; using lexical`)
    config.searchRanking = 'lexical'
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
   * Vectorize texts through the cache, fetching only what is missing.
   *
   * Returns null on any shortfall — no key, a provider error, a timeout, vectors that do not
   * line up — because every caller treats the embedding path as an optimisation. Factored out
   * when search needed the same table as conflict ranking: two copies of this loop is two
   * places for the index/vector pairing to drift.
   */
  const ensureVectors = async (texts: readonly string[]): Promise<Map<string, number[]> | null> => {
    const settings = { ...EMBEDDING_DEFAULTS, ...config.embedding } as EmbeddingSettings
    await vectorCache.load()
    const missing: string[] = []
    for (const text of texts) {
      if (vectorCache.get(vectorKey(settings, text)) === undefined && !missing.includes(text)) missing.push(text)
    }
    if (missing.length > 0) {
      const fresh = await embedding.embed(missing)
      if (fresh === null) return null
      for (const [index, text] of missing.entries()) {
        const vector = fresh[index]
        if (vector === undefined) return null
        vectorCache.set(vectorKey(settings, text), vector)
      }
      void vectorCache.persist()
    }
    const vectors = new Map<string, number[]>()
    for (const text of texts) {
      const vector = vectorCache.get(vectorKey(settings, text))
      if (vector === undefined) return null
      vectors.set(text, vector)
    }
    return vectors
  }

  /**
   * Rank memories by cosine similarity, or give up and let BM25 do it.
   *
   * Returns null on any shortfall, because ranking is an optimisation and the write path must
   * not depend on it. The caller falls back to lexical.
   */
  const embeddingRanker =
    config.conflictRanking !== 'embedding'
      ? undefined
      : async (
          incoming: string,
          records: readonly MemoryRecord[],
          limit: number,
        ): Promise<MemoryRecord[] | null> => {
          const vectors = await ensureVectors([incoming, ...records.map((record) => record.text)])
          if (vectors === null) return null
          const incomingVector = vectors.get(incoming)
          if (incomingVector === undefined) return null
          return records
            .map((record) => ({ record, score: cosineSimilarity(incomingVector, vectors.get(record.text) ?? []) }))
            .sort((left, right) => {
              if (right.score !== left.score) return right.score - left.score
              return (right.record.updatedAt ?? 0) - (left.record.updatedAt ?? 0)
            })
            .slice(0, limit)
            .map((entry) => entry.record)
        }

  /**
   * Rank search hits by cosine similarity, or null to keep the lexical result.
   *
   * Measured before it was wired: on 36 probes derived from labelled memories, BM25 ranked the
   * answering memory at MRR 0.71 overall and 0.46 for probes that phrased the need in other
   * words; cosine ranked it 0.90 and 0.83. Across the whole set there was **not one probe where
   * BM25 found the target in the top 5 and embeddings missed it**, and 7 where the reverse
   * held. Hence a ranking *mode* rather than a fusion: the naive normalized sum measured worse
   * than embeddings alone (0.74), because BM25 scores 1.0 for its own top hit whatever that hit
   * is, and RRF recovered only part of the gap (0.83).
   *
   * Opt-in, not the default, because it sends the query and every stored sentence to a
   * provider. `lexical` keeps search local.
   */
  const embeddingSearchRanker =
    config.searchRanking !== 'embedding'
      ? undefined
      : async (query: string, records: readonly MemoryRecord[], limit: number): Promise<MemoryRecord[] | null> => {
          const vectors = await ensureVectors([query, ...records.map((record) => record.text)])
          if (vectors === null) return null
          const queryVector = vectors.get(query)
          if (queryVector === undefined) return null
          return records
            .map((record) => ({ record, score: cosineSimilarity(queryVector, vectors.get(record.text) ?? []) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score || right.record.importance - left.record.importance)
            .slice(0, limit)
            .map((entry) => entry.record)
        }

  // --- canonical form -------------------------------------------------------------
  //
  // Jev cannot do this: its API answers noul/choice/score and cannot emit text. So the
  // harness's own `llm` service is used, and the route is asked for rather than hardcoded
  // — the deployment owns which model is the default.
  const llmPort = ctx.get?.('llm') as LlmStreamPort | undefined
  const defaultModel = ctx.get?.('agentDefaultModel') as
    | { currentSelection?: () => { provider?: unknown; model?: unknown } }
    | undefined
  const normalizer = createNormalizer({
    llm: llmPort,
    settings: config.normalize,
    log,
    resolveRoute: async () => {
      if (config.normalize.provider !== '' && config.normalize.model !== '') {
        return { provider: config.normalize.provider, model: config.normalize.model }
      }
      const selection = defaultModel?.currentSelection?.()
      const provider = typeof selection?.provider === 'string' ? selection.provider : ''
      const model = typeof selection?.model === 'string' ? selection.model : ''
      return provider !== '' && model !== '' ? { provider, model } : null
    },
  })

  /**
   * Decide the sentence boundaries and who wrote what, from a window of recent messages.
   *
   * Runs *inside* the write budget rather than after it, unlike the canonical pass: what it returns
   * changes which candidates exist at all, so doing it later would mean extracting twice. It has
   * its own shorter timeout inside that budget, and every failure falls back to the punctuation
   * splitter — the write path must never depend on a network round trip.
   */
  // The segmentation call runs inside the write budget, so its own timeout has to fit *inside* that
  // budget. It shipped at 8s by default — borrowed from the canonical pass, which runs after the
  // deadline — and 8s inside a 2.5s hook does not mean "segmentation falls back": it means the whole
  // turn's write is abandoned when the call is slow.
  //
  // The number is now measured rather than halved for safety: over 11 real conversation windows the
  // call took a median of 851ms and at most 1271ms, with 1 of 11 past a 1250ms budget. The judge
  // answers in a median 342ms, so 900ms of headroom covers the rest of the turn and segmentation
  // gets 1600ms — enough for every call in that sample, still inside 2500ms in the normal case.
  // The segmentation call is the *fallback* whenever the model write call is primary, so its budget has
  // to fit in what that call leaves behind. Without this the two budgets simply add up — 10s + 8s inside
  // a 12s deadline — and a failed model call would not fall back at all, it would abandon the turn and
  // write nothing, which is the one outcome the fallback exists to prevent.
  const reservedForModel = config.writeMode === 'model' ? Math.min(config.modelWrite.timeoutMs ?? MODEL_WRITE_DEFAULTS.timeoutMs, Math.max(400, config.writeTimeoutMs - 900)) : 0
  const segmentBudget = Math.min(
    config.segment.timeoutMs ?? SEGMENT_DEFAULTS.timeoutMs,
    // The rest of the turn needs room: a judge call (median 342ms measured) and the document write.
    Math.max(400, config.writeTimeoutMs - 900 - reservedForModel),
  )
  const segmentSettings: SegmentSettings = { ...SEGMENT_DEFAULTS, ...config.segment, timeoutMs: segmentBudget }

  // The one call that replaces the whole pipeline. It gets the same treatment for the same reason,
  // but its measured profile is worse: median 1233ms over 49 real windows, 16 of them past 1600ms,
  // worst 3701ms. `Math.max` keeps a small `writeTimeoutMs` from producing a negative budget, and the
  // fallback below is what makes a timeout survivable — it drops to the deterministic splitter and
  // the local gate rather than calling anything else.
  const modelWriteSettings: ModelWriteSettings = {
    ...MODEL_WRITE_DEFAULTS,
    ...config.modelWrite,
    timeoutMs: Math.min(
      config.modelWrite.timeoutMs ?? MODEL_WRITE_DEFAULTS.timeoutMs,
      Math.max(400, config.writeTimeoutMs - 900),
    ),
  }
  const modelWriter = createModelWriter({
    llm: llmPort,
    settings: modelWriteSettings,
    log,
    resolveRoute: async () => {
      const selection = defaultModel?.currentSelection?.()
      const provider = typeof selection?.provider === 'string' ? selection.provider : ''
      const model = typeof selection?.model === 'string' ? selection.model : ''
      return provider !== '' && model !== '' ? { provider, model } : null
    },
  })
  // Both paths read the same window length; `modelWrite.window` is the one that applies on the model
  // path because the call is what consumes it, and the segmenter's own value still governs its path.
  const writeWindow = config.writeMode === 'model' ? modelWriteSettings.window : segmentSettings.window
  const segmenter = createSegmenter({
    llm: llmPort,
    settings: segmentSettings,
    log,
    resolveRoute: async () => {
      const selection = defaultModel?.currentSelection?.()
      const provider = typeof selection?.provider === 'string' ? selection.provider : ''
      const model = typeof selection?.model === 'string' ? selection.model : ''
      return provider !== '' && model !== '' ? { provider, model } : null
    },
  })

  /**
   * Give the memories written this turn a canonical form.
   *
   * Deliberately outside the write deadline: the hook has 2500ms and its job is to persist
   * what the person said. Cleaning text for injection is not worth risking that, so it runs
   * afterwards, unbounded by the write budget but bounded by its own timeout, and a failure
   * leaves the verbatim sentence in place.
   *
   * @param ids - the records written this turn.
   * @param signal - the turn's abort signal.
   */
  async function normalizeWritten(ids: readonly string[], signal: AbortSignal | undefined): Promise<void> {
    // Asked once per pass, and silence when there is no route: a deployment without the
    // service would otherwise get a `normalize ok:false` line for every single write. The
    // capability is reported once, on the `start` line, where the embedding state goes too.
    if ((await normalizer.route()) === null) return
    for (const id of ids) {
      const record = store.get(id)
      if (!record || record.status !== 'active') continue
      // Stale means the sentence changed after it was cleaned, so it is redone.
      if (typeof record.canonical === 'string' && (record.canonicalAt ?? 0) >= record.updatedAt) continue
      const canonical = await normalizer.normalize(record.text, signal)
      if (canonical === null) {
        // The reason travels with the failure: a refusal rate that cannot be attributed is
        // a number nobody can act on, and "the gate is too strict" and "the model keeps
        // answering the wrong shape" are different problems with different fixes.
        void store.ledger({ kind: 'normalize', id, ok: false, reason: normalizer.lastReason() })
        continue
      }
      const current = store.get(id)
      if (!current || current.text !== record.text) continue
      await store.put({ ...current, canonical: canonical.text, canonicalModel: canonical.model, canonicalAt: Date.now() })
      void store.ledger({
        kind: 'normalize',
        id,
        ok: true,
        model: canonical.model,
        from: excerpt(record.text, 160),
        to: excerpt(canonical.text, 160),
      })
    }
  }

  /**
   * Schedule the canonical pass for records just written, on whichever path wrote them.
   *
   * Fire-and-forget by design: the memory is already durable, and the cleaning is for
   * injection, so it never delays a write or a tool result. A failure leaves the verbatim
   * sentence standing, which is why `normalizeWritten` already swallows its own errors.
   *
   * @param ids - ids just written.
   * @param signal - the caller's cancellation, when there is one.
   */
  function scheduleNormalize(ids: readonly string[], signal: AbortSignal | undefined): void {
    if (ids.length === 0 || !config.normalize.enabled) return
    void normalizeWritten(ids, signal).catch((error) =>
      log('warn', 'normalization pass failed; verbatim sentences stand', { error: String(error) }),
    )
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
        searchRanking: config.searchRanking,
        types: config.types,
      })
      const normalizeRoute = await normalizer.route()
      const normalizeState = {
        enabled: config.normalize.enabled,
        inject: config.normalize.inject,
        ready: normalizeRoute !== null,
        provider: normalizeRoute?.provider ?? null,
        model: normalizeRoute?.model ?? null,
      }
      const embeddingState =
        config.conflictRanking === 'embedding'
          ? await embedding.describe()
          : { mode: 'lexical', note: 'BM25 over the memories; nothing leaves the machine' }
      return store.ledger({
        kind: 'start',
        version,
        judge: judge.kind,
        writeGate: config.writeGate,
        writeMode: config.writeMode,
        modelWrite: {
          window: modelWriteSettings.window,
          budgetMs: modelWriteSettings.timeoutMs,
          // Requested, not observed — see `segment.requestedReasoningEffort` above.
          requestedReasoningEffort: 'off',
          // Same three states as `segment.route` above, for the same reason: "no route" and "turned
          // off" produce the same absence of writes and are not the same problem.
          route:
            config.writeMode !== 'model' || !modelWriteSettings.enabled
              ? 'disabled'
              : llmPort === undefined
                ? 'no-llm-service'
                : (await modelWriter.route()) === null
                  ? 'no-default-model'
                  : `${(await modelWriter.route())!.provider}/${(await modelWriter.route())!.model}`,
        },
        conflictRanking: config.conflictRanking,
        searchRanking: config.searchRanking,
        archive: store.archiveStats(),
        segment: {
          enabled: segmentSettings.enabled,
          window: segmentSettings.window,
          minCoverage: segmentSettings.minCoverage,
          // The *effective* budget, after the clamp above: a config value that would exceed the
          // write budget is the reason a slow call loses a whole turn, and the start line is where
          // that becomes visible without reading the code.
          budgetMs: segmentSettings.timeoutMs,
          // What is *requested*, not what was observed. The first version of this line said
          // `thinking: 'off'` as a literal, which is a claim that cannot be false — and a live
          // `unparsable` looked like evidence the option was being ignored, when the real cause was a
          // window too big for its own answer. The service validates this value against the model's
          // declared efforts and *throws* if unsupported (`dsh-llm` `resolveCallWithInfo`), so a
          // rejection would surface as `error:...` on the call's own line rather than as silence.
          requestedReasoningEffort: 'off',
          // Three different states, three different words. `null` used to mean any of them at once,
          // which is the same mistake as `ready: false` with no `source`: the first start line after
          // this shipped said `route: null` next to `enabled: false`, and there was no way to tell
          // whether the model was unreachable or the feature was simply off.
          route: !segmentSettings.enabled
            ? 'disabled'
            : llmPort === undefined
              ? 'no-llm-service'
              : (await segmenter.route()) === null
                ? 'no-default-model'
                : `${(await segmenter.route())!.provider}/${(await segmenter.route())!.model}`,
        },
        // The gate, not just the judge. Two runs can both say `judge: jev` while asking the
        // model different questions at different thresholds, and the ledger could not tell
        // them apart — which is exactly the question "did the numbers move because of my
        // change or because of the version?" that cost a round of confusion. The question is
        // recorded as a hash plus its length: enough to tell two wordings apart, short enough
        // not to paste a paragraph of prompt into every start line.
        gate: {
          minRemember: config.minRemember,
          minImportance: config.minImportance,
          types: config.types,
          // The *effective* question, so a config override is visible too rather than being
          // recorded as the shipped default.
          rememberQuestionHash: hashText(config.jev?.rememberQuestion ?? REMEMBER_QUESTION),
          rememberQuestionChars: (config.jev?.rememberQuestion ?? REMEMBER_QUESTION).length,
        },
        embedding: embeddingState,
        normalize: normalizeState,
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
   * The person's own recent words, as the query injection ranks against.
   *
   * Walks the session log backwards for `count` messages the human wrote. Empty is the honest answer
   * for a brand-new session and is what keeps the first turn behaving exactly as it used to — there
   * is no conversation to be relevant to yet.
   *
   * The cap is deliberate: BM25 normalises by document length, so pasting an entire file of history
   * in would dilute every memory's score toward zero and quietly turn relevance off.
   *
   * @param session - the session being served, if there is one.
   * @param count - how many of the person's messages to include.
   * @returns their text, oldest first, or '' when there is none.
   */
  function recallQueryOf(session: SessionLike | null | undefined, count: number): string {
    if (!session || count <= 0) return ''
    const limit = typeof session.seq === 'number' ? session.seq : 0
    const found: string[] = []
    for (let seq = limit - 1; seq >= 0 && found.length < count; seq -= 1) {
      const event = session.eventAt?.(seq)
      if (event?.type !== 'user/message') continue
      // The `seq` has to be attached: `archiveMessages` numbers the messages it returns by it and
      // skips any event without one, while `session.eventAt` returns the stored event rather than an
      // enriched copy. Without this the query was '' for every session — a silently disabled feature
      // whose output still looked plausible, because the prior ranking was still producing an order.
      // The end-to-end test is what caught it; a library test could not, since the library was never
      // the broken part.
      const text = archiveMessages([{ ...event, seq } as TurnEvent])[0]?.text ?? ''
      if (text !== '') found.push(text)
    }
    return found.reverse().join('\n').slice(0, RECALL_QUERY_MAX_CHARS)
  }

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
      // What the session is about right now, so injection can look at the conversation instead of
      // only at the store. Built from the person's own recent messages rather than the model's:
      // a memory is worth injecting when it bears on what was *asked*, and the assistant's long
      // replies would swamp the query with words nobody is searching for.
      const query = recallQueryOf(agent?.session, config.recall.queryMessages)
      const chosen = selectMemories(store.all(), {
        cwd,
        types: config.recall.types ?? config.types,
        quota: config.recall.quota,
        maxTokens: config.recall.maxTokens,
        now: Date.now(),
        preferCanonical: config.normalize.inject,
        query,
        relevanceWeight: config.recall.relevanceWeight,
        recencyBonus: config.recall.recencyBonus,
        recentSlots: config.recall.recentSlots,
        omitRedundantId: config.recall.omitRedundantId,
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
          tokens: estimateTokens(
            renderRecall(chosen, { includeHelp: false, preferCanonical: config.normalize.inject, omitRedundantId: config.recall.omitRedundantId }),
          ),
        })
      }
      return { text: renderRecall(chosen, { preferCanonical: config.normalize.inject, omitRedundantId: config.recall.omitRedundantId }), ids }
    } catch (error) {
      log('warn', 'recall failed; injecting nothing', { error: String(error) })
      return { text: '', ids: [] }
    }
  }

  /**
   * The conversation a model reads on the write path: the last few **rounds**, oldest first.
   *
   * One round is a message the person wrote plus the final answer that followed it. The intermediate
   * assistant lines and tool traffic of a long turn are deliberately left out: they are what the turn
   * *did*, not what was said to the person, and including them is what made the old window (the last
   * five messages) capable of containing nothing the person wrote.
   *
   * Walked backwards from the end of the session log so a long session costs five rounds, not its
   * whole history. Returns null when the session cannot be walked — the caller then keeps the old
   * message-count window, which is also what its own tests exercise.
   *
   * @param session - the session being written from.
   * @param rounds - how many rounds to include.
   * @param answerChars - cap on each round's answer; the person's own words are never truncated.
   * @returns the window in reading order, or null.
   */
  function conversationWindowOf(
    session: SessionLike | null | undefined,
    rounds: number,
    answerChars: number,
  ): Array<{ seq: number; role: string; text: string }> | null {
    if (!session?.eventAt || rounds <= 0) return null
    const limit = typeof session.seq === 'number' ? session.seq : 0
    const collected: Array<{ seq: number; role: string; text: string }> = []
    // Assistant lines of the round being walked, newest first. The first one collected is that round's
    // final answer, which is the only one the next round's reader needs.
    let answers: Array<{ seq: number; text: string }> = []
    let found = 0
    for (let seq = limit - 1; seq >= 0 && found < rounds; seq -= 1) {
      const event = session.eventAt(seq)
      if (!event) continue
      const message = archiveMessages([{ ...event, seq } as TurnEvent])[0]
      if (!message) continue
      if (message.role === 'assistant') {
        answers.push({ seq, text: message.text })
        continue
      }
      if (message.role !== 'user') continue
      collected.push({ seq, role: 'user', text: message.text })
      const answer = answers[0]
      if (answer && answerChars > 0) collected.push({ seq: answer.seq, role: 'assistant', text: answer.text.slice(0, answerChars) })
      answers = []
      found += 1
    }
    return collected.reverse()
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
    // The record may have been written a turn earlier, so it is not in any turn's
    // `writtenIds`; without this it would never get a canonical form.
    scheduleNormalize([incoming], undefined)
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
    // Selected by *state*, not by the reason it was parked: a question now comes from the unsure band,
    // whose record says `conflict: 'no'`. Requiring `yes` here made every band question unanswerable
    // after the first attempt — caught by the test that asserts the next turn resumes it.
    const pending = records.find(
      (record) =>
        record.status === 'needs-review' &&
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
  ): Promise<{ pair: ConflictPair; via: 'jev' | 'overlap' | 'known' } | null> {
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
    const turnHeader = agent?.session?.header

    // Archive before every guard and every flag.
    //
    // The archive is the evidence layer, and evidence that depends on readiness or on a feature
    // flag has holes exactly where someone would later want it: the first turns after a restart
    // (the store is still loading, `ready` is false, and those turns used to vanish) and delegated
    // sessions (whose messages are the parent's instructions — not memories, but real content,
    // and the only record of what a subagent was actually told). Extraction stays behind the
    // guards below; this does not.
    try {
      const archived = archiveMessages(collectTurnEvents(agent?.session))
      if (archived.length > 0) {
        void store.archive(
          archived.map((message) => ({
            sessionId: turnHeader?.id ?? null,
            seq: message.seq,
            role: message.role,
            at: Date.now(),
            cwd: turnHeader?.cwd ?? null,
            text: message.text,
          })),
        )
        void store.ledger({ kind: 'archive', count: archived.length, roles: [...new Set(archived.map((m) => m.role))] })
      }
    } catch (error) {
      log('warn', `archive skipped: ${String(error)}`)
    }

    if (!config.writeEnabled || !ready) return
    if (config.writeSkipSubagents && (turnHeader?.delegationDepth ?? 0) > 0) {
      void store.ledger({ kind: 'skip', reason: 'subagent-session', sessionId: turnHeader?.id ?? null, turn })
      return
    }

    let pending: ConflictAsk[] = []
    try {
      const outcome = await withDeadline(handleTurn(), config.writeTimeoutMs)
      pending = outcome?.pendingConflicts ?? []
      if (outcome?.written) log('info', `remembered ${outcome.written} item(s) from turn ${turn}`, { model: outcome.model })
      // After the write, never inside its budget.
      if (outcome) scheduleNormalize(outcome.writtenIds, signal)
    } catch (error) {
      log('warn', `turn-end write skipped (fail-open): ${String(error)}`)
      void store.ledger({ kind: 'hook-error', turn, error: String(error) })
    }

    // One question per turn, and only the first: two questions in a row is an
    // interrogation, not a memory system.
    if (pending.length > 0 && config.askOnConflict) {
      try {
        // No deadline by default — see `askOnConflictTimeoutMs`. A deployment that must not block (a
        // headless runner) sets one, and then an expired question leaves the record in `needs-review`
        // for the next-turn retry instead of holding the turn open.
        const asked = askAboutConflict(pending[0], agent, signal)
        await (config.askOnConflictTimeoutMs > 0 ? withDeadline(asked, config.askOnConflictTimeoutMs) : asked)
      } catch (error) {
        log('warn', `conflict question left unanswered (fail-open): ${String(error)}`)
        void store.ledger({ kind: 'conflict-resolved', id: pending[0].incomingId, choice: 'unanswered', error: String(error) })
      }
    }

    /** Read the turn's events, judge the candidates, and persist what passes the gate. */
    async function handleTurn(): Promise<TurnWriteOutcome> {
      const session = agent?.session
      const events = collectTurnEvents(session)
      const header = session?.header
      const cwd = header?.cwd ?? null

      // The window the segmenter reads: the last N messages, oldest first, from the same events the
      // extractor walks. Assistant messages are included because the point of a window is to see
      // what was being discussed, and because attribution needs something to distinguish from.
      //
      // On `writeMode: 'model'` the same window goes to the one call that decides everything, and
      // the segmentation call is *not* made: it is not that the two are redundant, it is that the
      // write budget is 2500ms and the two calls together do not fit in it. Measured on the real
      // provider, the one call has a median 1233ms and the slowest of 49 took 3701ms — longer than
      // the whole budget — so a failed model write must fall back to the deterministic splitter and
      // *stop*, never to a second round trip. Doing both would turn a timeout into a lost turn
      // instead of a slower decision.
      // The model reads rounds; the fallback is the old message-count window for a session that cannot
      // be walked (and for the tests that drive the hook with a hand-built event list).
      const conversation = conversationWindowOf(
        agent?.session,
        config.conversationWindow.rounds,
        config.conversationWindow.answerChars,
      )
      const window =
        conversation && conversation.length > 0 ? conversation : archiveMessages(events).slice(-writeWindow)
      // A window with nothing the person wrote cannot produce a memory, and both callers below exist
      // only to find the person's own spans. Measured in this very session: five consecutive assistant
      // messages, 4664 characters, and the segmentation call spent **7 seconds and 2400 tokens** to
      // answer `no-user-text`. That is the whole write budget spent on a call whose answer is known
      // before it is made.
      const hasHumanText = window.some((message) => message.role === 'user')
      let units: Array<{ seq: number; text: string; type?: string | null }> | null = null
      let modelWrite: {
        ok: boolean
        reason: string
        model: string | null
        items: number
        /** how many items came back with a summary, which is the only shape the store can use */
        summaries: number
        kept: number
        worth: number
      } | null = null
      // The model path's candidates: the model's own summaries, not verbatim spans.
      //
      // This is the point of the path — the stored sentence is readable on its own, and neither a typo
      // nor a clause cut can survive into it. The verbatim `source` travels beside it as provenance.
      let modelCandidates: Candidate[] | null = null
      if (config.writeMode === 'model' && hasHumanText) {
        const written = await modelWriter.decide(
          window.map((message) => ({ seq: message.seq, role: message.role, text: message.text })),
          signal,
        )
        modelWrite = {
          ok: written !== null,
          reason: modelWriter.lastReason(),
          model: written?.model ?? null,
          items: written?.items.length ?? 0,
          // Mirrors the evaluation that justified this path, exactly: an item counts only when the
          // model attributed it to the person, called it worth remembering, *and* typed it as a
          // memory. That triple is what scored F1 0.69 there, so widening it here would ship a rule
          // nobody measured. `worth` is kept separately in the ledger because the two refusals mean
          // different things: "not worth remembering" is the model doing its job, "typed other" is
          // the type whitelist still refusing a sentence the model said was worth keeping.
          summaries: (written?.items ?? []).filter((item) => item.summary !== '').length,
          kept: (written?.items ?? []).filter(
            (item) => item.who === 'user' && item.worth && (WRITE_TYPES as readonly string[]).includes(item.type),
          ).length,
          worth: (written?.items ?? []).filter((item) => item.who === 'user' && item.worth).length,
        }
        if (written) {
          modelCandidates = written.items
            .filter((item) => item.who === 'user' && item.worth && (WRITE_TYPES as readonly string[]).includes(item.type))
            // A runaway answer should not be able to write more than the deterministic path ever could.
            .slice(0, config.extract.maxPerTurn)
            .map((item) => ({
              kind: 'user' as const,
              // What gets stored, injected and searched: the model's summary.
              text: item.summary,
              key: signatureOf(item.summary),
              seq: item.seq,
              // What the person actually wrote — provenance, and the evidence behind the summary.
              quote: window[item.messageIndex]!.text.slice(item.start, item.end),
              hintedType: item.type,
              signalScore: 1,
              signals: [],
              tool: null,
              modelType: item.type,
            }))
        }
        void store.ledger({ kind: 'write-path', mode: 'model', window: window.length, ...modelWrite })
      } else {
        const segmented = hasHumanText ? await segmenter.segment(window, signal) : null
        if (segmented) {
          // Only the person's own spans become candidates. A block the model marked `pasted`,
          // `quoted` or `tool-output` is real text — it stays in the archive — but it is not their
          // claim, which is the distinction the labelled corpus keeps asking for.
          units = segmented.segments
            .filter((segment) => segment.attribution === 'user')
            .map((segment) => ({
              seq: window[segment.messageIndex]!.seq,
              text: window[segment.messageIndex]!.text.slice(segment.start, segment.end),
            }))
        }
        // A line per turn only when something happened. "No route" is a property of the install and
        // is already on the `start` line; copying it onto every turn would bury the timeouts, which
        // are the lines worth reading.
        const segmentReason = segmenter.lastReason()
        if (segmentReason !== 'no-route') {
          void store.ledger({
            kind: 'segment',
            ok: segmented !== null,
            reason: segmentReason,
            model: segmented?.model ?? null,
            window: window.length,
            units: segmented?.segments.length ?? 0,
            userUnits: units?.length ?? 0,
            pasted: segmented?.segments.filter((segment) => segment.attribution === 'pasted').length ?? 0,
            coverage: segmented ? Number(segmented.coverage.toFixed(2)) : null,
            budgetMs: segmentSettings.timeoutMs,
            // Why it failed, in the line itself. Without these three the live failures read
            // `unparsable` for a week and that word points at the prompt, while the cause was the token
            // budget: on a reasoning route the thinking eats it, and on a big window the answer does.
            // Two different fixes, indistinguishable from the old line.
            windowChars: window.reduce((total, message) => total + message.text.length, 0),
            finish: segmenter.lastAnswer()?.finish ?? null,
            answerChars: segmenter.lastAnswer()?.chars ?? null,
            reasoningChars: segmenter.lastAnswer()?.reasoningChars ?? null,
          })
        }
      }

      // The screens and the extractor are the *fallback* path's way of deciding what is worth keeping.
      // When the model answered, it decided that itself — re-deciding it locally is the thing this path
      // exists to stop doing. One exception is kept deliberately: a secret must not reach the store, and
      // that is a data-safety rule rather than a judgement about worth.
      const candidates =
        modelCandidates !== null
          ? modelCandidates.filter((candidate) => {
              const screen = screenSentence(`${candidate.text} ${candidate.quote}`)
              if (screen.keep || screen.reason !== 'secret') return true
              void store.ledger({ kind: 'skip', reason: 'veto:secret', id: candidate.key, quote: excerpt(candidate.quote, 120) })
              return false
            })
          : extractCandidates(events, {
        ...config.extract,
        units,
        // Which messages that answer covers. The extractor walks the whole turn, and in a long turn
        // the person's message is not in the window at all — reading "the model answered" as "the
        // model answered about everything" made such a turn produce no candidates, silently.
        decidedSeqs: units === null ? null : new Set(window.map((message) => message.seq)),
        // The extractor reports every rejection; the ledger records the reasons that carry
        // information (see isNoteworthyVeto), because a line per question and per "好的"
        // would bury the lines that matter.
        onVeto: (sentence, reason) => {
          if (!isNoteworthyVeto(reason)) return
          void store.ledger({ kind: 'skip', reason: `veto:${reason}`, quote: excerpt(sentence, 120) })
        },
      })
      if (candidates.length === 0) return { written: 0, writtenIds: [], candidates: 0 }

      // The echo screen. A sentence the *model* already said, pasted into the person's message, is
      // not their requirement — and the envelope cannot tell the difference, so the comparison is
      // against what this session actually said earlier. Measured on the labelled rows: 15 of 28
      // caught, none of the positives killed.
      const decided =
        config.echo.enabled && modelCandidates === null
        ? candidates.filter((candidate) => {
            const earlier = store
              .recentArchive()
              .filter(
                (entry) =>
                  entry.sessionId === (header?.id ?? null) &&
                  entry.role !== 'user' &&
                  typeof entry.seq === 'number' &&
                  typeof candidate.seq === 'number' &&
                  entry.seq < candidate.seq,
              )
            const hit = findEcho(candidate.text, earlier, config.echo)
            if (!hit) return true
            void store.ledger({
              kind: 'skip',
              reason: 'echoed-model',
              id: candidate.key,
              role: hit.role,
              coverage: Number(hit.coverage.toFixed(2)),
              quote: excerpt(candidate.quote, 120),
            })
            return false
          })
        : candidates

      if (decided.length === 0) return { written: 0, writtenIds: [], candidates: candidates.length }

      const inScopeRecords = store.all().filter((record) => inScope(record, cwd))
      const activePartners = inScopeRecords.filter((record) => record.status === 'active')
      /** candidate key → the same-identity record whose text this replaces in place. */
      const updates = new Map<string, string>()
      /** candidate key → a different-identity record this one supersedes. */
      const replacements = new Map<string, string>()
      /**
       * candidate key → the pair question's verdict, carried out of the dedup loop.
       *
       * The two loops are separate (`decided` → `fresh`), so the verdict is not in scope where it is
       * recorded on the write path; the pre-emption line needs it to say *which* relationship pre-empted
       * the question.
       */
      const pairVerdicts = new Map<string, string | null>()
      /** candidate key → the stored memory it resembles, for the relationship question. */
      const partners = new Map<string, MemoryRecord>()
      /**
       * The stored memory we already know this candidate is about, from either path.
       *
       * Used to ask the person directly. The question needs to name the other side, and re-deriving it
       * with `choosePartner` failed on live traffic — the band fired, the pairing could not be named
       * again, and a question that should have been asked was dropped as `conflict-unpaired`.
       */
      const knownPartnerOf = new Map<string, MemoryRecord>()

      const fresh: Candidate[] = []
      for (const candidate of decided) {
        const exact = store.get(candidate.key)
        // Byte-identical to something stored: no judgement in it, no model call.
        if (exact && exact.text === candidate.text) {
          void store.ledger({ kind: 'skip', reason: 'duplicate', id: candidate.key, quote: candidate.quote })
          continue
        }
        // The signature matched but the words differ (`<n>` folds 8000 and 9000 into
        // one), or most tokens are shared (a paraphrase). Both are places where the
        // deterministic key is the wrong authority, so the model is asked which of the
        // three relationships it is. Without the model, behaviour is what it was: a
        // signature match is still treated as a duplicate.
        const near = exact ?? findConflictPartner(candidate.text, activePartners, NEAR_DUPLICATE_MIN)?.existing
        // Collection only: the partner is found here because this half is deterministic and free, and
        // the relationship is asked in the *same* request as everything else about the candidate. Asking
        // it as a second round trip, beside a separate conflict question, was the redundancy the person
        // pointed at.
        if (near) {
          partners.set(candidate.key, near)
          knownPartnerOf.set(candidate.key, near)
        }
        pairVerdicts.set(candidate.key, null)
        if (near) {
          // Two shapes, and which one this is decided by the identity, not by the model.
          //
          // When the id matches, old and new *are* the same record by construction: the
          // signature folds 8000 and 9000 into `<n>`. Writing a "new" record therefore
          // overwrote the old one and then superseded what it had just written, which left
          // the memory unreachable — worse than either behaviour. The record is updated in
          // place instead, with the previous text in the ledger: the rule keeps its identity
          // across a corrected number, which is what identity should mean.
          //
          // A model that cannot answer changes nothing here: the person's latest words win,
          // and the collision is recorded rather than dropped in silence.
          if (near.id === candidate.key) {
            // Same identity: the record is updated in place, whatever the model says about the
            // relationship. The ledger line that used to record "the model could not answer" is written
            // after the judgement comes back, where the answer actually is.
            updates.set(candidate.key, near.id)
          }
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
      if (fresh.length === 0) {
        return { written: 0, writtenIds: [], candidates: candidates.length, duplicates: decided.length }
      }

      // Ranked, not sliced: `slice(0, 20)` handed the judge the first twenty memories
      // in store order, so a contradiction at position twenty-one was invisible and
      // the judge answered "no conflict" with nothing in the ledger to show for it.
      // One window for the whole turn, ranked against every candidate's text: the
      // judge sees a single `known` list, so it should hold whatever any of this
      // turn's sentences might contradict.
      const shown = await rankPartners(
        fresh.map((candidate) => candidate.text).join('\n'),
        inScopeRecords,
        config.knownForConflict,
      )
      const known = shown.map((record) => `[${record.type}] ${record.text}`)

      const { rows, model, degraded } = await judge.judge(fresh, {
        known,
        // The partner each candidate resembles, if any: the relationship is asked about it in the same
        // request. `null` for a candidate with no similar memory, which is when the model is asked what
        // it *is* about instead.
        partners: fresh.map((candidate) => partners.get(candidate.key)?.text ?? null),
        signal,
        project: cwd,
      })

      // Apply what came back with the request, and follow up only where there was nothing to quote.
      const skippedPairs = new Set<string>()
      for (const candidate of fresh) {
        const judgement = rows.find((row) => row.key === candidate.key)
        if (!judgement) continue
        const partner = partners.get(candidate.key)
        pairVerdicts.set(candidate.key, judgement.relationship ?? null)
        if (partner) {
          // The relationship was asked in the same request, quoted against this sentence.
          //
          // `same-update` means the old record is superseded — but only when it is a *different* record.
          // When the identity is the same, the in-place update is already recorded above and superseding
          // it would mean the record superseding itself: exactly the bug the in-place path was built to
          // avoid (a record that overwrote itself was unreachable).
          //
          // And nothing is replaced while a question is pending: the band fired precisely because the
          // model's answer was not decisive, so applying its lean first meant answering "keep the old one"
          // left neither memory — the old one already superseded and the new one dropped.
          const torn = relationActionsDisagree(judgement.relationshipProbabilities, config.conflictReviewMinScore)
          if (judgement.relationship === 'same-update' && partner.id !== candidate.key && !torn) {
            replacements.set(candidate.key, partner.id)
          }
          if (judgement.relationship === 'same-duplicate' && !torn) skippedPairs.add(candidate.key)
          // `typeof` rather than `!== null`: the offline judge's rows simply lack the field, and an
          // `undefined` that reads as "the model answered" writes a decision line for a question nobody
          // was asked.
          if (typeof judgement.relationship === 'string') {
            void store.ledger({
              kind: 'pair-decision',
              id: candidate.key,
              with: partner.id,
              decision: judgement.relationship,
              probabilities: judgement.relationshipProbabilities ?? null,
              by: judgement.by,
              model,
              overlap: Number((findConflictPartner(candidate.text, [partner], 0)?.score ?? 0).toFixed(3)),
              quote: excerpt(candidate.quote, 120),
            })
          } else if (partner.id === candidate.key) {
            // Same identity, no usable answer: the person's latest words still win (the in-place update
            // is already recorded), and the collision is written down rather than dropped in silence.
            void store.ledger({
              kind: 'signature-collision',
              id: candidate.key,
              from: excerpt(partner.text, 160),
              to: excerpt(candidate.text, 160),
              reason: !config.pairDecision ? 'pair-decision-disabled' : 'judge-unavailable',
            })
          }
        } else if (typeof judgement.relatedIndex === 'number' && judgement.relatedIndex >= 0) {
          // Nothing similar by wording, but the model says this is about one of the known memories. The
          // relationship depends on *which* one, so it is a second request — the rare path, and the only
          // one left that costs a round trip.
          const target = shown[judgement.relatedIndex]
          if (target) {
            const verdict = await judge.decidePair(candidate.text, target.text, { project: cwd, signal })
            // Carried onto the row so the gate's band reads the same distribution whether the
            // relationship was answered in the first request or this follow-up.
            judgement.relationship = verdict.decision
            judgement.relationshipProbabilities = verdict.probabilities
            pairVerdicts.set(candidate.key, verdict.decision)
            knownPartnerOf.set(candidate.key, target)
            // The same rule as the first path, and it was missing here: while a question is pending the
            // model's lean must not be applied. Live traffic showed what that costs — the old memory was
            // superseded with nobody asked, because this branch set a replacement and the question was
            // then dropped for want of a nameable partner.
            const tornHere = relationActionsDisagree(verdict.probabilities, config.conflictReviewMinScore)
            if (verdict.decision === 'same-update' && target.id !== candidate.key && !tornHere) {
              replacements.set(candidate.key, target.id)
            }
            if (verdict.decision === 'same-duplicate' && !tornHere) skippedPairs.add(candidate.key)
            if (verdict.by === 'jev') {
              void store.ledger({
                kind: 'pair-decision',
                id: candidate.key,
                with: target.id,
                decision: verdict.decision ?? 'unknown',
                probabilities: verdict.probabilities ?? null,
                by: verdict.by,
                model: verdict.model,
                via: 'related-follow-up',
                quote: excerpt(candidate.quote, 120),
              })
            }
          }
        }
      }

      // The model named nothing related; when the deterministic check disagrees, record it without
      // interrupting anyone. Kept as a diagnostic for the one thing the merged question can no longer
      // see: a memory the model overlooked entirely.
      for (const candidate of fresh) {
        const judgement = rows.find((row) => row.key === candidate.key)
        if (partners.has(candidate.key)) continue
        if (typeof judgement?.relatedIndex === 'number' && judgement.relatedIndex >= 0) continue
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
      const writtenIds: string[] = []
      const pendingConflicts: ConflictAsk[] = []
      for (const candidate of fresh) {
        const judgement = rows.find((row) => row.key === candidate.key)
        if (skippedPairs.has(candidate.key)) {
          // The relationship said this sentence adds nothing the stored one does not already say.
          void store.ledger({
            kind: 'skip',
            reason: 'pair-duplicate',
            id: candidate.key,
            with: partners.get(candidate.key)?.id ?? null,
            quote: excerpt(candidate.quote, 120),
          })
          continue
        }
        // `deterministic` means the *local* type and score decide, not the model's.
        //
        // The first implementation only stripped `remember`, and `applyGate` then fell through to
        // the judge's `importance` — which is its 0..1 score answer. That combination was never
        // measured, and measuring it found it almost always closed: over 90 reconstructed rows,
        // 2 of 18 positives cleared importance 0.6 without a window and **0 of 18 with one**. The
        // arm the setting was justified by (F1 0.34) is the extractor's own type and score, so
        // those are what it now uses. The judge's `conflict` answer still travels, because the
        // review path depends on it.
        const local = heuristicRow(
          {
            key: candidate.key,
            text: candidate.text,
            hintedType: candidate.hintedType,
            signalScore: candidate.signalScore,
            signals: candidate.signals,
          },
          config,
        )
        const gated =
          config.writeGate === 'judge' || !judgement
            ? judgement
            : { ...judgement, type: local.type, importance: local.importance, remember: null }
        // On the model write path the call already decided this span is worth remembering and what
        // kind of memory it is, so the local gate would be a second opinion with a worse record
        // (F1 0.37 against 0.69 on the rows both were measured on). Its `conflict` answer still
        // counts, which is why the gate is not simply bypassed.
        const fromModel = typeof candidate.modelType === 'string' && candidate.modelType !== ''
        const gate = fromModel ? applyModelGate(judgement, config) : applyGate(gated, config)
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
            // The raw probability, so a later run can tell "nothing near the line" from "the threshold
            // is cutting real conflicts off" — the verdict alone cannot.
            conflict: judgement?.conflict ?? null,
            conflictScore: judgement?.conflictScore ?? null,
            quote: excerpt(candidate.quote, 120),
          })
          continue
        }
        // A suspected conflict is written first, in `needs-review`, and only then
        // taken to the human. Writing first means an unanswered question leaves the
        // system exactly where it is today — the record exists, and it is withheld
        // from recall — instead of losing what the user said.
        const updated = updates.get(candidate.key)
        const replaced = replacements.get(candidate.key)
        // A candidate the pair question already resolved as an update is not a
        // contradiction: asking the person to arbitrate it would be asking them to
        // re-decide what the model just decided, with less context.
        // The band's whole purpose is to ask precisely when the model's own answer was not decisive, so
        // a relationship that *leaned* one way must not suppress the question — that was the old rule,
        // and it made every torn answer silent. `pendingConflicts.length === 0` still limits a turn to one
        // question.
        if (gate.review && config.askOnConflict && pendingConflicts.length === 0) {
          // The partner is usually already known — either the similar memory the relationship was quoted
          // against, or the one the model named. Re-deriving it costs a model call and can fail, which is
          // how a question the band asked for went unasked.
          const known = knownPartnerOf.get(candidate.key)
          const paired = known
            ? { pair: findConflictPartner(candidate.text, [known], 0) ?? { incoming: candidate.text, existing: known, score: 0, shared: [] }, via: 'known' as const }
            : await pairConflict(candidate.text, store.all().filter((record) => record.status === 'active' && inScope(record, cwd)), cwd, signal)
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
        } else if (judgement.conflict === 'yes' && (replaced !== undefined || updated !== undefined)) {
          // A *confident* conflict that the pair judgement then resolved as the same rule in newer
          // wording: the person's decision is that this is Jev's to resolve, so no question is asked and
          // the old memory is replaced. Counted rather than argued about — this line is how we learn how
          // often a confident conflict silently overwrites an earlier statement, and whether any of them
          // were reversals somebody would have wanted to arbitrate. Counting changes no behaviour.
          void store.ledger({
            kind: 'conflict-preempted',
            id: candidate.key,
            with: replaced ?? updated ?? null,
            decision: pairVerdicts.get(candidate.key) ?? null,
            conflict: judgement?.conflict ?? null,
            conflictScore: judgement?.conflictScore ?? null,
            by: judgement?.by ?? 'none',
            quote: excerpt(candidate.quote, 120),
          })
        }
        const now = Date.now()
        // Read the previous text *before* the put: afterwards the record already holds the
        // new one, and the ledger line would claim the old text was the new text.
        const previousText = updated === undefined ? '' : (store.get(updated)?.text ?? '')
        // The type that decided the write. On the model path that is the model's own answer — the
        // local type only *hinted* it, and `selectMemories` filters the type whitelist, so storing
        // the hint here would write a record that is never injected.
        const writtenType = fromModel ? candidate.modelType! : (gated?.type ?? judgement.type)
        await store.put({
          id: candidate.key,
          // The type and importance that the *gate used*, not the judge's own numbers.
          //
          // Under `writeGate: deterministic` the gate reads the local type and score while the
          // judge may answer something else entirely — and this line used the judge's answer, so a
          // sentence the local rule accepted as `constraint` was stored as the judge's `fact`.
          // `selectMemories` filters on the type whitelist, so such a record was written and then
          // never injected: silent, and invisible to a test that asserts through `memory_search`,
          // which does not filter by type.
          type: writtenType,
          text: candidate.text,
          cwd,
          importance: gated?.importance ?? judgement.importance,
          // A pending question means the record is withheld from recall until it is answered, whether or
          // not a replacement was proposed: an unreviewed guess must not enter the prompt.
          status: gate.review ? 'needs-review' : 'active',
          supersedes: replaced ?? null,
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
          // What was acted on, and separately what the model said — the ledger records both so the
          // two can be compared after the fact instead of being conflated in one field.
          type: writtenType,
          importance: gated?.importance ?? judgement.importance,
          judgeType: judgement.type,
          modelType: candidate.modelType ?? null,
          remember: judgement.remember,
          conflictScore: judgement.conflictScore ?? null,
          by: judgement.by,
          model,
          conflict: judgement.conflict,
          // A pending question means the record is withheld from recall until it is answered, whether or
          // not a replacement was proposed: an unreviewed guess must not enter the prompt.
          status: gate.review ? 'needs-review' : 'active',
          supersedes: replaced ?? null,
          cwd,
          source: { sessionId: header?.id ?? null, seq: candidate.seq, quote: excerpt(candidate.quote, 160) },
          signals: judgement.signals,
          note: judgement.note,
        })
        if (updated !== undefined) {
          // In place: `store.put` already preserves createdAt, recalls and lastRecalledAt.
          void store.ledger({
            kind: 'pair-updated',
            id: candidate.key,
            inPlace: true,
            from: excerpt(previousText, 160),
            to: excerpt(candidate.text, 160),
          })
        }
        if (replaced !== undefined) {
          await store.supersede(replaced, candidate.key)
          void store.ledger({ kind: 'pair-updated', id: candidate.key, superseded: replaced, inPlace: false })
        }
        writtenIds.push(candidate.key)
        written += 1
      }
      return {
        written,
        writtenIds,
        candidates: candidates.length,
        duplicates: candidates.length - fresh.length,
        model,
        degraded,
        pendingConflicts,
      }
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
        const retried = retryPendingConflict(payload.agent, payload.signal)
        await (config.askOnConflictTimeoutMs > 0 ? withDeadline(retried, config.askOnConflictTimeoutMs) : retried)
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
      const asked = String(query ?? '')
      const wanted = limit ?? 20
      // Lexical first, then replaced when the embedding path answered: the fallback is the
      // already-computed result rather than a second code path, so a provider outage degrades
      // to BM25 instead of to an error.
      let hits = searchMemories(store.all(), asked, { cwd: cwdOf(exec), limit: wanted })
      if (embeddingSearchRanker) {
        const scoped = store
          .all()
          .filter((record) => inScope(record, cwdOf(exec)) && record.status !== 'superseded')
        const ranked = await embeddingSearchRanker(asked, scoped, wanted)
        if (ranked) {
          // Rare quoted names first, then the semantic order.
          //
          // Measured on the 36-probe baseline: embeddings alone score **MRR 0.00 on identifier
          // probes** — a question quoting a file or an error code has no semantic content to embed, so
          // the target is nowhere near the top. A verbatim name match is evidence no similarity score
          // can beat, and pinning is the lexically unambiguous case: the name occurs in one or two
          // memories. With that condition the embedding path goes 0.90 → **0.92** overall, near
          // questions 0.97 → **1.00**, far unchanged at 0.83, and identifiers 0.00 → **0.98**.
          //
          // The condition matters and was measured: pinning *every* verbatim match costs the near
          // questions (0.97 → 0.88), because those queries reuse the memory's own words and therefore
          // contain ordinary tokens that look like names and that several records share.
          const rare = (record: typeof scoped[number], name: string): boolean =>
            scoped.filter((other) => other.text.includes(name)).length <= 2 && record.text.includes(name)
          const pinned: typeof ranked = []
          for (const name of asked.match(NAME_LIKE) ?? []) {
            for (const record of scoped) if (rare(record, name)) pinned.push(record)
          }
          const ordered: typeof ranked = []
          const seen = new Set<string>()
          for (const record of [...pinned, ...ranked]) {
            if (seen.has(record.id)) continue
            seen.add(record.id)
            ordered.push(record)
          }
          hits = ordered.map((record) => ({ record, score: 0 }))
        }
      }
      const matches: MemorySearchMatch[] = hits
        .filter((hit) => (type ? hit.record.type === type : true))
        .map((hit) => ({ ...toMatch(hit.record), origin: 'memory' as const }))

      // Then the archive, ranked by the same scorer. Same query, same ranking, one merged
      // list: the person asked a question, not a question about one storage layer.
      if (config.searchArchive) {
        const archived = archiveRecords(store.recentArchive())
          .filter((record) => (type ? false : true))
          .filter((record) => inScope(record, cwdOf(exec)))
        const archiveHits = searchMemories(archived, asked, { cwd: cwdOf(exec), limit: wanted })
        for (const hit of archiveHits) matches.push({ ...toMatch(hit.record), origin: 'archive' as const })
      }
      return { query: asked, matches, total: store.stats().total }
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
      scheduleNormalize([id], undefined)
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
        id: {
          type: 'string',
          description: '记忆 id，只在注入的那条后面带 id 时使用（id 与原文相同的话就不显示了，那时用 query）',
        },
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
        // An archive id is not a memory: it was never promoted, so `remove` cannot see it.
        // Handled here rather than rejected, because the person found it by searching and
        // "I cannot delete what you just showed me" is the answer that makes a memory system
        // untrustworthy.
        removed = id.startsWith('l0:')
          ? ((await store.forgetArchive(id)) ? [id] : [])
          : (await store.remove(id))
            ? [id]
            : []
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
/** One search match without the origin, which the two call sites set themselves. */
function toMatch(record: {
  id: string
  type: string
  text: string
  importance: number
  createdAt: number
  status: string
}): Omit<MemorySearchMatch, 'origin'> {
  return {
    id: record.id,
    type: record.type,
    text: record.text,
    importance: record.importance,
    createdAt: record.createdAt,
    status: record.status,
  }
}

/**
 * Shape archived messages so the same retriever can rank them.
 *
 * Reusing `searchMemories` rather than writing a second matcher is deliberate: the archive and
 * the store must be judged by one definition of relevance, or a hit in one layer and a miss in
 * the other would be an artefact of the code rather than of the content.
 *
 * @param entries - archived messages, oldest first.
 * @returns records scoped and typed for the retriever.
 */
function archiveRecords(entries: readonly L0Entry[]): MemoryRecord[] {
  return entries.map((entry, index) => ({
    id: archiveId(entry, index),
    type: 'archive',
    text: entry.text,
    cwd: entry.cwd,
    importance: 0.5,
    status: 'active',
    source: { sessionId: entry.sessionId, seq: entry.seq, quote: entry.text.slice(0, 200), at: entry.at },
    createdAt: entry.at,
    updatedAt: entry.at,
    recalls: 0,
    lastRecalledAt: null,
    judge: { kind: 'archive', confidence: null, conflict: 'unknown', mode: null },
  }))
}

function renderSearchResult(value: MemorySearchResult): string {
  const matches = value?.matches ?? []
  if (matches.length === 0) return `长期记忆里没有匹配「${value?.query ?? ''}」的条目（共 ${value?.total ?? 0} 条记忆）。`
  const lines = matches.map(
    (match) =>
      `- [${match.type}${match.origin === 'archive' ? ' · 原文归档，未被采纳为记忆' : ''}] ${match.text} (${match.id}, ${new Date(match.createdAt).toISOString().slice(0, 10)})`,
  )
  const archived = matches.filter((match) => match.origin === 'archive').length
  return `匹配「${value.query}」的长期记忆：\n${lines.join('\n')}${archived > 0 ? `\n（其中 ${archived} 条来自原文归档，是当时没通过闸门、但原话仍在的内容）` : ''}`
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
