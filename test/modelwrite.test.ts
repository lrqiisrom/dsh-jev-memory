/**
 * The model write path: what it accepts, what it refuses, and what it falls back to.
 *
 * These tests exist mostly for one property — that the module cannot put words into a memory. It
 * gets a window, returns spans, and every span is checked character-for-character against the
 * message it claims to come from. Measuring the same idea *without* that check tied the pipeline at
 * F1 0.37 while a fifth of the output was not verbatim, including one substitution that changed the
 * claim ("继承" for "集成"), so the check is the feature, not a sanitizer around it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildModelWritePrompt,
  createModelWriter,
  explainModelWrite,
  MODEL_WRITE_SYSTEM,
  WRITE_TYPES,
  type WriteMessage,
} from '../dsh/lib/modelwrite.ts'

const WINDOW: WriteMessage[] = [
  { seq: 3, role: 'user', text: '必须把端口固定成 8000。另外这个配置流程应该再简化一下。' },
  { seq: 4, role: 'assistant', text: '好的，我把服务端口写进 README。' },
]

/** Answer with a fixed string, and count the calls. */
function llmAnswering(answer: string): { port: unknown; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    port: {
      stream: () => {
        calls += 1
        return (async function* () {
          yield { type: 'text-delta', text: answer }
          yield { type: 'finish' }
        })()
      },
    },
  }
}

test('the prompt shows every message the model may quote, with its role', () => {
  const prompt = buildModelWritePrompt(WINDOW)
  assert.match(prompt, /\[0\] 角色=user/u)
  assert.match(prompt, /\[1\] 角色=assistant/u)
  assert.match(prompt, /必须把端口固定成 8000/u)
  // The instruction must demand verbatim text and forbid offsets: the shipped prompt asked for
  // character positions once, and the real model then returned spans that were one or two
  // characters off, which the module refused as `out-of-range` on nearly every window.
  assert.match(MODEL_WRITE_SYSTEM, /一字不差/u)
  assert.match(MODEL_WRITE_SYSTEM, /不要输出字符下标/u)
})

test('a verbatim span is accepted, and its offsets are found here rather than taken from the model', () => {
  const span = '另外这个配置流程应该再简化一下。'
  const decided = explainModelWrite(
    JSON.stringify([{ message: 0, source: span, summary: '用户决定把端口固定成 8000。', who: 'user', worth: true, type: 'constraint' }]),
    WINDOW,
  )
  assert.equal(decided.reason, 'ok')
  assert.equal(decided.items?.length, 1)
  const item = decided.items![0]!
  assert.equal(item.seq, 3, 'the span carries its message sequence, not its index in the window')
  assert.equal(WINDOW[0]!.text.slice(item.start, item.end), span)
  assert.equal(item.type, 'constraint')
})

test('a span that is not in the message it names is refused, not matched loosely', () => {
  // The failure this prevents, from the measured run: asked to quote a sentence about "集成", the
  // model answered "继承" — one character, a different claim, and it was stored under the person's
  // name until the verbatim check existed.
  const decided = explainModelWrite(
    JSON.stringify([{ message: 0, source: '必须把端口固定成 9000。', summary: '用户决定把端口固定成 9000。', who: 'user', worth: true, type: 'constraint' }]),
    WINDOW,
  )
  assert.equal(decided.reason, 'all-refused')
  assert.equal(decided.items, null, 'null, so the caller falls back instead of reading "nothing here"')
})

test('an item naming a message outside the window is refused', () => {
  const decided = explainModelWrite(
    JSON.stringify([{ message: 7, text: '必须把端口固定成 8000。', who: 'user', worth: true, type: 'constraint' }]),
    WINDOW,
  )
  assert.equal(decided.reason, 'all-refused')
})

test('an unknown attribution is refused here; a type is a judgement the caller filters', () => {
  // The line between this module and its caller, pinned so it does not drift: this module checks
  // *verifiability* — is the text in the message, is the role one a memory can attribute to — and
  // the caller applies *policy* — is this type one the store and the recall filter know. Merging
  // the two would put the type whitelist in two places, and the whitelist is the thing the corpus
  // says is wrong (it refuses real requirements typed `procedure`).
  const good = '必须把端口固定成 8000。'
  const decided = explainModelWrite(
    JSON.stringify([
      { message: 0, source: good, summary: '用户要求把端口固定成 8000。', who: 'user', worth: true, type: 'constraint' },
      { message: 0, source: good, summary: '用户要求把端口固定成 8000。', who: 'someone-else', worth: true, type: 'constraint' },
      { message: 0, source: good, summary: '用户要求把端口固定成 8000。', who: 'user', worth: true, type: 'invented-type' },
      { message: 0, source: good, summary: '用户要求把端口固定成 8000。', who: 'user', worth: true, type: 'other' },
    ]),
    WINDOW,
  )
  assert.equal(decided.reason, 'ok')
  assert.deepEqual(
    decided.items?.map((item) => item.type),
    ['constraint', 'invented-type', 'other'],
    'the invented attribution is gone; the types are still there for the caller to weigh',
  )
  assert.equal(
    decided.items?.filter((item) => (WRITE_TYPES as readonly string[]).includes(item.type)).length,
    1,
    'and exactly one item survives the caller-side rule that was measured',
  )
})

