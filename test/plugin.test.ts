import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, collectTurnEvents, RECALL_CONTEXT_NAME, resolveConfig, resolveStoreRoot, withDeadline } from '../dsh/index.ts'
import type {
  AskQuestionItem,
  ForgetArgs,
  MemoryForgetResult,
  MemorySearchResult,
  MemoryWriteResult,
  PluginContext,
  PromptContextDefinition,
  SearchArgs,
  SessionLike,
  ToolDefinition,
  TurnStoppingPayload,
  WriteArgs,
} from '../dsh/index.ts'
import { CONFLICT_CHOICES } from '../dsh/lib/conflict.ts'
import type { TurnEvent } from '../dsh/lib/extract.ts'

/** What the fake context recorded, so a test can drive the plugin's hooks by hand. */
interface Captured {
  contexts: PromptContextDefinition[]
  listeners: Map<string, (...args: unknown[]) => unknown>
  /** Registered definitions, kept as `unknown`: each test picks the one it drives. */
  tools: Map<string, unknown>
  disposers: Array<() => void>
  injected?: string[]
  /** what the fake credentials service returns, when a test wires one. */
  credentialValue?: string
  /** questions the plugin put to the human, in order. */
  asked: Array<{ questions: AskQuestionItem[]; agent?: unknown }>
  /** labels the fake human replies with, when a test wires an answerer. */
  askAnswer?: string[]
  /** one entry per question, for tests that need the first answer to be missing. */
  askAnswers?: string[][]
}

/**
 * A minimal Cordis context: enough surface for the plugin to mount and for the
 * test to drive its hooks by hand. Building one instead of booting the harness
 * is what keeps this test offline and deterministic — the harness itself is
 * exercised by the separate end-to-end run documented in README.md.
 */
function fakeContext(): { ctx: PluginContext; captured: Captured } {
  const captured: Captured = { contexts: [], listeners: new Map(), tools: new Map(), disposers: [], asked: [] }
  const ctx: PluginContext = {
    logger: { info: () => {}, warn: () => {} },
    // Per-name scope, exactly like the real context: the plugin injects both
    // `systemPrompt` and `credentials`, and a fake that always hands back the same
    // shape would hide a wiring mistake in either one.
    inject: (names, callback) => {
      captured.injected = names
      const scope: Parameters<typeof callback>[0] = {
        systemPrompt: {
          context: (definition) => {
            captured.contexts.push(definition)
            return () => {}
          },
        },
      }
      if (names.includes('credentials') && captured.credentialValue !== undefined) {
        scope.credentials = { resolve: async () => ({ value: captured.credentialValue as string, source: 'file' }) }
      }
      if (names.includes('userQuestions') && (captured.askAnswer !== undefined || captured.askAnswers !== undefined)) {
        scope.userQuestions = {
          ask: async (request) => {
            captured.asked.push({ questions: request.questions, agent: request.agent })
            const selected = captured.askAnswers?.shift() ?? captured.askAnswer ?? []
            // An empty selection is how the harness reports "nobody answered": the
            // plugin must read that as unanswered, not as "keep both".
            return { answers: selected.length > 0 ? [{ id: request.questions[0]?.id ?? 'q', selected }] : [] }
          },
        }
      }
      callback(scope)
    },
    on: (event, handler) => {
      // Stored verbatim rather than pre-applied: waterfall listeners differ in
      // arity (`system-prompt/assemble` takes three arguments), and a wrapper that
      // hard-coded one shape would hide exactly that contract.
      const raw = handler as unknown as (...args: unknown[]) => unknown
      captured.listeners.set(event, (...args: unknown[]) => raw(...args))
      return () => {}
    },
    tools: {
      register: <TArgs, TResult>(definition: ToolDefinition<TArgs, TResult>) => {
        captured.tools.set(definition.name, definition)
        return () => {}
      },
    },
    effect: (factory) => {
      captured.disposers.push(factory())
      return () => {}
    },
  }
  return { ctx, captured }
}

/**
 * A listener the tests can call with just the payload.
 *
 * `next` defaults to "enter this step with no messages", which is what the harness
 * does when nothing intervenes; a test that cares about a different decision uses
 * {@link rawListener} and supplies its own.
 */
