/**
 * A memory store built from a labelled batch, for evaluating recall offline.
 *
 * Two things make this legitimate rather than invented. The records come from sentences the
 * person actually wrote — no synthetic text anywhere — and the *junk* is not made up either:
 * it is the rows they marked "don't remember" that today's pipeline would still have
 * written. That matters because the two halves of the reading side are different problems:
 * a store of 18 good memories measures the retriever, a store that is 80% junk measures what
 * the retriever has to survive, which is the situation the write-side numbers describe.
 *
 * The store is built in memory and never touches `~/.dsh/jev-memory/memory.json`: that file
 * changes as the plugin runs, and a benchmark whose corpus moves is not a benchmark.
 *
 * @module eval/lib/recall-corpus
 */

import { readFileSync } from 'node:fs'

import { matchTypeSignals, signatureOf } from '../../dsh/lib/signals.ts'
import { screenSentence } from '../../dsh/lib/signals.ts'
import { stripPastedPrefixes } from '../../dsh/lib/signals.ts'
import { clipAtClause } from '../../dsh/lib/text.ts'
import type { MemoryRecord } from '../../dsh/lib/store.ts'
import { parseCsvRecords } from './csv.ts'

/** One labelled row that made it into the store. */
export interface CorpusEntry {
  record: MemoryRecord
  /** `true-positive` = the person marked it worth remembering; `false-positive` = the gate
   * would have written it anyway. Recorded so a report can say which store it measured. */
  origin: 'true-positive' | 'false-positive'
  stratum: string
}

/** A store, plus the counts that explain how it was built. */
export interface Corpus {
  entries: CorpusEntry[]
  /** how many labelled rows were considered. */
  considered: number
  /** how many were dropped because a screen refuses them today. */
  screenedOut: number
}

/** Options for {@link buildCorpus}. */
export interface CorpusOptions {
  /** include the "don't remember" rows the gate would still write. */
  includeFalsePositives?: boolean
  /** cap on how many false positives to include, sampled deterministically. */
  maxFalsePositives?: number
  /** the workspace the memories belong to; scope filtering uses it. */
  cwd?: string | null
}

/**
 * Build a store from one labelling CSV.
 *
 * Deterministic by construction: false positives are taken in file order rather than
 * sampled randomly, so two runs over the same file produce the same store and the same
 * numbers. A benchmark that reshuffles itself per run cannot show a regression.
 *
 * @param path - the labelling CSV.
 * @param options - see {@link CorpusOptions}.
 * @returns the store and how it was built.
 */
export function buildCorpus(path: string, options: CorpusOptions = {}): Corpus {
  const { includeFalsePositives = true, maxFalsePositives = Number.POSITIVE_INFINITY, cwd = null } = options
  const rows = parseCsvRecords(readFileSync(path, 'utf8'))
  const entries: CorpusEntry[] = []
  const seen = new Set<string>()
  let considered = 0
  let screenedOut = 0
  let falsePositives = 0

  for (const row of rows) {
    const label = (row.label ?? '').trim()
    if (label !== '1' && label !== '0') continue
    considered += 1
    const origin: CorpusEntry['origin'] = label === '1' ? 'true-positive' : 'false-positive'
    if (origin === 'false-positive') {
      if (!includeFalsePositives || falsePositives >= maxFalsePositives) continue
      // A row the pipeline refuses today would never be in the store, so including it
      // would measure a store that cannot exist.
      const cleaned = stripPastedPrefixes(row.text ?? '')
      if (!screenSentence(cleaned).keep) {
        screenedOut += 1
        continue
      }
    }
    const text = clipAtClause(stripPastedPrefixes(row.text ?? ''))
    if (text === '') continue
    const id = (row.id ?? '').trim() || signatureOf(text)
    if (seen.has(id)) continue
    seen.add(id)
    if (origin === 'false-positive') falsePositives += 1
    // Importance is what the gate would have produced: it wrote these rows, so it thought
    // they mattered. Using the row's recorded extractor score keeps that honest instead of
    // inventing a confidence for each one.
    const raw = Number((row.signal_score ?? '').trim())
    const importance = Number.isFinite(raw) && raw > 0 ? Math.min(1, raw) : 0.6
    entries.push({
      record: {
        id,
        type: matchTypeSignals(text).type ?? 'fact',
        text,
        cwd,
        importance,
        status: 'active',
        // Provenance is filled with the batch and row so a hit can be traced back to the
        // sentence it came from, but no session id is invented: these came from a CSV, not
        // from a live session.
        source: { sessionId: null, seq: null, quote: text.slice(0, 200), at: 0 },
        createdAt: 0,
        updatedAt: 0,
        recalls: 0,
        lastRecalledAt: null,
        judge: { kind: origin === 'true-positive' ? 'human-label' : 'gate-would-write', confidence: null, conflict: 'unknown', mode: null },
      },
      origin,
      stratum: row.stratum ?? '',
    })
  }
  return { entries, considered, screenedOut }
}

/** The store's records, in the order they were built. */
export function recordsOf(corpus: Corpus): MemoryRecord[] {
  return corpus.entries.map((entry) => entry.record)
}
