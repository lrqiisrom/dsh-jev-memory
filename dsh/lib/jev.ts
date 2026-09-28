/**
 * Jev (TypeSafe System One) client: the optional model-backed judge.
 *
 * Jev is a *decision* model, not a generative one: one synchronous POST
 * carries a `state` and a map of typed questions, and the response carries
 * typed answers. That shape is why this plugin can use it safely — the
 * request has no field a new sentence could be written into, so the judge can
 * label and score candidates but can never invent a memory.
 *
 * Wire contract: `POST https://api.typesafe.ai/v1/systemone`, bearer auth,
 * body `{state, model, questions}`, response `{model, answers, usage}`.
 * Every field used below is documented in docs/jev-api.md with its source;
 * the parts of that document marked as unverified are not relied on here.
 *
 * Disciplines encoded in this file rather than left to callers:
 *  - the `confidence` Jev returns is passed through for the ledger only;
 *  - the conflict decision compares a *Noul* probability against a threshold
 *    this plugin owns, and never ports a threshold between primitives
 *    (official jaggedness documentation: P(q)+P(¬q) need not be 1);
 *  - a Score answer is turned into 0..1 by arithmetic in code, using the
 *    level count, rather than by asking the model for a percentage;
 *  - the responding model id is returned so the ledger records which version
 *    actually judged, making alias drift visible instead of silent.
 *
 * Types: the request/answer vocabulary is declared here because it is this
 * module's own wire contract, and the whole plugin is zero-dependency — the
 * harness type for `fetch` is the platform's, not an installed package. The
 * parsed response body is `unknown` and is read through `asRecord`, so no
 * field of a model answer is trusted just because it typechecks.
 *
 * @module dsh/lib/jev
 */

import { clamp01 } from './store.ts'

/** Host logger signature, repeated per module so no module imports another for it. */
export type LogSink = (level: string, message: string, detail?: unknown) => void

/** Transport and vocabulary settings; every one is overridable from plugin config. */
export interface JevSettings {
  baseUrl: string
  path: string
  apiKeyEnv: string
  baseUrlEnv: string
  /** Literal bearer token; takes precedence over the environment variable. */
  apiKey?: string
  model: string
  timeoutMs: number
  maxRetries: number
  retryStatuses: number[]
  conflictThreshold: number
  importanceLevels: string[]
  maxCandidates: number
  maxKnown: number
}

/** Transport and vocabulary defaults; every one is overridable from plugin config. */
export const JEV_DEFAULTS: Omit<JevSettings, 'apiKey'> = {
  baseUrl: 'https://api.typesafe.ai',
  path: '/v1/systemone',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  baseUrlEnv: 'TYPESAFE_BASE_URL',
  model: 'jev-latest',
  timeoutMs: 2000,
  /** Retries inside the timeout budget, only for retryable statuses. */
  maxRetries: 1,
  /** Retryable HTTP statuses per the official table (429, 529, 5xx, 408). */
  retryStatuses: [408, 429, 500, 502, 503, 504, 529],
  /** Noul probability above which a candidate is treated as conflicting. */
  conflictThreshold: 0.7,
  /**
   * Score legend, least to most important for *future sessions*.
   *
   * Every level names the future-session frame, because the generic wording
   * ("有用 / 重要") let Jev score a project-wide convention 0.28 while it scored a
   * one-off task instruction 0.73 — it had no way to tell which of the two would
   * still matter tomorrow.
   */
  importanceLevels: ['与未来会话无关', '只对本次任务有用', '对未来会话有点参考', '对未来会话重要', '以后必须遵守或反复用到'],
  /** Only this many candidates are judged per request; the rest stay unjudged. */
  maxCandidates: 6,
  /** Known memories included as conflict context (context rot is real: keep it small). */
  maxKnown: 20,
}

/** Type definitions handed to the Choice question as its criteria. */
export const TYPE_CRITERIA: Record<string, string> = {
  constraint: '硬约束：以后也必须遵守的规则、约定、禁止事项',
  pitfall: '踩过的坑：曾导致失败、报错、返工的具体教训',
  decision: '已定的决策及其原因：选型、方案取舍',
  preference: '个人偏好：风格、习惯、默认做法',
  procedure: '流程：固定的操作步骤或检查清单',
  rejected: '被明确否掉的方案：不要再提的做法',
  fact: '项目事实：端口、路径、入口等易过期的事实',
}

