/**
 * Tests for the evaluation harvester.
 *
 * These are not tests of the plugin; they guard the two properties that make the
 * labelled evaluation set worth anything, both of which failed once for real:
 *
 *  - **A session log is read whichever generation it is.** The first version
 *    hard-coded `session.v3.jsonl.zstd`, so the 8 un-migrated sessions on this
 *    machine were invisible and the corpus was silently 10% smaller than reported.
 *  - **A re-run does not destroy labels.** Harvesting is repeatable and the corpus
 *    grows every day, so a second run over a bigger pool must keep the rows a
 *    person already labelled. The old sampler shuffled with one PRNG stream and
 *    replaced 92.5% of the chosen rows when the pool grew by 13 — measured on a
 *    pool of the real size. The new one ranks each row independently, and if a
 *    label would still be lost the tool refuses to write at all.
 *
 * @module test/harvest
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

const SCRIPT = new URL('../eval/harvest-candidates.ts', import.meta.url).pathname
const CODING_WORKSPACE = '/Users/rom/Documents/projectSDK'

/** Write one synthetic session log, compressed the way the harness writes them. */
async function writeSession(home: string, id: string, cwd: string, sentences: string[]): Promise<void> {
  const dir = join(home, 'sessions', cwd.replaceAll('/', '-'), id)
  await mkdir(dir, { recursive: true })
  const events: unknown[] = [{ type: 'session', version: 3, id, cwd, delegationDepth: 0 }]
  let seq = 0
  for (const text of sentences) {
    events.push({ type: 'turn/start', seq: seq++ })
    events.push({
      type: 'user/message',
      seq: seq++,
      data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' },
    })
    events.push({ type: 'turn/end', seq: seq++ })
  }
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join('')
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
}

/** Run the harvester against a temporary harness home. */
function harvest(home: string, outDir: string): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DSH_HOME: home, HARVEST_OUT_DIR: outDir, HARVEST_OUT: 'round.csv' },
    encoding: 'utf8',
  })
  return { status: result.status, stderr: String(result.stderr ?? ''), stdout: String(result.stdout ?? '') }
}

/** The `id` column of a harvested CSV, which is the sentence's own signature. */
function idsOf(csv: string): string[] {
  const records = csv.trim().split('\n').slice(1)
  return records.map((record) => {
    const cells: string[] = []
    let cell = ''
    let quoted = false
    for (let index = 0; index < record.length; index += 1) {
      const char = record[index]
      if (quoted) {
        if (char !== '"') cell += char
        else if (record[index + 1] === '"') {
          cell += '"'
          index += 1
        } else quoted = false
      } else if (char === '"') quoted = true
      else if (char === ',') {
        cells.push(cell)
        cell = ''
      } else cell += char
    }
    cells.push(cell)
    // id is the eighth column: row,stratum,workspace,kind,hinted_type,veto_reason,seen,id,text…
    return cells[7] ?? ''
  })
}

const SENTENCES = [
  '这个项目里的语言不要选 Java，因为 DSH 的 Java Native 插件方案已经不考虑了',
  '数据库先做 sqlite，不上 postgres，改起来太麻烦而且部署也重',
  '这个仓库的测试必须用 node --test 跑，不要引入 jest，多一套依赖没必要',
]

