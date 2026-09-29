/**
 * Reading the other two agents on this machine.
 *
 * The corpus is supposed to be what a person actually types at coding agents, and this
 * machine has three of them. DSH writes its own session logs, so those are read directly;
 * Codex and Cursor each keep a private, undocumented store, and this module turns both into
 * the same shape the DSH reader produces. One shape matters: the candidates then come from
 * the *same* extractor and the same screens, so a sentence is judged by one set of rules
 * rather than by whichever adapter happened to read it first.
 *
 * Two things both adapters are careful about, because both stores are version-dependent and
 * a parser that quietly returns nothing looks exactly like a store with nothing in it:
 *
 *  - **every skip is counted** by reason and reported, never swallowed;
 *  - **the first turn of a session carries the workspace**, taken from the store rather than
 *    inferred where the store provides it (Codex's `session_meta.cwd` does; Cursor's often
 *    does not, and that inference is counted separately).
 *
 * @module eval/lib/source
 */

import { spawnSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * A source-agnostic turn: the synthetic events the shared extractor consumes.
 *
 * Deliberately the same three event types the harness writes (`user/message`, `tool/call`,
 * `tool/result`) so nothing downstream needs to know which agent a turn came from.
 */
export interface SourceTurn {
  /** which agent wrote it. */
  source: 'dsh' | 'codex' | 'cursor'
  /** the session or conversation it belongs to. */
  sessionId: string
  /** the workspace, or null when the store does not say. */
  workspace: string | null
  events: Array<{ seq: number; type: string; data: unknown }>
}

/** What one adapter read, and what it refused to read. */
export interface SourceRead {
  turns: SourceTurn[]
  /** human messages seen, whether or not they became turns. */
  humanMessages: number
  /** skipped items by reason — the interesting half of an undocumented format. */
  skipped: Record<string, number>
}

/** Host-home-relative defaults, overridable so tests never touch the real stores. */
export interface SourcePaths {
  codex?: string
  cursorDb?: string
}

const CODEX_DEFAULT = `${homedir()}/.codex`
const CURSOR_DB_DEFAULT = `${homedir()}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`

/** Text wrapped in a Codex context tag is injected, never typed by a person. */
const CODEX_INJECTED = /^\s*<(environment_context|user_instructions|turn_context|system|world_state)/u

/**
 * Read Codex rollout logs.
 *
 * The format, as observed: a `session_meta` line carrying `cwd`, then `response_item` lines
 * for messages and `turn_context` lines that mark turn boundaries. Real human input is a
 * `response_item` whose payload is a `message` with `role: 'user'`; the agent's own injected
 * context arrives through the same door and is filtered out here, because treating it as a
 * person's words is the mistake this project has already made once.
 *
 * @param paths - where to look; defaults to the real Codex home.
 * @returns turns, the human-message count, and the skip accounting.
 */
export function readCodexTurns(paths: SourcePaths = {}): SourceRead {
  const root = paths.codex ?? CODEX_DEFAULT
  const files = globSync(`${root}/**/rollout-*.jsonl`)
  const skipped: Record<string, number> = {}
  const turns: SourceTurn[] = []
  let humanMessages = 0
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      bump('unreadable-rollout')
      continue
    }
    let sessionId = file.replace(/^.*rollout-|\.jsonl$/gu, '')
    let workspace: string | null = null
    let events: SourceTurn['events'] = []
    let seq = 0
    const flush = (): void => {
      if (events.some((event) => event.type === 'user/message')) {
        turns.push({ source: 'codex', sessionId, workspace, events })
      }
      events = []
      seq = 0
    }

    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let event: { type?: string; payload?: Record<string, unknown> }
      try {
        event = JSON.parse(line)
      } catch {
        bump('unparsable-line')
        continue
      }
      const payload = event.payload ?? {}
      if (event.type === 'session_meta') {
        if (typeof payload.cwd === 'string') workspace = payload.cwd
        if (typeof payload.id === 'string') sessionId = payload.id
        continue
      }
      if (event.type === 'turn_context') {
        // `turn_context` carries the cwd too, and it is where a turn actually begins.
        if (typeof payload.cwd === 'string') workspace = payload.cwd
        flush()
        continue
      }
      if (event.type !== 'response_item' || payload.role !== 'user') continue
      const blocks = Array.isArray(payload.content) ? payload.content : []
      const message = blocks
        .map((block) => (typeof (block as { text?: unknown })?.text === 'string' ? String((block as { text: string }).text) : ''))
        .join('\n')
        .trim()
      if (message === '') {
        bump('empty-message')
        continue
      }
      if (CODEX_INJECTED.test(message)) {
        bump('injected-context')
        continue
      }
      humanMessages += 1
      events.push({
        seq: seq++,
        type: 'user/message',
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: message }] },
      })
    }
    flush()
  }
  return { turns, humanMessages, skipped }
}