/**
 * One candidate as the model port sees it.
 *
 * `text` is optional only so the judgement layer's unit tests can build a
 * candidate without it: the heuristic judge never reads it, and the Jev request
 * body embeds it when a model actually judges.
 */
export interface JevCandidate {
  key: string
  text?: string
  hintedType: string | null
  signalScore: number
  signals: string[]
}

/** Judge input, as the judgement layer hands it to the client. */
export interface JevDecideRequest {
  candidates: JevCandidate[]
  /** enabled types (the Choice labels). */
  types: string[]
  /** known memory texts, for the conflict question. */
  known?: string[]
  /** the workspace the memories belong to; passed to the model as framing. */
  project?: string | null
  /** per-call budget. */
  timeoutMs?: number
  /** the turn's abort signal. */
  signal?: AbortSignal
}

/** One answer row, before the judgement layer maps it onto a candidate. */
export interface JevRow {
  key: string
  type: string | null
  importance: number | null
  /** Noul answer to "is this worth remembering at all"; the write gate reads this. */
  remember: number | null
  conflict: string
  confidence: number | null
  note?: string | null
}

/** What the model port answers: one row per answered candidate, plus the model id. */
export interface JevDecideResult {
  rows: JevRow[]
  model: string | null
}

/** One typed question in the request body. */
export interface JevQuestion {
  type: string
  /** A string, or the official object form that references named state fields by backticks. */
  instructions: string | Record<string, unknown>
  criteria: unknown
}

/**
 * The framing every question shares.
 *
 * Without it Jev judges the sentence in a vacuum and cannot know that "必须用
 * pnpm" is a project convention rather than generic common knowledge. The
 * official guidance warns that *irrelevant* state degrades accuracy; this is the
 * opposite case — the smallest amount of relevant framing.
 */
export const MEMORY_CONTEXT =
  '这是一个 coding agent 的跨会话长期记忆系统。写入的记忆会在以后**全新的会话**里被自动注入系统提示、占用上下文，所以宁缺勿滥。' +
  '判断的是「用户这句话里有没有**本项目的具体信息**——工具、命令、路径、数值、方案名、约定、踩过的坑、做过的取舍」，' +
  '而不是「它听起来深不深刻」。像"必须用 pnpm 而不是 npm"这种看着普通、但写明了本项目选型的句子，是**应当**记住的。' +
  '不该记住的：只对当前这一次任务有意义的操作指令、寒暄、提问、临时状态、与项目无关的闲聊，以及没有任何项目特异性的通用常识。'

/** The JSON request body sent to the endpoint. */
export interface JevRequestBody {
  /**
   * The evaluated content. `memory_system` is the fixed framing (what a memory
   * is for), `project` is the workspace the memories belong to, `known_memories`
   * is the conflict-check context. Deliberately nothing else: the official
   * guidance is that irrelevant state costs accuracy.
   */
  state: { memory_system: string; project: string | null; known_memories: string[] }
  model: string
  questions: Record<string, JevQuestion>
}

/** The live client `createJevClient` returns. */
export interface JevClient {
  /**
   * Whether a key is configured *right now*.
   *
   * A method rather than a boolean because the credential can appear or change
   * while the process runs: the harness's credentials service is documented to be
   * re-read per operation so a changed secret reaches the next operation without a
   * restart, and a plugin that cached the answer at mount would defeat that.
   */
  isAvailable(): Promise<boolean>
  /** readiness plus the layer the key came from (`credentials` / `config` / `env` / `none`). */
  describe(): Promise<{ ready: boolean; source: string; endpoint: string }>
  endpoint: string
  decide(request: JevDecideRequest): Promise<JevDecideResult>
}

/** Wiring for {@link createJevClient}. */
export interface JevClientOptions {
  /** the `jev` config block. */
  config?: Partial<JevSettings>
  /** host logger. */
  log?: LogSink
  /** fetch implementation, injectable for tests. */
  fetchImpl?: typeof fetch
  /** environment used for key and base-URL lookups. */
  env?: NodeJS.ProcessEnv
  /**
   * Resolve the bearer token from the host's credential service.
   *
   * Preferred over `config.apiKey` because it keeps the secret out of the
   * composition file, and over the environment variable because the harness's
   * credential store is the user-facing place to put one. A plain string is
   * labelled `credentials`; returning `{ key, source }` lets the host name the
   * exact layer it used, which is what makes a failure diagnosable.
   */
  resolveApiKey?: () => Promise<string | undefined | { key?: string; source: string }>
}