function listenerFor(captured: Captured, event: string): (payload: TurnStoppingPayload) => unknown {
  const handler = rawListener(captured, event)
  return (payload) => handler(payload, async () => ({ kind: 'enter', messages: [] }))
}

/** The listener exactly as registered, for tests that drive `next` themselves. */
function rawListener(captured: Captured, event: string): (...args: unknown[]) => unknown {
  const handler = captured.listeners.get(event)
  if (!handler) throw new Error(`no listener was registered for ${event}`)
  return handler
}

/** The tool definition the plugin registered under one name, with its real contract. */
function toolFor<TArgs, TResult>(captured: Captured, name: string): ToolDefinition<TArgs, TResult> {
  const definition = captured.tools.get(name)
  if (!definition) throw new Error(`tool ${name} was not registered`)
  return definition as ToolDefinition<TArgs, TResult>
}

/** A session whose log holds exactly the events given, indexed by seq. */
function fakeSession({ id = 's1', cwd = '/work/a', events }: { id?: string; cwd?: string; events: TurnEvent[] }): SessionLike {
  return {
    seq: events.length,
    header: { id, cwd, delegationDepth: 0 },
    eventAt: (seq) => events[seq],
  }
}

const TURN_EVENTS: TurnEvent[] = [
  { type: 'turn/start', data: { turn: 1 } },
  {
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '必须用 pnpm 管理依赖，这是团队约定。' }],
    },
  },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } } },
]

/** Mount the plugin over a temp store and wait until it has loaded. */
async function mount(
  overrides: Record<string, unknown> = {},
  /** a key the fake credentials service should answer with, when the test wires one. */
  credentialValue?: string,
  /** runs after the fake context exists but before `apply`, to wire fakes. */
  setup?: (captured: Captured) => void,
): Promise<{ root: string; captured: Captured }> {
  const root = await mkdtemp(join(tmpdir(), 'dshmem-plugin-'))
  const { ctx, captured } = fakeContext()
  if (credentialValue !== undefined) captured.credentialValue = credentialValue
  setup?.(captured)
  apply(ctx, { root, judge: 'heuristic', ...overrides })
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { root, captured }
}

/** The plugin's `start` ledger line, which records what the judge could reach. */
async function startEntry(root: string): Promise<Record<string, any>> {
  await settle()
  const ledger = await readFile(join(root, 'ledger.jsonl'), 'utf8')
  const entries = ledger
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  return entries.find((entry) => entry.kind === 'start')
}

/**
 * Run `fn` with `DSH_HOME` pointed at a fresh temp directory.
 *
 * Without this the credential-file path would read the developer's real
 * `~/.dsh/.credentials.yaml`, so the test would pass or fail depending on the
 * machine it runs on.
 */
async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'dshmem-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('resolveConfig keeps the narrow default and reports bad values', () => {
  const clean = resolveConfig({})
  assert.deepEqual(clean.config.types, ['constraint', 'pitfall', 'decision'])
  assert.deepEqual(clean.problems, [])

  const messy = resolveConfig({ types: ['constraint', 'nonsense'], judge: 'gpt', minImportance: 'high', contextOrder: Number.NaN })
  assert.deepEqual(messy.config.types, ['constraint'])
  assert.equal(messy.config.judge, 'auto')
  assert.equal(messy.config.minImportance, 0.6)
  assert.equal(messy.config.contextOrder, 130)
  assert.equal(messy.problems.length, 4)
})

test('resolveStoreRoot follows config, then DSH_HOME, then ~/.dsh', () => {
  assert.equal(resolveStoreRoot('/tmp/explicit'), '/tmp/explicit')
  assert.equal(resolveStoreRoot('', { DSH_HOME: '/tmp/home' }), '/tmp/home/jev-memory')
  assert.equal(resolveStoreRoot('   ', { DSH_HOME: '  ' }), join(process.env.HOME ?? '', '.dsh', 'jev-memory'))
})

test('collectTurnEvents stops at the turn boundary and reads oldest first', () => {
  const session = fakeSession({ events: TURN_EVENTS })
  assert.deepEqual(collectTurnEvents(session).map((event) => event.type), ['user/message', 'assistant/message'])
  assert.deepEqual(collectTurnEvents(null), [])
  assert.deepEqual(collectTurnEvents({}), [])
})

