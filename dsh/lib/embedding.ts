/**
 * An embedding client, for ranking memories by meaning rather than by words.
 *
 * Why this exists as a *separate, optional* path: BM25 (see `conflict.ts`) is lexical,
 * so it scores a paraphrase near zero — "data 下的文件别碰" and "不要改动 data/ 目录"
 * share almost no tokens. The person running this plugin asked whether embeddings
 * would be more reliable, and for that specific failure they are. The cost is not the
 * request, it is everything around it: a provider, a key, a cache of derived vectors,
 * and the stored sentences leaving the machine.
 *
 * So the design keeps three separations sharp:
 *
 *  - **Ranking, not deciding.** A vector says "these two are about the same thing". It
 *    cannot say whether they agree: "端口用 8000" and "端口改成 9000" are near-identical
 *    and incompatible. The judgement stays with the model or the person.
 *  - **Derived, not authoritative.** Vectors live in their own file and can be thrown
 *    away; the memories do not depend on them. This is the one thing worth copying from
 *    memsearch, whose markdown files are canonical and whose Milvus index is disposable.
 *  - **Optional, not required.** With no key, a failing provider, or a timeout, the
 *    caller falls back to BM25. A write hook that cannot rank must still write.
 *
 * Verified live against the provider on 2026-09-29: OpenAI-compatible response
 * (`data[].embedding`), `dimensions` honoured, 2 inputs in 0.34s, 0.5 CNY per million
 * tokens (this corpus is roughly 30k tokens in total, about 0.015 CNY).
 *
 * @module dsh/lib/embedding
 */

import { createHash } from 'node:crypto'

/** Host logger signature, repeated per module so no module imports another for it. */
export type LogSink = (level: string, message: string, detail?: unknown) => void

/** Transport and vocabulary settings for the embedding provider. */
export interface EmbeddingSettings {
  baseUrl: string
  path: string
  model: string
  /** environment variable holding the bearer token. */
  apiKeyEnv: string
  /** base-url override variable, for a self-hosted gateway. */
  baseUrlEnv: string
  /** literal bearer token; takes precedence over the environment variable. */
  apiKey?: string
  /** vector size requested from the provider; must stay fixed per cache. */
  dimensions: number
  timeoutMs: number
  /** how many texts to send per request. */
  maxInputs: number
}

/** Defaults point at Zhipu BigModel's `embedding-3`, which handles Chinese well. */
export const EMBEDDING_DEFAULTS: Omit<EmbeddingSettings, 'apiKey'> = {
  baseUrl: 'https://open.bigmodel.cn',
  path: '/api/paas/v4/embeddings',
  model: 'embedding-3',
  apiKeyEnv: 'ZHIPU_API_KEY',
  baseUrlEnv: 'ZHIPU_BASE_URL',
  dimensions: 512,
  // Deliberately below the turn-end budget (2500ms) and the judge budget (1800ms):
  // ranking is an optimisation, and the write must not wait on it.
  timeoutMs: 1200,
  maxInputs: 32,
}

/** The port the plugin depends on; tests implement it without a network. */
export interface EmbeddingClient {
  /** asked per call, so a key added while the harness runs takes effect next turn. */
  isAvailable(): Promise<boolean>
  /**
   * Embed texts in order.
   *
   * @param texts - the texts to embed.
   * @returns one vector per text, or null when the provider could not answer.
   */
  embed(texts: string[]): Promise<number[][] | null>
  /** endpoint and credential state, for the mount log line. */
  describe(): Promise<{ ready: boolean; source: string; endpoint: string; model: string; dimensions: number }>
}

/**
 * Cosine similarity of two vectors.
 *
 * @param left - first vector.
 * @param right - second vector.
 * @returns similarity in -1..1, or 0 when either side has no magnitude.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  // Different lengths are refused rather than truncated. Comparing the first 512 of a
  // 1024-dimension vector against a 512-dimension one produces a confident, meaningless
  // number — the truncating version returned 1.0 for `[1, 2]` against `[1]`.
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (const [index, a] of left.entries()) {
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/**
 * The cache key for one text: the model and the vector size are part of it.
 *
 * Including them is what makes switching model or `dimensions` safe: every key misses
 * and the vectors are recomputed, instead of comparing a 512-dimension vector with a
 * 1024-dimension one and calling the result a similarity.
 *
 * @param settings - the provider settings in force.
 * @param text - the sentence.
 * @returns a stable hex key.
 */
export function vectorKey(settings: Pick<EmbeddingSettings, 'model' | 'dimensions'>, text: string): string {
  return createHash('sha256').update(`${settings.model}|${settings.dimensions}|${text}`).digest('hex').slice(0, 32)
}

/**
 * Build the embedding client.
 *
 * @param options - wiring: settings, a credential resolver, a logger, and a fetch.
 * @returns the client.
 */
