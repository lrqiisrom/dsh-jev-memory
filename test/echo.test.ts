/**
 * The echo screens: is this something the model already said, pasted back into the person's message?
 *
 * Two rules live here and they are tested apart, because they are fed different things and were
 * measured on different corpora. `findEcho` takes a candidate whose text *is* the person's sentence
 * (the fallback path). `findSpanEcho` takes the verbatim span a model-path candidate came from,
 * because that path's candidate text is the model's own third-person rewrite — and a rewrite is never
 * a contiguous run of the answer it rewrote, which is what made the screen fire once in 61 rows.
 *
 * The fixtures for `findSpanEcho` are real rows from `eval/labels/review-scale-400.csv`, kept verbatim
 * so the two thin margins cannot drift unnoticed: the one *keep* it must not kill is 10 tokens, and a
 * genuine echo sits at exactly 15.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ECHO_DEFAULTS, SPAN_ECHO_DEFAULTS, findEcho, findSpanEcho, normalizeForEcho } from '../dsh/lib/echo.ts'
import { tokenize } from '../dsh/lib/conflict.ts'

/** row 41's span — a 39-token paste of the answer two-thirds of a screen earlier. */
const ROW_41_SPAN =
  '两层：框架 checkpoint（LangGraph 机制，按 thread_id 存快照，可断点恢复）；业务层 stop 标识文件 + opencode.db 落盘（执行轨迹可查，重启后读状态决定继续/重试）。诚实说"恢复我们主要靠落盘状态 + 重试 loop，checkpoint 是框架能力"。'

/** row 78's span — 15 tokens, exactly at the floor. */
const ROW_78_SPAN = '动态特性：Go interface 调用、Java 反射/Spring DI——语言服务器解析不到具体实现 → 漏；'

/** row 21's span — 10 tokens, the paste-back-then-cut-line case the floor exists to spare. */
const ROW_21_SPAN = '砍掉：60 秒定时 commit（可能提交半成品污染记忆）'

/** The assistant answer rows 78 and 41 were quoted from, as one message. */
const ANSWER = [
  '语言覆盖不全：无 server/grammar 的语言走 FallbackDefinitions → 退化成名字匹配，跨文件同名匹配不上 → 漏边；',
  ROW_78_SPAN,
  '增量更新范围：只解析"变更文件 + 被引用文件"，如果变更文件引用的上游（谁调用它）没进图 → 反向边断；',
  '',
  ROW_41_SPAN,
].join('\n')

const assistant = (text: string) => [{ role: 'assistant', text }]

test('findSpanEcho flags a span the answer already used, word for word', () => {
  const hit = findSpanEcho(ROW_78_SPAN, assistant(ANSWER))
  assert.ok(hit, 'the span is made of the answer\'s own words')
  assert.equal(hit.role, 'assistant')
  assert.ok(hit.coverage >= 0.95, `coverage ${hit.coverage} should be at or above the threshold`)
})

test('the floor is what spares a short paste, and it is a thin margin', () => {
  // This is the one *keep* the rule would otherwise kill, and it is why `minTokens` exists rather
  // than relying on coverage: the person pasted a line back in order to cut it, so coverage is
  // perfect. It is 10 tokens against a floor of 15 — five tokens of headroom, not a wide margin.
  assert.ok([...tokenize(ROW_21_SPAN)].length < SPAN_ECHO_DEFAULTS.minTokens, 'fixture is still under the floor')
  assert.equal([...tokenize(ROW_21_SPAN)].length, 10, 'and the floor is 15, which is five tokens away')
  assert.equal(findSpanEcho(ROW_21_SPAN, assistant(`原文几点：\n${ROW_21_SPAN}`)), null)
  // Lowering the floor to meet it is what turns the rule into a false positive, so the boundary is
  // asserted rather than described.
  const lowered = findSpanEcho(ROW_21_SPAN, assistant(`原文几点：\n${ROW_21_SPAN}`), { ...SPAN_ECHO_DEFAULTS, minTokens: 10 })
  assert.ok(lowered, 'at a floor of 10 the same input fires — which is exactly the kill the floor prevents')
})

