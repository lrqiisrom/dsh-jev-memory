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

test('a call that reasons instead of answering is reported as such, not as an empty answer', async () => {
  // This is the shape that cost a real debugging round. On the route the plugin is handed, the model
  // thinks first and the thinking is streamed as `reasoning-delta`; if the budget runs out during it,
  // the text is empty and `finish` says `length`. The old reader kept neither field, so the ledger
  // said `empty` — a word that points at the prompt — for a call whose prompt was fine and whose
  // budget was the problem. Measured live: 9 of 12 `normalize` lines said exactly that.
  const settings = { ...NORMALIZE_DEFAULTS, provider: 'p', model: 'm' }
  const reasoningOnly = createNormalizer({
    llm: {
      stream: () =>
        (async function* () {
          yield { type: 'reasoning-delta', text: '先想一下……'.repeat(60) }
          yield { type: 'finish', reason: 'length' }
        })(),
    },
    settings,
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await reasoningOnly.normalize('端口固定 8000'), null)
  assert.equal(reasoningOnly.lastReason(), 'truncated')

  // And the reasoning must never be treated as the answer: the same stream with `stop` has no text at
  // all, so it is `empty` rather than a canonical form built from the model's notes.
  const reasoningStopped = createNormalizer({
    llm: {
      stream: () =>
        (async function* () {
          yield { type: 'reasoning-delta', text: '服务端口固定为 8000。' }
          yield { type: 'finish', reason: 'stop' }
        })(),
    },
    settings,
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await reasoningStopped.normalize('端口固定 8000'), null)
  assert.equal(reasoningStopped.lastReason(), 'empty')
})

test('every structured call asks for thinking to be off', async () => {
  // Not a style preference: on a reasoning route the thinking tokens come out of the same budget, and
  // measured on `deepseek-flash` that was the difference between 2/6 and 4/6 valid segmentations, and
  // between a median 3623ms and 596ms on the write call. Pinned per call so a future call site cannot
  // quietly omit it.
  const seen: Array<Record<string, unknown>> = []
  const settings = { ...NORMALIZE_DEFAULTS, provider: 'p', model: 'm' }
  const normalizer = createNormalizer({
    llm: {
      stream: (options) => {
        seen.push(options as unknown as Record<string, unknown>)
        return (async function* () {
          yield { type: 'text-delta', text: '服务端口固定为 8000。' }
          yield { type: 'finish', reason: 'stop' }
        })()
      },
    },
    settings,
    resolveRoute: async () => ({ provider: 'p', model: 'm' }),
  })
  await normalizer.normalize('端口固定 8000')
  assert.equal(seen[0]?.reasoningEffort, 'off')
})
