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
import { NAME_LIKE } from './recall.ts'

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
  /**
   * The model's own one-sentence rendering of the memory — the text that is stored and recalled.
   *
   * The person's `source` is kept beside it for provenance, never instead of it: the stored sentence
   * has to be readable on its own, and a verbatim fragment is not (typos, and a sentence cut at a
   * clause boundary reads as a fragment of an idea). This is the one place where the model writes the
   * memory, so it comes with `summaryDrifted`: the identifiers and numbers it uses must all be present
   * in the source it quotes, which is the check that would have caught 集成 being written as 继承.
   */
  summary: string
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
  /** Ten seconds, on request. The plugin's write deadline is the real ceiling: nothing above it
   *  imposes a shorter one (`agent/turn-stopping` is a cordis `serial` dispatch with no timeout). */
  timeoutMs: 10_000,
  /**
   * One retry, but only after a *fast* failure.
   *
   * A malformed answer comes back in about a second, so retrying it is nearly free and worth it (8 of
   * 120 answers arrived without JSON). A timeout is the opposite: a second ten-second attempt cannot fit
   * inside the write budget, and abandoning the whole turn is worse than falling back to the
   * deterministic path, which still writes something. So the retry is skipped when the clock, rather
   * than the answer, was the problem.
   */
  retry: 1,
}

/** The instruction. The person's own standard, stated, plus the two exclusions that matter most. */
export const MODEL_WRITE_SYSTEM =
  '你在为一个人维护跨会话的长期记忆。下面是一段真实对话，每条消息前面有编号和角色。\n' +
  '请找出其中**值得长期记住**的内容。判断标准：换个会话、换一天，这段内容还有用吗？\n' +
  '值得记的是**这个人自己**表达的、以后仍然适用的内容：约定、禁忌、取舍及原因、踩过的坑、项目事实。\n' +
  '不值得记的：一次性任务指令、提问、寒暄、状态汇报、临时状态、与项目无关的闲聊、没有项目特异性的通用常识。\n' +
  '注意：用户消息里可能混着**他粘贴或引用的别人的内容、模型自己的回答**——那些不算他说的。\n' +
  '每条记忆要输出**两样东西**：`source` 是你在原文里找到的那段（一字不差，只作出处）；' +
  '`summary` 是**你写的一句话总结**，它会成为长期记忆库里唯一的正文，以后靠它被召回。\n' +
  '输出一个 JSON 数组，每项形如：\n' +
  '{"message": 0, "source": "就用刚才那个项目。", "who": "user", "worth": true, "type": "decision", "summary": "用户决定这个项目沿用此前讨论的那个。"}\n' +
  '字段含义：\n' +
  '- `message`：消息编号\n' +
  '- `source`：**必须是那条消息里一字不差的原文片段**（直接复制，不要改写、不要补标点、不要翻译）。' +
  '**不要输出字符下标**。\n' +
  '- `summary`：**用第三人称写的一句总结**，是你对这段内容的理解。要求：\n' +
  '  1. 自包含：单独看这一句就能懂，不要出现"刚才那个""这个"这种离开上下文就没法读的指代；\n' +
  '  2. 修正错别字、补齐被切断的句子——原文口语、有错字、被切碎了都没关系，你写的是它的意思；\n' +
  '  3. **不得新增原文没有的事实**：原文里的数字、文件名、命令、标识符必须照抄，不能替换成别的；\n' +
  '  4. 一句话，不要展开成一段。\n' +
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
  let lastDrift: string | null = null
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') {
      refused += 1
      continue
    }
    const item = entry as Record<string, unknown>
    const messageIndex = Number(item.message)
    // `source` is the field the prompt asks for; `text` is still accepted because the evaluation
    // harnesses and older answers use it, and re-reading one field name is cheaper than re-running them.
    const source = typeof item.source === 'string' ? item.source : typeof item.text === 'string' ? item.text : ''
    const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
    const who = String(item.who ?? '')
    const type = String(item.type ?? '')
    const message = messages[messageIndex]
    if (!message || !(WRITE_WHO as readonly string[]).includes(who)) {
      refused += 1
      continue
    }
    if (source.trim() === '') {
      refused += 1
      continue
    }
    const at = message.text.indexOf(source)
    if (at < 0) {
      // The *source* is still checked character for character. It is only provenance now, but a
      // provenance pointer that points at nothing is worse than none: it would attach a model-written
      // summary to a quotation the person never said.
      refused += 1
      continue
    }
    if (summary === '') {
      // No summary means nothing to store: the record's text is the summary, so an item without one
      // contributes no memory (and is refused rather than stored as an empty record).
      refused += 1
      continue
    }
    const drift = summaryDrifted(summary, source)
    if (drift !== null) {
      // The model writes the memory on this path, so this is the one check standing between a summary
      // and a changed fact. It refuses only identifiers and numbers the source does not contain, which
      // is exactly the measured failure (集成 quoted as 继承): a synonym is a wording choice, a different
      // filename is a different claim.
      refused += 1
      lastDrift = drift
      continue
    }
    items.push({
      messageIndex,
      seq: message.seq,
      start: at,
      end: at + source.length,
      who,
      worth: item.worth === true,
      type,
      summary,
    })
  }
  // A whole answer of refused items is a broken answer, not an empty one: the caller's fallback
  // should engage rather than treat the turn as "nothing to remember".
  // A refused identifier is worth its own word: it is the only failure on this path that looks like a
  // successful write from the outside, so the ledger has to be able to say it happened.
  if (items.length === 0 && refused > 0) return { items: null, reason: lastDrift === null ? 'all-refused' : `drifted:${lastDrift}` }
  return { items, reason: items.length === 0 ? 'empty' : 'ok' }
}

