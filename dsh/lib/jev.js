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
 * @module dsh/lib/jev
 */

import { clamp01 } from './store.js'

/** Transport and vocabulary defaults; every one is overridable from plugin config. */
export const JEV_DEFAULTS = {
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
  /** Score legend, from least to most important (2–10 levels allowed). */
  importanceLevels: ['可以忽略', '有点用但不关键', '有用', '重要', '非常关键'],
  /** Only this many candidates are judged per request; the rest stay unjudged. */
  maxCandidates: 6,
  /** Known memories included as conflict context (context rot is real: keep it small). */
  maxKnown: 20,
}

/** Type definitions handed to the Choice question as its criteria. */
export const TYPE_CRITERIA = {
  constraint: '硬约束：以后也必须遵守的规则、约定、禁止事项',
  pitfall: '踩过的坑：曾导致失败、报错、返工的具体教训',
  decision: '已定的决策及其原因：选型、方案取舍',
  preference: '个人偏好：风格、习惯、默认做法',
  procedure: '流程：固定的操作步骤或检查清单',
  rejected: '被明确否掉的方案：不要再提的做法',
  fact: '项目事实：端口、路径、入口等易过期的事实',
}

/**
 * Create the Jev client.
 *
 * @param {object} options - wiring.
 * @param {object} options.config - the `jev` config block.
 * @param {(level: string, message: string, detail?: unknown) => void} [options.log] - host logger.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation, injectable for tests.
 * @param {NodeJS.ProcessEnv} [options.env] - environment used for key and base-URL lookups.
 * @returns {{available: boolean, endpoint: string, decide: (request: object) => Promise<{rows: any[], model: string|null}>}} the client.
 */