/**
 * Read a value as a property bag, or `null` when it cannot be one.
 *
 * Local to this module on purpose: the parsed response body is untrusted data,
 * and this is the one narrowing primitive used to read it without `any`.
 *
 * @param value - any value.
 * @returns the value as a record, or null.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * Create the Jev client.
 *
 * @param options - wiring.
 * @returns the client.
 */
export function createJevClient({
  config = {},
  log = () => {},
  fetchImpl = globalThis.fetch,
  env = process.env,
  resolveApiKey,
}: JevClientOptions = {}): JevClient {
  const settings: JevSettings = { ...JEV_DEFAULTS, ...config }
  const baseUrl = config.baseUrl || env?.[settings.baseUrlEnv] || settings.baseUrl
  const endpoint = new URL(settings.path, baseUrl).href

  /**
   * Resolve the bearer token for one call, most specific source first.
   *
   * Resolution happens per call rather than at mount: the credential service is
   * documented to be re-read per operation, and a user who pastes a key into the
   * settings UI should not have to restart the harness for the judge to start
   * working.
   */
  async function resolveKey(): Promise<{ key: string; source: string }> {
    if (resolveApiKey) {
      try {
        const fromHost = await resolveApiKey()
        if (typeof fromHost === 'string' && fromHost) return { key: fromHost, source: 'credentials' }
        if (fromHost && typeof fromHost === 'object' && fromHost.key) return { key: fromHost.key, source: fromHost.source }
      } catch (error) {
        log('warn', 'credential lookup failed; falling back to config/env', { error: String(error) })
      }
    }
    if (settings.apiKey) return { key: settings.apiKey, source: 'config' }
    const fromEnv = env?.[settings.apiKeyEnv]
    if (fromEnv) return { key: fromEnv, source: 'env' }
    return { key: '', source: 'none' }
  }

  return {
    async isAvailable(): Promise<boolean> {
      return Boolean((await resolveKey()).key) && typeof fetchImpl === 'function'
    },
    /**
     * Report whether a key is reachable and from which layer.
     *
     * Added because its absence cost a full debugging round: a key sat in the
     * credential store while the startup ledger said only `jevReady: false`, which
     * could equally have meant "wrong ref name", "service not reachable yet", or
     * "no key at all". The source name answers that in one field.
     *
     * @returns readiness plus the layer the key came from.
     */
    async describe(): Promise<{ ready: boolean; source: string; endpoint: string }> {
      const resolved = await resolveKey()
      return { ready: Boolean(resolved.key) && typeof fetchImpl === 'function', source: resolved.source, endpoint }
    },
    endpoint,
    /**
     * Label and score candidates in one request.
     *
     * @param request - judge input.
     * @returns judgement rows plus the responding model id.
     */
    async decide(request: JevDecideRequest): Promise<JevDecideResult> {
      const apiKey = (await resolveKey()).key
      if (!apiKey) throw new Error('jev is not configured')
      const candidates = (request.candidates ?? []).slice(0, settings.maxCandidates)
      if (candidates.length === 0) return { rows: [], model: null }

      const body = buildRequestBody({
        model: settings.model,
        candidates,
        types: request.types?.length ? request.types : ['constraint', 'pitfall', 'decision'],
        known: (request.known ?? []).slice(0, settings.maxKnown),
        importanceLevels: settings.importanceLevels,
        project: request.project ?? null,
      })

      const response = await postWithRetry({
        url: endpoint,
        apiKey,
        body,
        timeoutMs: typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs) ? request.timeoutMs : settings.timeoutMs,
        maxRetries: settings.maxRetries,
        retryStatuses: settings.retryStatuses,
        fetchImpl,
        signal: request.signal,
        log,
      })

      const json = asRecord(response.json)
      return {
        rows: parseDecisions(response.json, candidates, {
          conflictThreshold: settings.conflictThreshold,
          importanceLevels: settings.importanceLevels.length,
        }),
        model: typeof json?.model === 'string' ? json.model : null,
      }
    },
  }
}

