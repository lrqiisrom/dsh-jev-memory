import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createMemoryStore, normalizeRecord } from '../dsh/lib/store.ts'
import type { MemoryRecord } from '../dsh/lib/store.ts'

/** Build a minimal record for store tests. */
function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'k1',
    type: 'constraint',
    text: '必须用 pnpm。',
    cwd: '/work/a',
    importance: 0.9,
    status: 'active',
    source: { sessionId: 's1', seq: 3, quote: '必须用 pnpm。', at: 1_700_000_000_000 },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    recalls: 0,
    lastRecalledAt: null,
    judge: { kind: 'heuristic', confidence: null, conflict: 'unknown', mode: 'auto' },
    ...overrides,
  }
}

test('store persists records and reloads them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshmem-'))
  const store = createMemoryStore({ root, now: () => 1_700_000_000_000 })
  assert.deepEqual(await store.load(), { loaded: 0, recovered: false })

  await store.put(record())
  await store.flush()

  const reopened = createMemoryStore({ root, now: () => 1_700_000_000_000 })
  assert.equal((await reopened.load()).loaded, 1)
  assert.equal(reopened.get('k1')!.text, '必须用 pnpm。')
  assert.equal(reopened.has('k1'), true)
})

test('store replaces a re-stated memory without losing its recall history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshmem-'))
  const store = createMemoryStore({ root, now: () => 5 })
  await store.load()
  await store.put(record())
  store.noteRecalled(['k1'])
  await store.put(record({ importance: 1, createdAt: 999, updatedAt: 999 }))

  const kept = store.get('k1')!
  assert.equal(kept.createdAt, 1_700_000_000_000, 'first sighting wins as the origin')
  assert.equal(kept.recalls, 1, 'recall counter survives a restatement')
  assert.equal(kept.importance, 1)
})

test('store survives a corrupt document and keeps a backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshmem-'))
  await writeFile(join(root, 'memory.json'), '{ not json')
  const store = createMemoryStore({ root, now: () => 42 })
  assert.deepEqual(await store.load(), { loaded: 0, recovered: true })
  const backup = await readFile(join(root, 'memory.json.corrupt-42'), 'utf8')
  assert.equal(backup, '{ not json')
})

test('store writes an append-only ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshmem-'))
  const store = createMemoryStore({ root, now: () => 7 })
  await store.load()
  await store.ledger({ kind: 'write', id: 'k1' })
  await store.ledger({ kind: 'forget', id: 'k1' })
  const lines = (await readFile(join(root, 'ledger.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { t: number; kind: string })
  assert.equal(lines.length, 2)
  assert.equal(lines[0].t, 7)
  assert.equal(lines[1].kind, 'forget')
})

test('store removes records and reports stats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshmem-'))
  const store = createMemoryStore({ root, now: () => 1 })
  await store.load()
  await store.put(record({ id: 'a' }))
  await store.put(record({ id: 'b', type: 'pitfall', status: 'needs-review' }))
  assert.deepEqual(store.stats(), { total: 2, byType: { constraint: 1, pitfall: 1 }, needsReview: 1, recalls: 0 })
  assert.equal(await store.remove('a'), true)
  assert.equal(await store.remove('a'), false)
  assert.equal(store.stats().total, 1)

  const removed = await store.removeWhere((entry) => entry.type === 'pitfall')
  assert.equal(removed.length, 1)
  assert.equal(store.stats().total, 0)
})

test('normalizeRecord tolerates a hand-edited file', () => {
  const normalized = normalizeRecord({ text: '  手工改的  ', type: 'nonsense' }, 100)!
  assert.equal(normalized.text, '手工改的')
  assert.equal(normalized.type, 'fact', 'unknown types degrade instead of discarding the memory')
  assert.equal(normalized.status, 'active')
  assert.equal(normalized.createdAt, 100)
  assert.equal(normalizeRecord({}, 1), null)
  assert.equal(normalizeRecord(null, 1), null)
})