test('withDeadline rejects a slow write and passes a fast one through', async () => {
  assert.equal(await withDeadline(Promise.resolve('ok'), 50), 'ok')
  await assert.rejects(withDeadline(new Promise(() => {}), 10), /exceeded 10ms/)
})

test('a turn writes a memory, a later session recalls it, and it can be forgotten', async () => {
  const { captured } = await mount()
  assert.deepEqual(captured.injected, ['systemPrompt'])
  assert.equal(captured.contexts.length, 1)
  assert.equal(captured.contexts[0].name, 'jev-memory:recall')

  // Nothing to recall before anything has been learned.
  const session = fakeSession({ events: TURN_EVENTS })
  assert.equal(captured.contexts[0].text({ agent: { session } }), '')

  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session }, turn: 1, signal: undefined })

  const injected = captured.contexts[0].text({ agent: { session } })
  assert.match(injected, /## 长期记忆/)
  assert.match(injected, /- \[constraint\] 必须用 pnpm 管理依赖，这是团队约定。/)
  assert.match(injected, /memory_forget/)

  // Another workspace must not see this project's conventions.
  const elsewhere = fakeSession({ id: 's2', cwd: '/work/b', events: TURN_EVENTS })
  assert.equal(captured.contexts[0].text({ agent: { session: elsewhere } }), '')

  // A subagent inherits the parent's context and must not pay for it twice.
  const sub = fakeSession({ id: 's3', events: TURN_EVENTS })
  sub.header!.delegationDepth = 1
  assert.equal(captured.contexts[0].text({ agent: { session: sub } }), '')

  // The tools see the same store.
  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  const found = await search.execute({ query: 'pnpm' }, { agent: { session } })
  assert.equal(found.matches.length, 1)
  assert.match(search.output.render({ query: 'pnpm' }, found)[0].text, /必须用 pnpm/)

  const forget = toolFor<ForgetArgs, MemoryForgetResult>(captured, 'memory_forget')
  const removed = await forget.execute({ id: found.matches[0].id }, { agent: { session } })
  assert.deepEqual(removed, { removed: [found.matches[0].id], count: 1 })
  assert.equal(captured.contexts[0].text({ agent: { session } }), '')
})

test('a repeated statement is not written twice', async () => {
  const { captured } = await mount()
  const handler = listenerFor(captured, 'agent/turn-stopping')
  const session = fakeSession({ events: TURN_EVENTS })
  await handler({ agent: { id: 's1', session }, turn: 1, signal: undefined })
  await handler({ agent: { id: 's1', session }, turn: 2, signal: undefined })
  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  const found = await search.execute({ query: 'pnpm' }, { agent: { session } })
  assert.equal(found.matches.length, 1)
  assert.equal(found.total, 1)
})

test('memory_write and the injection agree on the same record', async () => {
  const { captured } = await mount()
  const write = toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write')
  const written = await write.execute({ text: '不要改动 data/ 目录下的文件。', type: 'constraint' })
  assert.equal(written.stored, true)
  assert.equal(written.replaced, false)
  assert.equal((await write.execute({ text: '不要改动 data/ 目录下的文件。', type: 'constraint' })).replaced, true)

  const session = fakeSession({ events: [] })
  assert.match(captured.contexts[0].text({ agent: { session } }), /不要改动 data\/ 目录下的文件。/)
})

test('a disabled plugin registers nothing', () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(captured.contexts.length, 0)
  assert.equal(captured.tools.size, 0)
  assert.equal(captured.listeners.size, 0)
})

test('a delegated child session never teaches the store', async () => {
  const { captured } = await mount()
  const session = fakeSession({ id: 'child', events: TURN_EVENTS })
  session.header!.delegationDepth = 1
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 'child', session }, turn: 1, signal: undefined })
  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  assert.equal((await search.execute({ query: 'pnpm' }, { agent: { session } })).matches.length, 0)
})