/**
 * Build the request body: known memories as state, four typed questions per
 * candidate (worth remembering / which type / how important / conflicts).
 *
 * Candidate text lives inside its own questions rather than being duplicated
 * into `state`, so `state` holds exactly the context the conflict question
 * needs and nothing else — the official guidance is that irrelevant state
 * degrades accuracy.
 *
 * @param input - request content.
 * @returns the JSON request body.
 */
export function buildRequestBody({
  model,
  candidates,
  types,
  known,
  importanceLevels,
  project,
}: {
  model: string
  /** candidates, index-addressed. */
  candidates: JevCandidate[]
  /** enabled type labels. */
  types: string[]
  /** known memory texts. */
  known: string[]
  /** ordered score legend. */
  importanceLevels: string[]
  /** the workspace the memories belong to, as framing for the judgement. */
  project?: string | null
}): JevRequestBody {
  const questions: Record<string, JevQuestion> = {}
  const choiceCriteria: Record<string, string> = {}
  for (const type of types) choiceCriteria[type] = TYPE_CRITERIA[type] ?? type
  choiceCriteria['none-of-the-above'] = '以上都不合适，或这条信息本身不值得记住'

  candidates.forEach((candidate, index) => {
    questions[rememberId(index)] = {
      type: 'noul',
      instructions: {
        context: MEMORY_CONTEXT,
        candidate: candidate.text,
        question: '上一条 `candidate` 是否值得写进长期记忆，供以后**新的会话**使用？判断标准：换个会话、换一天，它是否仍然有用，并且是用户对项目的说法或偏好（不是这一次任务的操作指令）。',
      },
      criteria: {
        true: '跨会话仍然成立、且对以后有用',
        false: '只对当前这一次任务有意义，或是寒暄/提问/临时状态',
      },
    }
    questions[typeId(index)] = {
      type: 'choice',
      instructions: {
        context: MEMORY_CONTEXT,
        candidate: candidate.text,
        question: '如果上一条 `candidate` 值得长期记住，它属于哪一类？',
      },
      criteria: choiceCriteria,
    }
    questions[importanceId(index)] = {
      type: 'score',
      instructions: {
        context: MEMORY_CONTEXT,
        candidate: candidate.text,
        question: '上一条 `candidate` 对**以后的会话**有多重要？注意：项目里通用的常识不算重要，只有本项目的约定、教训、取舍才算。',
      },
      criteria: importanceLevels,
    }
    questions[conflictId(index)] = {
      type: 'noul',
      instructions: {
        context: MEMORY_CONTEXT,
        candidate: candidate.text,
        question: '上一条 `candidate` 是否与 `known_memories` 中的某一条冲突，或已被它取代（同一件事给出不同说法）？没有相关条目时回答 false。',
      },
      criteria: { true: '冲突或被取代', false: '不冲突' },
    }
  })

  return {
    state: {
      memory_system: MEMORY_CONTEXT,
      project: project ?? null,
      known_memories: known,
    },
    model,
    questions,
  }
}

/**
 * Map responses back onto candidates.
 *
 * Tolerant on purpose: an unanswered candidate is simply absent from the
 * result, and its caller falls back to the heuristic judge. Nothing here
 * throws on a missing field, because a partially answered response is still
 * useful and failing the whole turn's write would be worse.
 *
 * @param response - parsed response body.
 * @param candidates - the candidates that were sent.
 * @param options - mapping constants.
 * @returns one row per answered candidate.
 */
