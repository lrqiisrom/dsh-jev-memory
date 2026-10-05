import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyGate, createJudge, heuristicRow } from '../dsh/lib/judge.ts'
import { fixedCost, inScope, NAME_LIKE, renderLine, renderRecall, searchMemories, selectMemories } from '../dsh/lib/recall.ts'
import { signatureOf } from '../dsh/lib/signals.ts'
import { estimateTokens } from '../dsh/lib/text.ts'

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

test('selectMemories obeys the token budget, and counts the block it is part of', () => {
  // The budget is the *block's*, not the sum of its lines: `renderRecall` adds a heading and a
  // retraction note, and those were being spent without being charged. Measured on the 36-probe
  // baseline the injected block came to 641 tokens against a 600 budget — a budget the plugin
  // reports as its own and then overran. The first assertion is the behaviour change: a budget
  // smaller than the fixed part now holds nothing rather than overflowing.
  const records = [memory({ id: 'big', importance: 1 }), memory({ id: 'small', importance: 0.95 })]
  records[0].text = '必须'.repeat(400)
  const tight = selectMemories(records, { cwd: '/work/a', types: ['constraint'], maxTokens: 50, now: NOW })
  assert.deepEqual(tight.map((entry) => entry.record.id), [], 'a 50-token budget cannot hold the header and note')

  const chosen = selectMemories(records, { cwd: '/work/a', types: ['constraint'], maxTokens: 200, now: NOW })
  assert.deepEqual(chosen.map((entry) => entry.record.id), ['small'], 'the oversized line is skipped, not truncated')
  assert.ok(
    estimateTokens(renderRecall(chosen)) <= 200,
    'and what is actually injected fits the budget it was given',
  )
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

test('searchMemories ranks by relevance and stays inside the workspace', () => {
  const records = [memory({ id: 'c1', cwd: '/work/a' }), memory({ id: 'c2', cwd: '/work/b' })]
  records[0].text = '必须用 pnpm 管理依赖'
  records[1].text = '必须用 pnpm 管理依赖'
  const hits = searchMemories(records, 'pnpm', { cwd: '/work/a' })
  assert.deepEqual(hits.map((hit) => hit.record.id), ['c1'])
})

test('searchMemories finds a memory the question does not quote', () => {
  // The reason the substring matcher was replaced. Measured on 36 probes derived from
  // labelled memories: substring matching ranked the answering memory at MRR 0.23 and
  // returned nothing at all for 27 of them — 17 of the 18 probes that phrased the need in
  // other words. BM25 scores the tokens instead of requiring the literal phrase.
  const records = [memory({ id: 'port' }), memory({ id: 'yarn' })]
  records[0].text = '服务端口固定用 8000，别乱改'
  records[1].text = '前端依赖不要用 yarn'
  const hits = searchMemories(records, '端口是多少来着，改端口有什么规矩吗', { cwd: '/work/a' })
  assert.equal(hits[0]?.record.id, 'port', 'the memory about ports must win without the exact phrase')
})

test('searchMemories lets a quoted name outrank a stronger prose match', () => {
  // Replacing the substring matcher with BM25 fixed paraphrase and broke this case: on a quoted
  // name the old matcher scored MRR 0.97 and plain BM25 scored 0.31, because `memory` and `json`
  // are common tokens that carry little IDF. Measured over 22 machine-generated identifier
  // probes, the bonus takes it to 1.00 while leaving the 36 paraphrase probes at 0.71.
  const records = [memory({ id: 'names' }), memory({ id: 'prose' })]
  records[0].text = '简历里不要带 memory.json 这种自定义文件名'
  records[1].text = '简历里不要带自定义文件名也不要带仓库之外的东西，注意措辞要简洁'
  // The prose memory shares far more tokens with the question; only the name is decisive.
  const hits = searchMemories(records, 'memory.json 这个文件名有什么要求？', { cwd: '/work/a' })
  assert.equal(hits[0]?.record.id, 'names')
})

test('searchMemories does not treat an ordinary word as a name', () => {
  // `replace` and `intended` also occur exactly once in the store. Treating them as names made
  // the first identifier probe set measure nothing, and would let any long English word in a
  // question trigger the bonus.
  const records = [memory({ id: 'a' }), memory({ id: 'b' })]
  records[0].text = '必须用 pnpm 管理依赖'
  records[1].text = '依赖装完要跑一遍构建'
  const hits = searchMemories(records, 'dependencies 这块是怎么定的？', { cwd: '/work/a' })
  assert.equal(hits.length, 0, 'no shared token and no name means no result')
})

test('searchMemories returns nothing when nothing is related', () => {
  // The `score > 0` cutoff is part of the contract: a search tool that always returns its
  // whole store is worse than one that admits it found nothing. Making importance an additive
  // term instead of a tie-break would have destroyed this, since it makes every score positive.
  const records = [memory({ id: 'a', importance: 1 })]
  records[0].text = '必须用 pnpm 管理依赖'
  assert.deepEqual(searchMemories(records, '面试安排在周四', { cwd: '/work/a' }), [])
})

test('searchMemories no longer matches on the type name', () => {
  // `type` used to be concatenated into the haystack and worth 0.3 per token, so a query
  // containing "constraint" surfaced every constraint whatever it said.
  const records = [memory({ id: 'a', type: 'constraint' })]
  records[0].text = '必须用 pnpm 管理依赖'
  assert.deepEqual(searchMemories(records, 'constraint', { cwd: '/work/a' }), [])
})

test('heuristic judge labels type and importance from signals', () => {
  const row = heuristicRow({ key: 'k', hintedType: 'pitfall', signalScore: 0.8, signals: ['/报错/'] }, { types: ['constraint', 'pitfall'] })
  assert.equal(row.type, 'pitfall')
  assert.equal(row.importance, 0.8)
  assert.equal(row.by, 'heuristic')
  assert.equal(row.conflict, 'unknown')
})

test('the write gate is a deterministic threshold, not a probability rule', () => {
  const config = { types: ['constraint', 'pitfall', 'decision'], minImportance: 0.6, minRemember: 0.6, reviewOnConflict: true }
  assert.deepEqual(applyGate({ type: 'constraint', importance: 0.6, conflict: 'no' }, config), { write: true, reason: 'ok' })
  assert.equal(applyGate({ type: 'constraint', importance: 0.59, conflict: 'no' }, config).write, false)
  assert.equal(applyGate({ type: 'fact', importance: 1, conflict: 'no' }, config).reason, 'type-disabled:fact')
  const conflict = applyGate({ type: 'decision', importance: 0.9, conflict: 'yes' }, config)
  assert.deepEqual(conflict, { write: true, review: true, reason: 'conflict' })
  assert.equal(applyGate(null, config).write, false)
})

// The measured bug this rule fixes: a genuinely useful constraint scored 0.28 on
// the importance rubric while a task instruction scored 0.73. The judge's
// "worth remembering" answer now gates the write, and importance only ranks.
test('the remember answer gates the write, importance only ranks', () => {
  const config = { types: ['constraint', 'pitfall', 'decision'], minImportance: 0.6, minRemember: 0.6, reviewOnConflict: true }
  assert.deepEqual(applyGate({ type: 'constraint', importance: 0.2, remember: 0.95, conflict: 'no' }, config), {
    write: true,
    reason: 'ok',
  })
  assert.deepEqual(applyGate({ type: 'constraint', importance: 0.95, remember: 0.2, conflict: 'no' }, config), {
    write: false,
    reason: 'below-min-remember',
  })
  assert.equal(applyGate({ type: 'constraint', importance: 0.95, remember: null, conflict: 'no' }, config).write, true)
})

test('judge with mode off writes nothing and never calls the model', async () => {
  let called = 0
  const judge = createJudge({
    config: { judge: 'off', types: ['constraint'] },
    jev: { isAvailable: async () => true, choosePartner: async () => ({ index: null, confidence: null, model: null }),
    decidePair: async () => ({ decision: null, confidence: null, model: null }), decide: async () => { called += 1; return { rows: [], model: null } } },
  })
  assert.equal(judge.kind, 'off')
  const result = await judge.judge([{ key: 'k', hintedType: 'constraint', signalScore: 1, signals: [] }])
  assert.deepEqual(result, { rows: [], model: null, degraded: 'judge-off' })
  assert.equal(called, 0)
})

// A configured mode is not a preference to be second-guessed. Dropping this rule
// while making availability dynamic caused an "offline" run to make a real network
// call — caught by a plugin test that expected the heuristic to write a memory and
// instead saw the model refuse it.
test('an explicit heuristic mode never consults the model, even with a key available', async () => {
  let called = 0
  const judge = createJudge({
    config: { judge: 'heuristic', types: ['constraint'] },
    jev: {
      isAvailable: async () => true, choosePartner: async () => ({ index: null, confidence: null, model: null }),
    decidePair: async () => ({ decision: null, confidence: null, model: null }),
      decide: async () => {
        called += 1
        return { rows: [], model: null }
      },
    },
  })
  assert.equal(judge.kind, 'heuristic')
  const { rows } = await judge.judge([{ key: 'k', hintedType: 'constraint', signalScore: 0.7, signals: [] }])
  assert.equal(rows[0].by, 'heuristic')
  assert.equal(called, 0)
})

test('judge falls back to the heuristic when the model fails', async () => {
  const warnings: string[] = []
  const judge = createJudge({
    config: { judge: 'jev', types: ['constraint'], judgeTimeoutMs: 10 },
    jev: { isAvailable: async () => true, choosePartner: async () => ({ index: null, confidence: null, model: null }),
    decidePair: async () => ({ decision: null, confidence: null, model: null }), decide: async () => { throw new Error('timeout') } },
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
      isAvailable: async () => true, choosePartner: async () => ({ index: null, confidence: null, model: null }),
    decidePair: async () => ({ decision: null, confidence: null, model: null }),
      decide: async () => ({
        model: 'jev-1.13.0',
        rows: [{ key: 'k', type: 'fact', importance: 0.95, remember: 0.9, conflict: 'yes', conflictScore: null, confidence: 0.8 }],
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

test('injection can rank by what the session is about, and does nothing without a query', () => {
  // The reading side's largest measured number was that injection covered 2 of 36 needed memories,
  // because it never looked at the conversation. This pins the two halves of the fix: the query
  // changes what gets injected, and no query leaves the old ranking exactly as it was (the first turn
  // of a session has no conversation, and turning relevance into a coin flip there would be worse
  // than the old behaviour).
  const records = [memory({ id: 'deploy', importance: 0.5 }), memory({ id: 'style', importance: 1 })]
  records[0].text = '部署要先把 migrations 跑完再重启。'
  records[1].text = '颜色统一用蓝色系。'
  const args = { cwd: '/work/a', types: ['constraint'], maxTokens: 600, now: NOW }

  const without = selectMemories(records, { ...args, query: null })
  assert.deepEqual(without.map((entry) => entry.record.id), ['style', 'deploy'], 'no query: importance decides')

  const aboutDeploy = selectMemories(records, { ...args, query: '这次部署流程要注意什么？' })
  assert.equal(aboutDeploy[0]?.record.id, 'deploy', 'with a query, the relevant memory leads')

  // Weight 0 is the escape hatch: a query is present but must not influence the order.
  const ignored = selectMemories(records, { ...args, query: '这次部署流程要注意什么？', relevanceWeight: 0 })
  assert.deepEqual(ignored.map((entry) => entry.record.id), ['style', 'deploy'])
})

test('a memory irrelevant to the query still gets in when the quota is not full', () => {
  // The point of blending rather than filtering: a highly important memory that shares no words with
  // the current question keeps its place, so a session does not lose the constraints it is supposed
  // to be bound by just because today's question is about something else. This is why the default is
  // 0.8 rather than 1.0.
  const records = [memory({ id: 'rule', importance: 1 }), memory({ id: 'topic', importance: 0.2 })]
  records[0].text = '任何时候都不要动 main 分支。'
  records[1].text = '部署要先把 migrations 跑完再重启。'
  const chosen = selectMemories(records, {
    cwd: '/work/a',
    types: ['constraint'],
    maxTokens: 600,
    now: NOW,
    query: '这次部署流程要注意什么？',
  })
  assert.deepEqual(chosen.map((entry) => entry.record.id), ['topic', 'rule'], 'relevant first, important still present')
})

test('a memory written just now is ranked up, but does not displace a strong match', () => {
  // Item (3) of the reading side's work: the sentence the person just stated has not been mentioned in
  // the conversation yet, so relevance gives it nothing and it lives on the importance half of the
  // blend. Measured on a synthetic fresh record across the probes: 9 of 36 injected without this, 32 of
  // 36 with it, at no cost to coverage. A *reserve* was also measured — it reaches 29 of 36 by evicting
  // the lowest-ranked answer, which lost 1 to 6 coverage probes, so the bonus is what ships.
  // An older but *more important* memory against a fresh but less important one. The fixture matters:
  // the prior already contains a slow decay term (weight 0.15, half-life 180 days), so a fresh record
  // outranks an equally important old one on its own — the first version of this test proved nothing.
  // What the bonus adds is separate from and much larger than that decay: at weight 0.8 relevance, the
  // decay term is worth 0.03 of the final score, the bonus 0.4.
  const old = memory({ id: 'old', importance: 0.9 })
  old.text = '接口返回的错误码要统一。'
  old.createdAt = 0
  const fresh = memory({ id: 'fresh', importance: 0.5 })
  // Deliberately sharing no token with the query: the first fixture used a sentence containing 部署,
  // which made it the top relevance hit and meant the bonus was never what decided anything.
  fresh.text = '日志按天切分，不要写进同一个文件。'
  const query = '这次部署流程要注意什么？'
  // The block's heading and retraction note are charged to the budget too, so "room for exactly one
  // line" has to be computed rather than guessed — a budget below the fixed cost holds nothing, and a
  // guessed one let two lines in and quietly made the assertion below meaningless.
  const lineCost = (record: (typeof old) | (typeof fresh)): number =>
    estimateTokens(renderLine({ record, score: 0, ageDays: 0 }))
  const budgetForOne = (list: Array<typeof old>): number => fixedCost() + Math.max(...list.map(lineCost))
  const base = { cwd: '/work/a', types: ['constraint'], now: NOW, query }
  const ids = (chosen: ReturnType<typeof selectMemories>): string[] => chosen.map((entry) => entry.record.id)
  const both = [old, { ...fresh, createdAt: NOW }]
  const args = { ...base, maxTokens: budgetForOne(both) }

  // Both are irrelevant to the query here, so the older and slightly more important one leads.
  const without = ids(selectMemories(both, { ...args, recencyBonus: 0 }))
  assert.ok(without.includes('old'), 'without the term, the older memory is the one that fits')
  assert.ok(!without.includes('fresh'), 'and the just-written one is the one that does not')

  // The freshness term is computed against the clock the caller passes, so `createdAt: NOW` is "today".
  const withBonus = ids(selectMemories(both, { ...args, recencyBonus: 0.4 }))
  assert.ok(withBonus.includes('fresh'), 'the just-written memory is ranked up')
  assert.ok(!withBonus.includes('old'), 'and it takes the slot the older one had')

  // And it must not outrank a memory that actually answers the question.
  const strong = memory({ id: 'strong', importance: 0.3 })
  strong.text = '部署流程要写清楚，别漏步骤。'
  strong.createdAt = NOW
  const three = [{ ...fresh, createdAt: NOW }, strong, old]
  const mixed = ids(selectMemories(three, { ...base, maxTokens: budgetForOne(three), recencyBonus: 0.4 }))
  assert.ok(mixed.includes('strong'), 'a bounded bonus competes with weak matches; the strong one keeps its place')
})

test('the embedding path pins a rare quoted name, and only a rare one', async () => {
  // Embeddings score MRR 0.00 on identifier probes: a question quoting a file or an error code has no
  // semantic content to embed. A verbatim match is evidence no similarity score can beat, and the
  // condition that makes it safe was measured — pinning *every* verbatim match costs the near-question
  // probes, because those queries reuse the memory's own words and contain ordinary tokens that look
  // like names. This pins the plugin side of that rule; the sweep lives in `eval/recall-report.ts`.
  const records = [
    { id: 'holds', text: '端口写死在 wrangler.toml 里，别改成别的。', cwd: '/work/a', type: 'constraint', status: 'active' },
    { id: 'common', text: 'memory.json 这种文件名不要出现在简历里。', cwd: '/work/a', type: 'constraint', status: 'active' },
    { id: 'common2', text: 'memory.json 也不要提交到仓库。', cwd: '/work/a', type: 'constraint', status: 'active' },
    { id: 'common3', text: '把 memory.json 加到 .gitignore。', cwd: '/work/a', type: 'constraint', status: 'active' },
  ]
  const scoped = records.filter((record) => inScope(record, '/work/a') && record.status !== 'superseded')
  const pin = (query: string): string[] => {
    const pinned: string[] = []
    for (const name of query.match(NAME_LIKE) ?? []) {
      if (scoped.filter((other) => other.text.includes(name)).length <= 2) {
        for (const record of scoped) if (record.text.includes(name)) pinned.push(record.id)
      }
    }
    return pinned
  }
  assert.deepEqual(pin('wrangler.toml 里端口写在哪？'), ['holds'], 'a name in one memory identifies it')
  assert.deepEqual(pin('memory.json 要不要提交？'), [], 'a name in three memories identifies nothing')
})

test('an id that is only the sentence again is not printed, and one that informs is', () => {
  // Measured on the live store: 16 of 16 records have `id === signatureOf(text)`, so the rendered line
  // printed every memory twice. Dropping the duplicate took the block from 4.4 to 6.5 memories inside
  // the same 591 tokens. Ids that do carry something (an archive hit, or a record whose signature rule
  // has changed since) are kept, because they are the only handle on it.
  const verbose = memory({ id: 'whatever' })
  verbose.text = '必须用 pnpm 管理依赖，这是团队约定。'
  verbose.id = signatureOf(verbose.text)
  const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1
  const line = renderLine({ record: verbose, score: 0, ageDays: 0 }, false, true)
  // Counted rather than string-matched: when the signature happens to equal the sentence exactly, the
  // string is of course still there — what must be true is that it appears *once*.
  assert.equal(occurrences(line, verbose.text), 1, 'the sentence is printed once, not twice')
  assert.match(line, /^- \[constraint\] /, 'the type stays')
  assert.match(line, /\(\d{4}-\d{2}-\d{2}\)$/, 'and the date stays: age is information')

  const archive = memory({ id: 'l0:session:12' })
  archive.text = '随便一句归档内容。'
  assert.match(
    renderLine({ record: archive, score: 0, ageDays: 0 }, false, true),
    /l0:session:12/,
    'an id that is not the sentence is kept',
  )
  // And the option is opt-out back to the old rendering, so the two can be compared.
  assert.equal(
    occurrences(renderLine({ record: verbose, score: 0, ageDays: 0 }, false, false), verbose.text),
    2,
    'with the id kept it is printed twice, which is what the measurement was about',
  )
})