test('a task instruction is never written even from a root session', async () => {
  const { captured } = await mount()
  const events: TurnEvent[] = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '请严格按下面步骤操作，不要做任何额外的事。调用 `memory_write`，参数：{"text": "语言不要选 Java"}' }],
      },
    },
  ]
  const session = fakeSession({ id: 'root', events })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 'root', session }, turn: 1, signal: undefined })
  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  assert.equal((await search.execute({ query: '步骤' }, { agent: { session } })).matches.length, 0)
  assert.equal((await search.execute({ query: 'Java' }, { agent: { session } })).matches.length, 0)
})

test('a failing hook never propagates out of the turn boundary', async () => {
  const { captured } = await mount()
  const handler = listenerFor(captured, 'agent/turn-stopping')
  await assert.doesNotReject(async () => {
    await handler({ agent: { id: 'broken', session: { seq: 5, header: {}, eventAt: () => { throw new Error('boom') } } }, turn: 1 })
  })
})

// The bug this covers: the plugin looked the credential service up once during
// mount, Cordis's `get` refused to return a provider whose fiber was not active
// yet, and the plugin silently stayed on the heuristic judge forever — visible
// only as `ready: false` with no hint of why.
test('a credential service that arrives after mount still switches the judge to Jev', async () => {
  const { root } = await mount({ judge: 'auto' }, 'test-key-from-credentials')
  const start = await startEntry(root)
  assert.equal(start.judge, 'jev', 'mode auto with a reachable key configures the Jev judge')
  assert.deepEqual(start.jev, { ready: true, source: 'service:file', endpoint: 'https://api.typesafe.ai/v1/systemone' })
  assert.equal(start.credentialRef, 'TYPESAFE_API_KEY')
})

test('without any credential source the ledger says so instead of staying silent', async () => {
  await withTempHome(async (home) => {
    const { root } = await mount({ judge: 'auto' })
    const start = await startEntry(root)
    assert.equal(start.jev.ready, false)
    assert.equal(start.jev.source, 'none')
    assert.equal(home.includes('dshmem-home-'), true)
  })
})

// Reachability of the service is not something a plugin can assume, so the second
// path reads the provider's own document. This is the test that would have caught
// the original failure without a restart: with no service and a document present,
// the judge must still come up on Jev.
test('a credential document is read when the service is absent', async () => {
  await withTempHome(async (home) => {
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  TYPESAFE_API_KEY: key-from-document\n', { mode: 0o600 })
    const { root } = await mount({ judge: 'auto' })
    const start = await startEntry(root)
    assert.equal(start.jev.ready, true)
    assert.equal(start.jev.source, 'file')
  })
})

/**
 * Wait for the plugin's fire-and-forget ledger appends to land.
 *
 * Audit writes are deliberately not awaited inside the hook — a turn must never
 * block on bookkeeping — so a test that reads the ledger has to let the queue
 * drain first.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/**
 * A network stub for the two requests the plugin makes about a conflict.
 *
 * The second one is the *pairing* request: answering it with the first request's
 * shape (as a naive stub does) is exactly how this test caught that pairing now
 * costs a round trip — the plugin got no partner, said nothing, and the question
 * never appeared.
 */