export function createJevClient({ config = {}, log = () => {}, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const settings = { ...JEV_DEFAULTS, ...config }
  const apiKey = settings.apiKey || env?.[settings.apiKeyEnv] || ''
  const baseUrl = config.baseUrl || env?.[settings.baseUrlEnv] || settings.baseUrl
  const endpoint = new URL(settings.path, baseUrl).href
  const available = Boolean(apiKey) && typeof fetchImpl === 'function'

  return {
    available,
    endpoint,
    /**
     * Label and score candidates in one request.
     *
     * @param {object} request - judge input.
     * @param {Array<{key: string, text: string, hintedType: string|null}>} request.candidates - candidates.
     * @param {string[]} request.types - enabled types (the Choice labels).
     * @param {string[]} [request.known] - known memory texts, for the conflict question.
     * @param {number} [request.timeoutMs] - per-call budget.
     * @param {AbortSignal} [request.signal] - the turn's abort signal.
     * @returns {Promise<{rows: any[], model: string|null}>} judgement rows plus the responding model id.
     */
    async decide(request) {
      if (!available) throw new Error('jev is not configured')
      const candidates = (request.candidates ?? []).slice(0, settings.maxCandidates)
      if (candidates.length === 0) return { rows: [], model: null }

      const body = buildRequestBody({
        model: settings.model,
        candidates,
        types: request.types?.length ? request.types : ['constraint', 'pitfall', 'decision'],
        known: (request.known ?? []).slice(0, settings.maxKnown),
        importanceLevels: settings.importanceLevels,
      })

      const response = await postWithRetry({
        url: endpoint,
        apiKey,
        body,
        timeoutMs: Number.isFinite(request.timeoutMs) ? request.timeoutMs : settings.timeoutMs,
        maxRetries: settings.maxRetries,
        retryStatuses: settings.retryStatuses,
        fetchImpl,
        signal: request.signal,
        log,
      })

      return {
        rows: parseDecisions(response.json, candidates, {
          conflictThreshold: settings.conflictThreshold,
          importanceLevels: settings.importanceLevels.length,
        }),
        model: typeof response.json?.model === 'string' ? response.json.model : null,
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
 * @param {object} input - request content.
 * @param {string} input.model - model id or alias.
 * @param {Array<{text: string}>} input.candidates - candidates, index-addressed.
 * @param {string[]} input.types - enabled type labels.
 * @param {string[]} input.known - known memory texts.
 * @param {string[]} input.importanceLevels - ordered score legend.
 * @returns {object} the JSON request body.
 */
export function buildRequestBody({ model, candidates, types, known, importanceLevels }) {
  /** @type {Record<string, object>} */
  const questions = {}
  const choiceCriteria = {}
  for (const type of types) choiceCriteria[type] = TYPE_CRITERIA[type] ?? type
  choiceCriteria['none-of-the-above'] = '以上都不合适，或这条信息本身不值得记住'

  candidates.forEach((candidate, index) => {
    questions[rememberId(index)] = {
      type: 'noul',
      instructions: '这条信息是否值得写入长期记忆：它对以后的新会话仍然成立，并且不是一次性的任务指令？',
      criteria: {
        true: `值得记住：${candidate.text}`,
        false: '不值得：只是一次性任务、寒暄、提问，或对本项目无长期价值',
      },
    }
    questions[typeId(index)] = {
      type: 'choice',
      instructions: `如果「${candidate.text}」值得长期记住，它属于哪一类？`,
      criteria: choiceCriteria,
    }
    questions[importanceId(index)] = {
      type: 'score',
      instructions: `「${candidate.text}」作为长期记忆的重要性有多高？`,
      criteria: importanceLevels,
    }
    questions[conflictId(index)] = {
      type: 'noul',
      instructions: `「${candidate.text}」是否与 state 中已有的记忆冲突，或被其中某一条取代（同一件事给出不同说法）？没有相关条目时回答 false。`,
      criteria: { true: '冲突或被取代', false: '不冲突' },
    }
  })

  return {
    state: { known_memories: known },
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
 * @param {any} response - parsed response body.
 * @param {Array<{key: string, hintedType: string|null}>} candidates - the candidates that were sent.
 * @param {{conflictThreshold: number, importanceLevels: number}} options - mapping constants.
 * @returns {Array<object>} one row per answered candidate.
 */
export function parseDecisions(response, candidates, options) {
  const answers = response?.answers && typeof response.answers === 'object' ? response.answers : {}
  const rows = []
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const remember = answers[rememberId(index)]
    const choice = answers[typeId(index)]
    const score = answers[importanceId(index)]
    const conflict = answers[conflictId(index)]
    if (!remember && !choice && !score) continue

    const label = typeof choice?.choice === 'string' ? choice.choice : null
    const scoreValue = typeof score?.score === 'number' ? score.score : null
    const importance = scoreValue === null ? (typeof remember?.noul === 'number' ? clamp01(remember.noul) : null) : scoreToUnit(scoreValue, options.importanceLevels)

    rows.push({
      key: candidate.key,
      type: label && label !== 'none-of-the-above' ? label : candidate.hintedType,
      importance,
      conflict: (typeof conflict?.noul === 'number' ? conflict.noul : 0) >= options.conflictThreshold ? 'yes' : 'no',
      confidence: typeof choice?.confidence === 'number' ? clamp01(choice.confidence) : typeof score?.confidence === 'number' ? clamp01(score.confidence) : null,
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
 * @param {number} score - the expected score.
 * @param {number} levels - the number of legend entries.
 * @returns {number} importance in 0..1.
 */
export function scoreToUnit(score, levels) {
  const span = Math.max(1, levels - 1)
  return clamp01(score / span)
}

/**
 * POST one JSON body, retrying only retryable statuses inside one deadline.
 *
 * The timeout is deliberate rather than incidental: this call sits inside the
 * harness's awaited turn boundary, and a slow judge must lose to a fast turn
 * close. Retries therefore share the caller's budget instead of extending it,
 * which is the opposite of the SDK default (10s per attempt, no total budget).
 *
 * @param {object} request - transport input.
 * @param {string} request.url - absolute endpoint.
 * @param {string} request.apiKey - bearer token.
 * @param {unknown} request.body - JSON-serializable request body.
 * @param {number} request.timeoutMs - total budget in milliseconds.
 * @param {number} request.maxRetries - retries after the first attempt.
 * @param {number[]} request.retryStatuses - statuses worth retrying.
 * @param {typeof fetch} request.fetchImpl - fetch implementation.
 * @param {AbortSignal} [request.signal] - outer abort signal.
 * @param {(level: string, message: string, detail?: unknown) => void} request.log - host logger.
 * @returns {Promise<{json: any, requestId: string|null, attempts: number}>} the parsed response.
 */
export async function postWithRetry({ url, apiKey, body, timeoutMs, maxRetries, retryStatuses, fetchImpl, signal, log }) {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let lastError

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
 * @param {number} ms - milliseconds to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/** @param {number} index - candidate index. @returns {string} question key. */
export const rememberId = (index) => `remember:${index}`
/** @param {number} index - candidate index. @returns {string} question key. */
export const typeId = (index) => `type:${index}`
/** @param {number} index - candidate index. @returns {string} question key. */
export const importanceId = (index) => `importance:${index}`
/** @param {number} index - candidate index. @returns {string} question key. */
export const conflictId = (index) => `conflict:${index}`
