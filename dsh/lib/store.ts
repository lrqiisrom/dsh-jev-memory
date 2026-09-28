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
 * Types: `MemoryRecord` and the JSONL ledger entry are described locally rather
 * than imported from the harness. The plugin is zero-dependency on purpose, and
 * the on-disk document is this module's own format — it has no host type to
 * borrow. Values read back from a hand-edited file arrive as `unknown` and are
 * narrowed with `asRecord` plus per-field coercion, never with `any`.
 *
 * @module dsh/lib/store
 */

import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { hashText, normalize } from './text.ts'

/** On-disk document format version; bumped when the record shape changes. */
export const MEMORY_FILE_VERSION = 1

/** Memory types this plugin knows how to store. */
export const MEMORY_TYPES: string[] = ['constraint', 'pitfall', 'decision', 'preference', 'procedure', 'rejected', 'fact']

/** Host logger signature, repeated per module so no module imports another for it. */
export type LogSink = (level: string, message: string, detail?: unknown) => void

/** Provenance of one memory: which session said it, at which seq, and the quote. */
export interface MemorySource {
  sessionId: string | null
  seq: number | null
  quote: string
  at: number
}

/** Which judge produced a record's labels, and how sure it was. */
export interface MemoryJudge {
  kind: string
  confidence: number | null
  conflict: string
  mode: string | null
  /**
   * The responding model id, when a model judged this row. Written into the
   * live record by the plugin; `normalizeRecord` does not carry it across a
   * reload, exactly as before this migration.
   */
  model?: string | null
}

/** One stored memory, in the shape the document on disk holds. */
export interface MemoryRecord {
  /** stable content hash, also the dedup key. */
  id: string
  /** one of `MEMORY_TYPES`. */
  type: string
  /** the stored sentence, verbatim (clipped). */
  text: string
  /** workspace the memory belongs to; null = global. */
  cwd: string | null
  /** 0..1, produced by the judgement layer. */
  importance: number
  /**
   * `needs-review` = suspected conflict, withheld from recall;
   * `superseded` = a human chose to replace it, kept for audit but never injected.
   */
  status: 'active' | 'needs-review' | 'superseded'
  /** provenance: session, seq, quote, when. */
  source: MemorySource
  /** epoch ms. */
  createdAt: number
  /** epoch ms. */
  updatedAt: number
  /** how many times it entered an injected recall. */
  recalls: number
  /** epoch ms of the last injection. */
  lastRecalledAt: number | null
  /** which judge produced the labels and how sure it was. */
  judge: MemoryJudge
}

/** One append-only ledger line; `kind` is required by convention. */
export type LedgerEntry = Record<string, unknown>

/** Per-type counts of live records. */
export interface StoreStats {
  total: number
  byType: Record<string, number>
  needsReview: number
  /** records a human chose to replace; kept for audit, never injected. */
  superseded: number
  recalls: number
}

/** Store construction options. */
export interface MemoryStoreOptions {
  /** directory holding `memory.json` and `ledger.jsonl`. */
  root: string
  /** clock, injectable for tests. */
  now?: () => number
  /** host logger. */
  log?: LogSink
}

/**
 * Read a value as a property bag, or `null` when it cannot be one.
 *
 * Local to this module on purpose: the plugin's file list is fixed, so a shared
 * guard module would add a file (and an export) the harness never asked for.
 *
 * @param value - any value.
 * @returns the value as a record, or null.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * Coerce a stored status into the current vocabulary.
 *
 * An unknown or missing value becomes `active`, matching the tolerant reading
 * the rest of `normalizeRecord` uses: a hand-edited document loses a state flag
 * rather than a memory.
 *
 * @param value - the stored status.
 * @returns one of the three known statuses.
 */
function normalizeStatus(value: unknown): MemoryRecord['status'] {
  return value === 'needs-review' || value === 'superseded' ? value : 'active'
}

/**
 * Create a store rooted at `root`. Nothing touches the disk until {@link MemoryStore.load}.
 *
 * @param options - store options.
 * @returns the store handle.
 */
export function createMemoryStore({ root, now = Date.now, log = () => {} }: MemoryStoreOptions): MemoryStore {
  return new MemoryStore({ root, now, log })
}

/** In-memory index over one JSON document, with a serialized atomic writer. */
export class MemoryStore {
  #root: string
  #now: () => number
  #log: LogSink
  /** keyed by record id (a signature hash). */
  #records = new Map<string, MemoryRecord>()
  /** serializes every disk mutation. */
  #chain: Promise<void> = Promise.resolve()
  /**
   * How many times each candidate signature has been observed, derived from the
   * ledger at load time and incremented as the plugin sees more.
   *
   * Derived from the ledger on purpose: "have I seen this failure before?" needs
   * to survive restarts, and the ledger already records every observation with
   * its signature id. Counting there costs no new schema and adds no second
   * source of truth that could disagree with the audit trail.
   */
  #observed = new Map<string, number>()
  /**
   * How many times each conflict question has been put to the human.
   *
   * Same derivation, same reason: the retry-after-a-timeout path needs to know
   * whether it already asked, and the ledger already says so. Without a bound the
   * plugin would re-ask the same unresolved question forever, which turns a
   * helpful prompt into nagging.
   */
  #asked = new Map<string, number>()
  #loaded = false
  #flushCount = 0