test('harvests a labelled CSV and a corpus snapshot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jev-harvest-'))
  const out = await mkdtemp(join(tmpdir(), 'jev-out-'))
  try {
    await writeSession(home, 'session-a', CODING_WORKSPACE, SENTENCES)
    const first = harvest(home, out)
    assert.equal(first.status, 0, first.stderr)
    const csv = await readFile(join(out, 'round.csv'), 'utf8')
    assert.ok(idsOf(csv).length > 0, 'at least one candidate is expected')

    const snapshot = JSON.parse(await readFile(join(out, 'round.frame.json'), 'utf8')) as {
      logs: Record<string, number>
      sampler: string
      rowHashes: string[]
    }
    assert.equal(snapshot.logs.v3, 1, 'the v3 log is counted')
    assert.equal(snapshot.sampler, 'hash-rank-fnv1a')
    assert.equal(snapshot.rowHashes.length, idsOf(csv).length, 'the snapshot records every sampled row')
    assert.match(snapshot.rowHashes[0] ?? '', /^[0-9a-f]{16}$/u, 'in hashed form, so it can be committed')
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

test('reads a session that was never migrated to the versioned format', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jev-harvest-'))
  const out = await mkdtemp(join(tmpdir(), 'jev-out-'))
  try {
    // Generation 0: the file name carries no version suffix. This is the shape the
    // first harvester could not see at all.
    const dir = join(home, 'sessions', CODING_WORKSPACE.replaceAll('/', '-'), 'session-legacy')
    await mkdir(dir, { recursive: true })
    const events = [
      { type: 'session', version: 0, id: 'session-legacy', cwd: CODING_WORKSPACE, delegationDepth: 0 },
      { type: 'turn/start', seq: 0 },
      {
        type: 'user/message',
        seq: 1,
        data: { content: [{ type: 'text', text: SENTENCES[0] }], source: { kind: 'user' }, role: 'user' },
      },
      { type: 'turn/end', seq: 2 },
    ]
    const body = events.map((event) => `${JSON.stringify(event)}\n`).join('')
    await writeFile(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))

    const result = harvest(home, out)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /v0 1 个/u, 'the un-migrated log is read')
    assert.ok(idsOf(await readFile(join(out, 'round.csv'), 'utf8')).length > 0)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

test('a second run keeps the rows already chosen, and the labels on them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jev-harvest-'))
  const out = await mkdtemp(join(tmpdir(), 'jev-out-'))
  const outFile = join(out, 'round.csv')
  try {
    await writeSession(home, 'session-a', CODING_WORKSPACE, SENTENCES)
    assert.equal(harvest(home, out).status, 0)
    const before = idsOf(await readFile(outFile, 'utf8'))
    assert.ok(before.length > 0)

    // Label the first row the way a person would, then grow the corpus.
    const labelled = (await readFile(outFile, 'utf8'))
      .trimEnd()
      .split('\n')
      // Replace the empty label,note pair rather than appending after it: the
      // columns are positional, and a test that writes into the wrong one would
      // pass while the tool ignored the label.
      .map((record, index) => (index === 1 ? record.replace(/,,$/u, ',1,looks useful') : record))
      .join('\n')
    await writeFile(outFile, `${labelled}\n`, 'utf8')

    await writeSession(home, 'session-b', CODING_WORKSPACE, [
      '这个模块的日志一律走 pino，不要再自己包一层 console',
      '接口返回一律用 snake_case，前端已经按这个写好了，别改成 camelCase',
    ])
    const grown = harvest(home, out)
    assert.equal(grown.status, 0, grown.stderr)
    const after = idsOf(await readFile(outFile, 'utf8'))

    for (const id of before) {
      assert.ok(after.includes(id), `already-chosen row ${id} survived the corpus growing`)
    }
    assert.match(await readFile(outFile, 'utf8'), /,1,looks useful/u, 'the label moved with its row')
    assert.match(grown.stdout, /沿用已有标注 1\/1 行/u)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

test('refuses to write when a re-run would drop a label', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jev-harvest-'))
  const out = await mkdtemp(join(tmpdir(), 'jev-out-'))
  const outFile = join(out, 'round.csv')
  try {
    await writeSession(home, 'session-a', CODING_WORKSPACE, SENTENCES)
    assert.equal(harvest(home, out).status, 0)
    const labelled = (await readFile(outFile, 'utf8'))
      .trimEnd()
      .split('\n')
      // Replace the empty label,note pair rather than appending after it: the
      // columns are positional, and a test that writes into the wrong one would
      // pass while the tool ignored the label.
      .map((record, index) => (index === 1 ? record.replace(/,,$/u, ',1,looks useful') : record))
      .join('\n')
    await writeFile(outFile, `${labelled}\n`, 'utf8')

    // The session that carried the labelled sentence disappears, so the label has
    // nowhere to move to. Losing it silently is the one outcome this must not have.
    await rm(join(home, 'sessions', CODING_WORKSPACE.replaceAll('/', '-'), 'session-a'), { recursive: true })

    const refused = harvest(home, out)
    assert.equal(refused.status, 1, 'the run stops instead of overwriting')
    assert.match(refused.stderr, /不在样本里/u)
    assert.match(await readFile(outFile, 'utf8'), /,1,looks useful/u, 'the labelled file is untouched')
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})
