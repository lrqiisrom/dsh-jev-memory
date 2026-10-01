/**
 * Tests for the evaluation report.
 *
 * The report produces the headline numbers, so its arithmetic is worth pinning: a
 * precision that silently counts a duplicate row twice, or a screens arm that reads a
 * row's harvest-time verdict instead of today's rules, is a wrong number that looks
 * exactly like a right one.
 *
 * @module test/report
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = new URL('../eval/report.ts', import.meta.url).pathname
const HEADER = 'row,stratum,task_class,workspace,kind,hinted_type,signal_score,veto_reason,seen,id,text,label,note'

/** Run the report against a temporary label directory. */
function report(dir: string): { status: number | null; stdout: string; stderr: string } {
  // No credential, so the report cannot reach the network inside a test: with a key
  // in the ambient environment these tests made real judge calls, and the numbers
  // they assert on then depended on a model.
  const env: NodeJS.ProcessEnv = { ...process.env, REPORT_DIR: dir, REPORT_BATCHES: 'a.csv,b.csv', REPORT_REPEAT: '1' }
  delete env.TYPESAFE_API_KEY
  delete env.TYPESAFE_BASE_URL
  const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' })
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

const CODING = '/Users/rom/Documents/projectSDK'

test('counts one row per sentence across batches, without double counting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-report-'))
  try {
    // The same sentence sits in both batches, as it does when a label is carried from
    // round1 into a coding-only batch. Counting it twice once turned 9 positives into
    // 15 by adding a duplicate's worth of rows to every cell.
    const row = `1,coding-signal,coding,${CODING},user,constraint,0.8,,1,句子的签名,必须用 pnpm 管理依赖 不要用 npm,1,`
    await writeFile(join(dir, 'a.csv'), `${HEADER}\n${row}\n`, 'utf8')
    await writeFile(join(dir, 'b.csv'), `${HEADER}\n${row}\n`, 'utf8')
    const result = report(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /已标注 \*\*1\*\* 句/u)
    assert.match(result.stdout, /跨批次重复 1 行/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('re-screens rows with the rules in the working tree, not the ones that drew them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-report-'))
  try {
    // A transcript line drawn before the transcript screen existed is recorded as a
    // candidate. Read with the rules that drew it, the screens arm looks like it
    // writes garbage; read with today's rules it is correctly refused.
    const rows = [
      `${HEADER}`,
      `1,coding-signal,coding,${CODING},user,constraint,0.8,,1,id-a,必须用 pnpm 管理依赖 不要用 npm,1,`,
      `2,coding-signal,study,${CODING},user,constraint,0.8,,1,id-b,面试官:你之前说的那个方案我觉得还是可以再讨论一下,0,`,
    ].join('\n')
    await writeFile(join(dir, 'a.csv'), `${rows}\n`, 'utf8')
    await writeFile(join(dir, 'b.csv'), `${HEADER}\n`, 'utf8')
    const result = report(dir)
    assert.equal(result.status, 0, result.stderr)
    const report_ = await readFile(join(dir, 'report.md'), 'utf8')
    // One positive, one negative, and only the positive survives today's screens.
    // The row is asserted whole because the column layout carries the meaning: written /
    // right / wrong / missed / 写对率 / 该记覆盖率.
    assert.match(report_, /\| 只过筛子（当前规则） \| 1 \/ 2 \| 1 \| 0 \| 0 \| \*\*100%\*\* \| 100% \|/u)
    assert.match(report_, /两次筛子判定不同的行：1/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('keeps unsure rows out of every threshold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-report-'))
  try {
    const rows = [
      `${HEADER}`,
      `1,coding-signal,coding,${CODING},user,constraint,0.8,,1,id-a,必须用 pnpm 管理依赖 不要用 npm,1,`,
      `2,coding-signal,coding,${CODING},user,constraint,0.8,,1,id-b,这个方案要不要沉淀下来我还没想好,?,`,
    ].join('\n')
    await writeFile(join(dir, 'a.csv'), `${rows}\n`, 'utf8')
    await writeFile(join(dir, 'b.csv'), `${HEADER}\n`, 'utf8')
    const result = report(dir)
    assert.equal(result.status, 0, result.stderr)
    // Reported, and excluded: a `?` is where the standard itself is ambiguous, so
    // counting it either way would tune a threshold on a coin flip.
    assert.match(result.stdout, /拿不准的 1 行/u)
    assert.match(result.stdout, /合计\*\* \| 1 \| 0 \| \*\*100%\*\* \| 1 \|/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
