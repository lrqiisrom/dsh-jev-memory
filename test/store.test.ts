import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { signatureOf } from '../dsh/lib/signals.ts'
import { createMemoryStore, normalizeRecord, recordIdOf } from '../dsh/lib/store.ts'
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
  await store.put(record({ id: 'c', type: 'decision', status: 'superseded' }))
  assert.deepEqual(store.stats(), {
    total: 3,
    byType: { constraint: 1, pitfall: 1, decision: 1 },
    needsReview: 1,
    superseded: 1,
    recalls: 0,
  })
  assert.equal(await store.remove('a'), true)
  assert.equal(await store.remove('a'), false)
  assert.equal(store.stats().total, 2)

  const removed = await store.removeWhere((entry) => entry.status !== 'active')
  assert.equal(removed.length, 2)
  assert.equal(store.stats().total, 0)
})

// "Have I seen this failure before?" has to survive a restart, and the answer is
// derived from the ledger rather than a second store of its own — one source of
// truth, and no new schema to keep in sync with the audit trail.
test('observation counts are derived from the ledger and survive a reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshmem-'))
  const store = createMemoryStore({ root, now: () => 1 })
  await store.load()
  assert.equal(store.observedCount('sig'), 0)
  store.noteObserved('sig')
  await store.ledger({ kind: 'observed', id: 'sig' })
  // A judgement outcome for the same signature must not be counted twice.
  await store.ledger({ kind: 'skip', reason: 'below-min-remember', id: 'sig' })
  await store.flush()

  const reopened = createMemoryStore({ root, now: () => 1 })
  await reopened.load()
  assert.equal(reopened.observedCount('sig'), 1)
  assert.equal(reopened.observedCount('other'), 0)
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

test('superseding keeps the old record, unlike deleting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmem-store-'))
  const store = createMemoryStore({ root: dir })
  await store.load()
  await store.put({ ...record(), id: 'old', text: '可以随便改 data/ 目录下的文件' })
  await store.put({ ...record(), id: 'new', text: '不要改动 data/ 目录下的任何文件' })

  assert.equal(await store.supersede('old', 'new'), true)
  assert.equal(await store.supersede('missing', 'new'), false)

  const old = store.get('old')
  assert.equal(old?.status, 'superseded')
  assert.equal(old?.supersededBy, 'new')
  assert.match(String(old?.text), /可以随便改/u, 'the earlier statement is still readable')

  // It has to survive a reload too: an audit trail that only exists in memory is not one.
  const reopened = createMemoryStore({ root: dir })
  await reopened.load()
  const persisted = reopened.get('old')
  assert.equal(persisted?.status, 'superseded')
  assert.equal(persisted?.supersededBy, 'new')
  assert.match(String(persisted?.text), /可以随便改/u)
})

test('legacy folded ids are re-keyed to content hashes, and links follow them', async () => {
  // Ids used to be `signatureOf(text)`. The store is keyed by id, so the load path has to move those
  // records onto the new scheme once, or every lookup written in terms of the new id misses them.
  // Both directions are checked here: the id moves, and so does the record that points at it.
  // Two texts with *different* folded signatures, because two legacy records could not have shared
  // one: the collision meant the second write destroyed the first, so a collided pair is not
  // recoverable and cannot appear in a file. (Checked against the live store: 31 legacy ids, 0
  // collisions, so nothing was lost there.)
  const root = await mkdtemp(join(tmpdir(), 'dshmem-'))
  const oldText = '服务端口固定 8000，不要改。'
  const newText = '提交信息用中文写。'
  const legacyId = signatureOf(oldText)
  const newLegacyId = signatureOf(newText)
  assert.notEqual(legacyId, newLegacyId)
  const file = join(root, 'memory.json')
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      records: [
        { ...record({ id: legacyId, text: oldText, status: 'superseded', supersededBy: newLegacyId }) },
        { ...record({ id: newLegacyId, text: newText, supersedes: legacyId }) },
      ],
    }),
  )

  const store = createMemoryStore({ root, now: () => 1_700_000_000_000 })
  assert.equal((await store.load()).loaded, 2)

  const oldId = recordIdOf(oldText)
  const newId = recordIdOf(newText)
  assert.notEqual(oldId, legacyId, 'the folded id is gone')
  assert.equal(store.has(legacyId), false, 'and nothing is left under it')
  assert.equal(store.get(oldId)!.text, oldText, 'the record is reachable by its content hash')
  assert.equal(store.get(oldId)!.supersededBy, newId, 'the link was re-pointed, not left dangling')
  assert.equal(store.get(newId)!.supersedes, oldId, 'in both directions')
})

