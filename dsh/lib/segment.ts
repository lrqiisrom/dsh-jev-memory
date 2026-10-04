/**
 * Segmenting a conversation window into units, with attribution.
 *
 * Why this exists. The deterministic splitter cuts on punctuation inside one message, and it was
 * measured: of the 16 labelled rows whose note says the text was split badly, 12 turned out to be
 * mechanical (a 240-character clip, a leftover list ordinal, code lines) and were fixed with rules.
 * The remaining 4 are not mechanical — they are a message that mixes the person's own words with a
 * block they pasted from the model, and no punctuation rule can tell those apart. The person said
 * so directly: "末尾这段是我复制的模型的输出，后面应该才是我要补充的点".
 *
 * So a model reads a window of recent messages and answers two questions no regex can: where the
 * units are, and who said each one. Two rules keep it from becoming a fabrication channel:
 *
 *  1. **It returns offsets, not text.** Every unit is a slice the caller takes out of the original
 *     message, so a model cannot invent a sentence, reword one, or translate it. Anything outside
 *     the message's own length is refused, not clamped.
 *  2. **No silent loss.** Units for one message may not overlap, and the fraction of the message
 *     they cover is reported. A low-coverage answer means the model dropped content, which is
 *     refused rather than accepted — the failure mode this project keeps rejecting is the quiet one.
 *
 * The window is the point as much as the segmentation: a sentence in one turn and its continuation
 * two turns later are currently unrelated, because the extractor's unit is a single turn.
 *
 * @module dsh/lib/segment
 */

import { answerFailure, readAnswer, type LlmStreamPort, type LogSink } from './normalize.ts'

/** One message the segmenter may read. */
export interface SegmentMessage {
  /** the event's sequence number, so a unit can be traced back. */
  seq: number
  /** `user`, `assistant` or whatever the host called it. */
  role: string
  text: string
}

/** Who authored one unit. */
export type Attribution = 'user' | 'quoted' | 'pasted' | 'tool-output' | 'assistant'

/** Every attribution the model is allowed to answer with. */
export const ATTRIBUTIONS: readonly Attribution[] = ['user', 'quoted', 'pasted', 'tool-output', 'assistant']

/** One unit: a character range inside one message, plus who wrote it. */
export interface Segment {
  /** index into the messages that were sent. */
  messageIndex: number
  /** inclusive character offset into that message's text, located by the caller. */
  start: number
  /** exclusive character offset. */
  end: number
  attribution: Attribution
}

/** How segmentation is produced and bounded. */
export interface SegmentSettings {
  /** produce a segmentation at all. Off until measured, like the canonical pass was. */
  enabled: boolean
  /**
   * How many recent messages the model may read.
   *
   * The reference implementation this follows reads ten extractable messages plus five as
   * read-only background. Five is the smaller, cheaper end of that range: enough to see that a
   * sentence continues from the previous turn, which is the case the single-turn extractor cannot
   * see at all.
   */
  window: number
  timeoutMs: number
  /** below this fraction of the *user* messages covered by their units, refuse the answer. */
  minCoverage: number
}

/** Settings the segmenter falls back on when a caller passes none. */
export const SEGMENT_DEFAULTS: SegmentSettings = {
  enabled: false,
  window: 5,
  timeoutMs: 8000,
  minCoverage: 0.6,
}

/** The instruction the model is given. */
export const SEGMENT_SYSTEM =
  '你在为"长期记忆"插件判断一段对话里每一部分的**边界**和**归属**。' +
  '给你的是一段对话窗口，每条消息前面有编号和角色。\n' +
  '你要做的只有两件事：\n' +
  '1) 把**用户消息**切成若干语义完整的片段（可以跨越多句，也可以只是半句——按意思切，不要按标点切）；\n' +
  '2) 给每个片段标上它是谁写的。\n' +
  '归属只能从这五个里选：\n' +
  '- `user`：用户自己说的话、他自己的要求/决定/踩过的坑\n' +
  '- `quoted`：用户引用别人的话（同事、文档、报错原文）\n' +
  '- `pasted`：用户从模型或别处**复制粘贴**进来的整段内容\n' +
  '- `tool-output`：工具或命令的输出\n' +
  '- `assistant`：助手自己说的话\n' +
  '**只输出 JSON 数组，不要输出任何解释**，每项形如：\n' +
  '{"message": 0, "text": "就用刚才那个项目。", "who": "user"}\n' +
  '其中 `text` 必须是那条消息里**一字不差的原文片段**（直接复制，不要改写、不要补标点、不要翻译）。\n' +
  '**不要输出字符下标**，不要解释。\n' +
  '注意：一条消息里可能混着用户自己的话和粘贴块（例如"我觉得应该改成这样：<粘贴一大段>"），' +
  '这种情况必须切成至少两段，粘贴块标 `pasted`，用户自己的话标 `user`。\n' +
  '**哪些消息可以切**：窗口中只有标注为「可分段」的消息是提取源；标注为「仅背景」的消息' +
  '（助手的回答）**只用来判断用户是不是在粘贴/引用它们**，' +
  '**不要从里面切分，也不要为它们返回任何 JSON 项**。'

