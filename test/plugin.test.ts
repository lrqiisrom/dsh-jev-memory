import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, collectTurnEvents, resolveConfig, resolveStoreRoot, withDeadline } from '../dsh/index.ts'
import type {
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
import type { TurnEvent } from '../dsh/lib/extract.ts'

/** What the fake context recorded, so a test can drive the plugin's hooks by hand. */
interface Captured {
  contexts: PromptContextDefinition[]
  listeners: Map<string, (payload: TurnStoppingPayload) => unknown>
  /** Registered definitions, kept as `unknown`: each test picks the one it drives. */
  tools: Map<string, unknown>
  disposers: Array<() => void>
  injected?: string[]
  /** what the fake credentials service returns, when a test wires one. */
  credentialValue?: string
}

/**
 * A minimal Cordis context: enough surface for the plugin to mount and for the
 * test to drive its hooks by hand. Building one instead of booting the harness
 * is what keeps this test offline and deterministic — the harness itself is
 * exercised by the separate end-to-end run documented in README.md.
 */
function fakeContext(): { ctx: PluginContext; captured: Captured } {
  const captured: Captured = { contexts: [], listeners: new Map(), tools: new Map(), disposers: [] }
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
      callback(scope)
    },
    on: (event, handler) => {
      captured.listeners.set(event, handler)
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

/** The handler the plugin registered for one event. */
function listenerFor(captured: Captured, event: string): (payload: TurnStoppingPayload) => unknown {
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
): Promise<{ root: string; captured: Captured }> {
  const root = await mkdtemp(join(tmpdir(), 'dshmem-plugin-'))
  const { ctx, captured } = fakeContext()
  if (credentialValue !== undefined) captured.credentialValue = credentialValue
  apply(ctx, { root, judge: 'heuristic', ...overrides })
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { root, captured }
}

/** The plugin's `start` ledger line, which records what the judge could reach. */
async function startEntry(root: string): Promise<Record<string, any>> {
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