test('an empty array is an answer, not a failure', () => {
  const decided = explainModelWrite('[]', WINDOW)
  assert.deepEqual(decided, { items: [], reason: 'empty' })
})

test('prose around the JSON is tolerated, and text with no JSON at all is not', () => {
  const span = '必须把端口固定成 8000。'
  assert.equal(
    explainModelWrite(`好的，如下：\n${JSON.stringify([{ message: 0, source: span, summary: '用户决定把端口固定成 8000。', who: 'user', worth: true, type: 'constraint' }])}\n`,
      WINDOW).reason,
    'ok',
  )
  assert.equal(explainModelWrite('这些都不值得记。', WINDOW).reason, 'unparsable')
})

test('the writer returns nothing, with a reason, when there is no route', async () => {
  const writer = createModelWriter({
    llm: llmAnswering('[]').port as never,
    settings: { enabled: true, window: 5, timeoutMs: 200, retry: 0 },
    resolveRoute: async () => null,
  })
  assert.equal(await writer.decide(WINDOW), null)
  assert.equal(writer.lastReason(), 'no-route')
})

test('a disabled writer never calls the model', async () => {
  const fake = llmAnswering('[]')
  const writer = createModelWriter({
    llm: fake.port as never,
    settings: { enabled: false, window: 5, timeoutMs: 200, retry: 0 },
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await writer.decide(WINDOW), null)
  assert.equal(fake.calls(), 0)
  assert.equal(writer.lastReason(), 'disabled', 'not `no-route`: those are different problems')
})

test('a retry is spent on a broken answer, and the model id travels back', async () => {
  let calls = 0
  const span = '必须把端口固定成 8000。'
  const writer = createModelWriter({
    llm: {
      stream: () => {
        calls += 1
        const text = calls === 1 ? '我不太确定。' : JSON.stringify([{ message: 0, source: span, summary: '用户决定把端口固定成 8000。', who: 'user', worth: true, type: 'constraint' }])
        return (async function* () {
          yield { type: 'text-delta', text }
          yield { type: 'finish' }
        })()
      },
    } as never,
    settings: { enabled: true, window: 5, timeoutMs: 200, retry: 1 },
    resolveRoute: async () => ({ provider: 'p', model: 'test-model' }),
  })
  const decided = await writer.decide(WINDOW)
  assert.equal(calls, 2, 'the unparsable answer cost one retry, which is what the setting is for')
  assert.equal(decided?.model, 'test-model')
  assert.equal(writer.lastReason(), 'ok')
})

test('every type this path may write is one the store and the recall filter already know', () => {
  // A type outside the store's own list would be written and then never injected, which is the
  // silent failure the write ledger's `judgeType` field was added to catch.
  assert.deepEqual([...WRITE_TYPES], ['constraint', 'pitfall', 'decision'])
})

test('a summary may reword, but may not invent an identifier', () => {
  // This is the only thing standing between a model-written memory and a changed fact. The failure it
  // comes from is measured: quoting a sentence about 集成, an earlier version answered 继承 and it was
  // stored under the person's name. A different filename or number is a different claim; a different
  // ordinary word is a wording choice, which is the point of summarising at all.
  const source = '必须把 memory.json 从简历里去掉。'
  const window = [{ seq: 1, role: 'user', text: source }]

  const reworded = explainModelWrite(
    JSON.stringify([{ message: 0, source, summary: '用户要求简历里不要出现这个配置文件。', who: 'user', worth: true, type: 'constraint' }]),
    window,
  )
  assert.equal(reworded.reason, 'ok', 'rewording is allowed')
  assert.equal(reworded.items?.[0]?.summary, '用户要求简历里不要出现这个配置文件。')

  const invented = explainModelWrite(
    JSON.stringify([{ message: 0, source, summary: '用户要求把 memory.txt 从简历里去掉。', who: 'user', worth: true, type: 'constraint' }]),
    window,
  )
  assert.equal(invented.reason, 'drifted:memory.txt', 'a different filename is refused, and named')
  assert.equal(invented.items, null, 'null so the caller falls back rather than silently dropping it')
})

test('an item without a summary is refused, because the summary is the memory', () => {
  // The record's text is the summary on this path. An item that quotes but does not summarise has
  // nothing to store, and storing the quotation instead would quietly reintroduce the verbatim path.
  const source = '必须把端口固定成 8000。'
  const decided = explainModelWrite(
    JSON.stringify([{ message: 0, source, who: 'user', worth: true, type: 'constraint' }]),
    [{ seq: 1, role: 'user', text: source }],
  )
  assert.equal(decided.reason, 'all-refused')
  assert.equal(decided.items, null)
})
