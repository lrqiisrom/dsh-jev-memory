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

import {appendFile, mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { signatureOf } from './signals.ts'
import { hashText, normalize } from './text.ts'

/** The placeholders a folded fingerprint leaves behind; see {@link rekeyLegacyIds}. */
const FOLD_MARKER = /<(?:n|str|path|code|hex)>/u

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
  id: string  /** one of `MEMORY_TYPES`. */
  type: string
  /** the stored sentence, verbatim (clipped). */
  text: string
  /** workspace the memory belongs to; null = global. */
  cwd: string | null
  /** 0..1, produced by the judgement layer. */
  importance: number
  /**
   * The record this one replaced, when a person answered a conflict with "use the new
   * one". Kept as a link rather than a deletion, on both sides.
   */
  supersedes?: string | null
  /** The record that replaced this one; set together with `status: 'superseded'`. */
  supersededBy?: string | null
  /**
   * A cleaned rendering of `text`, produced by a model, for injection.
   *
   * Derived, never authoritative: `text` is what the person said and stays the evidence.
   * Recomputed whenever `text` changes, which is why `canonicalAt` is compared against
   * `updatedAt` instead of being trusted.
   */
  canonical?: string | null
  /** which model produced the canonical form. */
  canonicalModel?: string | null
  /** when it was produced; older than `updatedAt` means stale. */
  canonicalAt?: number | null
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

/**
 * One archived message: the raw evidence layer.
 *
 * Everything the plugin sees is written here, unfiltered, including the assistant's own
 * messages. Two things depend on that. The first is recoverability: the promotion gate is a
 * judgement, judgements are wrong, and a memory system that deletes what it judged
 * uninteresting cannot revisit the decision — the labelled corpus said so directly, with 122
 * rows marked "don't remember" that the plugin had already thrown away and could not re-read
 * when the gate changed. The second is attribution: detecting that a memory is the model's
 * own words rather than the person's requires having the model's earlier words, and nothing
 * else records them.
 *
 * Deliberately not a `MemoryRecord`: an archive entry has no type, no importance and no
 * recall, because none of those are known yet. This is the input to a decision, not its
 * result.
 */
export interface L0Entry {
  /** the session that produced it, so a later pass can reconstruct the thread. */
  sessionId: string | null
  /** the event's sequence number inside that session. */
  seq: number | null
  /** `user`, `assistant`, or whatever the host called it. */
  role: string
  /** epoch ms of the message. */
  at: number
  /** workspace, for scope filtering on search. */
  cwd: string | null
  /** the text, complete. Not clipped: the archive is the evidence, and a clipped
   *  evidence layer is how the 240-character problem started. */
  text: string
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

/**
 * How many archived messages stay in memory for search.
 *
 * A number rather than "all of them" because the archive grows without bound by design, and a
 * prompt-time search that reads every file is a latency bug waiting for a long-running
 * install. The disk copy is complete; this is the searchable window.
 */
const ARCHIVE_MEMORY_LIMIT = 2000

/**
 * How many day files the searchable window covers.
 *
 * The date in the filename is what makes this a one-line rule instead of a scan — but only
 * because the files are named by day. Before this it read the newest file alone, which made the
 * search window look like a retention policy: a message from two days ago was on disk and
 * unfindable, and nothing said so. Seven days is a bound on prompt-time cost, not a claim about
 * what is worth keeping; the retention question (how long anything stays at all) is still open
 * and deliberately not answered by this constant.
 */
const ARCHIVE_SEARCH_DAYS = 7

/**
 * The id under which one archived message is addressable.
 *
 * Derived from where the message came from rather than from its position in the window, so an
 * id stays valid across restarts and after other entries are deleted. `seq` is stable within a
 * session and a session id is unique, which is exactly the pair a deletion needs.
 *
 * @param entry - the archived message.
 * @param index - its position, used only when the host gave no sequence number.
 * @returns the archive id.
 */
export function archiveId(entry: L0Entry, index = 0): string {
  return `l0:${entry.sessionId ?? '?'}:${entry.seq ?? index}`
}

/** In-memory index over one JSON document, with a serialized atomic writer. */
export class MemoryStore {
  #root: string
  #now: () => number
  #log: LogSink
  /** keyed by record id (a content hash; see {@link recordIdOf}). */
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
   * The tail of the archive, kept in memory so search can reach it.
   *
   * Bounded on purpose and the bound is stated rather than hidden: the full archive is on
   * disk as JSONL (that is the durable evidence), while this window is what
   * `memory_search` can find without reading every file on every query. A search that
   * silently covered only part of the archive would be worse than one that says how far
   * back it looks.
   */
  #archive: L0Entry[] = []
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
      const loaded: MemoryRecord[] = []
      // The assertion keeps the original failure mode exactly: a `records` value
      // that is not iterable throws right here, which is what routes a corrupt
      // document into the recovery branch below.
      for (const record of records as ReadonlyArray<unknown>) {
        const normal = normalizeRecord(record, this.#now())
        if (normal) loaded.push(normal)
      }
      // Legacy ids become content hashes on the way in, so every later reader sees one id scheme.
      // This is where it happens because the file is the only place the old scheme survives, and the
      // rewrite is left to the next ordinary persist rather than done here: a reader must not write.
      // Once that persist happens the file is hash-keyed, and the previous version of this plugin —
      // which looks records up by folded signature — would not find them.
      const { records: current, rekeyed, collisions } = rekeyLegacyIds(loaded)
      if (rekeyed > 0) this.#log('info', 're-keyed legacy ids to content hashes', { rekeyed })
      if (collisions.length > 0) {
        // Two records whose texts differ only in case or whitespace now want the same id. Reported
        // rather than silently merged: with the store keyed by id, silence here is a lost memory.
        this.#log('warn', 'records share an id after re-keying; one will be dropped', { collisions })
      }
      for (const record of current) this.#index(record)
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
    await this.#loadArchiveTail()
    return { loaded: this.#records.size, recovered }
  }

  /**
   * Read the newest archive day file into the searchable window.
   *
   * One file, not all of them: the window is for search at prompt time, and walking a year of
   * daily files to answer one query is the kind of cost that turns a helpful feature into a
   * latency complaint. Failure is logged and swallowed — a missing archive is not a reason to
   * refuse to start.
   */
  async #loadArchiveTail(): Promise<void> {
    try {
      const dir = this.#archiveDir()
      const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort()
      if (names.length === 0) return
      const entries: L0Entry[] = []
      for (const name of names.slice(-ARCHIVE_SEARCH_DAYS)) {
        const raw = await readFile(join(dir, name), 'utf8')
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue
          const parsed = asRecord(JSON.parse(line)) as unknown as L0Entry | null
          if (parsed && typeof parsed.text === 'string') entries.push(parsed)
        }
      }
      this.#archive = entries.slice(-ARCHIVE_MEMORY_LIMIT)
    } catch {
      // No archive yet, or unreadable: search simply reaches less far back.
    }
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
            // `signature`, not `id`: the counter is about the *shape* of a repeated failure, and the
            // record id it sits next to is a content hash that would make every near-identical failure
            // a new one. Older lines predate the field and kept the signature in `id`.
            const key = typeof parsed.signature === 'string' && parsed.signature !== '' ? parsed.signature : parsed.id
            if (typeof key === 'string' && key !== '') this.#observed.set(key, (this.#observed.get(key) ?? 0) + 1)
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
   * Mark a record as replaced by another, without deleting it.
   *
   * The question the person answers says the old memory is kept "for later reference".
   * Deleting it made that a lie, and the comment above the old code path claimed
   * `superseded` while calling `remove` — the record was gone and only its id survived
   * in the ledger. A superseded record keeps its text, loses `active`, and stops being
   * recalled or searched, which is what "no longer in use" should mean.
   *
   * @param id - the record being replaced.
   * @param byId - the record that replaces it, or null when nothing does.
   * @returns whether the record existed.
   */
  async supersede(id: string, byId: string | null = null): Promise<boolean> {
    const record = this.#records.get(id)
    if (!record) return false
    await this.put({ ...record, status: 'superseded', supersededBy: byId, updatedAt: this.#now() })
    return true
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

  /**
   * Append messages to the archive. Never rejects, never blocks a turn.
   *
   * The archive is the one layer that must not lose anything: it is what makes a wrong
   * promotion decision reversible. Failures are logged and swallowed for the same reason the
   * ledger's are — a full disk must not take the session down.
   *
   * @param entries - messages to archive, in order.
   * @returns resolves once the lines are durable.
   */
  async archive(entries: readonly L0Entry[]): Promise<void> {
    if (entries.length === 0) return
    for (const entry of entries) this.#archive.push(entry)
    if (this.#archive.length > ARCHIVE_MEMORY_LIMIT) {
      this.#archive.splice(0, this.#archive.length - ARCHIVE_MEMORY_LIMIT)
    }
    const byFile = new Map<string, string[]>()
    for (const entry of entries) {
      const file = this.#archiveFile(entry.at)
      const lines = byFile.get(file) ?? []
      lines.push(JSON.stringify(entry))
      byFile.set(file, lines)
    }
    this.#chain = this.#chain
      .then(() => mkdir(this.#archiveDir(), { recursive: true, mode: 0o700 }))
      .then(async () => {
        for (const [file, lines] of byFile) await appendFile(file, `${lines.join('\n')}\n`, { mode: 0o600 })
      })
      .catch((error) => {
        this.#log('warn', 'archive append failed', { error: String(error) })
      })
    return this.#chain
  }

  /**
   * Delete one archived message from disk as well as from the window.
   *
   * A real delete, not a tombstone, for the same reason `remove` is: the person asked for it
   * to be gone, and keeping a copy while saying otherwise is the lie this project refuses.
   * The archive is append-only for the *system's* writes; a human's deletion outranks that.
   *
   * The whole day file is rewritten because JSONL has no in-place delete and the files are
   * small by construction (one day of messages).
   *
   * @param id - an archive id of the form `l0:<sessionId>:<seq>`.
   * @returns whether anything was removed.
   */
  async forgetArchive(id: string): Promise<boolean> {
    const match = this.#archive.find((entry, index) => archiveId(entry, index) === id)
    if (!match) return false
    this.#archive = this.#archive.filter((entry, index) => archiveId(entry, index) !== id)
    const file = this.#archiveFile(match.at)
    this.#chain = this.#chain
      .then(async () => {
        let raw = ''
        try {
          raw = await readFile(file, 'utf8')
        } catch {
          return
        }
        // Match on session *and* sequence. Comparing the sequence alone deleted every message
        // that happened to share the number, including other sessions' — one character of
        // carelessness away from deleting a different conversation.
        const kept = raw
          .split('\n')
          .filter((line) => {
            if (line.trim() === '') return false
            const entry = asRecord(JSON.parse(line))
            return !(entry && entry.sessionId === match.sessionId && entry.seq === match.seq)
          })
        await writeFile(file, kept.length > 0 ? `${kept.join('\n')}\n` : '', { mode: 0o600 })
      })
      .catch((error) => {
        this.#log('warn', 'archive delete failed', { id, error: String(error) })
      })
    return true
  }

  /**
   * The archived messages search can reach, newest last.
   *
   * @param limit - how many of the newest to return.
   * @returns the messages, in chronological order.
   */
  recentArchive(limit = ARCHIVE_MEMORY_LIMIT): L0Entry[] {
    return this.#archive.slice(-limit)
  }

  /** How much of the archive is in memory, for the mount ledger line. */
  archiveStats(): { inMemory: number; dir: string; searchDays: number } {
    return { inMemory: this.#archive.length, dir: this.#archiveDir(), searchDays: ARCHIVE_SEARCH_DAYS }
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

  #archiveDir(): string {
    return join(this.#root, 'l0')
  }

  /** One file per day: greppable, and a day is a natural unit for a human reading back. */
  #archiveFile(at: number): string {
    return join(this.#archiveDir(), `${new Date(at).toISOString().slice(0, 10)}.jsonl`)
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
 * The id of a record, derived from the text it stores and from nothing else.
 *
 * Every writer must go through this, because `id` is the primary key: `put` looks the id up and
 * overwrites what it finds. An id computed from anything other than the stored text — a clipped
 * form, an unclipped form, a hint the model gave — means the next write of the same sentence
 * fails to find it and stores a second copy.
 *
 * @param text - the text that will be stored.
 * @returns the record id.
 */
export function recordIdOf(text: unknown): string {
  return hashText(text)
}

/**
 * Re-key every record whose id is not the content hash of its own text.
 *
 * Ids used to be `signatureOf(text)`, which folds digits, quotes, paths, backticks and hex runs to
 * `<n>`/`<str>`/`<path>`/`<code>`/`<hex>`. Folding is right for *similarity* — "端口用 3000" and
 * "端口用 3001" really are nearly the same sentence, and that is what the near-duplicate search
 * wants — and wrong for *identity*: as a primary key it made those two the same record, so the
 * second write silently overwrote the first and the card called that "覆盖了同内容的旧条目".
 * Six realistic pairs were checked and all six collided.
 *
 * A record is re-keyed when its id is *visibly a fingerprint of text*: it equals `signatureOf(text)`,
 * or it still contains a fold marker. Live data supplied the case that rules out the narrower
 * "equals the signature" test — one record's id was five characters *longer* than its own text,
 * because the id came from the hard-clipped identity while the stored text came from the
 * clause-boundary clip, and that id is neither a hash nor the signature of the text.
 *
 * The equally important half is what it does *not* touch. Re-keying everything that is "not the
 * content hash" also rewrites an id a person chose by hand in the file, and a hand-edited memory
 * file is a supported input. The narrow test leaves `k1` where the person put it.
 *
 * The limitation, stated rather than hidden: a stale id whose original text contained no digits,
 * quotes, paths, backticks or hex runs carries no marker and is left alone. Such a record is not
 * reachable by a lookup derived from its text. Nothing in the live store is in that state, and the
 * new write path cannot create one (an in-place update only happens when the id already matches).
 *
 * Namespaced ids are left alone: `l0:...` points at something outside the record (an archive day
 * file), so re-keying it would break the pointer rather than repair it. The test is the namespace
 * *prefix*, not "contains a colon" — a folded signature of ordinary text can contain one, and the
 * first version of this function skipped three live records for that reason (`reasoningeffort:
 * <str>` was enough to look namespaced).
 *
 * Cross-references are remapped along with the ids, or `supersedes`/`supersededBy` would point at
 * ids that no longer exist.
 *
 * @param records - normalized records, in file order.
 * @returns the re-keyed records, how many moved, and any new id that two records wanted.
 */
export function rekeyLegacyIds(records: readonly MemoryRecord[]): {
  records: MemoryRecord[]
  rekeyed: number
  collisions: string[]
} {
  const moved = new Map<string, string>()
  for (const record of records) {
    if (/^[a-z][a-z0-9]*:/u.test(record.id)) continue
    if (!FOLD_MARKER.test(record.id) && record.id !== signatureOf(record.text)) continue
    const next = recordIdOf(record.text)
    if (record.id !== next) moved.set(record.id, next)
  }
  if (moved.size === 0) return { records: [...records], rekeyed: 0, collisions: [] }

  const taken = new Map<string, number>()
  for (const record of records) {
    const next = moved.get(record.id) ?? record.id
    taken.set(next, (taken.get(next) ?? 0) + 1)
  }
  const collisions = [...taken.entries()].filter(([, count]) => count > 1).map(([id]) => id)

  const remap = (id: string | null | undefined): string | null =>
    typeof id === 'string' && moved.has(id) ? moved.get(id)! : (id ?? null)
  return {
    records: records.map((record) => ({
      ...record,
      id: moved.get(record.id) ?? record.id,
      supersedes: remap(record.supersedes),
      supersededBy: remap(record.supersededBy),
    })),
    rekeyed: moved.size,
    collisions,
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
    supersedes: typeof source.supersedes === 'string' ? source.supersedes : null,
    supersededBy: typeof source.supersededBy === 'string' ? source.supersededBy : null,
    canonical: typeof source.canonical === 'string' ? source.canonical : null,
    canonicalModel: typeof source.canonicalModel === 'string' ? source.canonicalModel : null,
    canonicalAt: Number.isFinite(source.canonicalAt) ? Number(source.canonicalAt) : null,
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
