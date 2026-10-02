/**
 * The segmenter's validator is where its safety lives: a model answer that is accepted when it
 * should not be becomes a memory nobody said, or silently deletes text nobody meant to lose.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ATTRIBUTIONS,
  buildSegmentPrompt,
  createSegmenter,
  explainSegments,
  SEGMENT_DEFAULTS,
  SEGMENT_SYSTEM,
  type SegmentMessage,
} from '../dsh/lib/segment.ts'
import type { LlmStreamPort } from '../dsh/lib/normalize.ts'

const WINDOW: SegmentMessage[] = [
  { seq: 1, role: 'user', text: '我要给简历加一段。' },
  { seq: 2, role: 'assistant', text: '好的，你想写哪个项目？' },
  { seq: 3, role: 'user', text: '就用刚才那个项目。另外这段是模型的输出：一次消息变成一串任务，请按这个格式。' },
]

/** A port that answers with a fixed string. */
function stubLlm(text: string, onCall?: (options: unknown) => void): LlmStreamPort {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(options: unknown): AsyncIterable<{ type: string; text?: string }> {
      onCall?.(options)
      yield { type: 'text-delta', text }
      yield { type: 'finish' }
    },
  }
}

const ok = (raw: string, messages: SegmentMessage[] = WINDOW): ReturnType<typeof explainSegments> =>
  explainSegments(raw, messages, { minCoverage: 0.6 })

test('a well-formed answer is accepted, and the text is located rather than trusted', () => {
  // The answer carries the text of each unit; the offsets are computed here by finding it in the
  // message. Asking the model for offsets was measured and abandoned — it is arithmetic an LLM is
  // bad at, and the first two real windows came back `out-of-range` and `empty`.
  const answer = JSON.stringify([
    { message: 0, text: '我要给简历加一段。', who: 'user' },
    { message: 1, text: '好的，你想写哪个项目？', who: 'assistant' },
    { message: 2, text: '就用刚才那个项目。', who: 'user' },
    { message: 2, text: '另外这段是模型的输出：一次消息变成一串任务，请按这个格式。', who: 'pasted' },
  ])
  const decided = ok(answer)
  assert.equal(decided.reason, 'ok')
  assert.equal(decided.segments?.length, 4)
  // The stored text is still the slice of the original, so the model cannot reword it.
  const pasted = decided.segments![3]!
  assert.equal(WINDOW[2]!.text.slice(pasted.start, pasted.end), '另外这段是模型的输出：一次消息变成一串任务，请按这个格式。')
  assert.equal(pasted.attribution, 'pasted', "the pasted block is not the person's own words")
})

test('a unit that is not verbatim in the message is refused', () => {
  // Paraphrased, translated or invented text must never end up as a memory in someone's own voice.
  const answer = JSON.stringify([
    { message: 0, text: '我想给简历加一段内容', who: 'user' },
    { message: 1, text: '好的，你想写哪个项目？', who: 'assistant' },
    { message: 2, text: '就用刚才那个项目。另外这段是模型的输出：一次消息变成一串任务，请按这个格式。', who: 'user' },
  ])
  assert.equal(ok(answer).reason, 'not-verbatim')
})

test('a message index that does not exist is refused', () => {
  // The index is the one number left in the protocol, and pointing at a message that is not there
  // would attach text to the wrong conversation.
  assert.equal(ok(JSON.stringify([{ message: 9, text: '我要给简历加一段。', who: 'user' }])).reason, 'out-of-range')
  assert.equal(ok(JSON.stringify([{ message: 0, text: '   ', who: 'user' }])).reason, 'empty')
})

test('overlapping units are refused', () => {
  // Two units sharing characters means one sentence becomes two memories with two ids.
  const answer = JSON.stringify([
    { message: 0, text: '我要给简', who: 'user' },
    { message: 0, text: '给简历加一段。', who: 'user' },
    { message: 1, text: '好的，你想写哪个项目？', who: 'assistant' },
    { message: 2, text: '就用刚才那个项目。另外这段是模型的输出：一次消息变成一串任务，请按这个格式。', who: 'user' },
  ])
  assert.equal(ok(answer).reason, 'overlap')
})

