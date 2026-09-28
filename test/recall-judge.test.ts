import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyGate, createJudge, heuristicRow } from '../dsh/lib/judge.ts'
import { inScope, renderRecall, searchMemories, selectMemories } from '../dsh/lib/recall.ts'

const DAY = 86_400_000
const NOW = 1_700_000_000_000

/** Build a record with a type, importance and age. */
function memory({
  id,
  type = 'constraint',
  importance = 0.9,
  ageDays = 0,
  cwd = '/work/a',
  status = 'active',
}: {
  id: string
  type?: string
  importance?: number
  ageDays?: number
  cwd?: string | null
  status?: string
}) {
  return {
    id,
    type,
    text: `${type} ${id}`,
    cwd,
    importance,
    status,
    createdAt: NOW - ageDays * DAY,
    recalls: 0,
  }
}

test('selectMemories respects the per-type quota and the type filter', () => {
  const records = [
    memory({ id: 'c1' }),
    memory({ id: 'c2' }),
    memory({ id: 'c3' }),
    memory({ id: 'p1', type: 'pitfall' }),
    memory({ id: 'f1', type: 'fact' }),
  ]
  const chosen = selectMemories(records, {
    cwd: '/work/a',
    types: ['constraint', 'pitfall'],
    quota: { constraint: 2, pitfall: 1 },
    now: NOW,
  })
  assert.deepEqual(chosen.map((entry) => entry.record.id), ['c1', 'c2', 'p1'])
})

test('selectMemories keeps a stale constraint ahead of a fresh minor pitfall', () => {
  const records = [
    memory({ id: 'old-constraint', importance: 0.9, ageDays: 300 }),
    memory({ id: 'new-pitfall', type: 'pitfall', importance: 0.5 }),
  ]
  const chosen = selectMemories(records, { cwd: '/work/a', types: ['constraint', 'pitfall'], now: NOW })
  assert.deepEqual(chosen.map((entry) => entry.record.id), ['old-constraint', 'new-pitfall'])
})

test('selectMemories excludes other workspaces and suspected conflicts', () => {
  const records = [
    memory({ id: 'here', cwd: '/work/a' }),
    memory({ id: 'elsewhere', cwd: '/work/b' }),
    memory({ id: 'global', cwd: null }),
    memory({ id: 'suspect', status: 'needs-review' }),
  ]
  const chosen = selectMemories(records, { cwd: '/work/a', types: ['constraint'], now: NOW })
  assert.deepEqual(chosen.map((entry) => entry.record.id).sort(), ['global', 'here'])
})

test('selectMemories obeys the token budget', () => {
  const records = [memory({ id: 'big', importance: 1 }), memory({ id: 'small', importance: 0.95 })]
  records[0].text = '必须'.repeat(400)
  const chosen = selectMemories(records, { cwd: '/work/a', types: ['constraint'], maxTokens: 50, now: NOW })
  assert.deepEqual(chosen.map((entry) => entry.record.id), ['small'])
})