export function createEmbeddingClient({
  config = {},
  log = () => {},
  resolveApiKey,
  fetchImpl = globalThis.fetch,
}: {
  config?: Partial<EmbeddingSettings>
  log?: LogSink
  /** resolves the bearer token per call; `source` is reported, never the token. */
  resolveApiKey: () => Promise<{ key: string | undefined; source: string }>
  fetchImpl?: typeof fetch
}): EmbeddingClient {
  const env = typeof process === 'undefined' ? undefined : process.env
  const settings: EmbeddingSettings = { ...EMBEDDING_DEFAULTS, ...config }
  const baseUrl = config.baseUrl || env?.[settings.baseUrlEnv] || settings.baseUrl
  const endpoint = new URL(settings.path, baseUrl).href

  return {
    async isAvailable() {
      try {
        return Boolean((await resolveApiKey()).key) && typeof fetchImpl === 'function'
      } catch {
        return false
      }
    },

    async describe() {
      const resolved = await resolveApiKey().catch(() => ({ key: undefined, source: 'unresolved' }))
      return {
        ready: Boolean(resolved.key) && typeof fetchImpl === 'function',
        source: resolved.key ? resolved.source : 'missing',
        endpoint,
        model: settings.model,
        dimensions: settings.dimensions,
      }
    },

    async embed(texts) {
      if (texts.length === 0) return []
      const resolved = await resolveApiKey()
      if (!resolved.key || typeof fetchImpl !== 'function') return null
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, settings.timeoutMs)
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${resolved.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: settings.model,
            input: texts.slice(0, settings.maxInputs),
            dimensions: settings.dimensions,
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          log('warn', 'embedding provider refused the request', { status: response.status, endpoint })
          return null
        }
        const body: unknown = await response.json()
        const data = (body as { data?: unknown })?.data
        if (!Array.isArray(data)) {
          log('warn', 'embedding response had no data array', { endpoint })
          return null
        }
        // Order by `index`: the provider documents the array as index-addressed, and
        // trusting array order would silently pair a vector with the wrong sentence.
        const ordered = [...data].sort(
          (left, right) =>
            Number((left as { index?: number })?.index ?? 0) - Number((right as { index?: number })?.index ?? 0),
        )
        const vectors: number[][] = []
        for (const entry of ordered) {
          const vector = (entry as { embedding?: unknown })?.embedding
          if (!Array.isArray(vector) || vector.some((value) => typeof value !== 'number')) return null
          vectors.push(vector as number[])
        }
        return vectors.length === texts.length ? vectors : null
      } catch (error) {
        log('warn', 'embedding request failed; ranking falls back to lexical', { error: String(error) })
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * A derived vector cache on disk.
 *
 * Separate from the memory document on purpose: it is rebuildable, it is not user
 * data, and a provider or dimension change must be able to discard it without
 * touching what the person said.
 *
 * @param options - the file to use and a logger.
 * @returns get/set/persist over a plain map.
 */
export function createVectorCache({
  file,
  log = () => {},
  read,
  write,
}: {
  file: string
  log?: LogSink
  /** injected in tests; defaults to node:fs. */
  read?: (file: string) => Promise<string>
  write?: (file: string, text: string) => Promise<void>
}): {
  load: () => Promise<void>
  get: (key: string) => number[] | undefined
  set: (key: string, vector: number[]) => void
  persist: () => Promise<void>
  size: () => number
} {
  const vectors = new Map<string, number[]>()
  let loaded = false
  let dirty = false
  let chain: Promise<void> = Promise.resolve()

  const defaultRead = async (path: string): Promise<string> => {
    const { readFile } = await import('node:fs/promises')
    return readFile(path, 'utf8')
  }
  const defaultWrite = async (path: string, text: string): Promise<void> => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  }

  return {
    async load() {
      if (loaded) return
      loaded = true
      try {
        const parsed: unknown = JSON.parse(await (read ?? defaultRead)(file))
        const entries = (parsed as { vectors?: Record<string, number[]> })?.vectors
        if (entries && typeof entries === 'object') {
          for (const [key, vector] of Object.entries(entries)) {
            if (Array.isArray(vector) && vector.every((value) => typeof value === 'number')) {
              vectors.set(key, vector)
            }
          }
        }
      } catch {
        /* no cache yet, or unreadable: it is derived, so starting empty is correct */
      }
    },
    get: (key) => vectors.get(key),
    set: (key, vector) => {
      vectors.set(key, vector)
      dirty = true
    },
    size: () => vectors.size,
    async persist() {
      if (!dirty) return
      dirty = false
      const text = `${JSON.stringify({ version: 1, vectors: Object.fromEntries(vectors) })}\n`
      // Serialized like the store's writes, so two turns cannot interleave a write.
      chain = chain.then(async () => {
        try {
          await (write ?? defaultWrite)(file, text)
        } catch (error) {
          log('warn', 'could not persist the embedding cache', { error: String(error) })
        }
      })
      await chain
    },
  }
}