function jevStub(): typeof fetch {
  return (async (_url: string, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (body?.questions?.partner) {
      return new Response(
        JSON.stringify({ model: 'jev-1.13.0', answers: { partner: { type: 'choice', choice: 'm0', confidence: 0.9 } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return jevConflictResponse()
  }) as unknown as typeof fetch
}

/** A canned Jev answer: worth remembering, a constraint, and a suspected conflict. */
function jevConflictResponse(): Response {
  return new Response(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        'remember:0': { type: 'noul', noul: 0.9 },
        'type:0': { type: 'choice', choice: 'constraint', confidence: 0.9 },
        'importance:0': { type: 'score', score: 3, legend: {}, confidence: 0.9 },
        'conflict:0': { type: 'noul', noul: 0.95 },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const CONFLICTING_TURN: TurnEvent[] = [
  { type: 'turn/start', data: { turn: 1 } },
  {
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '不要改动 data/ 目录下的任何文件。' }],
    },
  },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } } },
]

/**
 * The whole human-in-the-loop path, driven end to end: the judge raises a
 * conflict, the plugin asks, the answer decides which memory survives.
 *
 * The network is stubbed rather than avoided because this is precisely the wiring
 * that unit tests cannot reach — the pairing, the question, the answer mapping and
 * the store mutation all have to agree with each other.
 */
test('a suspected conflict is put to the human and the answer decides', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = jevStub()
  try {
    const { root, captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } }, undefined, (c) => {
      c.askAnswer = [CONFLICT_CHOICES.replace]
    })
    const session = fakeSession({ events: [] })

    // Something the user said earlier, which the new sentence contradicts.
    const write = toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write')
    const seeded = await write.execute({ text: '可以随便改 data/ 目录下的文件', type: 'constraint' }, { agent: { session } })
    assert.equal(seeded.stored, true)

    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: CONFLICTING_TURN }) },
      turn: 1,
      signal: undefined,
    })

    assert.equal(captured.asked.length, 1, 'the plugin must ask exactly once')
    const question = captured.asked[0].questions[0]
    assert.match(question.detail ?? '', /不要改动 data\/ 目录下的任何文件/)
    assert.match(question.detail ?? '', /可以随便改 data\/ 目录下的文件/)
    assert.equal(captured.asked[0].agent !== undefined, true, 'the question must carry the live agent')

    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    const found = await search.execute({ query: 'data' }, { agent: { session } })
    assert.equal(found.matches.length, 1, 'the replaced memory must be gone')
    assert.match(found.matches[0].text, /不要改动/)

    await settle()
    const ledger = await readFile(join(root, 'ledger.jsonl'), 'utf8')
    assert.match(ledger, /"kind":"conflict-ask"/)
    assert.match(ledger, /"kind":"conflict-resolved".*"choice":"replace"/)
    assert.match(ledger, /"kind":"conflict-ask".*"via":"jev"/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('keeping the older memory drops the new one instead', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = jevStub()
  try {
    const { root, captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } }, undefined, (c) => {
      c.askAnswer = [CONFLICT_CHOICES['keep-old']]
    })
    const session = fakeSession({ events: [] })
    await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
      { text: '可以随便改 data/ 目录下的文件', type: 'constraint' },
      { agent: { session } },
    )
    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: CONFLICTING_TURN }) },
      turn: 1,
      signal: undefined,
    })

    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    const found = await search.execute({ query: 'data' }, { agent: { session } })
    assert.equal(found.matches.length, 1)
    assert.match(found.matches[0].text, /可以随便改/)
    await settle()
    assert.match(await readFile(join(root, 'ledger.jsonl'), 'utf8'), /"choice":"keep-old"/)
  } finally {
    globalThis.fetch = realFetch
  }
})

// Without an answerer the record must stay withheld rather than be guessed at:
// the fail-open direction is "keep less", never "assume".
test('an unanswered conflict leaves the new memory withheld', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = jevStub()
  try {
    const { root, captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } })
    const session = fakeSession({ events: [] })
    await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
      { text: '可以随便改 data/ 目录下的文件', type: 'constraint' },
      { agent: { session } },
    )
    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: CONFLICTING_TURN }) },
      turn: 1,
      signal: undefined,
    })

    assert.equal(captured.asked.length, 0)
    // The withheld record is not injected, so only the earlier memory is visible.
    const injected = captured.contexts[0].text({ agent: { session } })
    assert.match(injected, /可以随便改/)
    assert.doesNotMatch(injected, /不要改动/)
    await settle()
    assert.match(await readFile(join(root, 'ledger.jsonl'), 'utf8'), /"choice":"unanswered"/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a one-off tool failure is not remembered, a repeated one is', async () => {
  const { captured } = await mount()
  const session = fakeSession({ events: [] })
  const failure = (seq: number): TurnEvent[] => [
    { type: 'turn/start', data: { turn: seq } },
    { type: 'tool/call', data: { callId: `c${seq}`, name: 'bash', arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: `c${seq}` },
          content: [{ type: 'text', text: 'EPERM: /etc/hosts blocked', isError: true }],
        },
      },
    },
  ]
  const handler = listenerFor(captured, 'agent/turn-stopping')
  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')

  await handler({ agent: { id: 's1', session: fakeSession({ events: failure(1) }) }, turn: 1, signal: undefined })
  assert.equal((await search.execute({ query: 'EPERM' }, { agent: { session } })).matches.length, 0, 'the first sighting is dropped')

  await handler({ agent: { id: 's1', session: fakeSession({ events: failure(2) }) }, turn: 2, signal: undefined })
  assert.equal((await search.execute({ query: 'EPERM' }, { agent: { session } })).matches.length, 1, 'the repeat is remembered')
})

