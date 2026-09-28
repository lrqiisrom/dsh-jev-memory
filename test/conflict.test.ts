import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildConflictQuestion, choiceFromAnswer, CONFLICT_CHOICES, findConflictPartner, tokenize } from '../dsh/lib/conflict.ts'
import type { MemoryRecord } from '../dsh/lib/store.ts'

/** A minimal record for pairing tests. */
function memory(id: string, text: string, createdAt = 1_700_000_000_000): MemoryRecord {
  return {
    id,
    type: 'constraint',
    text,
    cwd: '/work/a',
    importance: 0.9,
    status: 'active',
    source: { sessionId: 's', seq: 1, quote: text, at: createdAt },
    createdAt,
    updatedAt: createdAt,
    recalls: 0,
    lastRecalledAt: null,
    judge: { kind: 'jev', confidence: null, conflict: 'unknown', mode: 'auto' },
  }
}

test('tokenize keeps latin words and CJK bigrams, not single characters', () => {
  const tokens = tokenize('必须用 pnpm 管理 data 目录')
  assert.equal(tokens.has('pnpm'), true)
  assert.equal(tokens.has('data'), true)
  assert.equal(tokens.has('必须'), true)
  assert.equal(tokens.has('必'), false)
})

test('findConflictPartner picks the most overlapping memory and names the shared tokens', () => {
  const records = [
    memory('other', '端口固定 8000，不要改'),
    memory('candidate', '可以随便改 data/ 目录下的文件'),
  ]
  const pair = findConflictPartner('不要改动 data/ 目录下的任何文件', records)
  assert.equal(pair?.existing.id, 'candidate')
  assert.ok((pair?.score ?? 0) >= 0.2)
  assert.ok((pair?.shared ?? []).includes('目录'))
})

test('findConflictPartner returns null when nothing is similar enough', () => {
  assert.equal(findConflictPartner('必须用 pnpm', [memory('x', '今天下午开了个会')]), null)
  assert.equal(findConflictPartner('必须用 pnpm', []), null)
})

test('buildConflictQuestion quotes both sides verbatim and dates the earlier one', () => {
  const pair = findConflictPartner('不要改动 data/ 目录下的任何文件', [memory('candidate', '可以随便改 data/ 目录下的文件')])
  assert.ok(pair)
  const question = buildConflictQuestion(pair, 'incoming-id')
  assert.equal(question.id, 'conflict:incoming-id')
  assert.match(question.detail, /不要改动 data\/ 目录下的任何文件/)
  assert.match(question.detail, /可以随便改 data\/ 目录下的文件/)
  assert.match(question.detail, /\d{4}-\d{2}-\d{2}/)
  assert.deepEqual(
    question.options.map((option) => option.label),
    [CONFLICT_CHOICES.replace, CONFLICT_CHOICES['keep-old'], CONFLICT_CHOICES['keep-both']],
  )
})

test('choiceFromAnswer maps labels back and refuses to guess', () => {
  assert.equal(choiceFromAnswer({ selected: [CONFLICT_CHOICES.replace] }), 'replace')
  assert.equal(choiceFromAnswer({ selected: [CONFLICT_CHOICES['keep-both']] }), 'keep-both')
  assert.equal(choiceFromAnswer({ selected: [] }), null)
  assert.equal(choiceFromAnswer({ selected: ['随便写的自定义答案'] }), null)
  assert.equal(choiceFromAnswer(undefined), null)
})
