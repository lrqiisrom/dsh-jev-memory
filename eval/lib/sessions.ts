/**
 * Reading DSH session logs, and putting a labelled row back into its conversation.
 *
 * Three separate needs turned out to be one: checking whether a sentence is the model's own words
 * (that is a comparison against the same session's earlier assistant messages), measuring whether a
 * wider window improves the judgement, and reconstructing the window a segmentation decision saw.
 * All three need the same thing — a session's messages, and the position a labelled row came from —
 * and a second copy of this reader would be a second chance to get the event shape wrong.
 *
 * The shape, verified against a live log rather than assumed:
 * `{ type: 'user/message', seq, time, data: { content: [...], source: { kind }, role, id } }`.
 *
 * @module eval/lib/sessions
 */

import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { EXTRACT_DEFAULTS, extractCandidates } from '../../dsh/lib/extract.ts'
import { signatureOf } from '../../dsh/lib/signals.ts'

/** One message, with the position it held in its session. */
export interface SessionMessage {
  seq: number
  /** `user`, `assistant`, or an injected kind such as `session-reference`. */
  role: string
  text: string
  /** epoch ms from the event, when the log carries one. */
  time: number | null
}

/** One session, ready to be asked about a row. */
export interface Session {
  id: string
  messages: SessionMessage[]
  /** extractor id → the message it came from, so a labelled row can be located. */
  keyToSeq: Map<string, number>
}

/** Read one multi-frame zstd log through the CLI the harvester already depends on. */
export function readLog(path: string): string {
  const result = spawnSync('zstdcat', [path], { maxBuffer: 1024 * 1024 * 512, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout ?? '') : ''
}

/** The text blocks of a content array, joined and trimmed. */
function textOf(content: unknown): string {
  return Array.isArray(content)
    ? content
        .map((block) =>
          (block as { type?: string; text?: string })?.type === 'text' ? String((block as { text?: string }).text ?? '') : '',
        )
        .join('\n')
        .trim()
    : ''
}

/**
 * Parse one session log into messages plus the extractor ids it produced.
 *
 * @param raw - the decompressed log.
 * @param id - the session id, for the returned record.
 * @returns the session.
 */
export function parseSession(raw: string, id: string): Session {
  const messages: SessionMessage[] = []
  const keyToSeq = new Map<string, number>()
  let turn: Array<{ seq: number; type: string; data: unknown }> = []
  // **Session-global**, not per-turn. Resetting it at every `turn/start` looked harmless and was
  // not: `seq` is used to find a message again (`messages.findIndex(m => m.seq === seq)`), and a
  // number that repeats once per turn finds the *first* turn's message instead of the row's. That
  // is why the echo detector reported 0 of 28 — it was comparing each row against the wrong part of
  // the conversation. The live plugin already numbers events session-globally (`session.seq`), so
  // this also brings the evaluation back in line with what the plugin records.
  let seq = 0

  const flush = (): void => {
    if (turn.length === 0) return
    const candidates = extractCandidates(turn as never, {
      ...EXTRACT_DEFAULTS,
      onVeto: (sentence, _reason, vetoSeq) => keyToSeq.set(signatureOf(sentence), vetoSeq ?? 0),
    })
    for (const candidate of candidates) keyToSeq.set(candidate.key, candidate.seq)
    turn = []
  }

  for (const line of raw.split('\n')) {
    if (line === '') continue
    let event: { type?: string; data?: unknown }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const type = event.type ?? ''
    if (type === 'session' || type === 'turn/start' || type === 'turn/end') {
      flush()
      continue
    }
    // The extractor walks the turn's events, not the line stream. Forgetting to fill this is a
    // silent zero — the first version of the window script scanned 48 sessions, produced no
    // candidates and reported "no windows recovered" with no hint why.
    turn.push({ seq, type, data: event.data })
    const data = event.data as { source?: { kind?: string }; content?: unknown; message?: { content?: unknown } } | null
    const time = typeof (event as { time?: unknown }).time === 'number' ? (event as { time: number }).time : null
    if (type === 'user/message') {
      const text = textOf(data?.content)
      const kind = data?.source?.kind
      if (text !== '') messages.push({ seq, role: typeof kind === 'string' && kind !== '' ? kind : 'user', text, time })
    } else if (type === 'assistant/message') {
      const text = textOf(data?.message?.content)
      if (text !== '') messages.push({ seq, role: 'assistant', text, time })
    }
    seq += 1
  }
  flush()
  return { id, messages, keyToSeq }
}

/** Every session log under the harness home, newest generation per session, child sessions skipped. */
export async function readSessions(options: { max?: number; includeChildren?: boolean } = {}): Promise<Session[]> {
  const root = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sessions')
  const files: Array<{ file: string; id: string }> = []
  for (const workspace of await readdir(root)) {
    let ids: string[] = []
    try {
      ids = await readdir(join(root, workspace))
    } catch {
      continue
    }
    for (const id of ids) {
      const dir = join(root, workspace, id)
      let entries: string[] = []
      try {
        entries = await readdir(dir)
      } catch {
        continue
      }
      const logs = entries.filter((name) => name.startsWith('session') && name.endsWith('.jsonl.zstd')).sort()
      const best = logs[logs.length - 1]
      if (best) files.push({ file: join(dir, best), id })
    }
  }
  const out: Session[] = []
  for (const file of files) {
    if (options.max !== undefined && out.length >= options.max) break
    const raw = readLog(file.file)
    if (raw === '') continue
    // A delegated child's "user" message is the parent agent's own prompt, so judging those would
    // mean judging words the person never wrote. Same rule as the harvester. `includeChildren` is
    // for the one question that needs the opposite: whether a sentence the person pasted came from a
    // subagent's *output*, which lives in the child session and nowhere else.
    if (!options.includeChildren)
    try {
      const head: unknown = JSON.parse(raw.slice(0, raw.indexOf('\n')))
      if (((head as { delegationDepth?: number } | null)?.delegationDepth ?? 0) > 0) continue
    } catch {
      /* a log without a readable header is treated as a normal session */
    }
    out.push(parseSession(raw, file.id))
  }
  return out
}

/** The messages around one position: the window ending at `seq`, oldest first. */
export function windowEndingAt(session: Session, seq: number, size: number): SessionMessage[] {
  const at = session.messages.findIndex((message) => message.seq === seq)
  if (at < 0) return []
  return session.messages.slice(Math.max(0, at - size + 1), at + 1)
}

/** Everything the same session said *before* this position, for the attribution question. */
export function earlierMessages(session: Session, seq: number): SessionMessage[] {
  const at = session.messages.findIndex((message) => message.seq === seq)
  return at < 0 ? [] : session.messages.slice(0, at)
}
