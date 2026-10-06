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
  readCompleteObjects,
  summaryDrifted,
  MODEL_WRITE_SYSTEM,
  WRITE_TYPES,
  type WriteMessage,
} from '../dsh/lib/modelwrite.ts'
import { NAME_LIKE } from '../dsh/lib/recall.ts'

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

test('a retry is skipped when the first attempt failed on the clock, not on the answer', async () => {
  // With a ten-second call inside a twelve-second write budget, a second ten-second attempt cannot fit:
  // the caller would abandon the whole turn instead of falling back to the deterministic path, which
  // still writes something. So the retry survives for fast, malformed answers and is dropped after a
  // slow failure.
  let calls = 0
  const slow = createModelWriter({
    llm: {
      stream: (_options: unknown, ...rest: unknown[]) => {
        void rest
        calls += 1
        // Never yields: the writer's own timeout aborts it.
        return (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 5_000))
        })()
      },
    } as never,
    settings: { enabled: true, window: 5, timeoutMs: 120, retry: 3 },
    resolveRoute: async () => ({ provider: 'p', model: 'test-model' }),
  })
  const started = Date.now()
  assert.equal(await slow.decide(WINDOW), null)
  assert.equal(calls, 1, 'one attempt, not four: each would have cost the same 120ms')
  assert.match(slow.lastReason(), /no-retry-after-slow-failure/)
  assert.ok(Date.now() - started < 1_000, 'and the writer returns promptly instead of burning the budget')

  // The fast path still retries, which is what `retry` is for.
  let fast = 0
  const writer = createModelWriter({
    llm: {
      stream: () => {
        fast += 1
        return (async function* () {
          yield { type: 'text-delta', text: fast === 1 ? '我不知道。' : '[]' }
          yield { type: 'finish', reason: 'stop' }
        })()
      },
    } as never,
    settings: { enabled: true, window: 5, timeoutMs: 1_000, retry: 1 },
    resolveRoute: async () => ({ provider: 'p', model: 'test-model' }),
  })
  assert.deepEqual(await writer.decide(WINDOW), { items: [], model: 'test-model' })
  assert.equal(fast, 2, 'an unparsable answer one second in is still worth a second try')
})

test('an answer cut off mid-array keeps the items that were complete', () => {
  // The live failure this exists for: a 15,233-character window, a 3,462-character answer, `finish:
  // length`, the array never closed, and the whole window wrote nothing — the call paid for and
  // discarded. One missing bracket must not cost every item in front of it.
  // Both sources have to be verbatim in the window, or the item is refused for the right reason and
  // the test would be measuring the verbatim check instead of the salvage.
  const first = '必须把端口固定成 8000。'
  const second = '另外这个配置流程应该再简化一下。'
  const window = [...WINDOW]
  const cut =
    `[{"message": 0, "source": "${first}", "summary": "用户要求把端口固定成 8000。", "who": "user", "worth": true, "type": "constraint"},` +
    ` {"message": 0, "source": "${second}", "summary": "用户要求把配置流程再简化一下。", "who": "user", "worth": true, "type": "constraint"},` +
    ` {"message": 0, "source": "第三`
  const decided = explainModelWrite(cut, window)
  assert.equal(decided.reason, 'truncated', 'the reason says the answer stopped early')
  assert.equal(decided.items?.length, 2, 'and the two complete items are kept')
  assert.deepEqual(
    decided.items?.map((item) => item.summary),
    ['用户要求把端口固定成 8000。', '用户要求把配置流程再简化一下。'],
  )
})

test('salvage still refuses everything the normal path refuses', () => {
  // Salvaging is not a looser rule. The item below quotes a line that is not in the message, which is
  // the failure the verbatim check exists for, so it must be dropped even though it parses.
  const cut =
    `[{"message": 0, "source": "这句话原文里没有", "summary": "用户说了什么。", "who": "user", "worth": true, "type": "constraint"},` +
    ` {"message": 0, "source": "另外这个配置流程应该再简化一下。", "summary": "用户要求把配置流程再简化一下。", "who": "user", "worth": true, "type": "constraint"}`
  const decided = explainModelWrite(cut, WINDOW)
  assert.equal(decided.reason, 'truncated')
  assert.equal(decided.items?.length, 1, 'only the item whose source is in the message survives')
  assert.match(decided.items![0]!.summary, /简化/u)

  // And a cut-off answer whose complete items are all refused stays a refusal, not a partial write.
  // The drift used here names a *long Latin identifier*, because that is what the check can see — see
  // the gap pinned in the test below.
  const allBad = `[{"message": 0, "source": "必须把端口固定成 8000。", "summary": "用户要求改用 startPortServer。", "who": "user", "worth": true, "type": "constraint"}`
  assert.match(String(explainModelWrite(allBad, WINDOW).reason), /^drifted:/u)
  assert.equal(explainModelWrite(allBad, WINDOW).items, null)
})

