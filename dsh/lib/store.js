/**
 * The memory store: one JSON document of memories plus an append-only JSONL
 * ledger, both under the plugin's own directory in the harness home.
 *
 * Why not `ctx.storageDomain` (the official schema-validated KV form)? It is
 * the right shape for product data, but it declares its tables with zod, and
 * this plugin is deliberately zero-dependency: a dependency-free module is
 * what lets the development copy mount straight from the workspace with
 * `--patch`, with no install step and no resolution surprises. The store is
 * kept behind a small port (`put`/`all`/`remove`) so a domain-backed
 * implementation can replace it without touching callers — see docs/DESIGN.md.
 *
 * Durability model: every mutation registers in memory first and then writes
 * the whole document atomically (temp file + rename), with writes serialized
 * through one promise chain so two callers can never interleave a rename.
 * Reads are always synchronous and from memory, which is what the prompt
 * assembler needs (its context callback cannot await).
 *
 * Known limitation: two harness processes writing the same file concurrently
 * last-write-wins. Single-process use is the supported case; a lock file is
 * the documented next step, not a silent assumption.
 *
 * @module dsh/lib/store
 */

import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { hashText, normalize } from './text.js'

/** On-disk document format version; bumped when the record shape changes. */
export const MEMORY_FILE_VERSION = 1

/** Memory types this plugin knows how to store. */
export const MEMORY_TYPES = ['constraint', 'pitfall', 'decision', 'preference', 'procedure', 'rejected', 'fact']

/**
 * @typedef {object} MemoryRecord
 * @property {string} id            stable content hash, also the dedup key.
 * @property {string} type          one of {@link MEMORY_TYPES}.
 * @property {string} text          the stored sentence, verbatim (clipped).
 * @property {string|null} cwd      workspace the memory belongs to; null = global.
 * @property {number} importance    0..1, produced by the judgement layer.
 * @property {'active'|'needs-review'} status  `needs-review` = suspected conflict.
 * @property {object} source        provenance: session, seq, quote, when.
 * @property {number} createdAt     epoch ms.
 * @property {number} updatedAt     epoch ms.
 * @property {number} recalls       how many times it entered an injected recall.
 * @property {number|null} lastRecalledAt  epoch ms of the last injection.
 * @property {object} judge         which judge produced the labels and how sure it was.
 */

/**
 * Create a store rooted at `root`. Nothing touches the disk until {@link MemoryStore.load}.
 *
 * @param {object} options - store options.
 * @param {string} options.root - directory holding `memory.json` and `ledger.jsonl`.
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @param {(level: string, message: string, detail?: unknown) => void} [options.log] - host logger.
 * @returns {MemoryStore} the store handle.
 */
export function createMemoryStore({ root, now = Date.now, log = () => {} }) {
  return new MemoryStore({ root, now, log })
}

/** In-memory index over one JSON document, with a serialized atomic writer. */
export class MemoryStore {
  /** @type {string} */
  #root
  /** @type {() => number} */
  #now
  /** @type {(level: string, message: string, detail?: unknown) => void} */
  #log
  /** @type {Map<string, MemoryRecord>} keyed by record id (a signature hash). */
  #records = new Map()
  /** @type {Promise<unknown>} serializes every disk mutation. */
  #chain = Promise.resolve()
  #loaded = false
  #flushCount = 0

  constructor({ root, now, log }) {
    this.#root = root
    this.#now = now
    this.#log = log
  }

  /** @returns {string} the directory holding this store's files. */
  get root() {
    return this.#root
  }

  /** @returns {boolean} whether {@link load} completed (even if it started empty). */
  get ready() {
    return this.#loaded
  }

