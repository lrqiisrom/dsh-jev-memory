import assert from 'node:assert/strict'
import { test } from 'node:test'

import { signatureOf } from '../dsh/lib/signals.ts'
import { extractCandidates } from '../dsh/lib/extract.ts'
import type { TurnEvent } from '../dsh/lib/extract.ts'

/** One synthetic turn: a human message, a tool call, and its failed result. */
function turnEvents(): TurnEvent[] {
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
  const events: TurnEvent[] = [
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
  const events: TurnEvent[] = [
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
  const events: TurnEvent[] = [
    { seq: 1, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: sentences }] } },
  ]
  assert.equal(extractCandidates(events, { maxPerMessage: 5, maxPerTurn: 3 }).length, 3)
  assert.equal(extractCandidates(events, { maxPerMessage: 1, maxPerTurn: 3 }).length, 1)
})

test('extractCandidates dedups identical candidates inside one turn', () => {
  const events: TurnEvent[] = [
    { seq: 1, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '必须用 pnpm 管理依赖。必须用 pnpm 管理依赖。' }] } },
  ]
  const candidates = extractCandidates(events)
  assert.equal(new Set(candidates.map((candidate) => candidate.key)).size, candidates.length)
})

test('extractCandidates tolerates malformed events', () => {
  assert.deepEqual(extractCandidates([null, {}, { type: 'tool/result', data: null }]), [])
})

test('a failure naming only an error code is refused, and says so', () => {
  const vetoes: Array<{ text: string; reason: string | null }> = []
  const events: TurnEvent[] = [
    { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'edit' } },
    {
      seq: 2,
      type: 'tool/result',
      data: {
        message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'FS_AMBIGUOUS_EDIT' }] },
        error: { name: 'edit' },
      },
    },
  ]
  const candidates = extractCandidates(events, { onVeto: (text, reason) => vetoes.push({ text, reason }) })
  assert.deepEqual(candidates, [], 'a bare code is not a memory')
  // Not dropped in silence: this class of rejection was invisible once, and finding
  // it took a person labelling rows by hand.
  assert.deepEqual(vetoes, [{ text: 'edit 失败：FS_AMBIGUOUS_EDIT', reason: 'tool-failure-no-detail' }])
})

test('a failure that explains itself is still remembered', () => {
  const events: TurnEvent[] = [
    { seq: 1, type: 'tool/call', data: { callId: 'c2', name: 'sqlite' } },
    {
      seq: 2,
      type: 'tool/result',
      data: {
        message: { source: { callId: 'c2' }, content: [{ type: 'text', text: 'EDQUOT，磁盘配额用尽，要先清 .pnpm-store' }] },
        error: { name: 'sqlite' },
      },
    },
  ]
  const failure = extractCandidates(events).find((candidate) => candidate.kind === 'tool-failure')
  assert.ok(failure, 'a failure with a cause is a pitfall worth keeping')
  assert.match(failure.text, /磁盘配额用尽/u)
})

test('cleaning changes the stored text but never the sentence identity', () => {
  // The whole reason cleaning is safe mid-evaluation: the label table joins on `id`, which
  // is the signature of what the person actually wrote (clipped). Cleaning must therefore
  // not touch it, or every label already given would be orphaned.
  const raw = '\\end{itemize} 端口固定 8000，不要改，否则部署会连不上。'
  const events: TurnEvent[] = [
    { seq: 1, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: raw }] } },
  ]
  const [candidate] = extractCandidates(events)
  assert.ok(candidate, 'the sentence survives the screens once the residue is gone')
  assert.equal(candidate.text, '端口固定 8000，不要改，否则部署会连不上。', 'stored text is cleaned')
  assert.equal(candidate.key, signatureOf(raw), 'identity still comes from the original sentence')
})

test('a model answer binds only the messages it was shown', () => {
  // The rule lives here because this is where the two halves meet: the caller walks the whole turn,
  // while the model only ever read a window of it. Reading "a model answered" as "a model answered
  // about every message" made a turn produce no candidates at all whenever the person's message fell
  // outside that window — silently, and with the splitter suppressed as the only explanation.
  //
  // The window shape has since changed (it is rounds now, so the person's newest message is always in
  // it), which makes the old plugin-level scenario unreachable; the rule still has to hold, because a
  // turn can carry more messages than any window, and because the fallback window still exists.
  const events: TurnEvent[] = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '必须把端口固定成 8000。' }] } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的，我看一下。' }] } } },
    { seq: 3, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '另外日志按天切分。' }] } },
  ]
  const options = { units: [{ seq: 3, text: '另外日志按天切分。' }], onVeto: null }

  // The model answered about seq 3 only. Seq 1 was never shown to it, so the splitter keeps it.
  const scoped = extractCandidates(events, { ...options, decidedSeqs: new Set([3]) } as never)
  assert.deepEqual(
    scoped.map((candidate) => candidate.text).sort(),
    ['另外日志按天切分。', '必须把端口固定成 8000。'].sort(),
    'a message outside the window keeps the punctuation splitter',
  )

  // Claiming the answer covers the whole turn suppresses the splitter for seq 1 — the old behaviour,
  // pinned so the difference between the two is visible rather than remembered.
  const overclaimed = extractCandidates(events, { ...options, decidedSeqs: null } as never)
  assert.deepEqual(overclaimed.map((candidate) => candidate.text), ['另外日志按天切分。'])
})