// The timeout is large on purpose, and a missed question is resumed rather than
// lost: the next turn's first step re-asks it, when the user is present by
// definition. Bounded, so an ignored question eventually stops asking.
test('an unanswered conflict is re-asked at the start of the next turn', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = jevStub()
  try {
    const { root, captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } }, undefined, (c) => {
      // first question gets no answer; the retry gets one
      c.askAnswers = [[], [CONFLICT_CHOICES.replace]]
    })
    const session = fakeSession({ events: [] })
    await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
      { text: '可以随便改 data/ 目录下的文件', type: 'constraint' },
      { agent: { session } },
    )
    const startTurn: TurnStoppingPayload = { agent: { session: fakeSession({ events: CONFLICTING_TURN }) }, turn: 1, signal: undefined }
    await listenerFor(captured, 'agent/turn-stopping')(startTurn)
    assert.equal(captured.asked.length, 1, 'asked once at turn end')

    // Still withheld: nothing was decided yet.
    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    assert.equal((await search.execute({ query: 'data' }, { agent: { session } })).matches.length, 2)

    const preStep = listenerFor(captured, 'agent/pre-step')
    await preStep({ agent: { session }, step: 1, signal: undefined })
    assert.equal(captured.asked.length, 2, 'the next turn resumes the question')

    await settle()
    const found = await search.execute({ query: 'data' }, { agent: { session } })
    assert.equal(found.matches.length, 1, 'the resumed answer resolved it')
    assert.match(found.matches[0].text, /不要改动/)
    assert.match(await readFile(join(root, 'ledger.jsonl'), 'utf8'), /"attempt":2/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a conflict nobody can be paired with is recorded instead of vanishing', async () => {
  const realFetch = globalThis.fetch
  // The judge raises a conflict, then explicitly names no partner.
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (body?.questions?.partner) {
      return new Response(
        JSON.stringify({ model: 'jev-1.13.0', answers: { partner: { type: 'choice', choice: 'none-of-the-above', confidence: 0.9 } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return jevConflictResponse()
  }) as unknown as typeof fetch
  try {
    const { root, captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } }, undefined, (c) => {
      c.askAnswer = [CONFLICT_CHOICES.replace]
    })
    const session = fakeSession({ events: [] })
    await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
      { text: '可以随便改 data/ 目录下的文件', type: 'constraint' },
      { agent: { session } },
    )
    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: CONFLICTING_TURN }) },
      turn: 1,
      signal: undefined,
    })
    assert.equal(captured.asked.length, 0, 'naming no partner must not produce a question')
    await settle()
    assert.match(await readFile(join(root, 'ledger.jsonl'), 'utf8'), /"reason":"conflict-unpaired"/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('pairing falls back to lexical overlap when the model cannot answer', async () => {
  const realFetch = globalThis.fetch
  let partnerCalls = 0
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (body?.questions?.partner) {
      partnerCalls += 1
      return new Response('upstream failed', { status: 500 })
    }
    return jevConflictResponse()
  }) as unknown as typeof fetch
  try {
    const { root, captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } }, undefined, (c) => {
      c.askAnswer = [CONFLICT_CHOICES['keep-both']]
    })
    const session = fakeSession({ events: [] })
    await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
      { text: '可以随便改 data/ 目录下的文件', type: 'constraint' },
      { agent: { session } },
    )
    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: CONFLICTING_TURN }) },
      turn: 1,
      signal: undefined,
    })
    assert.equal(partnerCalls >= 1, true, 'the model is asked first')
    assert.equal(captured.asked.length, 1, 'a failed pairing still lets the human decide')
    await settle()
    // Both survive, and the ledger says the pairing came from overlap, not the model.
    const found = await toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search').execute(
      { query: 'data' },
      { agent: { session } },
    )
    assert.equal(found.matches.length, 2)
    assert.match(await readFile(join(root, 'ledger.jsonl'), 'utf8'), /"via":"overlap"/)
  } finally {
    globalThis.fetch = realFetch
  }
})