test('an unknown attribution is refused', () => {
  // An attribution nobody defined would be treated as the user's own words by the caller.
  const answer = JSON.stringify([
    { message: 0, text: '我要给简历加一段。', who: 'somebody-else' },
    { message: 1, text: '好的，你想写哪个项目？', who: 'assistant' },
    { message: 2, text: '就用刚才那个项目。另外这段是模型的输出：一次消息变成一串任务，请按这个格式。', who: 'user' },
  ])
  assert.equal(ok(answer).reason, 'unknown-attribution')
})

test('an answer that covers too little is refused rather than accepted', () => {
  // A model that mentions one clause and stays silent about the rest would delete content without
  // saying so — the failure mode this project keeps rejecting.
  const answer = JSON.stringify([{ message: 0, text: '我要给简历加一段。', who: 'user' }])
  const decided = ok(answer)
  assert.equal(decided.reason, 'low-coverage')
  assert.ok(decided.coverage < 0.6)
})

test('prose around the JSON is tolerated, nonsense is not', () => {
  const wrapped = `好的，结果如下：\n${JSON.stringify([
    { message: 0, text: '我要给简历加一段。', who: 'user' },
    { message: 1, text: '好的，你想写哪个项目？', who: 'assistant' },
    { message: 2, text: '就用刚才那个项目。另外这段是模型的输出：一次消息变成一串任务，请按这个格式。', who: 'user' },
  ])}\n以上。`
  assert.equal(ok(wrapped).reason, 'ok')
  assert.equal(ok('我觉得这段应该分成三段。').reason, 'unparsable')
  assert.equal(ok('[]').reason, 'empty')
})

test('the prompt carries the window, the indexes and the attributions', () => {
  const prompt = buildSegmentPrompt(WINDOW)
  assert.match(prompt, /消息 0（角色：user）/)
  assert.match(prompt, /消息 2（角色：user）/)
  assert.match(prompt, /就用刚才那个项目/)
  assert.match(SEGMENT_SYSTEM, /只输出 JSON 数组/)
  assert.match(SEGMENT_SYSTEM, /一字不差的原文片段/)
  assert.match(SEGMENT_SYSTEM, /不要输出字符下标/)
  // The mixed-message case is named in the prompt because it is the reason this exists.
  assert.match(SEGMENT_SYSTEM, /粘贴/)
  assert.deepEqual([...ATTRIBUTIONS], ['user', 'quoted', 'pasted', 'tool-output', 'assistant'])
})

test('the segmenter returns units on a good answer and falls back on a bad one', async () => {
  const messages: SegmentMessage[] = [{ seq: 1, role: 'user', text: '端口别乱改，定 8000 了。' }]
  const good = createSegmenter({
    llm: stubLlm(JSON.stringify([{ message: 0, text: '端口别乱改，定 8000 了。', who: 'user' }])),
    settings: { ...SEGMENT_DEFAULTS, enabled: true },
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  const result = await good.segment(messages)
  assert.equal(result?.segments.length, 1)
  assert.equal(result?.model, 'm')
  assert.equal(good.lastReason(), 'ok')

  const bad = createSegmenter({
    llm: stubLlm('这段我切成三段吧。'),
    settings: { ...SEGMENT_DEFAULTS, enabled: true },
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await bad.segment(messages), null)
  assert.equal(bad.lastReason(), 'unparsable')
})

test('no route means no segmentation, and the caller keeps its splitter', async () => {
  const off = createSegmenter({
    llm: stubLlm('[]'),
    settings: SEGMENT_DEFAULTS,
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await off.segment(WINDOW), null)
  assert.equal(off.lastReason(), 'no-route', 'disabled by default, like the canonical pass was')

  const unrouted = createSegmenter({
    llm: stubLlm('[]'),
    settings: { ...SEGMENT_DEFAULTS, enabled: true },
    resolveRoute: async () => null,
  })
  assert.equal(await unrouted.segment(WINDOW), null)
  assert.equal(unrouted.lastReason(), 'no-route')

  const broken = createSegmenter({
    llm: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream(): AsyncIterable<{ type: string }> {
        throw new Error('provider down')
      },
    },
    settings: { ...SEGMENT_DEFAULTS, enabled: true },
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await broken.segment(WINDOW), null)
  assert.match(broken.lastReason(), /^error:/u)
})