test('braces, brackets and escapes inside a string do not fool the scanner', () => {
  // A summary quoting code is ordinary on this path, so a scanner that counted braces inside strings
  // would cut objects in half and keep the wrong half.
  const messy = 'if (x) { return [1] }  // 说 "好" 的时候'
  const window = [{ seq: 1, role: 'user', text: `看这段：${messy}` }]
  const answer =
    `[{"message": 0, "source": ${JSON.stringify(`看这段：${messy}`)}, "summary": "用户贴了一段代码。", "who": "user", "worth": true, "type": "constraint"},` +
    ` {"message": 0, "source": "截断`
  const decided = explainModelWrite(answer, window)
  assert.equal(decided.reason, 'truncated')
  assert.equal(decided.items?.length, 1, 'the object with braces and brackets inside its strings survived')
  assert.equal(decided.items![0]!.end - decided.items![0]!.start, `看这段：${messy}`.length)
})

test('a salvaged answer is used, and is not retried', async () => {
  // Two things at once, both about cost. The items must reach the caller, and there must be no second
  // attempt: the first attempt already produced usable memories, so retrying would pay twice for the
  // same window — and on a slow call the retry is exactly what the budget cannot afford.
  let calls = 0
  const writer = createModelWriter({
    llm: {
      stream: () => {
        calls += 1
        return (async function* () {
          yield {
            type: 'text-delta',
            text: `[{"message": 0, "source": "必须把端口固定成 8000。", "summary": "用户要求把端口固定成 8000。", "who": "user", "worth": true, "type": "constraint"}, {"message": 0, "source": "还有`,
          }
          yield { type: 'finish', reason: 'length' }
        })()
      },
    } as never,
    settings: { enabled: true, window: 5, timeoutMs: 1_000, retry: 1 },
    resolveRoute: async () => ({ provider: 'p', model: 'test-model' }),
  })
  const written = await writer.decide(WINDOW)
  assert.equal(written?.items.length, 1, 'the complete item is returned')
  assert.equal(calls, 1, 'and the answer is not asked for twice')
  // The ledger has to be able to say this happened. `ok` here would hide a truncation behind a
  // successful write, which is how it went unnoticed in the first place.
  assert.equal(writer.lastReason(), 'truncated')
})

test('an answer with no array at all is still refused, not salvaged', () => {
  assert.equal(explainModelWrite('这些都不值得记。', WINDOW).reason, 'unparsable')
  assert.deepEqual(readCompleteObjects('没有任何数组'), { values: null, closed: false })
  assert.deepEqual(readCompleteObjects('[]'), { values: [], closed: true })
})

test('the drift check sees long Latin names and nothing else — a gap, not a design', () => {
  // `summaryDrifted` matches `\b[A-Za-z][A-Za-z0-9_.-]{4,}\b`: five characters or more, starting with a
  // Latin letter. Measured against the eight cases below, that catches the two Latin identifiers and
  // misses everything else — including the two examples the prompt itself gives.
  //
  // Pinned as a test rather than left in a comment because the source comment claims more than the
  // pattern delivers ("a different filename, command, number or symbol is a different claim"), and a
  // claim nobody checks is how a check quietly stops working.
  const caught = (summary: string, source: string): boolean => summaryDrifted(summary, source) !== null

  assert.equal(caught('用户决定把接口命名成 fetchData。', '把接口命名成 loadData。'), true, 'a long Latin identifier')
  assert.equal(caught('用户要求提交到 /data/reports-2 目录。', '提交到 /data/reports 目录。'), true, 'a path segment')

  // The gaps. Each is a changed fact, not a wording choice, and each is accepted as written today.
  assert.equal(caught('用户要求把端口固定成 9000。', '必须把端口固定成 8000。'), false, 'a changed port number')
  assert.equal(caught('用户要求超时设成 30 秒。', '超时设成 10 秒。'), false, 'a changed timeout')
  assert.equal(
    caught('用户要求设置 timeoutMs=9000。', '设置 timeoutMs=3000。'),
    false,
    'the identifier is copied, its value is not: the token passes and the number is never looked at',
  )
  assert.equal(
    caught('用户要求用 yarn 管理依赖。', '必须用 pnpm 管理依赖。'),
    false,
    'four characters: the single most load-bearing token in a "必须用 pnpm" memory escapes the pattern',
  )
  assert.equal(caught('这个方案提到了集成的问题。', '这个方案提到了继承的问题。'), false, 'Chinese is never matched')

  // Chinese is the bulk of the corpus, so the check as it stands covers a small share of the writes.
  // Whether to widen it is a separate decision — widening to digits refuses summaries that render
  // "两个" as "2", and every refusal here costs a memory.
  assert.equal(NAME_LIKE.test('pnpm'), false)
  assert.equal(NAME_LIKE.test('timeoutMs'), true)
})
