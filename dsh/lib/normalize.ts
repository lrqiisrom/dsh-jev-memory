/**
 * A canonical rendering of a memory: the person's sentence, cleaned.
 *
 * Why this exists. The plugin stores what the person actually wrote, on purpose — it is
 * the evidence, and a memory that cannot be traced back to a sentence someone said is
 * worth less than one that can. But raw text carries what raw text carries: typos,
 * filler, fragments, half-sentences. Every other system in this space rewrites before
 * storing: memsearch has an LLM turn each turn into 2–10 third-person bullets and keeps
 * the transcript recoverable; OpenViking extracts into typed schema files with `as of`
 * dates. Storing the raw sentence is the outlier, and the drawback is real.
 *
 * So both are kept, and the split is the point:
 *
 *  - the **verbatim sentence** stays on the record and in the ledger, untouched;
 *  - the **canonical form** is a derived field, recomputed when the sentence changes,
 *    and used for injection only when a person has looked at samples and turned it on.
 *
 * Three rules keep it from becoming a fabrication channel:
 *
 *  1. **No new facts.** The prompt says so, and a deterministic gate enforces it: the
 *     canonical form must share enough of its content tokens with the sentence.
 *  2. **No silent acceptance.** A form that fails the gate is not repaired or trimmed —
 *     it is dropped, and the sentence stands. Fail-open here means "keep the original",
 *     never "keep what the model guessed".
 *  3. **No rewrite without a route.** Jev cannot do this at all — its API answers
 *     noul/choice/score and cannot emit text — so this uses the harness's own `llm`
 *     service and the deployment's default model. No route, no canonical form.
 *
 * @module dsh/lib/normalize
 */

import { tokenize } from './conflict.ts'

/** Host logger signature, repeated per module so no module imports another for it. */
export type LogSink = (level: string, message: string, detail?: unknown) => void

/** How the canonical form is produced and used. */
export interface NormalizeSettings {
  /** produce a canonical form at all. */
  enabled: boolean
  /**
   * inject the canonical form instead of the verbatim sentence.
   *
   * Off by default and deliberately: this changes what the model is shown, so it is a
   * decision made after reading samples, not a default that arrives with the feature.
   */
  inject: boolean
  /** provider route; empty means "ask the host for the default". */
  provider: string
  /** model id; empty means "ask the host for the default". */
  model: string
  timeoutMs: number
  /** how much longer than the input the output may be before it is refused. */
  maxRatio: number
  /**
   * The minimum share of the output's tokens that must appear in the input.
   *
   * Calibrated on two examples rather than guessed: a genuine cleanup of "嗯那个啥 就是
   * 端口别乱改啊 定了 8000" into "服务端口固定为 8000，不要修改。" shares 0.375 of its
   * tokens, while an elaboration that invents a reason and a follow-up action shares 0.19.
   * 0.25 sits between them. The margin is narrow and the failure is asymmetric on purpose:
   * refusing keeps the person's own sentence, so a false refusal costs readability while a
   * false acceptance puts invented text into the prompt.
   */
  minOverlap: number
}

/** Defaults: on for recording, off for injection. */
export const NORMALIZE_DEFAULTS: Omit<NormalizeSettings, 'provider' | 'model'> & {
  provider: string
  model: string
} = {
  enabled: true,
  inject: false,
  provider: '',
  model: '',
  timeoutMs: 8000,
  maxRatio: 3,
  minOverlap: 0.25,
}

/** The framing every normalization call shares. */
export const NORMALIZE_SYSTEM =
  '你把用户说过的一句话整理成一句清楚、完整、第三人称的中文陈述，供以后会话参考。'

/**
 * Build the user message for one sentence.
 *
 * @param text - the sentence as the person wrote it.
 * @returns the prompt.
 */
export function buildNormalizePrompt(text: string): string {
  return [
    '下面是一句从真实会话里摘出来的话，可能有错别字、口语、断句或多余的前缀。',
    '',
    '原句：',
    text,
    '',
    '要求：',
    '1. 只做整理：修正明显的错别字与口语、补全省略但明确的主语、去掉无意义的填充词。',
    '2. **绝对不能添加原句里没有的信息**，也不要推测、不要补充理由、不要解释、不要评论。',
    '3. **保持原句的语言**：原句是英文就输出英文，是中文就输出中文，不要翻译。',
    '4. **数字、代码标识符、文件路径、以及 `→` `->` `=` `==` 这类符号关系要原样保留**，不要改写成词、不要补单位、不要补标点以外的字。',
    '5. 只输出整理后的那一句话，不要引号、不要前缀、不要编号、不要换行说明。',
    '6. 原句**措辞已经清楚时仍然要清掉格式残渣**：LaTeX/markdown 标记（`\\textbf{}`、`\\item`、`**`）、',
    '   编号列表残留（开头的 `1.`、结尾孤立的 `2.`）、明显的截断尾巴。只有**既没有格式残渣、措辞也清楚**时才原样输出。',
    '7. 如果无法在不添加信息的前提下整理它，就原样输出。',
  ].join('\n')
}