/**
 * Render the window the model reads.
 *
 * Each message carries its index, role and full text. Indexes are printed because the answer
 * refers back to them, and a model that has to count messages gets that wrong.
 *
 * @param messages - the window, oldest first.
 * @returns the user message for the model.
 */
export function buildSegmentPrompt(messages: readonly SegmentMessage[]): string {
  // Borrowed from TencentDB-Agent-Memory's write path, which says this out loud: `【背景对话】（仅供理解
  // 上下文推断关系/时间，严禁从中提取记忆）` and `【待提取的新消息】（只从这里提取记忆！）`
  // (`MemoryCore/src/core/prompts/l1-extraction.ts:406-416`). Their guarantee does not depend on the model
  // marking attribution correctly, because the prompt structure decides what may be mined.
  //
  // Ours carried the same distinction only in the validator: the assistant's lines are in the window for
  // one reason — telling a pasted block apart from the person's own words — and the caller drops spans
  // attributed to anything but `user`. Saying so costs nothing and saves real work. Measured on three
  // real windows (`eval/segment-prompt-ab.ts`, 2026-10-03):
  //
  //   | variant | their spans | background spans | answer chars | ms |
  //   |---|---|---|---|---|
  //   | chronological, unlabelled | 5 / 5 / 7 | 5 / 0 / 5 | 1716 / 395 / 1835 | 3109 / 901 / 3544 |
  //   | labelled per line | 5 / 5 / 7 | 0 / 0 / 0 | 449 / 395 / 568 | 1110 / 971 / 1226 |
  //
  // The person's spans are identical in every window, so the split costs no extraction; what disappears
  // is the model enumerating spans inside its own answers, which the caller discarded anyway. Answer
  // length fell 3.8× and latency 2.9× on the two windows that had any.
  //
  // Labels go on the line rather than into separate sections (the alternative measured the same) because
  // attribution leans on adjacency: the answer a block was pasted from is usually the one just before it.
  const body = messages
    .map((message, index) => {
      const label = message.role === 'user' ? '可分段' : '仅背景，不要切分'
      return `--- 消息 ${index}（角色：${message.role}｜${label}）---\n${message.text}`
    })
    .join('\n')
  return `以下是对话窗口，共 ${messages.length} 条消息。请按要求输出 JSON 数组。\n\n${body}`
}

/** The outcome of validating one model answer. */
export interface SegmentExplanation {
  /** the accepted segmentation, or null when it was refused. */
  segments: Segment[] | null
  /** why: `ok`, `unparsable`, `empty`, `no-user-text`, `not-verbatim`, `out-of-range`, `overlap`, `low-coverage`, `unknown-attribution`. */
  reason: string
  /** fraction of the messages' characters covered by accepted units. */
  coverage: number
}

/**
 * Decide whether one model answer may be used, and why.
 *
 * Every check exists because its absence is a silent failure: an offset past the end would slice
 * garbage, overlapping units would make one sentence two memories, an unknown attribution would be
 * treated as the user's own words, and a low-coverage answer would quietly delete whatever the
 * model chose not to mention.
 *
 * @param raw - the model's text.
 * @param messages - the window it was given.
 * @param settings - the coverage floor.
 * @returns the accepted units, or the reason there are none.
 */