export function parseDecisions(
  response: unknown,
  candidates: JevCandidate[],
  options: { conflictThreshold: number; importanceLevels: number },
): JevRow[] {
  const answers = asRecord(asRecord(response)?.answers) ?? {}
  const rows: JevRow[] = []
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const rememberAnswer = answers[rememberId(index)]
    const choiceAnswer = answers[typeId(index)]
    const scoreAnswer = answers[importanceId(index)]
    const conflictAnswer = answers[conflictId(index)]
    if (!rememberAnswer && !choiceAnswer && !scoreAnswer) continue

    const remember = asRecord(rememberAnswer)
    const choice = asRecord(choiceAnswer)
    const score = asRecord(scoreAnswer)
    const conflict = asRecord(conflictAnswer)

    const choiceValue = choice?.choice
    const label = typeof choiceValue === 'string' ? choiceValue : null
    const scoreValue = typeof score?.score === 'number' ? score.score : null
    const rememberNoul = remember?.noul
    const importance =
      scoreValue === null ? (typeof rememberNoul === 'number' ? clamp01(rememberNoul) : null) : scoreToUnit(scoreValue, options.importanceLevels)
    const conflictNoul = conflict?.noul
    const choiceConfidence = choice?.confidence
    const scoreConfidence = score?.confidence

    rows.push({
      key: candidate.key,
      type: label && label !== 'none-of-the-above' ? label : candidate.hintedType,
      importance,
      // The Noul answer to "is this worth remembering at all" travels as its own
      // field. It used to be folded into `confidence`, which threw the answer away
      // exactly where it mattered — the write gate was reading a Score instead of
      // the boolean judgement, and a genuinely good constraint ("必须用 pnpm") scored
      // 0.28 on the generic importance rubric while a task instruction scored 0.73.
      remember: typeof rememberNoul === 'number' ? clamp01(rememberNoul) : null,
      conflict: (typeof conflictNoul === 'number' ? conflictNoul : 0) >= options.conflictThreshold ? 'yes' : 'no',
      confidence:
        typeof choiceConfidence === 'number' ? clamp01(choiceConfidence) : typeof scoreConfidence === 'number' ? clamp01(scoreConfidence) : null,
      note: null,
    })
  }
  return rows
}

/**
 * Turn a Score answer into 0..1 using the level count, in code.
 *
 * The answer may land between levels (the official example is 1.05), so this
 * is a linear map over `levels - 1` rather than a lookup — and it is arithmetic
 * the plugin performs, never a number the model is asked to interpolate.
 *
 * @param score - the expected score.
 * @param levels - the number of legend entries.
 * @returns importance in 0..1.
 */
export function scoreToUnit(score: number, levels: number): number {
  const span = Math.max(1, levels - 1)
  return clamp01(score / span)
}

/** The parsed HTTP response, before it is interpreted. */
export interface JevHttpResult {
  json: unknown
  requestId: string | null
  attempts: number
}

/**
 * POST one JSON body, retrying only retryable statuses inside one deadline.
 *
 * The timeout is deliberate rather than incidental: this call sits inside the
 * harness's awaited turn boundary, and a slow judge must lose to a fast turn
 * close. Retries therefore share the caller's budget instead of extending it,
 * which is the opposite of the SDK default (10s per attempt, no total budget).
 *
 * @param request - transport input.
 * @returns the parsed response.
 */
export async function postWithRetry({
  url,
  apiKey,
  body,
  timeoutMs,
  maxRetries,
  retryStatuses,
  fetchImpl,
  signal,
  log,
}: {
  /** absolute endpoint. */
  url: string
  /** bearer token. */
  apiKey: string
  /** JSON-serializable request body. */
  body: unknown
  /** total budget in milliseconds. */
  timeoutMs: number
  /** retries after the first attempt. */
  maxRetries: number
  /** statuses worth retrying. */
  retryStatuses: number[]
  /** fetch implementation. */
  fetchImpl: typeof fetch
  /** outer abort signal. */
  signal?: AbortSignal
  /** host logger. */
  log: LogSink
}): Promise<JevHttpResult> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let lastError: unknown

  while (attempt <= maxRetries) {
    attempt += 1
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`jev request timed out after ${timeoutMs}ms`)), remaining)
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const requestId = response.headers?.get?.('x-typesafe-request-id') ?? null
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const error = new Error(`jev responded ${response.status}${requestId ? ` (request ${requestId})` : ''}: ${detail.slice(0, 200)}`)
        if (!retryStatuses.includes(response.status) || attempt > maxRetries) throw error
        lastError = error
        log('warn', 'jev request failed with a retryable status', { attempt, status: response.status })
        await sleep(Math.min(500 * 2 ** (attempt - 1), Math.max(0, deadline - Date.now())))
        continue
      }
      return { json: await response.json(), requestId, attempts: attempt }
    } catch (error) {
      lastError = error
      if (attempt > maxRetries || signal?.aborted) break
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }
  throw lastError ?? new Error('jev request failed')
}

/**
 * @param ms - milliseconds to wait.
 * @returns resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/** @param index - candidate index. @returns question key. */
export const rememberId = (index: number): string => `remember:${index}`
/** @param index - candidate index. @returns question key. */
export const typeId = (index: number): string => `type:${index}`
/** @param index - candidate index. @returns question key. */
export const importanceId = (index: number): string => `importance:${index}`
/** @param index - candidate index. @returns question key. */
export const conflictId = (index: number): string => `conflict:${index}`