  /**
   * Read the document from disk. A missing file is a normal first run; a
   * corrupt file is moved aside rather than throwing, because a memory plugin
   * must never be the reason the host fails to boot.
   *
   * @returns {Promise<{loaded: number, recovered: boolean}>} load outcome.
   */
  async load() {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    const file = this.#file()
    let recovered = false
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      for (const record of parsed?.records ?? []) {
        const normal = normalizeRecord(record, this.#now())
        if (normal) this.#index(normal)
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') {
        recovered = true
        const backup = `${file}.corrupt-${this.#now()}`
        this.#log('warn', 'memory document unreadable; starting empty and keeping a backup', {
          file,
          backup,
          error: String(error),
        })
        await rename(file, backup).catch(() => {})
      }
    }
    this.#loaded = true
    return { loaded: this.#records.size, recovered }
  }

  /** @returns {MemoryRecord[]} every live record, newest first. */
  all() {
    return [...this.#records.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * @param {string} id - record id.
   * @returns {MemoryRecord|undefined} the record, if present.
   */
  get(id) {
    return this.#records.get(id)
  }

  /**
   * @param {string} id - signature key produced by `signatureOf`.
   * @returns {boolean} whether a live record already covers that signature.
   */
  has(id) {
    return this.#records.has(id)
  }

  /**
   * Insert or replace one record. Replacing preserves the recall counters so a
   * re-stated memory (say, a constraint the user repeats) does not lose its
   * history, while `updatedAt` records the restatement.
   *
   * @param {MemoryRecord} record - the record to persist.
   * @returns {Promise<MemoryRecord>} the stored record.
   */
  async put(record) {
    const existing = this.#records.get(record.id)
    const next = existing
      ? { ...record, createdAt: existing.createdAt, recalls: existing.recalls, lastRecalledAt: existing.lastRecalledAt }
      : record
    this.#unindex(record.id)
    this.#index(next)
    await this.#persist()
    return next
  }

  /**
   * Remove one record permanently.
   *
   * @param {string} id - record id.
   * @returns {Promise<boolean>} whether a record was removed.
   */
  async remove(id) {
    if (!this.#records.has(id)) return false
    this.#unindex(id)
    await this.#persist()
    return true
  }

  /**
   * Remove every record matching a predicate.
   *
   * @param {(record: MemoryRecord) => boolean} predicate - selection.
   * @returns {Promise<MemoryRecord[]>} the removed records.
   */
  async removeWhere(predicate) {
    const removed = []
    for (const record of this.all()) {
      if (predicate(record)) {
        this.#unindex(record.id)
        removed.push(record)
      }
    }
    if (removed.length > 0) await this.#persist()
    return removed
  }

  /**
   * Record that memories were injected. Kept in memory only between flushes:
   * recall counters are bookkeeping, not user data worth a synchronous write
   * on every model step.
   *
   * @param {string[]} ids - recalled record ids.
   * @returns {void}
   */
  noteRecalled(ids) {
    if (ids.length === 0) return
    const at = this.#now()
    for (const id of ids) {
      const record = this.#records.get(id)
      if (!record) continue
      record.recalls += 1
      record.lastRecalledAt = at
    }
    this.#flushCount += 1
    if (this.#flushCount % 20 === 0) void this.#persist()
  }

  /**
   * Append one audit line. The ledger is append-only and never rewritten, so
   * it survives document corruption and stays greppable.
   *
   * @param {object} entry - ledger entry; `kind` is required by convention.
   * @returns {Promise<void>} resolves once the line is durable.
   */
  async ledger(entry) {
    const line = `${JSON.stringify({ t: this.#now(), ...entry })}\n`
    this.#chain = this.#chain
      .then(() => mkdir(this.#root, { recursive: true, mode: 0o700 }))
      .then(() => appendFile(this.#ledgerFile(), line, { mode: 0o600 }))
      .catch((error) => {
        this.#log('warn', 'ledger append failed', { error: String(error) })
      })
    return this.#chain
  }

  /** @returns {Record<string, number>} per-type counts of live records. */
  stats() {
    /** @type {Record<string, number>} */
    const byType = {}
    let needsReview = 0
    let recalls = 0
    for (const record of this.#records.values()) {
      byType[record.type] = (byType[record.type] ?? 0) + 1
      if (record.status === 'needs-review') needsReview += 1
      recalls += record.recalls
    }
    return { total: this.#records.size, byType, needsReview, recalls }
  }

  /**
   * Wait for every queued disk mutation. Used by tests and by the plugin's
   * disposer so a stop never drops an accepted write.
   *
   * @returns {Promise<void>} resolves when the write chain is idle.
   */
  async flush() {
    await this.#chain
  }

  #file() {
    return join(this.#root, 'memory.json')
  }

  #ledgerFile() {
    return join(this.#root, 'ledger.jsonl')
  }

  /** @param {MemoryRecord} record */
  #index(record) {
    this.#records.set(record.id, record)
  }

  /** @param {string} id */
  #unindex(id) {
    this.#records.delete(id)
  }

  /** Queue one whole-document atomic write. */
  #persist() {
    const document = JSON.stringify(
      {
        version: MEMORY_FILE_VERSION,
        writtenAt: this.#now(),
        records: this.all(),
      },
      null,
      2,
    )
    const file = this.#file()
    this.#chain = this.#chain
      .then(() => mkdir(dirname(file), { recursive: true, mode: 0o700 }))
      .then(() => writeFile(`${file}.tmp`, document, { mode: 0o600 }))
      .then(() => rename(`${file}.tmp`, file))
      .catch((error) => {
        this.#log('warn', 'memory document write failed', { file, error: String(error) })
      })
    return this.#chain
  }
}

/**
 * Coerce one parsed record into the current shape, dropping unusable entries.
 *
 * Tolerant on purpose: a hand-edited memory file is a supported workflow, so
 * an unknown type becomes `fact` and a missing status becomes `active` rather
 * than discarding a memory the user curates by hand.
 *
 * @param {any} record - parsed record.
 * @param {number} now - clock fallback.
 * @returns {MemoryRecord|null} the normalized record, or null when unusable.
 */
export function normalizeRecord(record, now) {
  if (!record || typeof record !== 'object') return null
  const text = normalize(record.text)
  if (!text) return null
  const type = MEMORY_TYPES.includes(record.type) ? record.type : 'fact'
  const createdAt = Number.isFinite(record.createdAt) ? Number(record.createdAt) : now
  return {
    id: typeof record.id === 'string' && record.id ? record.id : hashText(text),
    type,
    text,
    cwd: typeof record.cwd === 'string' && record.cwd ? record.cwd : null,
    importance: clamp01(record.importance),
    status: record.status === 'needs-review' ? 'needs-review' : 'active',
    source: {
      sessionId: record.source?.sessionId ?? null,
      seq: Number.isFinite(record.source?.seq) ? record.source.seq : null,
      quote: normalize(record.source?.quote ?? ''),
      at: Number.isFinite(record.source?.at) ? record.source.at : createdAt,
    },
    createdAt,
    updatedAt: Number.isFinite(record.updatedAt) ? Number(record.updatedAt) : createdAt,
    recalls: Number.isFinite(record.recalls) ? Number(record.recalls) : 0,
    lastRecalledAt: Number.isFinite(record.lastRecalledAt) ? Number(record.lastRecalledAt) : null,
    judge: {
      kind: record.judge?.kind ?? 'unknown',
      confidence: Number.isFinite(record.judge?.confidence) ? Number(record.judge.confidence) : null,
      conflict: record.judge?.conflict ?? 'unknown',
      mode: record.judge?.mode ?? null,
    },
  }
}

/**
 * @param {unknown} value - any number.
 * @returns {number} the value clamped into 0..1.
 */
export function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}
