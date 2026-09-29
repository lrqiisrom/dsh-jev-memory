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
    '3. 保持原句的语言（中文就输出中文），保持它是「一条要求/约定/事实」的性质。',
    '4. 只输出整理后的那一句话，不要引号、不要前缀、不要编号、不要换行说明。',
    '5. 如果原句已经足够清楚，或你无法在不添加信息的前提下整理它，就原样输出。',
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
  let value = String(output ?? '').trim()
  // A model that wraps its answer in quotes or prefixes it with a label is common enough
  // to handle rather than reject.
  value = value.replace(/^["'“”「『]+/u, '').replace(/["'“”」』]+$/u, '').trim()
  value = value.replace(/^(整理后|整理|结果|输出)[:：]\s*/u, '').trim()
  if (value.length < 2) return null
  if (value === String(input ?? '').trim()) return null
  if (/^(抱歉|对不起|无法|不能|sorry|cannot|i can)/iu.test(value)) return null
  if (value.length > Math.max(20, String(input).length * settings.maxRatio)) return null

  const inputTokens = tokenize(input)
  const outputTokens = tokenize(value)
  if (outputTokens.size === 0) return null
  let shared = 0
  for (const token of outputTokens) if (inputTokens.has(token)) shared += 1
  if (shared / outputTokens.size < settings.minOverlap) return null
  return value
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
  }): AsyncIterable<{ type: string; text?: string }>
}

/** A normalizer, or a reason it cannot work. */
export interface Normalizer {
  /** asked per call, so a route added later takes effect on the next write. */
  route(): Promise<{ provider: string; model: string } | null>
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
  return {
    route: async () => {
      if (!settings.enabled || llm === undefined) return null
      const route = await resolveRoute().catch(() => null)
      return route && route.provider !== '' && route.model !== '' ? route : null
    },

    async normalize(text, signal) {
      const route = await this.route()
      if (route === null) return null
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
        })
        let output = ''
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
          if (chunk.type === 'finish') break
        }
        const accepted = acceptCanonical(text, output, settings)
        if (accepted === null) {
          log('warn', 'canonical form refused; the verbatim sentence stands', {
            input: text.slice(0, 60),
            output: output.slice(0, 60),
          })
          return null
        }
        return { text: accepted, model: route.model }
      } catch (error) {
        // Fail-open in the only direction that is safe here: keep the sentence.
        log('warn', 'normalization failed; the verbatim sentence stands', { error: String(error) })
        return null
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
