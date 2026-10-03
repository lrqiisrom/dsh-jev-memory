/**
 * One call that decides what to remember: boundaries, attribution, worthiness and type.
 *
 * Measured before it was written, on 120 labelled rows whose conversation windows could still be
 * reconstructed. Same rows, same windows, same model, same labels:
 *
 *                       precision   recall    F1    TP  FP  FN
 *   one call (this)        56%      90%     0.69   18  14   2
 *   the pipeline today     27%      60%     0.37   12  32   8
 *
 * Better on both axes at once, and the margin is what justified building a second write path rather
 * than tuning the first. The gain is not "a model decides" — the judge already decided once and tied
 * the free rule at F1 0.33. It is that this call sees the **window**, gets the person's own standard
 * stated outright, and answers a bounded question per span (`worth` true/false, `type` from a small
 * set) instead of scoring one isolated sentence.
 *
 * The one thing it may not do is write the sentence. Every item must be a verbatim span of the
 * message it names — checked here, refused otherwise — and the caller slices the text out. Measuring
 * the same idea *without* that rule tied the pipeline at F1 0.37 while 22% of the model's output was
 * not verbatim anyone's words, including one substitution that changed what the memory said. So this
 * module is where the proposal was kept and the prose was dropped.
 *
 * @module dsh/lib/modelwrite
 */

import { answerFailure, readAnswer, type LlmStreamPort, type LogSink } from './normalize.ts'

/** One message the caller may show the model. */
export interface WriteMessage {
  seq: number
  role: string
  text: string
}

/** The types a memory may have. An item typed anything else is not written. */
export const WRITE_TYPES = ['constraint', 'pitfall', 'decision'] as const

/** Who the model may say a span belongs to. */
export const WRITE_WHO = ['user', 'pasted', 'quoted', 'tool-output', 'assistant'] as const

/** One accepted item: a span of one message, plus the judgements about it. */
export interface WriteItem {
  /** index into the messages the model was shown. */
  messageIndex: number
  /** the message's own sequence number, so provenance survives the window. */
  seq: number
  /** character offsets into that message's text, located here rather than trusted from the model. */
  start: number
  end: number
  who: string
  worth: boolean
  type: string
}

/** Settings for the model write path. */
export interface ModelWriteSettings {
  enabled: boolean
  /** how many recent messages the model may read. */
  window: number
  /** its own budget, inside the write deadline. */
  timeoutMs: number
  /** retries on a missing or malformed answer; measured 8 of 120 came back without JSON. */
  retry: number
}

/** Defaults; the plugin overrides `timeoutMs` from the write budget. */
export const MODEL_WRITE_DEFAULTS: ModelWriteSettings = {
  enabled: true,
  window: 10,
  timeoutMs: 1500,
  retry: 1,
}

/** The instruction. The person's own standard, stated, plus the two exclusions that matter most. */
export const MODEL_WRITE_SYSTEM =
  '你在为一个人维护跨会话的长期记忆。下面是一段真实对话，每条消息前面有编号和角色。\n' +
  '请找出其中**值得长期记住**的片段。判断标准：换个会话、换一天，这段内容还有用吗？\n' +
  '值得记的是**这个人自己**表达的、以后仍然适用的内容：约定、禁忌、取舍及原因、踩过的坑、项目事实。\n' +
  '不值得记的：一次性任务指令、提问、寒暄、状态汇报、临时状态、与项目无关的闲聊、没有项目特异性的通用常识。\n' +
  '注意：用户消息里可能混着**他粘贴或引用的别人的内容、模型自己的回答**——那些不算他说的。\n' +
  '输出一个 JSON 数组，每项形如：\n' +
  '{"message": 0, "text": "就用刚才那个项目。", "who": "user", "worth": true, "type": "decision"}\n' +
  '字段含义：\n' +
  '- `message`：消息编号\n' +
  '- `text`：**必须是那条消息里一字不差的原文片段**（直接复制，不要改写、不要补标点、不要翻译、不要省略口水词）。\n' +
  '  **不要输出字符下标**，也不要输出你自己写的句子。\n' +
  `- \`who\`：只能是 ${WRITE_WHO.join(' / ')} 之一\n` +
  '- `worth`：true / false，只在这是这个人自己的长期主张时为 true\n' +
  `- \`type\`：只能是 ${[...WRITE_TYPES, 'other'].join(' / ')} 之一\n` +
  '只输出 JSON 数组，不要任何解释。没有值得记的就输出 []。'

/**
 * Render the conversation the model reads.
 *
 * @param messages - the window, oldest first.
 * @returns the user message for the model.
 */
export function buildModelWritePrompt(messages: readonly WriteMessage[]): string {
  const body = messages.map((message, index) => `[${index}] 角色=${message.role}\n${message.text}`).join('\n\n')
  return `以下是一段对话：\n\n${body}`
}

/** The validated outcome of one answer. */
export interface WriteExplanation {
  items: WriteItem[] | null
  reason: string
}

/**
 * Validate one model answer against the messages it was given.
 *
 * The verbatim check is the point of the whole design: an item whose text is not in the message it
 * names is the model writing the memory, which is the failure mode measured at 22% when it was
 * allowed. The offsets are computed here from `indexOf`, never taken from the model.
 *
 * @param raw - the model's text.
 * @param messages - the window it was shown.
 * @returns the accepted items, or the reason there are none.
 */