/** One assembly result, with or without this plugin's runtime context. */
function assembly(includeRecall: boolean): { sections: unknown[]; contexts: Array<{ name: string; text: string }>; tools: unknown[]; variables: Record<string, string> } {
  return { sections: [], contexts: includeRecall ? [{ name: RECALL_CONTEXT_NAME, text: '记忆块' }] : [], tools: [], variables: {} }
}

/** Seed one memory so recall has something to say. */
async function seedMemory(captured: Captured, text = '必须用 pnpm 管理依赖。'): Promise<SessionLike> {
  const session = fakeSession({ events: [] })
  await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute({ text, type: 'constraint' }, { agent: { session } })
  return session
}

// The normal path must stay untouched: when the assembly contains our context, the
// plugin has nothing to complain about and nothing extra to inject.
test('an assembly that carries the recall context is left alone', async () => {
  const { root, captured } = await mount()
  const session = await seedMemory(captured)
  const assemble = rawListener(captured, 'system-prompt/assemble')
  const result = await assemble(assembly(true), { agent: { session } }, async () => assembly(true))
  assert.deepEqual(result, assembly(true))

  const decision = await rawListener(captured, 'agent/pre-step')(
    { agent: { session }, turn: 1, step: 1, signal: undefined },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  await settle()
  assert.doesNotMatch(await readFile(join(root, 'ledger.jsonl'), 'utf8'), /context-suppressed/)
})

// Measured against the harness source: with `includeRuntimeContext: false` the
// assembler builds an empty contexts array and never calls the callbacks, so the
// plugin would inject nothing, log nothing and warn nobody.
test('a suppressed runtime context moves recall to a plugin-sourced message', async () => {
  const { root, captured } = await mount()
  const session = await seedMemory(captured)
  const assemble = rawListener(captured, 'system-prompt/assemble')
  await assemble(assembly(false), { agent: { session } }, async () => assembly(false))
  await settle()
  const ledger = await readFile(join(root, 'ledger.jsonl'), 'utf8')
  assert.match(ledger, /"kind":"context-suppressed"/)
  assert.match(ledger, /"kind":"recall".*"via":"message"/)

  const decision = (await rawListener(captured, 'agent/pre-step')(
    { agent: { session }, turn: 1, step: 1, signal: undefined },
    async () => ({ kind: 'enter', messages: [] }),
  )) as { kind: string; messages: Array<{ source: { kind: string; plugin?: string; form?: string }; content: Array<{ text: string }> }> }
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].source.plugin, 'jev-memory')
  assert.equal(decision.messages[0].source.form, 'recall')
  assert.match(decision.messages[0].content[0].text, /必须用 pnpm/)

  // The message stays in the turn's history, so one delivery per turn is enough.
  const second = (await rawListener(captured, 'agent/pre-step')(
    { agent: { session }, turn: 1, step: 2, signal: undefined },
    async () => ({ kind: 'enter', messages: [] }),
  )) as { messages: unknown[] }
  assert.equal(second.messages.length, 0)
})

test('the fallback never resurrects a rejected step', async () => {
  const { captured } = await mount()
  const session = await seedMemory(captured)
  await rawListener(captured, 'system-prompt/assemble')(assembly(false), { agent: { session } }, async () => assembly(false))
  const decision = await rawListener(captured, 'agent/pre-step')(
    { agent: { session }, turn: 1, step: 1, signal: undefined },
    async () => ({ kind: 'reject' }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
})

test('an empty store is never mistaken for a suppressed prompt', async () => {
  const { root, captured } = await mount()
  const session = fakeSession({ events: [] })
  await rawListener(captured, 'system-prompt/assemble')(assembly(false), { agent: { session } }, async () => assembly(false))
  await settle()
  assert.doesNotMatch(await readFile(join(root, 'ledger.jsonl'), 'utf8'), /context-suppressed/)
})
