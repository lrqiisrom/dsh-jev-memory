/**
 * Tests for the canonical-form pass.
 *
 * The interesting property is not "does it clean text well" — that is a model question —
 * but "can it be prevented from inventing anything", which is a code question.
 *
 * @module test/normalize
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  acceptCanonical,
  buildNormalizePrompt,
  createNormalizer,
  NORMALIZE_DEFAULTS,
  type LlmStreamPort,
} from '../dsh/lib/normalize.ts'

const LIMITS = { maxRatio: NORMALIZE_DEFAULTS.maxRatio, minOverlap: NORMALIZE_DEFAULTS.minOverlap }

test('a cleaned rendering of the same sentence is accepted', () => {
  const input = '嗯那个啥 就是 端口别乱改啊 定了 8000'
  assert.equal(acceptCanonical(input, '服务端口固定为 8000，不要修改。', LIMITS), '服务端口固定为 8000，不要修改。')
  // Quotes and labels around the answer are handled rather than rejected.
  assert.equal(acceptCanonical(input, '「服务端口固定为 8000，不要修改。」', LIMITS), '服务端口固定为 8000，不要修改。')
  assert.equal(acceptCanonical(input, '整理后：服务端口固定为 8000，不要修改。', LIMITS), '服务端口固定为 8000，不要修改。')
})

test('an answer that adds information is refused, not trimmed', () => {
  const input = '端口别乱改啊 定了 8000'
  // The gate is about new content: a form that shares too few of its tokens with the
  // sentence is a rewrite, and a rewrite is where fabrication enters.
  assert.equal(acceptCanonical(input, '为了避免部署冲突，服务端口固定为 8000，并且需要在网关同步放行。', LIMITS), null)
  // Length is the cruder version of the same check.
  assert.equal(acceptCanonical(input, '端口'.repeat(80), LIMITS), null)
})

test('refusals and no-ops are refused', () => {
  const input = '端口固定 8000'
  assert.equal(acceptCanonical(input, '', LIMITS), null)
  assert.equal(acceptCanonical(input, '抱歉，我无法整理这句话。', LIMITS), null)
  assert.equal(acceptCanonical(input, '端口固定 8000', LIMITS), null, 'unchanged means nothing to store')
})

test('the normalizer collects the stream, and the prompt forbids adding facts', async () => {
  let seen = ''
  const llm: LlmStreamPort = {
    stream: (options) => {
      seen = options.messages[0]?.content[0]?.text ?? ''
      return (async function* () {
        yield { type: 'text-delta', text: '服务端口' }
        yield { type: 'text-delta', text: '固定为 8000，不要修改。' }
        yield { type: 'finish' }
      })()
    },
  }
  const normalizer = createNormalizer({
    llm,
    settings: { ...NORMALIZE_DEFAULTS, provider: 'p', model: 'm' },
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  const result = await normalizer.normalize('那个 端口 别改 8000')
  assert.equal(result?.text, '服务端口固定为 8000，不要修改。')
  assert.equal(result?.model, 'm')
  assert.match(seen, /绝对不能添加原句里没有的信息/u)
  assert.match(buildNormalizePrompt('原句内容'), /原句内容/u)
})

test('every failure keeps the verbatim sentence and reports nothing', async () => {
  const settings = { ...NORMALIZE_DEFAULTS, provider: 'p', model: 'm' }
  const noRoute = createNormalizer({ llm: undefined, settings, resolveRoute: async () => ({ provider: 'p', model: 'm' }) })
  assert.equal(await noRoute.normalize('端口固定 8000'), null, 'no llm service, no canonical form')

  const unresolved = createNormalizer({
    llm: { stream: () => (async function* () {})() },
    settings,
    resolveRoute: async () => null,
  })
  assert.equal(await unresolved.normalize('端口固定 8000'), null, 'no route, no canonical form')

  const throwing = createNormalizer({
    llm: {
      stream: () => {
        throw new Error('provider down')
      },
    },
    settings,
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await throwing.normalize('端口固定 8000'), null, 'a failure never invents text')

  // With injection on but recording off there is no route either: the flag that decides
  // whether the form is *used* must not switch the feature on.
  const disabled = createNormalizer({
    llm: { stream: () => (async function* () {})() },
    settings: { ...settings, enabled: false },
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await disabled.route(), null)
})
