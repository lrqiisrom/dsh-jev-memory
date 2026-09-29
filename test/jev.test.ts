import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createJudge } from '../dsh/lib/judge.ts'
import { REMEMBER_QUESTION, buildRequestBody, createJevClient } from '../dsh/lib/jev.ts'

const CANDIDATE = { key: 'k', text: '必须用 pnpm 管理依赖。', hintedType: 'constraint', signalScore: 0.7, signals: [] }

test('the key is resolved per call, host credentials first', async () => {
  const seen: string[] = []
  const client = createJevClient({
    config: { model: 'jev-latest' },
    env: {},
    resolveApiKey: async () => {
      seen.push('host')
      return 'from-credentials'
    },
    fetchImpl: (async (_url: string, init: { headers: Record<string, string> }) => {
      assert.equal(init.headers.authorization, 'Bearer from-credentials')
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: { 'remember:0': { type: 'noul', noul: 0.9 }, 'type:0': { type: 'choice', choice: 'constraint', confidence: 0.9 } },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch,
  })

  assert.equal(await client.isAvailable(), true)
  const result = await client.decide({ candidates: [CANDIDATE], types: ['constraint'] })
  assert.equal(result.model, 'jev-1.13.0')
  assert.equal(result.rows[0].remember, 0.9)
  // resolved twice: once for availability, once for the call — never cached
  assert.deepEqual(seen, ['host', 'host'])
})

test('the environment is the fallback when no credential service is wired', async () => {
  const client = createJevClient({ config: { model: 'jev-latest' }, env: { TYPESAFE_API_KEY: 'from-env' } })
  assert.equal(await client.isAvailable(), true)
  assert.equal(await createJevClient({ env: {} }).isAvailable(), false)
})

test('a failing credential lookup degrades to the environment instead of throwing', async () => {
  const client = createJevClient({
    env: { TYPESAFE_API_KEY: 'from-env' },
    resolveApiKey: async () => {
      throw new Error('service down')
    },
  })
  assert.equal(await client.isAvailable(), true)
})

// The behaviour a user expects when they paste a key into the settings UI while the
// harness is running: the very next turn uses it, with no restart.
test('judge auto mode picks up a credential that appears after mount', async () => {
  let available = false
  const judge = createJudge({
    config: { judge: 'auto', types: ['constraint'] },
    jev: {
      isAvailable: async () => available, choosePartner: async () => ({ index: null, confidence: null, model: null }),
      decide: async () => ({
        model: 'jev-1.13.0',
        rows: [{ key: 'k', type: 'constraint', importance: 0.9, remember: 0.9, conflict: 'no', confidence: 0.9 }],
      }),
    },
  })
  assert.equal((await judge.judge([CANDIDATE])).rows[0].by, 'heuristic')
  available = true
  assert.equal((await judge.judge([CANDIDATE])).rows[0].by, 'jev')
})

test('an unavailable credential service never breaks a judgement', async () => {
  const judge = createJudge({
    config: { judge: 'heuristic', types: ['constraint'] },
    jev: {
      isAvailable: async () => {
        throw new Error('no service')
      },
      choosePartner: async () => ({ index: null, confidence: null, model: null }),
      decide: async () => {
        throw new Error('must not be called')
      },
    },
  })
  const { rows, degraded } = await judge.judge([CANDIDATE])
  assert.equal(rows[0].by, 'heuristic')
  assert.equal(rows[0].remember, null)
  assert.equal(degraded, null)
})

test('the gate question asks about lifetime, not about grammar', () => {
  // The first wording asked whether the sentence was "用户对项目的说法或偏好（不是这一次
  // 任务的操作指令）" — a question about the sentence's form. The model answered it
  // correctly and refused imperative sentences, including standing preferences that
  // happen to be phrased as commands ("我要求你说设计是怎么设计的…就说流程就行了",
  // scored 0.14). The wording now asks whether the content still applies later, and
  // says outright that the imperative form is not the test.
  assert.match(REMEMBER_QUESTION, /以后\*\*新的会话\*\*里是否仍然适用或成立/u)
  assert.match(REMEMBER_QUESTION, /句子是以指令的形式说的并不影响判断/u)
  assert.doesNotMatch(REMEMBER_QUESTION, /不是这一次任务的操作指令/u)

  // And it travels: a caller that swaps it gets its own text asked.
  const body = buildRequestBody({
    model: 'jev-test',
    candidates: [{ key: 'k', text: '改成"一条消息 → 一串任务"', hintedType: 'decision', signalScore: 0.7, signals: [] }],
    types: ['constraint'],
    known: [],
    importanceLevels: ['不重', '重'],
    rememberQuestion: 'SENTINEL QUESTION',
  })
  // `instructions` is either a plain string or the official object form that names
  // state fields by backtick; the object form is what this code path sends.
  const asked = body.questions['remember:0']?.instructions
  assert.equal(typeof asked === 'object' ? asked.question : asked, 'SENTINEL QUESTION')
})
