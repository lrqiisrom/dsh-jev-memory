import assert from 'node:assert/strict'
import { test } from 'node:test'

import { blocksToText, clip, estimateTokens, hashText, looksInterrogative, normalize, splitSentences } from '../dsh/lib/text.ts'
import { isNoise, matchTypeSignals, screenSentence, signatureOf } from '../dsh/lib/signals.ts'

test('blocksToText keeps only text blocks', () => {
  const content = [
    { type: 'reasoning', text: 'internal thinking' },
    { type: 'text', text: '必须用 pnpm。' },
    { type: 'tool-call', name: 'bash' },
  ]
  assert.equal(blocksToText(content), '必须用 pnpm。')
  assert.equal(blocksToText('plain'), 'plain')
  assert.equal(blocksToText(undefined), '')
})

test('splitSentences splits CJK and latin prose and keeps the terminator', () => {
  assert.deepEqual(splitSentences('必须用 pnpm。不要用 npm！'), ['必须用 pnpm。', '不要用 npm！'])
  assert.deepEqual(splitSentences('one. two?'), ['one.', 'two?'])
  assert.deepEqual(splitSentences('第一行\n第二行'), ['第一行', '第二行'])
})

test('clip and normalize collapse whitespace and bound length', () => {
  assert.equal(normalize('  a \n  b  '), 'a b')
  assert.equal(clip('x'.repeat(10), 5).length, 5)
  assert.ok(clip('x'.repeat(10), 5).endsWith('…'))
})

test('hashText folds case so restatements dedup', () => {
  assert.equal(hashText('必须用 PNPM'), hashText('必须用 pnpm'))
})

test('looksInterrogative separates questions from statements', () => {
  assert.equal(looksInterrogative('为什么必须用 pnpm？'), true)
  assert.equal(looksInterrogative('必须用 pnpm。'), false)
  assert.equal(looksInterrogative('why must we use pnpm'), true)
})

// The second live false positive: a question with no question mark, starting with
// a URL, was stored as a `constraint`.
test('looksInterrogative catches Chinese questions without a question mark', () => {
  assert.equal(looksInterrogative('这个 dsh 的插件难道只能用 js 写吗'), true)
  assert.equal(
    looksInterrogative('https://github.com/zilliztech/memsearch 参考这个吧 我看这个插件的语言都是 python 多一点，这个 dsh 的插件难道只能用 js 写吗'),
    true,
  )
  assert.equal(looksInterrogative('必须用 pnpm 吗'), true)
  assert.equal(looksInterrogative('这个方案是不是更好'), true)
  assert.equal(looksInterrogative('我们是不是该换个思路'), true)
  assert.equal(looksInterrogative('必须用 pnpm 管理依赖，这是团队约定。'), false)
  assert.equal(looksInterrogative('不要改动 data/ 目录下的任何文件。'), false)
})

test('estimateTokens over-counts CJK and never returns zero for text', () => {
  assert.equal(estimateTokens('中文四个字'), 5)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens(''), 0)
})

test('matchTypeSignals picks the most specific family first', () => {
  assert.equal(matchTypeSignals('必须用 pnpm 而不是 npm').type, 'constraint')
  assert.equal(matchTypeSignals('这个命令会报错').type, 'pitfall')
  assert.equal(matchTypeSignals('我们决定用 SQLite').type, 'decision')
  assert.equal(matchTypeSignals('今天天气不错').type, null)
})

test('isNoise drops acknowledgements only', () => {
  assert.equal(isNoise('好的'), true)
  assert.equal(isNoise('继续'), true)
  assert.equal(isNoise('必须用 pnpm'), false)
})

test('signatureOf collapses ids, numbers and paths for dedup', () => {
  assert.equal(
    signatureOf('read 失败：ENOENT: /a/b/c.txt at 12345'),
    signatureOf('read 失败：ENOENT: /a/d/e.txt at 99999'),
  )
  assert.notEqual(signatureOf('read 失败：EPERM'), signatureOf('bash 失败：EPERM'))
})

// These three sentences are the real false positives from the first live run:
// a delegated child's task prompt was written as `constraint` memories.
test('screenSentence rejects task instructions that the type signals matched', () => {
  assert.deepEqual(screenSentence('请严格按下面步骤操作，不要做任何额外的事。'), { keep: false, reason: 'task-instruction' })
  assert.deepEqual(screenSentence('把第 2、3 步两个工具调用返回的原始结果（JSON 或文本，原样）贴出来，不要改写、不要总结成自己的话。'), {
    keep: false,
    reason: 'task-instruction',
  })
  assert.equal(screenSentence('回复一行：TOOLS AVAILABLE 或 TOOLS UNAVAILABLE。').keep, false)
  assert.equal(screenSentence('先看你当前可用的工具列表里是否有 memory_write 工具。').keep, false)
})

test('screenSentence rejects serialized tool calls and code payloads', () => {
  assert.deepEqual(screenSentence('调用 `memory_write`，参数：{"text": "语言不要选 Java", "type": "constraint"}'), {
    keep: false,
    reason: 'payload',
  })
  assert.equal(screenSentence('配置长这样：```yaml\n- id: x\n```').keep, false)
})

test('screenSentence keeps real constraints that look imperative', () => {
  for (const sentence of [
    '必须用 pnpm 管理依赖，这是团队约定。',
    '不要改动 data/ 目录下的任何文件。',
    '这个命令会清空缓存，注意别在生产库上跑。',
    '我们决定用 SQLite 而不是 Postgres，因为只在自己机器上跑。',
  ]) {
    assert.deepEqual(screenSentence(sentence), { keep: true, reason: null }, sentence)
  }
})
