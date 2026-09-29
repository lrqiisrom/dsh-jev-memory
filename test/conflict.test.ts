import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildConflictQuestion,
  choiceFromAnswer,
  CONFLICT_CHOICES,
  findConflictPartner,
  rankConflictPartners,
  tokenize,
} from '../dsh/lib/conflict.ts'
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

test('IDF makes a rare shared term outrank a common one', () => {
  // Latin tokens, where tokenization is clean and the property is the only thing
  // being tested: `pnpm` appears in almost every memory, `redis` in one. A scorer
  // that counted shared words equally would tie them.
  const records = [
    ...Array.from({ length: 11 }, (_, index) => memory(`f${index}`, `pnpm 管理依赖 ${index}`)),
    memory('common', 'pnpm 装包要加 -D'),
    memory('rare', 'redis 只当缓存层，不能当权威层'),
  ]
  assert.equal(rankConflictPartners('redis 和 pnpm 有什么区别', records, 1)[0]?.id, 'rare')
})

test('relevance beats recency, and the window never shrinks', () => {
  // The bug this fixes: the write path handed the judge `slice(0, 20)` in store
  // order, so a contradiction at position twenty-one was never shown and the model
  // answered "no conflict" with nothing in the ledger to show for it.
  const records = [
    memory('old-but-relevant', '服务端口用 8000', 1),
    ...Array.from({ length: 24 }, (_, index) => memory(`filler${index}`, `第 ${index} 条无关约定`, 2_000 + index)),
  ]
  const ranked = rankConflictPartners('端口改成 9000', records, 20)
  assert.equal(ranked.length, 20, 'a full window is still filled')
  assert.equal(ranked[0]?.id, 'old-but-relevant', 'the oldest memory wins on relevance alone')
  assert.equal(ranked[1]?.id, 'filler23', 'the rest fall back to newest-first')
})

test('the scorer is swappable, which is how an embedding path plugs in', () => {
  const records = [memory('x', '内存里的东西'), memory('y', '另一个东西', 1_700_000_000_001)]
  // A scorer is any function of (incoming, record); ranking must not care where the
  // number came from, which is what lets cosine similarity replace BM25 unchanged.
  const ranked = rankConflictPartners('随便', records, 1, (_incoming, record) => (record.id === 'y' ? 1 : 0))
  assert.deepEqual(ranked.map((entry) => entry.id), ['y'])
})
