/**
 * Tests for the optional embedding path.
 *
 * The properties that matter here are not "does it retrieve well" (that needs labelled
 * data) but "can it be trusted not to break a write": order, failure, and the boundary
 * between derived vectors and the memories themselves.
 *
 * @module test/embedding
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cosineSimilarity,
  createEmbeddingClient,
  createVectorCache,
  vectorKey,
} from '../dsh/lib/embedding.ts'

test('cosine similarity is 1 for the same direction and 0 for none', () => {
  // Floating point, so the comparison is approximate: the property that matters is
  // direction, and 1 - 2e-16 is the same direction.
  const close = (actual: number, expected: number): void => {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should be within 1e-9 of ${expected}`)
  }
  close(cosineSimilarity([1, 0], [1, 0]), 1)
  close(cosineSimilarity([1, 0], [0, 1]), 0)
  close(cosineSimilarity([1, 1], [2, 2]), 1)
  close(cosineSimilarity([0, 0], [1, 2]), 0)
  assert.equal(cosineSimilarity([1, 2], [1]), 0, 'a dimension mismatch is refused, not truncated')
})

test('the cache key carries the model and the dimensions', () => {
  const base = { model: 'embedding-3', dimensions: 512 }
  assert.equal(vectorKey(base, '端口用 8000'), vectorKey(base, '端口用 8000'))
  // Switching model or size must miss every key: comparing a 512-dimension vector
  // with a 1024-dimension one and calling it a similarity is the failure this avoids.
  assert.notEqual(vectorKey(base, '端口用 8000'), vectorKey({ ...base, dimensions: 1024 }, '端口用 8000'))
  assert.notEqual(vectorKey(base, '端口用 8000'), vectorKey({ ...base, model: 'other' }, '端口用 8000'))
})

/** A fetch stub that records the requests it was given. */
function stubFetch(
  handler: (body: { input: string[] }) => { status?: number; json?: unknown; throws?: boolean },
): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: { input: string[] }; authorization: string }> } {
  const calls: Array<{ url: string; body: { input: string[] }; authorization: string }> = []
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = init as { body: string; headers: Record<string, string> }
    const body = JSON.parse(request.body) as { input: string[] }
    calls.push({ url: String(url), body, authorization: request.headers.authorization ?? '' })
    const outcome = handler(body)
    if (outcome.throws) throw new Error('network down')
    return {
      ok: (outcome.status ?? 200) < 400,
      status: outcome.status ?? 200,
      json: async () => outcome.json,
    }
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

test('vectors come back in input order even when the provider reorders them', async () => {
  // The provider documents `data` as index-addressed. Trusting array order would pair
  // a vector with the wrong sentence, which is worse than failing: the ranking would
  // look confident and be wrong.
  const { fetchImpl } = stubFetch(() => ({
    json: {
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    },
  }))
  const client = createEmbeddingClient({ resolveApiKey: async () => ({ key: 'k', source: 'test' }), fetchImpl })
  assert.deepEqual(await client.embed(['第一句', '第二句']), [
    [1, 0],
    [0, 1],
  ])
})

test('the client reports what it is and never the token', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ json: { data: [{ index: 0, embedding: [1] }] } }))
  const client = createEmbeddingClient({
    config: { model: 'embedding-3', dimensions: 512, maxInputs: 2 },
    resolveApiKey: async () => ({ key: 'secret-token', source: 'file' }),
    fetchImpl,
  })
  const described = await client.describe()
  assert.equal(described.ready, true)
  assert.equal(described.source, 'file')
  assert.equal(described.model, 'embedding-3')
  assert.equal(described.dimensions, 512)
  assert.doesNotMatch(JSON.stringify(described), /secret-token/u, 'the token is never reported')

  await client.embed(['a', 'b', 'c'])
  assert.deepEqual(calls[0]?.body.input, ['a', 'b'], 'maxInputs caps the request')
  assert.equal(calls[0]?.authorization, 'Bearer secret-token')
})

test('every failure returns null rather than throwing', async () => {
  const options = { resolveApiKey: async () => ({ key: 'k', source: 'test' }) }
  const refused = stubFetch(() => ({ status: 429 }))
  assert.equal(await createEmbeddingClient({ ...options, fetchImpl: refused.fetchImpl }).embed(['x']), null)

  const broken = stubFetch(() => ({ throws: true }))
  assert.equal(await createEmbeddingClient({ ...options, fetchImpl: broken.fetchImpl }).embed(['x']), null)

  const malformed = stubFetch(() => ({ json: { data: 'nope' } }))
  assert.equal(await createEmbeddingClient({ ...options, fetchImpl: malformed.fetchImpl }).embed(['x']), null)

  const short = stubFetch(() => ({ json: { data: [{ index: 0, embedding: [1] }] } }))
  assert.equal(await createEmbeddingClient({ ...options, fetchImpl: short.fetchImpl }).embed(['a', 'b']), null)

  const noKey = createEmbeddingClient({
    resolveApiKey: async () => ({ key: undefined, source: 'missing' }),
    fetchImpl: refused.fetchImpl,
  })
  assert.equal(await noKey.isAvailable(), false)
  assert.equal(await noKey.embed(['x']), null)
})

test('the vector cache round-trips and survives a corrupt file', async () => {
  let written = ''
  const cache = createVectorCache({
    file: '/tmp/whatever.json',
    read: async () => JSON.stringify({ version: 1, vectors: { k1: [1, 2] } }),
    write: async (_file, text) => {
      written = text
    },
  })
  await cache.load()
  assert.deepEqual(cache.get('k1'), [1, 2])
  assert.equal(cache.size(), 1)
  await cache.persist()
  assert.equal(written, '', 'an untouched cache writes nothing')

  cache.set('k2', [3])
  await cache.persist()
  assert.match(written, /"k2":\[3\]/u)

  const corrupt = createVectorCache({
    file: '/tmp/corrupt.json',
    read: async () => {
      throw new Error('not json')
    },
    write: async () => {},
  })
  await corrupt.load()
  assert.equal(corrupt.size(), 0, 'derived data that cannot be read starts empty, it does not fail the turn')
})