/** Path-shaped strings inside a Cursor bubble, used to infer the project. */
const PATH_PATTERN = /\/Users\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_. -]+){1,3}/gu

/** The two or three leading segments of a path, so every file in a project collapses to one key. */
function projectRoot(path: string): string {
  const parts = path.split('/').filter(Boolean)
  // /Users/<name>/<kind>/<project> — deeper than the project is a file or a subdirectory.
  return `/${parts.slice(0, 4).join('/')}`
}

/**
 * Read Cursor's chat store.
 *
 * As observed: `cursorDiskKV` rows keyed `bubbleId:<composerId>:<bubbleId>`, where a user
 * message is a row whose JSON has `type: 1` and a `text` field. Two honest limitations,
 * both reported rather than papered over:
 *
 *  - **Order inside a conversation is not recoverable.** Bubbles carry no timestamp and
 *    `composerData.fullConversationHeadersOnly` is frequently empty, so a turn here is one
 *    message and its `seq` is only its position in this read.
 *  - **The workspace is usually absent.** `composerData.workspaceIdentifier` was empty in
 *    every composer inspected, so the project is inferred from the file paths the bubble
 *    references, and a conversation where that fails is counted as unresolved.
 *
 * @param paths - where the store lives; defaults to the real Cursor path.
 * @returns turns, the human-message count, and the skip accounting.
 */
export function readCursorTurns(paths: SourcePaths = {}): SourceRead {
  const db = paths.cursorDb ?? CURSOR_DB_DEFAULT
  const skipped: Record<string, number> = {}
  const turns: SourceTurn[] = []
  let humanMessages = 0
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  const query = (sql: string, maxBuffer = 1024 * 1024 * 512): string => {
    const result = spawnSync('sqlite3', ['-readonly', '-json', db, sql], { maxBuffer, encoding: 'utf8' })
    return result.status === 0 ? String(result.stdout ?? '') : ''
  }

  const bubbles = query(
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND json_extract(value,'$.type')=1;",
  )
  if (bubbles.trim() === '') {
    bump('cursor-store-unreadable-or-empty')
    return { turns, humanMessages, skipped }
  }

  let rows: Array<{ key: string; value: string }> = []
  try {
    rows = JSON.parse(bubbles) as Array<{ key: string; value: string }>
  } catch {
    bump('cursor-query-not-json')
    return { turns, humanMessages, skipped }
  }

  const byComposer = new Map<string, Array<{ text: string; paths: string[] }>>()
  for (const row of rows) {
    const parts = row.key.split(':')
    const composerId = parts[1] ?? 'unknown'
    let parsed: { text?: unknown }
    try {
      parsed = JSON.parse(row.value) as { text?: unknown }
    } catch {
      bump('unparsable-bubble')
      continue
    }
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
    if (text === '') {
      bump('empty-bubble')
      continue
    }
    humanMessages += 1
    const paths = [...row.value.matchAll(PATH_PATTERN)].map((match) => projectRoot(match[0]))
    const list = byComposer.get(composerId) ?? []
    list.push({ text, paths })
    byComposer.set(composerId, list)
  }

  for (const [composerId, messages] of byComposer) {
    // The most frequently referenced project in the conversation is the one it is about;
    // ties go to the first seen. Reported as unresolved when nothing was referenced at all.
    const votes = new Map<string, number>()
    for (const message of messages) for (const path of message.paths) votes.set(path, (votes.get(path) ?? 0) + 1)
    const ranked = [...votes.entries()].sort((left, right) => right[1] - left[1])
    const workspace = ranked[0]?.[0] ?? null
    if (workspace === null) bump('cursor-workspace-unresolved')
    turns.push({
      source: 'cursor',
      sessionId: `cursor-${composerId}`,
      workspace,
      events: messages.map((message, index) => ({
        seq: index,
        type: 'user/message',
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: message.text }] },
      })),
    })
  }

  return { turns, humanMessages, skipped }
}