test('fingerprint ids are re-keyed; a hand-chosen id and a namespace are not', async () => {
  // Four cases, all of them from live data or from the rules the live data forced.
  //
  // A stale id: `signatureOf(identity)` where `identity` was hard-clipped, while the stored text came
  // from the clause-boundary clip — so the id carried a fold marker but was not the signature of its
  // own text. The "equals the signature" test would miss it; the marker test catches it.
  //
  // A colon: the first version of this check treated any id containing `:` as namespaced and skipped a
  // record whose folded text happened to contain `reasoningeffort: <str>`. A namespace is a prefix.
  //
  // And the two it must leave alone: `l0:...` points at an archive file, and `k1` is an id a person
  // typed into the file by hand. Rewriting either would break what it points at.
  const root = await mkdtemp(join(tmpdir(), 'dshmem-'))
  const staleText = '服务端口固定 8000，不要改。'
  const staleId = signatureOf(`${staleText}后来又加了一句 9000。`)
  const colonText = '结构化调用必须传 reasoningeffort: off，否则会报错。'
  await writeFile(
    join(root, 'memory.json'),
    JSON.stringify({
      records: [
        record({ id: staleId, text: staleText }),
        record({ id: signatureOf(colonText), text: colonText }),
        record({ id: 'l0:s1:7', text: '归档里的一句话。' }),
        record({ id: 'k1', text: '手写的一条。' }),
      ],
    }),
  )

  const store = createMemoryStore({ root, now: () => 1_700_000_000_000 })
  assert.equal((await store.load()).loaded, 4)

  assert.equal(store.get(recordIdOf(staleText))?.text, staleText, 'the stale fingerprint was replaced')
  assert.equal(store.has(staleId), false)
  assert.equal(store.get(recordIdOf(colonText))?.text, colonText, 'a colon in the text is not a namespace')
  assert.equal(store.get('l0:s1:7')?.text, '归档里的一句话。', 'a namespaced id is left where it is')
  assert.equal(store.get('k1')?.text, '手写的一条。', 'and so is an id a person chose')
})

test('a stale id with no fold marker is left alone, and that is a known gap', async () => {
  // Stated as a test rather than as a comment in the source, because a known gap that no test
  // describes is a gap nobody will notice.
  //
  // An id derived from an older text that contained no digits, quotes, paths, backticks or hex runs
  // carries no marker, so the re-key cannot recognise it, and it is not reachable by a lookup derived
  // from the text it now holds. Widening the rule to "anything that is not a content hash" would
  // repair this case and would also rewrite `k1` — an id a person typed. Nothing in the live store is
  // in this state (32 records checked: 32 content hashes), and the new write path cannot create one,
  // because an in-place update only happens when the id already matches the text.
  const root = await mkdtemp(join(tmpdir(), 'dshmem-'))
  const text = '必须用 pnpm 管理依赖。'
  const unmarkedId = signatureOf(`${text}后来补了一句。`)
  await writeFile(join(root, 'memory.json'), JSON.stringify({ records: [record({ id: unmarkedId, text })] }))

  const store = createMemoryStore({ root, now: () => 1_700_000_000_000 })
  assert.equal((await store.load()).loaded, 1)
  assert.equal(store.has(unmarkedId), true, 'left as it was')
  assert.equal(store.get(recordIdOf(text)), undefined, 'and therefore not reachable by its own text')
})

test('two texts that differ only in a folded literal are two ids, not one', async () => {
  // The property the whole id change exists for. `signatureOf` folds 8000 and 9000 to the same `<n>`,
  // which is exactly what the near-duplicate search wants and exactly what a primary key must not do:
  // as an id it made these two the same record, so writing the second silently destroyed the first.
  const pairs: Array<[string, string]> = [
    ['服务端口固定 8000，不要改。', '服务端口固定 9000，不要改。'],
    ['超时设成 10s。', '超时设成 30s。'],
    ['构建产物放 /dist/a。', '构建产物放 /build/b。'],
  ]
  for (const [left, right] of pairs) {
    assert.notEqual(recordIdOf(left), recordIdOf(right), `${left} vs ${right}`)
    assert.equal(signatureOf(left), signatureOf(right), 'and the fingerprint still calls them the same shape')
  }
  assert.equal(recordIdOf('必须用 pnpm。'), recordIdOf('必须用 pnpm。'), 'identical text stays one id')
  assert.equal(recordIdOf('必须用 pnpm。'), recordIdOf('  必须用  pnpm。 '), 'whitespace is not identity')
})