test('renderRecall labels type, id and date, and is empty when nothing was chosen', () => {
  const chosen = selectMemories([memory({ id: 'c1', ageDays: 10 })], { cwd: '/work/a', types: ['constraint'], now: NOW })
  const text = renderRecall(chosen)
  assert.match(text, /^## 长期记忆/)
  assert.match(text, /- \[constraint\] constraint c1 \(c1, \d{4}-\d{2}-\d{2}\)/)
  assert.match(text, /memory_forget/)
  assert.equal(renderRecall([]), '')
})

test('inScope treats a global memory as visible everywhere', () => {
  assert.equal(inScope({ cwd: null }, '/work/a'), true)
  assert.equal(inScope({ cwd: null }, null), true)
  assert.equal(inScope({ cwd: '/work/a' }, '/work/a'), true)
  assert.equal(inScope({ cwd: '/work/a' }, '/work/b'), false)
  assert.equal(inScope({ cwd: '/work/a' }, null), false)
})

test('searchMemories matches substrings and stays inside the workspace', () => {
  const records = [memory({ id: 'c1', cwd: '/work/a' }), memory({ id: 'c2', cwd: '/work/b' })]
  records[0].text = '必须用 pnpm 管理依赖'
  records[1].text = '必须用 pnpm 管理依赖'
  const hits = searchMemories(records, 'pnpm', { cwd: '/work/a' })
  assert.deepEqual(hits.map((hit) => hit.record.id), ['c1'])
})

test('heuristic judge labels type and importance from signals', () => {
  const row = heuristicRow({ key: 'k', hintedType: 'pitfall', signalScore: 0.8, signals: ['/报错/'] }, { types: ['constraint', 'pitfall'] })
  assert.equal(row.type, 'pitfall')
  assert.equal(row.importance, 0.8)
  assert.equal(row.by, 'heuristic')
  assert.equal(row.conflict, 'unknown')
})

test('the write gate is a deterministic threshold, not a probability rule', () => {
  const config = { types: ['constraint', 'pitfall', 'decision'], minImportance: 0.6, reviewOnConflict: true }
  assert.deepEqual(applyGate({ type: 'constraint', importance: 0.6, conflict: 'no' }, config), { write: true, reason: 'ok' })
  assert.equal(applyGate({ type: 'constraint', importance: 0.59, conflict: 'no' }, config).write, false)
  assert.equal(applyGate({ type: 'fact', importance: 1, conflict: 'no' }, config).reason, 'type-disabled:fact')
  const conflict = applyGate({ type: 'decision', importance: 0.9, conflict: 'yes' }, config)
  assert.deepEqual(conflict, { write: true, review: true, reason: 'conflict' })
  assert.equal(applyGate(null, config).write, false)
})

test('judge with mode off writes nothing and never calls the model', async () => {
  let called = 0
  const judge = createJudge({
    config: { judge: 'off', types: ['constraint'] },
    jev: { available: true, decide: async () => { called += 1; return { rows: [], model: null } } },
  })
  assert.equal(judge.kind, 'off')
  const result = await judge.judge([{ key: 'k', hintedType: 'constraint', signalScore: 1, signals: [] }])
  assert.deepEqual(result, { rows: [], model: null, degraded: 'judge-off' })
  assert.equal(called, 0)
})

test('judge falls back to the heuristic when the model fails', async () => {
  const warnings: string[] = []
  const judge = createJudge({
    config: { judge: 'jev', types: ['constraint'], judgeTimeoutMs: 10 },
    jev: { available: true, decide: async () => { throw new Error('timeout') } },
    log: (level, message) => warnings.push(`${level}:${message}`),
  })
  const { rows, degraded } = await judge.judge([{ key: 'k', hintedType: 'constraint', signalScore: 0.7, signals: [] }])
  assert.equal(rows[0].by, 'heuristic')
  assert.equal(rows[0].note, 'jev-failed')
  assert.equal(degraded, 'jev-failed')
  assert.equal(warnings.length, 1)
})

test('judge maps model rows onto candidates and rejects types outside the config', async () => {
  const judge = createJudge({
    config: { judge: 'jev', types: ['constraint', 'pitfall'] },
    jev: {
      available: true,
      decide: async () => ({
        model: 'jev-1.13.0',
        rows: [{ key: 'k', type: 'fact', importance: 0.95, conflict: 'yes', confidence: 0.8 }],
      }),
    },
  })
  const { rows, model, degraded } = await judge.judge([{ key: 'k', hintedType: 'constraint', signalScore: 0.5, signals: [] }])
  assert.equal(rows[0].type, 'constraint', 'a type the config disables is replaced by the signal hint')
  assert.equal(rows[0].importance, 0.95)
  assert.equal(rows[0].conflict, 'yes')
  assert.equal(rows[0].by, 'jev')
  assert.equal(model, 'jev-1.13.0', 'the responding model version travels with the judgement')
  assert.equal(degraded, null)
})