export function explainModelWrite(raw: string, messages: readonly WriteMessage[]): WriteExplanation {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return { items: null, reason: 'unparsable' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { items: null, reason: 'unparsable' }
  }
  if (!Array.isArray(parsed)) return { items: null, reason: 'unparsable' }
  if (parsed.length === 0) return { items: [], reason: 'empty' }

  const items: WriteItem[] = []
  let refused = 0
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') {
      refused += 1
      continue
    }
    const item = entry as Record<string, unknown>
    const messageIndex = Number(item.message)
    const text = typeof item.text === 'string' ? item.text : ''
    const who = String(item.who ?? '')
    const type = String(item.type ?? '')
    const message = messages[messageIndex]
    if (!message || !(WRITE_WHO as readonly string[]).includes(who)) {
      refused += 1
      continue
    }
    if (text.trim() === '') {
      refused += 1
      continue
    }
    const at = message.text.indexOf(text)
    if (at < 0) {
      // Refused rather than matched loosely: text that is not verbatim in the message is the model
      // paraphrasing or inventing, and neither may be stored as something the person said.
      refused += 1
      continue
    }
    items.push({ messageIndex, seq: message.seq, start: at, end: at + text.length, who, worth: item.worth === true, type })
  }
  // A whole answer of refused items is a broken answer, not an empty one: the caller's fallback
  // should engage rather than treat the turn as "nothing to remember".
  if (items.length === 0 && refused > 0) return { items: null, reason: 'all-refused' }
  return { items, reason: items.length === 0 ? 'empty' : 'ok' }
}

/** A model writer, or a reason it cannot work. */
export interface ModelWriter {
  /** asked per call, so a route added later takes effect without a restart. */
  route(): Promise<{ provider: string; model: string } | null>
  /** why the last call returned null; `'ok'` after a success. */
  lastReason(): string
  /**
   * Decide what to remember from one window.
   *
   * @param messages - the window, oldest first.
   * @param signal - cancellation from the write path.
   * @returns the accepted items and the model id, or null with `lastReason` explaining.
   */
  decide(messages: readonly WriteMessage[], signal?: AbortSignal): Promise<{ items: WriteItem[]; model: string } | null>
}

/**
 * Build the writer.
 *
 * Returns null on any shortfall — no route, a provider error, a malformed answer, a timeout — because
 * the caller has a deterministic path to fall back to and must never depend on a network round trip.
 *
 * @param options - the llm port, settings, a route resolver and a logger.
 * @returns the writer.
 */
export function createModelWriter({
  llm,
  settings,
  resolveRoute,
  log = () => {},
}: {
  llm: LlmStreamPort | undefined
  settings: ModelWriteSettings
  resolveRoute: () => Promise<{ provider: string; model: string } | null>
  log?: LogSink
}): ModelWriter {
  let lastReason = 'not-attempted'
  return {
    lastReason: () => lastReason,
    route: async () => {
      if (!settings.enabled || llm === undefined) return null
      const route = await resolveRoute().catch(() => null)
      return route && route.provider !== '' && route.model !== '' ? route : null
    },

    async decide(messages, signal) {
      if (!settings.enabled) {
        // Three states, three words, for the same reason the `start` line distinguishes them:
        // "turned off", "no llm service" and "no default model" produce the same absence of writes
        // and are different problems. `route()` collapses them; `lastReason` must not.
        lastReason = 'disabled'
        return null
      }
      if (messages.length === 0) {
        lastReason = 'no-messages'
        return null
      }
      const route = await this.route()
      if (route === null) {
        lastReason = 'no-route'
        return null
      }
      const prompt = buildModelWritePrompt(messages)
      for (let attempt = 0; attempt <= settings.retry; attempt += 1) {
        const controller = new AbortController()
        const onAbort = (): void => controller.abort()
        signal?.addEventListener('abort', onAbort, { once: true })
        const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
        try {
          const stream = llm!.stream({
            provider: route.provider,
            model: route.model,
            system: MODEL_WRITE_SYSTEM,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            maxTokens: 1500,
            signal: controller.signal,
            // Measured on the route this plugin is handed (`deepseek-flash`, a reasoning model), over
            // seven real user-anchored windows: thinking on → median 3623ms, worst 7953ms, and 2 of 7
            // answers cut off mid-JSON and unusable; thinking off → median 596ms, worst 942ms, none
            // truncated. It is also the closer analogue of the configuration the 0.69 was measured on,
            // which ran `deepseek-chat` and therefore did not think at all. See
            // `LlmStreamPort.reasoningEffort` for the mechanism.
            reasoningEffort: 'off',
          })
          const answer = await readAnswer(stream)
          const decided = explainModelWrite(answer.text, messages)
          // A truncated answer is not a refused one, and the two used to share the word `unparsable`:
          // one means the prompt or the model, the other means the budget. The caller retries both, but
          // the ledger line is where this gets diagnosed, so it has to say which.
          lastReason = decided.reason === 'unparsable' ? (answerFailure(answer) ?? decided.reason) : decided.reason
          if (decided.items !== null) return { items: decided.items, model: route.model }
          log('warn', `model write refused (${lastReason}); falling back`, {
            messages: messages.length,
            output: answer.text.slice(0, 80),
            finish: answer.finish,
            reasoningChars: answer.reasoningChars,
          })
        } catch (error) {
          lastReason = `error:${String(error).slice(0, 40)}`
          log('warn', 'model write failed; falling back', { error: String(error) })
        } finally {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }
      }
      return null
    },
  }
}
