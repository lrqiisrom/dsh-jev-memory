/**
 * The write path's window: what a round is, which rounds are kept, and in what order they are read.
 *
 * These tests exist because the window was previously a closure that nothing could assert, and a real
 * defect lived in it unnoticed: each round was appended as `[question, answer]` and the flat list was
 * reversed at the end, so the model read every answer *before* the question it answered. A real prompt
 * began `[0] 角色=assistant`. The one script that inspected windows counted characters, and the fixture
 * it used was built in the natural order, so the reversal had nothing to disagree with.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { conversationWindowOf, type WindowMessage } from '../dsh/lib/window.ts'

/** A session whose positions are just messages, newest last. */
function reader(messages: readonly WindowMessage[]): { current: number; at: (seq: number) => WindowMessage | null } {
  const bySeq = new Map(messages.map((message) => [message.seq, message]))
  return { current: messages.length, at: (seq) => bySeq.get(seq) ?? null }
}

const ROUNDS: WindowMessage[] = [
  { seq: 0, role: 'user', text: '第一个问题' },
  { seq: 1, role: 'assistant', text: '第一个回答' },
  { seq: 2, role: 'user', text: '第二个问题' },
  { seq: 3, role: 'assistant', text: '第二个回答' },
  { seq: 4, role: 'user', text: '第三个问题' },
  { seq: 5, role: 'assistant', text: '第三个回答' },
]

test('a round is read question first, then the answer to it', () => {
  const source = reader(ROUNDS)
  const window = conversationWindowOf(source.current, source.at, 5, 1_000)
  assert.deepEqual(
    window?.map((message) => `${message.role}:${message.text}`),
    ['user:第一个问题', 'assistant:第一个回答', 'user:第二个问题', 'assistant:第二个回答', 'user:第三个问题', 'assistant:第三个回答'],
  )
})

test('rounds come out oldest first, and only the last N are kept', () => {
  const source = reader(ROUNDS)
  const window = conversationWindowOf(source.current, source.at, 2, 1_000)
  assert.deepEqual(
    window?.map((message) => message.text),
    ['第二个问题', '第二个回答', '第三个问题', '第三个回答'],
    'the two newest rounds, still in reading order',
  )
})

test('an answer is capped and the question never is', () => {
  const long: WindowMessage[] = [
    { seq: 0, role: 'user', text: '问'.repeat(500) },
    { seq: 1, role: 'assistant', text: '答'.repeat(500) },
  ]
  const source = reader(long)
  const window = conversationWindowOf(source.current, source.at, 1, 200)
  assert.equal(window?.[0]?.text.length, 500, 'the person is quoted in full')
  assert.equal(window?.[1]?.text.length, 200, 'the answer is capped')
  // A cap of zero means "leave the answers out", which is how the caller asks for the person's words only.
  assert.deepEqual(conversationWindowOf(source.current, source.at, 1, 0)?.[1], undefined)
})

test('the last assistant line of a round is the one kept', () => {
  // A turn can produce several assistant messages. The first one collected walking backwards is the
  // final answer, and it is the only one the next round's reader needs; the earlier ones are what the
  // turn did on the way there.
  const many: WindowMessage[] = [
    { seq: 0, role: 'user', text: '问题' },
    { seq: 1, role: 'assistant', text: '中间过程' },
    { seq: 2, role: 'assistant', text: '最终回答' },
  ]
  const source = reader(many)
  assert.deepEqual(
    conversationWindowOf(source.current, source.at, 1, 1_000)?.map((message) => message.text),
    ['问题', '最终回答'],
  )
})

test('a round with no answer keeps its question instead of dropping it', () => {
  // The hook runs at the end of a turn, and the newest question can be the last thing in the log. A
  // window that dropped it would be a window with nothing of the person's in it, which is the shape the
  // per-round window was introduced to prevent.
  const open: WindowMessage[] = [
    { seq: 0, role: 'user', text: '旧问题' },
    { seq: 1, role: 'assistant', text: '旧回答' },
    { seq: 2, role: 'user', text: '刚问的' },
  ]
  const source = reader(open)
  assert.deepEqual(
    conversationWindowOf(source.current, source.at, 5, 1_000)?.map((message) => message.text),
    ['旧问题', '旧回答', '刚问的'],
  )
})

test('tool traffic and injected roles are skipped, not rendered', () => {
  const noisy: WindowMessage[] = [
    { seq: 0, role: 'user', text: '问题' },
    { seq: 1, role: 'tool/result', text: '一大段工具输出' },
    { seq: 2, role: 'session-reference', text: '注入的系统片段' },
    { seq: 3, role: 'assistant', text: '回答' },
  ]
  const source = reader(noisy)
  assert.deepEqual(
    conversationWindowOf(source.current, source.at, 5, 1_000)?.map((message) => message.role),
    ['user', 'assistant'],
  )
})

test('no session, or no rounds, means no window', () => {
  const source = reader(ROUNDS)
  assert.equal(conversationWindowOf(null, source.at, 5, 1_000), null)
  assert.equal(conversationWindowOf(undefined, source.at, 5, 1_000), null)
  assert.equal(conversationWindowOf(source.current, source.at, 0, 1_000), null)
  assert.deepEqual(
    conversationWindowOf(source.current, () => null, 5, 1_000),
    [],
    'positions that hold nothing are skipped rather than ending the walk',
  )
})