/**
 * Whether a canonical form is acceptable, and the same text trimmed when it is.
 *
 * Deterministic on purpose: this is the gate that keeps "the model rewrote it" from
 * becoming "the model invented it". It refuses rather than repairs, because a repaired
 * guess is still a guess.
 *
 * @param input - the verbatim sentence.
 * @param output - what the model returned.
 * @param settings - the ratio and overlap thresholds.
 * @returns the usable canonical form, or null when it must be dropped.
 */
export function acceptCanonical(
  input: string,
  output: string,
  settings: Pick<NormalizeSettings, 'maxRatio' | 'minOverlap'>,
): string | null {
  return explainCanonical(input, output, settings).text
}

/**
 * The same decision, with the reason it went the way it did.
 *
 * The reason exists because "refused" on its own is the kind of ledger line this project
 * keeps having to fix: it says something happened without saying what, so a refusal rate of
 * a quarter cannot be acted on. With the cause, a too-strict gate and a model that keeps
 * answering the wrong shape are different problems.
 *
 * @param input - the verbatim sentence.
 * @param output - what the model returned.
 * @param settings - the ratio and overlap thresholds.
 * @returns the usable text (or null) and the reason code.
 */
export function explainCanonical(
  input: string,
  output: string,
  settings: Pick<NormalizeSettings, 'maxRatio' | 'minOverlap'>,
): { text: string | null; reason: string } {
  let value = String(output ?? '').trim()
  // A model that wraps its answer in quotes or prefixes it with a label is common enough
  // to handle rather than reject.
  value = value.replace(/^["'“”「『]+/u, '').replace(/["'“”」』]+$/u, '').trim()
  value = value.replace(/^(整理后|整理|结果|输出)[:：]\s*/u, '').trim()
  if (value.length < 2) return { text: null, reason: 'empty' }
  if (value === String(input ?? '').trim()) return { text: null, reason: 'unchanged' }
  if (/^(抱歉|对不起|无法|不能|sorry|cannot|i can)/iu.test(value)) return { text: null, reason: 'model-refused' }
  if (value.length > Math.max(20, String(input).length * settings.maxRatio)) {
    return { text: null, reason: 'too-long' }
  }

  const inputTokens = tokenize(input)
  const outputTokens = tokenize(value)
  if (outputTokens.size === 0) return { text: null, reason: 'no-tokens' }
  let shared = 0
  for (const token of outputTokens) if (inputTokens.has(token)) shared += 1
  if (shared / outputTokens.size < settings.minOverlap) return { text: null, reason: 'low-overlap' }
  return { text: value, reason: 'ok' }
}

/** The model-call surface this module needs, so tests can fake it without a network. */
export interface LlmStreamPort {
  stream(options: {
    provider: string
    model: string
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
    system?: string
    maxTokens?: number
    signal?: AbortSignal
    /**
     * Whether the model may spend tokens thinking before it answers.
     *
     * `'off'` is required, not a preference, on any route that serves a reasoning model — and the
     * route this plugin is handed on the machine it was developed against is one. Measured on
     * `deepseek-flash`, three calls that all had to fit a 1.5–2.5s budget:
     *
     * | call | thinking on | thinking off |
     * |---|---|---|
     * | segmentation, 6 real windows | 2/6 valid, median 4467ms | 4/6 valid, median 860ms |
     * | canonical form, 4 sentences | 3/4 non-empty, max 2026ms | 4/4 non-empty, max 730ms |
     * | write call, 7 real windows | 1 writeable, median 3623ms, 2/7 truncated | 2 writeable, median 596ms, 0 truncated |
     *
     * The mechanism is arithmetic rather than taste: thinking tokens come out of the same
     * `maxTokens` budget, so a reasoning model either truncates the answer (`finish_reason: length`
     * with a half-written JSON array — this is what the live `segment` line reported as `unparsable`
     * on 5 of 5 turns) or spends the whole budget thinking and returns no text at all. The harness
     * itself does this for its own short structured call (`purpose: 'session-title'` forces thinking
     * off), and the adapter documents `'off'` as always legal, so this costs nothing where the route
     * cannot think.
     */
    reasoningEffort?: string
  }): AsyncIterable<{ type: string; text?: string; reason?: string }>
}

/** One answer, with the two fields the text alone hides. */
export interface LlmAnswer {
  /** the concatenated `text-delta` chunks — everything the model said *after* thinking. */
  text: string
  /**
   * How many characters the model spent thinking, which never appears in `text`.
   *
   * Read because it is the difference between "the model had nothing to say" and "the model spent the
   * whole budget thinking", and those two looked identical in the ledger: both produced an empty
   * answer, and the ledger's word for it was `empty`, which points at the prompt.
   */
  reasoningChars: number
  /** the terminal `finish` reason: `stop`, `length`, `tool-calls`, … or `unknown`. */
  finish: string
}

/**
 * Drain one model stream into an answer.
 *
 * Shared by the three structured calls rather than copied into each: they were three copies of the
 * same four-line loop that kept the text and dropped the finish reason, and the dropped field is
 * exactly what made a truncated answer indistinguishable from a refused one. One reader means one
 * place to be right.
 *
 * @param stream - the chunk stream from the llm port.
 * @returns the text, how much thinking was spent, and why the stream ended.
 */
export async function readAnswer(stream: AsyncIterable<{ type: string; text?: string; reason?: string }>): Promise<LlmAnswer> {
  let text = ''
  let reasoningChars = 0
  let finish = 'unknown'
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    // Counted, never merged into the answer: reasoning is not content, and a caller that concatenated
    // it would be parsing the model's notes as its output.
    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length
    if (chunk.type === 'finish') {
      finish = typeof chunk.reason === 'string' && chunk.reason !== '' ? chunk.reason : 'stop'
      break
    }
  }
  return { text, reasoningChars, finish }
}

/**
 * Name the failure of an answer that could not be used, using the finish reason.
 *
 * `unparsable` was the only word for all of it, and it sends the reader to the prompt. When the
 * stream ended because the token budget ran out, the prompt is not what is wrong — the budget is, and
 * on a reasoning route the reason is that the budget was spent before the answer began.
 *
 * @param answer - the drained stream.
 * @returns `'truncated'`, `'empty'`, or null when the answer has text and the caller must judge it.
 */
export function answerFailure(answer: LlmAnswer): 'truncated' | 'empty' | null {
  if (answer.finish === 'length') return 'truncated'
  if (answer.text.trim() === '') return 'empty'
  return null
}

/** A normalizer, or a reason it cannot work. */
export interface Normalizer {
  /** asked per call, so a route added later takes effect on the next write. */
  route(): Promise<{ provider: string; model: string } | null>
  /** why the last `normalize` returned null; `'ok'` after a success. */
  lastReason(): string
  /**
   * Produce the canonical form of one sentence.
   *
   * @param text - the verbatim sentence.
   * @param signal - cancellation from the write path.
   * @returns the canonical form and the model that produced it, or null.
   */
  normalize(text: string, signal?: AbortSignal): Promise<{ text: string; model: string } | null>
}

/**
 * Build the normalizer.
 *
 * @param options - the llm port, resolved settings, a route resolver, and a logger.
 * @returns the normalizer.
 */
export function createNormalizer({
  llm,
  settings,
  resolveRoute,
  log = () => {},
}: {
  llm: LlmStreamPort | undefined
  settings: NormalizeSettings
  /** config first, then whatever the host calls its default model. */
  resolveRoute: () => Promise<{ provider: string; model: string } | null>
  log?: LogSink
}): Normalizer {
  let lastReason = 'not-attempted'
  return {
    lastReason: () => lastReason,
    route: async () => {
      if (!settings.enabled || llm === undefined) return null
      const route = await resolveRoute().catch(() => null)
      return route && route.provider !== '' && route.model !== '' ? route : null
    },

    async normalize(text, signal) {
      const route = await this.route()
      if (route === null) {
        lastReason = 'no-route'
        return null
      }
      const controller = new AbortController()
      const onAbort = (): void => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
      try {
        const stream = llm!.stream({
          provider: route.provider,
          model: route.model,
          system: NORMALIZE_SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildNormalizePrompt(text) }] }],
          maxTokens: 400,
          signal: controller.signal,
          // See `LlmStreamPort.reasoningEffort`: without this the call spends all 400 tokens thinking
          // and returns nothing, which is what 9 of 12 live normalize lines recorded as `empty`.
          reasoningEffort: 'off',
        })
        const answer = await readAnswer(stream)
        const decided = explainCanonical(text, answer.text, settings)
        lastReason = decided.text === null ? (answerFailure(answer) ?? decided.reason) : decided.reason
        if (decided.text === null) {
          log('warn', `canonical form refused (${lastReason}); the verbatim sentence stands`, {
            input: text.slice(0, 60),
            output: answer.text.slice(0, 60),
            finish: answer.finish,
            reasoningChars: answer.reasoningChars,
          })
          return null
        }
        return { text: decided.text, model: route.model }
      } catch (error) {
        // Fail-open in the only direction that is safe here: keep the sentence.
        lastReason = `failed:${String(error).slice(0, 40)}`
        log('warn', 'normalization failed; the verbatim sentence stands', { error: String(error) })
        return null
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