export function explainSegments(
  raw: string,
  messages: readonly SegmentMessage[],
  settings: Pick<SegmentSettings, 'minCoverage'> = SEGMENT_DEFAULTS,
): SegmentExplanation {
  const refuse = (reason: string, coverage = 0): SegmentExplanation => ({ segments: null, reason, coverage })
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return refuse('unparsable')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return refuse('unparsable')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return refuse('empty')

  // The model returns the text of each unit, not its offsets, and the offsets are located here.
  // Asking for character indices was measured and abandoned: on the first two real windows the
  // answers were refused `out-of-range` and `empty`, because an LLM counting characters — in
  // Chinese, through a JSON encoder — is doing arithmetic it is bad at. Finding a verbatim string
  // is the same task the model is good at, and it keeps the safety property intact: the unit must
  // appear in the message exactly, and the stored text is still *our* slice of the original.
  const segments: Segment[] = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') return refuse('unparsable')
    const item = entry as Record<string, unknown>
    const messageIndex = Number(item.message)
    const who = String(item.who ?? '')
    const text = typeof item.text === 'string' ? item.text : ''
    if (!ATTRIBUTIONS.includes(who as Attribution)) return refuse('unknown-attribution')
    const message = messages[messageIndex]
    if (!message) return refuse('out-of-range')
    if (text.trim() === '') return refuse('empty')
    const at = message.text.indexOf(text)
    // Refused rather than accepted with a best-effort match: a unit that is not verbatim in the
    // message is the model paraphrasing, translating, or inventing, and none of those may become a
    // memory in someone's own voice.
    if (at < 0) return refuse('not-verbatim')
    segments.push({ messageIndex, start: at, end: at + text.length, attribution: who as Attribution })
  }

  // Non-overlap, per message. Two units sharing characters means one sentence is about to become
  // two memories with different ids.
  const byMessage = new Map<number, Segment[]>()
  for (const segment of segments) {
    const list = byMessage.get(segment.messageIndex) ?? []
    list.push(segment)
    byMessage.set(segment.messageIndex, list)
  }
  for (const list of byMessage.values()) {
    list.sort((left, right) => left.start - right.start)
    for (let index = 1; index < list.length; index += 1) {
      if (list[index]!.start < list[index - 1]!.end) return refuse('overlap')
    }
  }

  // Coverage is measured over the messages the model was asked to segment — the user's own — not
  // over the window. Counting the assistant messages as uncovered made every answer look like it
  // had dropped 60% of the content, and the first real run was refused `low-coverage` for a
  // segmentation that was in fact complete.
  const mine = messages.map((message, index) => ({ message, index })).filter((entry) => entry.message.role === 'user')
  if (mine.length === 0) return refuse('no-user-text')
  const covered = segments
    .filter((segment) => messages[segment.messageIndex]!.role === 'user')
    .reduce((total, segment) => total + messages[segment.messageIndex]!.text.slice(segment.start, segment.end).replace(/\s/gu, '').length, 0)
  const total = mine.reduce((sum, entry) => sum + entry.message.text.replace(/\s/gu, '').length, 0)
  const coverage = total === 0 ? 0 : covered / total
  if (coverage < settings.minCoverage) return refuse('low-coverage', coverage)
  return { segments, reason: 'ok', coverage }
}

/** A segmenter, or a reason it cannot work. */
export interface Segmenter {
  /** asked per call, so a route added later takes effect without a restart. */
  route(): Promise<{ provider: string; model: string } | null>
  /** why the last call returned null; `'ok'` after a success. */
  lastReason(): string
  /**
   * The shape of the last answer, for the ledger.
   *
   * `lastReason` alone cannot separate "the answer was cut off by the budget" from "the answer was
   * unreadable", and those need different fixes. `null` before any call.
   */
  lastAnswer(): { finish: string; chars: number; reasoningChars: number } | null
  /**
   * Segment one window.
   *
   * @param messages - the window, oldest first.
   * @param signal - cancellation from the caller.
   * @returns the accepted units and the model id, or null with `lastReason` explaining.
   */
  segment(messages: readonly SegmentMessage[], signal?: AbortSignal): Promise<{ segments: Segment[]; model: string; coverage: number } | null>
}

/**
 * Build the segmenter.
 *
 * Fails open in the only safe direction: when there is no route, the model errs, or the answer is
 * refused, the caller keeps its deterministic splitter. Nothing is invented and nothing is lost
 * that the deterministic path would have found.
 *
 * @param options - the llm port, settings, a route resolver and a logger.
 * @returns the segmenter.
 */
export function createSegmenter({
  llm,
  settings,
  resolveRoute,
  log = () => {},
}: {
  llm: LlmStreamPort | undefined
  settings: SegmentSettings
  resolveRoute: () => Promise<{ provider: string; model: string } | null>
  log?: LogSink
}): Segmenter {
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

    async segment(messages, signal) {
      if (messages.length === 0) {
        lastReason = 'no-messages'
        return null
      }
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
          system: SEGMENT_SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildSegmentPrompt(messages) }] }],
          // Raised from 1200 once thinking was turned off. The two changes belong together: with
          // thinking on, 1200 tokens were not enough for a dense five-message window and the JSON came
          // back cut in half (`finish_reason: length`) — the five live `segment` lines all failed that
          // way — while raising it to 3000 was worse, because the reasoning expanded to fill whatever
          // it was given (3000 reasoning tokens, no text, 12.5s). With thinking off the budget is spent
          // on the answer only, so a larger number costs nothing unless the answer needs it: measured
          // 4/6 windows valid with a median 860ms, no truncation in the sample.
          maxTokens: 2500,
          signal: controller.signal,
          reasoningEffort: 'off',
        })
        const answer = await readAnswer(stream)
        lastAnswer = { finish: answer.finish, chars: answer.text.length, reasoningChars: answer.reasoningChars }
        const decided = explainSegments(answer.text, messages, settings)
        lastReason = decided.segments === null ? (answerFailure(answer) ?? decided.reason) : decided.reason
        if (decided.segments === null) {
          log('warn', `segmentation refused (${lastReason}); the deterministic splitter stands`, {
            messages: messages.length,
            output: answer.text.slice(0, 80),
            finish: answer.finish,
            reasoningChars: answer.reasoningChars,
          })
          return null
        }
        return { segments: decided.segments, model: route.model, coverage: decided.coverage }
      } catch (error) {
        lastReason = `error:${String(error).slice(0, 40)}`
        log('warn', 'segmentation failed; the deterministic splitter stands', { error: String(error) })
        return null
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