test('a true echo sits exactly at the floor', () => {
  // The other side of the same thin margin. If the floor moved to 16 this row would escape, so the
  // test pins the count rather than trusting the constant.
  assert.equal([...tokenize(ROW_78_SPAN)].length, SPAN_ECHO_DEFAULTS.minTokens)
  assert.ok(findSpanEcho(ROW_78_SPAN, assistant(ANSWER)))
})

test('a span stitched from parts that were never adjacent still matches', () => {
  // Three of the eighteen measured rows quoted the answer out of order or joined two separate list
  // items. A contiguous-run test misses those by construction; token containment does not.
  const stitched = '增量更新范围：只解析"变更文件 + 被引用文件"；语言覆盖不全：无 server/grammar 的语言走 FallbackDefinitions。'
  assert.ok([...tokenize(stitched)].length >= SPAN_ECHO_DEFAULTS.minTokens)
  assert.ok(findSpanEcho(stitched, assistant(ANSWER)), 'order does not matter')
  assert.equal(normalizeForEcho(ANSWER).includes(normalizeForEcho(stitched)), false, 'and it is genuinely not contiguous')
})

test('coverage is over the span, so a long answer quoting the person is not an echo', () => {
  // Direction matters. An answer that happens to overlap a few words of the person's sentence is not
  // evidence that the person quoted the answer: the denominator is the span, and most of this span is
  // nowhere in that answer.
  const span = '用户要求写入侧在每轮对话结束前取最近五轮上下文加本轮对话，调用大模型判断用户提示词中是否有需要长期记忆的内容。'
  assert.ok([...tokenize(span)].length >= SPAN_ECHO_DEFAULTS.minTokens, 'fixture is above the floor')
  assert.equal(findSpanEcho(span, assistant('写入侧的时机还是每轮结束前比较合理，其余细节我们之后再定。')), null)
})

test('only the newest few answers are searched', () => {
  const older = { role: 'assistant', text: '开头的闲聊。' }
  const middle = { role: 'assistant', text: '中间那轮：与本次无关的讨论。' }
  const hit = findSpanEcho(ROW_41_SPAN, [older, middle, { role: 'assistant', text: ANSWER }])
  assert.ok(hit, 'the newest answer is where the quote is')
  // Pushed out of the lookback window, the same span is no longer found — which is the risk the
  // narrow net accepts: a person quoting from four turns back is not caught.
  const tooOld = findSpanEcho(
    ROW_41_SPAN,
    [{ role: 'assistant', text: ANSWER }, { role: 'assistant', text: '一' }, { role: 'assistant', text: '二' }, { role: 'assistant', text: '三' }],
    { ...SPAN_ECHO_DEFAULTS, lookback: 2 },
  )
  assert.equal(tooOld, null)
})

test('the person\'s own earlier words are not an echo of the model', () => {
  assert.equal(findSpanEcho(ROW_78_SPAN, [{ role: 'user', text: ANSWER }]), null)
})

test('whitespace and punctuation do not defeat the comparison', () => {
  const rewrapped = ROW_78_SPAN.replace(/[：，]/gu, ' ').replace(/\s+/gu, '  ')
  assert.ok(findSpanEcho(rewrapped, assistant(ANSWER)), 'a paste is re-wrapped; the words are what count')
})

test('findEcho keeps its own behaviour: contiguous, directional, with its own floor', () => {
  // Pinned here because the module had no tests at all, and this rule is the fallback path's.
  assert.ok(findEcho('不要改动 data/ 目录下的任何文件', assistant('补充一条：不要改动 data/ 目录下的任何文件，任何人都不行。')))
  assert.equal(findEcho('不要改动 data/ 目录下的任何文件', [{ role: 'user', text: '不要改动 data/ 目录下的任何文件' }]), null)
  assert.equal(findEcho('好的', assistant('好的好的好的好的')), null, 'below minChars is not a quote')
  // And the two rules really are different: the contiguous one cannot see a rewrite, which is the
  // model path's whole candidate shape.
  const rewrite = '用户项目的阶段中断恢复分两层：框架层用断点快照，业务层用标识文件。'
  assert.equal(findEcho(rewrite, assistant(ROW_41_SPAN)), null, 'findEcho cannot match a paraphrase')
  assert.equal(SPAN_ECHO_DEFAULTS.minTokens >= ECHO_DEFAULTS.minChars, true)
})