  constructor({ root, now, log }: { root: string; now: () => number; log: LogSink }) {
    this.#root = root
    this.#now = now
    this.#log = log
  }

  /** @returns the directory holding this store's files. */
  get root(): string {
    return this.#root
  }

  /** @returns whether {@link load} completed (even if it started empty). */
  get ready(): boolean {
    return this.#loaded
  }

  /**
   * Read the document from disk. A missing file is a normal first run; a
   * corrupt file is moved aside rather than throwing, because a memory plugin
   * must never be the reason the host fails to boot.
   *
   * @returns load outcome.
   */
  async load(): Promise<{ loaded: number; recovered: boolean }> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    const file = this.#file()
    let recovered = false
    try {
      const raw = await readFile(file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const records: unknown = asRecord(parsed)?.records ?? []
      // The assertion keeps the original failure mode exactly: a `records` value
      // that is not iterable throws right here, which is what routes a corrupt
      // document into the recovery branch below.
      for (const record of records as ReadonlyArray<unknown>) {
        const normal = normalizeRecord(record, this.#now())
        if (normal) this.#index(normal)
      }
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') {
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
    await this.#loadObservedCounts()
    return { loaded: this.#records.size, recovered }
  }

  /**
   * Rebuild the observation counts from the ledger.
   *
   * Failure here is harmless — the counts start empty and rebuild as the plugin
   * works — so it never propagates: a plugin that cannot count is still a plugin
   * that remembers.
   *
   * @returns nothing.
   */
  async #loadObservedCounts(): Promise<void> {
    try {
      const raw = await readFile(this.#ledgerFile(), 'utf8')
      for (const line of raw.split('\n')) {
        if (line === '') continue
        try {
          const entry: unknown = JSON.parse(line)
          const parsed = asRecord(entry)
          // Only the explicit `observed` lines count. Counting every line that
          // happens to carry an id would double-count one sighting — the hook logs
          // the observation and then the judgement outcome for the same signature —
          // and "seen twice" would quietly become "seen once".
          if (parsed?.kind === 'observed') {
            const id = parsed.id
            if (typeof id === 'string' && id !== '') this.#observed.set(id, (this.#observed.get(id) ?? 0) + 1)
            continue
          }
          if (parsed?.kind === 'conflict-ask') {
            const id = parsed.id
            if (typeof id === 'string' && id !== '') this.#asked.set(id, (this.#asked.get(id) ?? 0) + 1)
          }
        } catch {
          /* one unreadable line must not lose the rest of the counts */
        }
      }
    } catch {
      /* no ledger yet, or unreadable: counts start empty */
    }
  }

  /**
   * How many times this signature was seen before now.
   *
   * @param id - the candidate signature.
   * @returns the recorded observation count, or 0.
   */
  observedCount(id: string): number {
    return this.#observed.get(id) ?? 0
  }

  /**
   * Record one observation, so a later occurrence can tell it is a repeat.
   *
   * @param id - the candidate signature.
   * @returns nothing.
   */
  noteObserved(id: string): void {
    this.#observed.set(id, (this.#observed.get(id) ?? 0) + 1)
  }

  /**
   * How many times a conflict question was already asked about this record.
   *
   * @param id - the incoming record's id.
   * @returns the recorded ask count, or 0.
   */
  askedCount(id: string): number {
    return this.#asked.get(id) ?? 0
  }

  /**
   * Record that a conflict question was just asked.
   *
   * The ledger line is written anyway, but the in-memory count has to move at the
   * same moment — otherwise a retry in the same process would read 0 and refuse to
   * resume the very question it just asked.
   *
   * @param id - the incoming record's id.
   * @returns nothing.
   */
  noteAsked(id: string): void {
    this.#asked.set(id, (this.#asked.get(id) ?? 0) + 1)
  }

  /** @returns every live record, newest first. */
  all(): MemoryRecord[] {
    return [...this.#records.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * @param id - record id.
   * @returns the record, if present.
   */
  get(id: string): MemoryRecord | undefined {
    return this.#records.get(id)
  }

  /**
   * @param id - signature key produced by `signatureOf`.
   * @returns whether a live record already covers that signature.
   */
  has(id: string): boolean {
    return this.#records.has(id)
  }

  /**
   * Insert or replace one record. Replacing preserves the recall counters so a
   * re-stated memory (say, a constraint the user repeats) does not lose its
   * history, while `updatedAt` records the restatement.
   *
   * @param record - the record to persist.
   * @returns the stored record.
   */
  async put(record: MemoryRecord): Promise<MemoryRecord> {
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
   * @param id - record id.
   * @returns whether a record was removed.
   */
  async remove(id: string): Promise<boolean> {
    if (!this.#records.has(id)) return false
    this.#unindex(id)
    await this.#persist()
    return true
  }

  /**
   * Remove every record matching a predicate.
   *
   * @param predicate - selection.
   * @returns the removed records.
   */
  async removeWhere(predicate: (record: MemoryRecord) => boolean): Promise<MemoryRecord[]> {
    const removed: MemoryRecord[] = []
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
   * @param ids - recalled record ids.
   * @returns nothing.
   */
  noteRecalled(ids: string[]): void {
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
   * @param entry - ledger entry; `kind` is required by convention.
   * @returns resolves once the line is durable.
   */
  async ledger(entry: LedgerEntry): Promise<void> {
    const line = `${JSON.stringify({ t: this.#now(), ...entry })}\n`
    this.#chain = this.#chain
      .then(() => mkdir(this.#root, { recursive: true, mode: 0o700 }))
      .then(() => appendFile(this.#ledgerFile(), line, { mode: 0o600 }))
      .catch((error) => {
        this.#log('warn', 'ledger append failed', { error: String(error) })
      })
    return this.#chain
  }

  /** @returns per-type counts of live records. */
  stats(): StoreStats {
    const byType: Record<string, number> = {}
    let needsReview = 0
    let superseded = 0
    let recalls = 0
    for (const record of this.#records.values()) {
      byType[record.type] = (byType[record.type] ?? 0) + 1
      if (record.status === 'needs-review') needsReview += 1
      if (record.status === 'superseded') superseded += 1
      recalls += record.recalls
    }
    return { total: this.#records.size, byType, needsReview, superseded, recalls }
  }

  /**
   * Wait for every queued disk mutation. Used by tests and by the plugin's
   * disposer so a stop never drops an accepted write.
   *
   * @returns resolves when the write chain is idle.
   */
  async flush(): Promise<void> {
    await this.#chain
  }

  #file(): string {
    return join(this.#root, 'memory.json')
  }

  #ledgerFile(): string {
    return join(this.#root, 'ledger.jsonl')
  }

  #index(record: MemoryRecord): void {
    this.#records.set(record.id, record)
  }

  #unindex(id: string): void {
    this.#records.delete(id)
  }

  /** Queue one whole-document atomic write. */
  #persist(): Promise<void> {
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
 * @param record - parsed record.
 * @param now - clock fallback.
 * @returns the normalized record, or null when unusable.
 */
export function normalizeRecord(record: unknown, now: number): MemoryRecord | null {
  const source = asRecord(record)
  if (!source) return null
  const text = normalize(source.text)
  if (!text) return null
  const type = typeof source.type === 'string' && MEMORY_TYPES.includes(source.type) ? source.type : 'fact'
  const createdAt = Number.isFinite(source.createdAt) ? Number(source.createdAt) : now
  const provenance = asRecord(source.source)
  const judge = asRecord(source.judge)
  const sessionId = provenance?.sessionId
  const judgeKind = judge?.kind
  const judgeConflict = judge?.conflict
  const judgeMode = judge?.mode
  // The four fields below are carried through exactly as the original did: only
  // `undefined`/`null` fall back, and a hand-edited file is a supported input,
  // so a document holding e.g. a numeric `sessionId` still round-trips. The
  // assertions describe the shape a well-formed document has; coercing with
  // `typeof` instead would have changed what `normalizeRecord` returns for a
  // malformed one.
  return {
    id: typeof source.id === 'string' && source.id ? source.id : hashText(text),
    type,
    text,
    cwd: typeof source.cwd === 'string' && source.cwd ? source.cwd : null,
    importance: clamp01(source.importance),
    status: normalizeStatus(source.status),
    source: {
      sessionId: (sessionId ?? null) as string | null,
      seq: Number.isFinite(provenance?.seq) ? Number(provenance?.seq) : null,
      quote: normalize(provenance?.quote ?? ''),
      at: Number.isFinite(provenance?.at) ? Number(provenance?.at) : createdAt,
    },
    createdAt,
    updatedAt: Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : createdAt,
    recalls: Number.isFinite(source.recalls) ? Number(source.recalls) : 0,
    lastRecalledAt: Number.isFinite(source.lastRecalledAt) ? Number(source.lastRecalledAt) : null,
    judge: {
      kind: (judgeKind ?? 'unknown') as string,
      confidence: Number.isFinite(judge?.confidence) ? Number(judge?.confidence) : null,
      conflict: (judgeConflict ?? 'unknown') as string,
      mode: (judgeMode ?? null) as string | null,
    },
  }
}

/**
 * @param value - any number.
 * @returns the value clamped into 0..1.
 */
export function clamp01(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}
