import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractCandidates } from '../dsh/lib/extract.js'

/** One synthetic turn: a human message, a tool call, and its failed result. */
function turnEvents() {
  return [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 1,
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '必须用 pnpm，不要用 npm。这个命令为什么失败？好的' }],
      },
    },
    { seq: 2, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } },
    {
      seq: 3,
      type: 'tool/result',
      data: {
        message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'EPERM: /etc/hosts blocked', isError: true }] },
      },
    },
  ]
}

test('extractCandidates keeps statements and drops questions, noise and short lines', () => {
  const candidates = extractCandidates(turnEvents())
  const texts = candidates.map((candidate) => candidate.text)
  assert.ok(texts.includes('必须用 pnpm，不要用 npm。'))
  assert.ok(!texts.some((text) => text.includes('为什么')), 'questions are not memories')
  assert.ok(!texts.includes('好的'))
})

test('extractCandidates ignores plugin and model messages', () => {
  const events = [
    {
      seq: 1,
      type: 'user/message',
      data: { role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '必须用 pnpm 这是系统注入的上下文' }] },
    },
  ]
  assert.deepEqual(extractCandidates(events), [])
})

test('extractCandidates turns a failed tool result into a pitfall signature', () => {
  const failure = extractCandidates(turnEvents()).find((candidate) => candidate.kind === 'tool-failure')
  assert.ok(failure, 'expected a failure candidate')
  assert.equal(failure.hintedType, 'pitfall')
  assert.equal(failure.tool, 'bash')
  assert.match(failure.text, /bash 失败/)
})

test('extractCandidates ranks constraints above neutral statements', () => {
  const events = [
    {
      seq: 1,
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '今天下午开了个会。必须用 pnpm 管理依赖，这是团队约定。' }],
      },
    },
  ]
  const candidates = extractCandidates(events)
  assert.equal(candidates[0].hintedType, 'constraint')
  assert.ok(candidates[0].signalScore > candidates[1].signalScore)
})

test('extractCandidates caps how much one turn can offer', () => {
  const sentences = [
    '必须用 pnpm 管理依赖。',
    '不要改动 data 目录下的任何文件。',
    '提交信息要用中文写清楚原因。',
    '这个服务的端口固定为 8000。',
    '禁止在测试里访问真实网络。',
  ].join('')
  const events = [
    { seq: 1, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: sentences }] } },
  ]
  assert.equal(extractCandidates(events, { maxPerMessage: 5, maxPerTurn: 3 }).length, 3)
  assert.equal(extractCandidates(events, { maxPerMessage: 1, maxPerTurn: 3 }).length, 1)
})

test('extractCandidates dedups identical candidates inside one turn', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '必须用 pnpm 管理依赖。必须用 pnpm 管理依赖。' }] } },
  ]
  const candidates = extractCandidates(events)
  assert.equal(new Set(candidates.map((candidate) => candidate.key)).size, candidates.length)
})

test('extractCandidates tolerates malformed events', () => {
  assert.deepEqual(extractCandidates([null, {}, { type: 'tool/result', data: null }]), [])
})