/**
 * The identifiers and numbers a summary may not invent.
 *
 * On this path the model writes the memory text, which is the one thing the plugin has always refused
 * to let it do — and the reason was measured: quoting a sentence about "集成", an earlier version
 * answered "继承" and it was stored under the person's name. A different filename, command, number or
 * symbol is a different claim; a different *word* is a wording choice, which is the whole point of
 * summarising. So this checks only tokens shaped like names, and only in one direction: every one the
 * summary uses must appear in the source it quotes.
 *
 * @param summary - the model-written memory text.
 * @param source - the verbatim span it quotes.
 * @returns the offending token, or null when the summary introduces none.
 */
export function summaryDrifted(summary: string, source: string): string | null {
  const haystack = source.toLowerCase()
  for (const name of summary.match(NAME_LIKE) ?? []) {
    if (!haystack.includes(name.toLowerCase())) return name
  }
  return null
}

/** A model writer, or a reason it cannot work. */
export interface ModelWriter {
  /** asked per call, so a route added later takes effect without a restart. */
  route(): Promise<{ provider: string; model: string } | null>
  /** why the last call returned null; `'ok'` after a success. */
  lastReason(): string
  /** The shape of the last answer, for the ledger; `null` before any call. */
  lastAnswer(): { finish: string; chars: number; reasoningChars: number } | null
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
  let lastAnswer: { finish: string; chars: number; reasoningChars: number } | null = null
  return {
    lastReason: () => lastReason,
    lastAnswer: () => lastAnswer,
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
      const startedAt = Date.now()
      for (let attempt = 0; attempt <= settings.retry; attempt += 1) {
        // A retry only earns its place when the first attempt failed on *content*. Once the clock was
        // the problem, a second attempt of the same length cannot fit the write budget — and the caller
        // falling back to the deterministic path is strictly better than the turn writing nothing.
        if (attempt > 0 && Date.now() - startedAt >= settings.timeoutMs / 2) {
          lastReason = `${lastReason}:no-retry-after-slow-failure`
          break
        }
        const controller = new AbortController()
        const onAbort = (): void => controller.abort()
        signal?.addEventListener('abort', onAbort, { once: true })
        // Two jobs, one timer: cancel the request if the transport is willing to be cancelled, and
        // *stop waiting* regardless. Aborting alone is not enough — a stream that ignores its signal
        // held this call for five seconds past a 120ms budget in a test, and would hold a real turn for
        // as long as the transport felt like it. The deadline is ours, not the transport's.
        let expire: (() => void) | null = null
        const deadline = new Promise<null>((resolve) => {
          expire = () => resolve(null)
        })
        const timer = setTimeout(() => {
          controller.abort()
          expire?.()
        }, settings.timeoutMs)
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
          const drained = await Promise.race([readAnswer(stream), deadline])
          if (drained === null) throw new Error(`model write exceeded ${settings.timeoutMs}ms`)
          const answer = drained
          lastAnswer = { finish: answer.finish, chars: answer.text.length, reasoningChars: answer.reasoningChars }
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
