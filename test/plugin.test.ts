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
  MemorySearchMatch,
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

/**
 * The two layers a search reaches, kept apart in assertions.
 *
 * `memory_search` returns promoted memories and archived messages in one list, because a person
 * asking a question should not have to know which layer the answer lived in. A test asserting
 * "nothing was written" still has to say which layer it means, or it would pass on an archive
 * hit and fail to notice that the gate had stopped working.
 */
const promoted = (result: MemorySearchResult): MemorySearchMatch[] =>
  result.matches.filter((match) => match.origin === 'memory')
const archivedHits = (result: MemorySearchResult): MemorySearchMatch[] =>
  result.matches.filter((match) => match.origin === 'archive')
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
  /** a fake `llm` service, when a test exercises the canonical pass. */
  llmPort?: unknown
  /** what the fake `agentDefaultModel` reports. */
  defaultModelSelection?: { provider: string; model: string }
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
    // Optional services are read with `ctx.get`, and returning undefined here is what
    // makes the canonical pass vanish rather than fail — which is the behaviour under
    // test in the "no route" case.
    get: (name: string) => {
      if (name === 'llm') return captured.llmPort
      if (name === 'agentDefaultModel') {
        return captured.defaultModelSelection === undefined
          ? undefined
          : { currentSelection: () => captured.defaultModelSelection }
      }
      return undefined
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
  // The temporary home removes the credential *document*, but the plugin also resolves a
  // key from the environment, so a test that means "nothing is configured" has to remove
  // that source too. Without this the test passed on a machine with no key exported and
  // failed on every machine that had one — which is every machine that runs the
  // evaluation, so it failed exactly where the behaviour mattered.
  const saved = new Map<string, string | undefined>()
  for (const name of ['TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'ZHIPU_API_KEY']) {
    saved.set(name, process.env[name])
    delete process.env[name]
  }
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
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
  assert.equal(promoted(found).length, 1)
  assert.ok(archivedHits(found).length >= 1, 'the raw message is reachable too, even though it is not a memory')
  assert.match(search.output.render({ query: 'pnpm' }, found)[0].text, /必须用 pnpm/)

  const forget = toolFor<ForgetArgs, MemoryForgetResult>(captured, 'memory_forget')
  const removed = await forget.execute({ id: promoted(found)[0]!.id }, { agent: { session } })
  assert.deepEqual(removed, { removed: [promoted(found)[0]!.id], count: 1 })
  assert.equal(captured.contexts[0].text({ agent: { session } }), '')
})

/** A message the screens refuse, plus an assistant reply that says something else. */
const REFUSED_TURN: TurnEvent[] = [
  { type: 'turn/start', data: { turn: 1 } },
  {
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '请你按照下面三个步骤操作，把第 2 步的原始结果贴出来，不要改写也不要总结。' }],
    },
  },
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '我建议先改配置项 consistencyLevel，再重跑一遍回归。' }] },
    },
  },
]

test('a message the gate refused is still in the archive, and search finds it', async () => {
  // The measured reason this layer exists: 122 labelled rows marked "don't remember" had already
  // been discarded by the plugin, so when the gate changed they could not be re-read. A
  // decision that cannot be revisited is a deletion with extra steps.
  const { captured } = await mount()
  const session = fakeSession({ events: REFUSED_TURN })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session }, turn: 1, signal: undefined })

  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  const found = await search.execute({ query: '贴出来' }, { agent: { session } })
  assert.equal(promoted(found).length, 0, 'the screens refused it, so it is not a memory')
  assert.equal(archivedHits(found).length, 1, 'but the words are still there')
  assert.match(archivedHits(found)[0]!.text, /不要改写/, 'the whole message, not a fragment')
  assert.match(search.output.render({ query: '贴出来' }, found)[0].text, /原文归档/)
})

test('the archive keeps the assistant messages too', async () => {
  // Nothing else records them, and "is this the model's words?" is a comparison against what the
  // model said earlier in the same session — the 30 labelled rows whose note says exactly that
  // cannot be judged without this.
  const { captured } = await mount()
  const session = fakeSession({ events: REFUSED_TURN })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session }, turn: 1, signal: undefined })

  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  const found = await search.execute({ query: 'consistencyLevel' }, { agent: { session } })
  assert.equal(promoted(found).length, 0)
  assert.equal(archivedHits(found).length, 1)
  assert.match(archivedHits(found)[0]!.text, /我建议先改配置项/)
})

test('a subagent turn is archived even though it is not extracted', async () => {
  // Two ways a turn used to vanish from the evidence layer: a session below the delegation depth
  // (the parent's instructions, which must not become memories but are still content) and a turn
  // that arrives before the store finished loading. Extraction stays behind the guards; the
  // archive does not, because a hole in the evidence is not fixable later.
  const { captured } = await mount()
  const sub = fakeSession({ id: 'sub-1', events: REFUSED_TURN })
  sub.header!.delegationDepth = 1
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 'sub-1', session: sub }, turn: 1, signal: undefined })

  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  const found = await search.execute({ query: '贴出来' }, { agent: { session: sub } })
  assert.equal(promoted(found).length, 0, 'a delegated session writes no memories')
  assert.equal(archivedHits(found).length, 1, 'but its messages are archived')
})

test('forgetting an archived message deletes it and nothing else', async () => {
  // A memory the person cannot get rid of is worse than no memory, and that applies to a layer
  // they can now search. The delete matches on session *and* sequence: comparing the sequence
  // alone would take out another session's message that happened to share the number.
  const { captured } = await mount()
  const first = fakeSession({ id: 's1', events: REFUSED_TURN })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session: first }, turn: 1, signal: undefined })
  const second = fakeSession({ id: 's2', events: REFUSED_TURN })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's2', session: second }, turn: 1, signal: undefined })

  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  const forget = toolFor<ForgetArgs, MemoryForgetResult>(captured, 'memory_forget')
  const before = await search.execute({ query: '贴出来' }, { agent: { session: first } })
  assert.equal(archivedHits(before).length, 2, 'both sessions archived the same text')

  const removed = await forget.execute({ id: archivedHits(before)[0]!.id })
  assert.equal(removed.count, 1)
  const after = await search.execute({ query: '贴出来' }, { agent: { session: first } })
  assert.equal(archivedHits(after).length, 1, 'the other session is untouched')
})

test('the write gate is deterministic by default and the judge can be put back', async () => {
  // Measured on 140 labelled rows: the judge at its re-tuned threshold scored F1 0.33, the free
  // extractor rule 0.34, and each one's unique contribution was equally poor. So the model's answer
  // no longer decides — and "deterministic" has to mean the *local* type and score, not the model's
  // numbers.
  //
  // The first implementation of this only stripped `remember`, which made `applyGate` fall through
  // to the judge's `importance` — its 0..1 score answer. That was never measured, and measuring it
  // later found it almost always closed: over 90 reconstructed rows, 2 of 18 positives cleared
  // importance 0.6 without a window and 0 of 18 with one. This test pins both directions so the
  // same mistake cannot come back quietly.
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          'remember:0': { type: 'noul', noul: 0.05 },
          'type:0': { type: 'choice', choice: 'fact', confidence: 0.9 },
          'importance:0': { type: 'score', score: 0, legend: {}, confidence: 0.9 },
          'conflict:0': { type: 'noul', noul: 0.05 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  try {
    // `judge: 'auto'` on purpose: `mount` defaults to the offline heuristic, and this test is about
    // what the *model's* answer is allowed to decide.
    const deterministic = await mount({ judge: 'auto', writeGate: 'deterministic' }, 'test-key')
    const a = fakeSession({ events: TURN_EVENTS })
    await listenerFor(deterministic.captured, 'agent/turn-stopping')({ agent: { id: 's1', session: a }, turn: 1, signal: undefined })
    const aSearch = toolFor<SearchArgs, MemorySearchResult>(deterministic.captured, 'memory_search')
    assert.equal(
      promoted(await aSearch.execute({ query: 'pnpm' }, { agent: { session: a } })).length,
      1,
      'the local type and score wrote it, even though the model said no on every answer',
    )
    assert.equal((await startEntry(deterministic.root))?.writeGate, 'deterministic')

    const judged = await mount({ judge: 'auto', writeGate: 'judge' }, 'test-key')
    const b = fakeSession({ events: TURN_EVENTS })
    await listenerFor(judged.captured, 'agent/turn-stopping')({ agent: { id: 's1', session: b }, turn: 1, signal: undefined })
    const bSearch = toolFor<SearchArgs, MemorySearchResult>(judged.captured, 'memory_search')
    assert.equal(
      promoted(await bSearch.execute({ query: 'pnpm' }, { agent: { session: b } })).length,
      0,
      'with the judge on the gate its remember 0.05 refuses the same sentence',
    )
    assert.equal((await startEntry(judged.root))?.writeGate, 'judge')
  } finally {
    globalThis.fetch = original
  }
})

test('a memory the local rule accepted is stored with the type the gate used, so recall finds it', async () => {
  // The judge answering `fact` while the local signals say `constraint` used to decide two different
  // things: the gate wrote the record, and the *judge's* type was what got stored. Recall filters on
  // the type whitelist, so that record was written and then never injected — silent, and invisible
  // to a test that asserts through `memory_search`, which does not filter by type. This asserts
  // through the injected context instead.
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          'remember:0': { type: 'noul', noul: 0.05 },
          // `pitfall` is in the enabled list on purpose: an answer *outside* it would be replaced by
          // the candidate's hinted type in the mapper, and the test would pass against the bug. The
          // mismatch only shows when the judge picks a different member of the list than the local
          // signals did.
          'type:0': { type: 'choice', choice: 'pitfall', confidence: 0.9 },
          'importance:0': { type: 'score', score: 0, legend: {}, confidence: 0.9 },
          'conflict:0': { type: 'noul', noul: 0.05 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  try {
    const { captured } = await mount({ judge: 'auto', writeGate: 'deterministic' }, 'test-key')
    const session = fakeSession({ events: TURN_EVENTS })
    await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session }, turn: 1, signal: undefined })

    const injected = captured.contexts[0]!.text({ agent: { session } })
    assert.match(injected, /pnpm/, 'the local rule accepted it, so it must reach the next session')
    assert.match(
      injected,
      /\[constraint\]/,
      "the stored type is the one the gate used; the judge answered pitfall, and the local signals said constraint",
    )
  } finally {
    globalThis.fetch = original
  }
})

test('deterministic mode refuses a sentence the local signals cannot type', async () => {
  // The other half: the model saying "yes" must not put an untyped sentence into memory either,
  // because a memory that only exists because a model waved it through is the thing this setting
  // was introduced to stop.
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          'remember:0': { type: 'noul', noul: 0.99 },
          'type:0': { type: 'choice', choice: 'constraint', confidence: 0.9 },
          'importance:0': { type: 'score', score: 4, legend: {}, confidence: 0.9 },
          'conflict:0': { type: 'noul', noul: 0.05 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  try {
    const { captured } = await mount({ judge: 'auto', writeGate: 'deterministic' }, 'test-key')
    const session = fakeSession({
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        {
          type: 'user/message',
          data: {
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: '我们对齐一下这个事情的进度吧。' }],
          },
        },
      ],
    })
    await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session }, turn: 1, signal: undefined })
    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    assert.equal(
      promoted(await search.execute({ query: '对齐' }, { agent: { session } })).length,
      0,
      'no local type signal, so the local score gate refuses it whatever the model answered',
    )
  } finally {
    globalThis.fetch = original
  }
})

test('a repeated statement is not written twice', async () => {
  const { captured } = await mount()
  const handler = listenerFor(captured, 'agent/turn-stopping')
  const session = fakeSession({ events: TURN_EVENTS })
  await handler({ agent: { id: 's1', session }, turn: 1, signal: undefined })
  await handler({ agent: { id: 's1', session }, turn: 2, signal: undefined })
  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  const found = await search.execute({ query: 'pnpm' }, { agent: { session } })
  assert.equal(promoted(found).length, 1)
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
  assert.equal(promoted(await search.execute({ query: 'pnpm' }, { agent: { session } })).length, 0)
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
  assert.equal(promoted(await search.execute({ query: '步骤' }, { agent: { session } })).length, 0)
  assert.equal(promoted(await search.execute({ query: 'Java' }, { agent: { session } })).length, 0)
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

test('the start line says which gate is live, not just which judge', async () => {
  // Two runs can both log `judge: jev` while asking a different question at a different
  // threshold, and the ledger used to be unable to tell them apart — so "did the numbers move
  // because of the change or because of the version" could not be answered from the file.
  const { root } = await mount({ judge: 'auto', minRemember: 0.12 }, 'test-key-from-credentials')
  const start = await startEntry(root)
  assert.equal(start.gate.minRemember, 0.12)
  assert.deepEqual(start.gate.types, ['constraint', 'pitfall', 'decision'])
  assert.match(start.gate.rememberQuestionHash, /^[0-9a-f]{12}$/u)
  assert.ok(start.gate.rememberQuestionChars > 50, 'the wording is recorded by size as well as by hash')

  // The hash follows the effective question, so a config override shows up instead of being
  // recorded as the shipped default.
  const overridden = await mount({ judge: 'auto', jev: { rememberQuestion: '换一个问题？' } }, 'test-key-from-credentials')
  const other = await startEntry(overridden.root)
  assert.notEqual(other.gate.rememberQuestionHash, start.gate.rememberQuestionHash)
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
    assert.equal(promoted(found).length, 1, 'the replaced memory must no longer be offered')
    assert.match(promoted(found)[0]!.text, /不要改动/)

    // It is gone from use, not from the record. The question told the person their earlier
    // statement would be kept "供以后查证", and until now the code deleted it, so that
    // promise had nothing behind it.
    const document = JSON.parse(await readFile(join(root, 'memory.json'), 'utf8')) as {
      records?: Array<Record<string, unknown>>
    } | Array<Record<string, unknown>>
    const records = Array.isArray(document) ? document : (document.records ?? [])
    const old = records.find((entry) => String(entry.text).includes('可以随便改'))
    assert.ok(old, 'the superseded memory is still stored')
    assert.equal(old.status, 'superseded')
    assert.equal(old.supersededBy, promoted(found)[0]!.id)
    const replacement = records.find((entry) => String(entry.text).includes('不要改动'))
    assert.equal(replacement?.supersedes, old.id)

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
    assert.equal(promoted(found).length, 1)
    assert.match(promoted(found)[0]!.text, /可以随便改/)
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
  assert.equal(promoted(await search.execute({ query: 'EPERM' }, { agent: { session } })).length, 0, 'the first sighting is dropped')

  await handler({ agent: { id: 's1', session: fakeSession({ events: failure(2) }) }, turn: 2, signal: undefined })
  assert.equal(promoted(await search.execute({ query: 'EPERM' }, { agent: { session } })).length, 1, 'the repeat is remembered')
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
    assert.equal(promoted(await search.execute({ query: 'data' }, { agent: { session } })).length, 2)

    const preStep = listenerFor(captured, 'agent/pre-step')
    await preStep({ agent: { session }, step: 1, signal: undefined })
    assert.equal(captured.asked.length, 2, 'the next turn resumes the question')

    await settle()
    const found = await search.execute({ query: 'data' }, { agent: { session } })
    assert.equal(promoted(found).length, 1, 'the resumed answer resolved it')
    assert.match(promoted(found)[0]!.text, /不要改动/)
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
    assert.equal(promoted(found).length, 2)
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

/**
 * A turn whose user message is `text`.
 *
 * @param text - what the person said.
 * @returns the turn's events.
 */
function turnWith(text: string): TurnEvent[] {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } } },
  ]
}

/** Every ledger entry, oldest first. */
async function ledgerEntries(root: string): Promise<Array<Record<string, any>>> {
  await settle()
  return (await readFile(join(root, 'ledger.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

// Found by ranking the window rather than slicing it: the judge is asked "does this
// contradict anything you know" about twenty memories, and when it answers no there is
// nothing in the ledger to say whether the answer was checked against the right twenty.
// This records the deterministic disagreement without interrupting anyone for it.
test('a contradiction the judge did not raise is recorded, not swallowed', async () => {
  const { root, captured } = await mount()
  const session = fakeSession({ events: TURN_EVENTS })
  await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
    { text: '服务端口固定 8000，不要改。', type: 'constraint' },
    { agent: { session } },
  )

  const later = fakeSession({ events: turnWith('端口改成 9000 了，因为 8000 被占用了。') })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session: later }, turn: 1, signal: undefined })

  const suspected = (await ledgerEntries(root)).filter((entry) => entry.kind === 'conflict-suspected')
  assert.equal(suspected.length, 1, 'the lexical check disagreed with the judge and said so')
  assert.match(String(suspected[0].id), /端口/u)
  assert.ok(Number(suspected[0].score) > 0, 'the score is recorded so the threshold can be tuned later')
})

test('an enabled embedding path asks the provider, caches the vectors, and still writes', async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; input: string[] }> = []
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { input: string[] }
    calls.push({ url: String(url), input: body.input })
    return {
      ok: true,
      status: 200,
      // One vector per input, deliberately reversed in `data` to prove index order wins.
      json: async () => ({
        data: body.input.map((_text, index) => ({ index, embedding: [index + 1, 1] })).reverse(),
      }),
    }
  }) as unknown as typeof fetch

  try {
    const { root, captured } = await mount({ conflictRanking: 'embedding', embedding: { maxInputs: 16 } })
    // Seed one memory first: ranking needs something to rank. On the very first write
    // the store is empty, so the honest behaviour is to skip the provider entirely.
    const session = await seedMemory(captured)
    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: turnWith('端口改成 9000 了，因为 8000 被占用了。') }) },
      turn: 1,
      signal: undefined,
    })

    assert.ok(calls.length > 0, 'the provider was asked')
    assert.match(calls[0]!.url, /\/api\/paas\/v4\/embeddings$/u)
    assert.ok(calls[0]!.input.length > 0)

    const cache = JSON.parse(await readFile(join(root, 'embeddings.json'), 'utf8')) as { vectors: Record<string, number[]> }
    assert.ok(Object.keys(cache.vectors).length > 0, 'the vectors are kept as derived state beside the store')

    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    const found = await search.execute({ query: 'pnpm' }, { agent: { session } })
    assert.equal(promoted(found).length, 1, 'a ranking failure must never cost the write')

    const start = await startEntry(root)
    assert.equal(start?.conflictRanking, 'embedding')
  } finally {
    globalThis.fetch = original
  }
})

test('an embedding provider that is down falls back to lexical and still writes', async () => {
  const original = globalThis.fetch
  let attempts = 0
  globalThis.fetch = (async () => {
    attempts += 1
    throw new Error('network down')
  }) as unknown as typeof fetch
  try {
    const { root, captured } = await mount({ conflictRanking: 'embedding' })
    const session = await seedMemory(captured)
    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: turnWith('端口改成 9000 了，因为 8000 被占用了。') }) },
      turn: 1,
      signal: undefined,
    })

    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    assert.equal(
      promoted(await search.execute({ query: '端口' }, { agent: { session } })).length,
      1,
      'the write still happened despite the provider being down',
    )
    assert.ok(attempts > 0, 'the embedding path was actually exercised, not silently skipped')
    // Nothing was cached, because nothing came back: the fallback left no derived state
    // behind that a later run could mistake for a real vector.
    await assert.rejects(readFile(join(root, 'embeddings.json'), 'utf8'))
  } finally {
    globalThis.fetch = original
  }
})

/**
 * A provider whose vectors encode meaning the text does not spell out.
 *
 * The generic fake used elsewhere returns `[index + 1, 1]`, which makes similarity depend on
 * the order texts happen to be sent in — useless for asserting that a semantic hit beat a
 * lexical miss. This one maps two topics onto two axes, so "装东西用哪个命令" is close to the
 * pnpm memory while sharing no token with it.
 */
function semanticFetch(calls: Array<{ input: string[] }>): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] }
    calls.push({ input: body.input })
    return {
      ok: true,
      json: async () => ({
        data: body.input.map((text, index) => ({
          index,
          embedding: [
            /端口|port|监听|占用/u.test(text) ? 1 : 0,
            /装东西|pnpm|依赖|包管理|安装/u.test(text) ? 1 : 0,
          ],
        })),
      }),
    }
  }) as unknown as typeof fetch
}

test('searchRanking embedding finds a memory the question shares no word with', async () => {
  const original = globalThis.fetch
  const calls: Array<{ input: string[] }> = []
  globalThis.fetch = semanticFetch(calls)
  try {
    const { root, captured } = await mount({
      searchRanking: 'embedding',
      embedding: { maxInputs: 16 },
      // The write path is left on the heuristic so the fake provider is only ever asked
      // about search: one thing under test at a time.
      judge: 'heuristic',
    })
    const session = await seedMemory(captured)
    const write = toolFor(captured, 'memory_write')
    await write.execute({ text: '服务端口固定用 8000，别乱改', type: 'constraint' })
    await write.execute({ text: '依赖统一用 pnpm 装，不要用 npm', type: 'constraint' })

    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    const semantic = await search.execute({ query: '装东西用哪个命令' }, { agent: { session } })
    // `seedMemory` already wrote "必须用 pnpm 管理依赖。", so two of the three memories are
    // about pnpm. What matters is the two halves of the claim: the pnpm memories rank, and the
    // port memory — which the question shares no word with and is not about — is excluded
    // rather than dragged in as filler.
    assert.ok(semantic.matches.length > 0, 'the embedding path found an answer')
    assert.match(semantic.matches[0]!.text, /pnpm/u, 'the embedding path chose the answer')
    assert.equal(
      semantic.matches.some((match) => /端口/u.test(match.text)),
      false,
      'a memory the question is not about is not returned',
    )

    // The same question under the shipped default finds nothing, which is what makes the
    // setting worth having rather than a no-op.
    const start = await startEntry(root)
    assert.equal(start?.searchRanking, 'embedding')
    assert.ok(calls.length > 0, 'the provider was asked')
  } finally {
    globalThis.fetch = original
  }
})

test('a search whose provider is down still answers from BM25', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('network down')
  }) as unknown as typeof fetch
  try {
    const { root, captured } = await mount({ searchRanking: 'embedding', judge: 'heuristic' })
    const session = await seedMemory(captured)
    const write = toolFor(captured, 'memory_write')
    await write.execute({ text: '依赖统一用 pnpm 装，不要用 npm', type: 'constraint' })

    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    const hits = await search.execute({ query: 'pnpm' }, { agent: { session } })
    assert.ok(
      hits.matches.some((match) => /pnpm/u.test(match.text)),
      'a provider outage degrades to lexical, not to an error',
    )
    const start = await startEntry(root)
    assert.equal(start?.searchRanking, 'embedding')
  } finally {
    globalThis.fetch = original
  }
})

// Superseding is not forgetting. `memory_forget` is the person saying "remove this", and
// keeping a copy of something they asked to delete would be a different kind of lie.
test('forgetting a superseded memory really removes it', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = jevStub()
  try {
    const { root, captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } }, undefined, (c) => {
      c.askAnswer = [CONFLICT_CHOICES.replace]
    })
    const session = fakeSession({ events: [] })
    const write = toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write')
    const seeded = await write.execute({ text: '可以随便改 data/ 目录下的文件', type: 'constraint' }, { agent: { session } })

    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: CONFLICTING_TURN }) },
      turn: 1,
      signal: undefined,
    })

    const forget = toolFor<ForgetArgs, MemoryForgetResult>(captured, 'memory_forget')
    assert.deepEqual(await forget.execute({ id: seeded.id }, { agent: { session } }), { removed: [seeded.id], count: 1 })

    const document = JSON.parse(await readFile(join(root, 'memory.json'), 'utf8')) as {
      records?: Array<Record<string, unknown>>
    }
    const records = document.records ?? []
    assert.equal(records.some((entry) => String(entry.text).includes('可以随便改')), false)
  } finally {
    globalThis.fetch = realFetch
  }
})

/** A Jev stub that answers the pair question with one fixed decision. */
function jevPairStub(decision: string): typeof fetch {
  return (async (_url: string, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (body?.questions?.pair) {
      return new Response(
        JSON.stringify({ model: 'jev-1.13.0', answers: { pair: { type: 'choice', choice: decision, confidence: 0.9 } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (body?.questions?.partner) {
      return new Response(
        JSON.stringify({ model: 'jev-1.13.0', answers: { partner: { type: 'choice', choice: 'none-of-the-above', confidence: 0.9 } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          'remember:0': { type: 'noul', noul: 0.9 },
          'type:0': { type: 'choice', choice: 'constraint', confidence: 0.9 },
          'importance:0': { type: 'score', score: 3, legend: {}, confidence: 0.9 },
          'conflict:0': { type: 'noul', noul: 0.05 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

// The two defects this exists for: the normalized signature folds 8000 and 9000 into
// `<n>`, so the second sentence used to be dropped as a duplicate and the plugin kept
// believing the old number. Whether that is a correction or a restatement is a
// judgement, so it is asked — about one named memory, only here.
test('a changed number updates the memory in place, with the old text in the ledger', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = jevPairStub('same-update')
  try {
    const { root, captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } })
    const session = fakeSession({ events: [] })
    const write = toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write')
    await write.execute({ text: '服务端口固定 8000，不要改。', type: 'constraint' }, { agent: { session } })

    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: turnWith('服务端口固定 9000，不要改。') }) },
      turn: 1,
      signal: undefined,
    })

    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    const found = await search.execute({ query: '端口' }, { agent: { session } })
    assert.equal(promoted(found).length, 1, 'one rule, one current memory')
    assert.match(promoted(found)[0]!.text, /9000/u, 'the new number is what the plugin now believes')
    assert.equal(promoted(found)[0]!.status, 'active', 'and it is reachable — not left superseded')

    // In place, not a second record: the signature is the identity, and `<n>` folds both
    // numbers into one id. Writing a second record overwrote the first and then superseded
    // what it had just written, which left the memory unreachable.
    const document = JSON.parse(await readFile(join(root, 'memory.json'), 'utf8')) as {
      records?: Array<Record<string, unknown>>
    }
    const records = document.records ?? []
    assert.equal(records.length, 1, 'one record, corrected')
    assert.match(String(records[0]?.text), /9000/u)

    const ledger = await ledgerEntries(root)
    assert.equal(ledger.find((entry) => entry.kind === 'pair-decision')?.decision, 'same-update')
    const applied = ledger.find((entry) => entry.kind === 'pair-updated')
    assert.equal(applied?.inPlace, true)
    assert.match(String(applied?.from), /8000/u, 'the previous text stays auditable')
    assert.match(String(applied?.to), /9000/u)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a paraphrase the model calls a restatement is dropped, not stored twice', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = jevPairStub('same-duplicate')
  try {
    const { root, captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } })
    const session = fakeSession({ events: [] })
    await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
      { text: '必须用 pnpm 管理依赖，这是团队约定。', type: 'constraint' },
      { agent: { session } },
    )

    // Different signature, most tokens shared: exactly the case a content key cannot
    // judge, because it cannot tell "same thing, different words" from "different rule".
    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: turnWith('这是团队约定：必须用 pnpm 管理依赖。') }) },
      turn: 1,
      signal: undefined,
    })

    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    assert.equal(promoted(await search.execute({ query: 'pnpm' }, { agent: { session } })).length, 1)
    const ledger = await ledgerEntries(root)
    assert.equal(ledger.find((entry) => entry.kind === 'pair-decision')?.decision, 'same-duplicate')
    assert.ok(ledger.some((entry) => entry.reason === 'pair-duplicate'), 'the skip says why')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a different rule that merely looks alike is kept as its own memory', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = jevPairStub('different')
  try {
    const { captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } })
    const session = fakeSession({ events: [] })
    await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
      { text: '必须用 pnpm 管理依赖，这是团队约定。', type: 'constraint' },
      { agent: { session } },
    )
    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: turnWith('提交前必须保证测试全绿，这是团队约定。') }) },
      turn: 1,
      signal: undefined,
    })
    const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
    assert.equal(
      promoted(await search.execute({ query: '团队约定' }, { agent: { session } })).length,
      2,
      'two rules both survive — the deterministic key would have been wrong either way',
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test('without a model a signature collision is recorded, not dropped in silence', async () => {
  // The offline judge has no opinion on this by construction. Falling back must not mean
  // "drop what the person just said" — which is exactly the defect this work started from
  // — so the latest words win and the collision is written down.
  const { root, captured } = await mount({ judge: 'heuristic' })
  const session = fakeSession({ events: [] })
  await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
    { text: '服务端口固定 8000，不要改。', type: 'constraint' },
    { agent: { session } },
  )
  await listenerFor(captured, 'agent/turn-stopping')({
    agent: { id: 's1', session: fakeSession({ events: turnWith('服务端口固定 9000，不要改。') }) },
    turn: 1,
    signal: undefined,
  })
  const ledger = await ledgerEntries(root)
  assert.equal(ledger.filter((entry) => entry.kind === 'pair-decision').length, 0, 'nobody was asked')
  const collision = ledger.find((entry) => entry.kind === 'signature-collision')
  assert.equal(collision?.reason, 'judge-unavailable')
  assert.match(String(collision?.from), /8000/u)
  assert.match(String(collision?.to), /9000/u)

  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  assert.match((await search.execute({ query: '端口' }, { agent: { session } })).matches[0]?.text ?? '', /9000/u)
})

// A paraphrase the model calls an update has a *different* signature, so there the old
// record is superseded and linked — the other shape of the same decision.
test('a paraphrase called an update supersedes the old record by link', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = jevPairStub('same-update')
  try {
    const { root, captured } = await mount({ judge: 'auto', jev: { apiKey: 'test-key' } })
    const session = fakeSession({ events: [] })
    const first = await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
      { text: '必须用 pnpm 管理依赖，这是团队约定。', type: 'constraint' },
      { agent: { session } },
    )
    await listenerFor(captured, 'agent/turn-stopping')({
      agent: { id: 's1', session: fakeSession({ events: turnWith('这是团队约定：必须用 pnpm 管理依赖。') }) },
      turn: 1,
      signal: undefined,
    })

    const document = JSON.parse(await readFile(join(root, 'memory.json'), 'utf8')) as {
      records?: Array<Record<string, unknown>>
    }
    const records = document.records ?? []
    assert.equal(records.length, 2, 'two identities, so two records')
    const old = records.find((entry) => entry.id === first.id)
    assert.equal(old?.status, 'superseded')
    const fresh = records.find((entry) => entry.id !== first.id)
    assert.equal(fresh?.supersedes, first.id)
    assert.ok((await ledgerEntries(root)).some((entry) => entry.kind === 'pair-updated' && entry.inPlace === false))
  } finally {
    globalThis.fetch = realFetch
  }
})

/** A fake `llm` service that answers with one fixed line. */
function fakeLlm(line: string): unknown {
  return {
    stream: (options: { messages: Array<{ content: Array<{ text: string }> }> }) => {
      void options
      return (async function* () {
        yield { type: 'text-delta', text: line }
        yield { type: 'finish' }
      })()
    },
  }
}

test('a written memory gains a canonical form, and the verbatim sentence stays', async () => {
  const { root, captured } = await mount(
    {},
    undefined,
    (c) => {
      c.llmPort = fakeLlm('必须使用 pnpm 管理依赖。')
      c.defaultModelSelection = { provider: 'p', model: 'test-model' }
    },
  )
  const session = fakeSession({ events: TURN_EVENTS })
  const write = toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write')
  await write.execute({ text: '必须用 pnpm 管理依赖，这是团队约定。', type: 'constraint' }, { agent: { session } })
  await settle()

  const document = JSON.parse(await readFile(join(root, 'memory.json'), 'utf8')) as {
    records?: Array<Record<string, unknown>>
  }
  const record = (document.records ?? [])[0]
  assert.equal(record?.canonical, '必须使用 pnpm 管理依赖。', 'the cleaned form is stored beside it')
  assert.equal(record?.canonicalModel, 'test-model')
  assert.equal(record?.text, '必须用 pnpm 管理依赖，这是团队约定。', 'the evidence is untouched')

  const normalizeLines = (await ledgerEntries(root)).filter((entry) => entry.kind === 'normalize')
  assert.equal(normalizeLines.length, 1)
  assert.equal(normalizeLines[0]?.ok, true)
  assert.match(String(normalizeLines[0]?.from), /必须用 pnpm/u)
  assert.match(String(normalizeLines[0]?.to), /必须使用 pnpm/u)
})

test('the write path uses the model\'s segmentation, and a pasted span is not a memory', async () => {
  // The case the deterministic splitter cannot see, and the reason a model is on this path at all:
  // one message that mixes the person's own requirement with a block they pasted. No punctuation
  // rule separates those; the model says where the boundary is and who wrote each part.
  // Both halves carry a type signal, and that is deliberate: the pasted block would qualify as a
  // memory on its own, so the only thing stopping it is its attribution. A fixture where the pasted
  // half had no signal would pass even if attribution were ignored entirely.
  const own = '必须把端口固定成 8000。'
  const pasted = '不要用 8000 了，改成 9000 更稳。'
  const message = `${own}下面这段是我从模型回答里复制过来的：${pasted}`
  const { captured } = await mount(
    { judge: 'auto', segment: { enabled: true } },
    'test-key',
    (c) => {
      c.llmPort = fakeLlm(
        JSON.stringify([
          { message: 0, text: own, who: 'user' },
          { message: 0, text: pasted, who: 'pasted' },
        ]),
      )
      c.defaultModelSelection = { provider: 'p', model: 'test-model' }
    },
  )
  const session = fakeSession({
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: message }] } },
    ],
  })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session }, turn: 1, signal: undefined })

  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  const port = promoted(await search.execute({ query: '端口固定成 8000' }, { agent: { session } }))
  assert.equal(port.length, 1, "the person's own sentence is a memory")
  assert.equal(port[0]!.text, own)
  assert.equal(
    promoted(await search.execute({ query: '改成 9000' }, { agent: { session } })).length,
    0,
    'the pasted block is not their claim, even though it is about the same port',
  )
  // It is still evidence: the archive keeps it, searchable and marked.
  assert.ok(archivedHits(await search.execute({ query: '改成 9000' }, { agent: { session } })).length >= 1)
})

test('a sentence the model already said is not remembered as the person\'s own', async () => {
  // The largest single reason a labelled row is marked "don't remember": 30 rows note that the text
  // came from the model, none of them marked "remember", and 24 were still getting through because
  // the envelope says `user`. The archive keeps the assistant's messages precisely so this check is
  // possible; the person's own second message is what proves it is not simply refusing everything.
  const quoted = '把服务端口固定成 8000，避免和其它服务冲突。'
  const { captured } = await mount({ judge: 'auto' }, 'test-key')
  const first = fakeSession({
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '端口怎么配？' }] } },
      {
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `建议这样：${quoted}另外记得写进文档。` }] } },
      },
    ],
  })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session: first }, turn: 1, signal: undefined })

  // The next turn pastes that answer back in, verbatim.
  const second = fakeSession({
    events: [
      { type: 'turn/start', data: { turn: 2 } },
      {
        type: 'user/message',
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `就按这个来：${quoted}` }] },
      },
    ],
  })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session: second }, turn: 2, signal: undefined })

  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  assert.equal(
    promoted(await search.execute({ query: '端口固定成 8000' }, { agent: { session: second } })).length,
    0,
    'the model said it, so pasting it back is not the person stating a requirement',
  )

  // And a requirement the person actually writes still gets through — the screen is not a wall.
  const third = fakeSession({
    events: [
      { type: 'turn/start', data: { turn: 3 } },
      {
        type: 'user/message',
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '必须把日志级别固定成 warn，不要再改。' }] },
      },
    ],
  })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session: third }, turn: 3, signal: undefined })
  assert.equal(
    promoted(await search.execute({ query: '日志级别固定成 warn' }, { agent: { session: third } })).length,
    1,
    'a sentence nobody said before is still remembered',
  )
})

test('the start line distinguishes "off" from "no llm service" from "no default model"', async () => {
  // The first start line after this shipped said `enabled: false, route: null` — and `null` there
  // meant any of three different things at once, which is the same mistake as `ready: false` with no
  // `source`. The value that was actually wrong (the feature was off) could not be told from the one
  // that would have been fine (no model route).
  const off = await mount({ segment: { enabled: false } }, 'test-key', (c) => {
    c.llmPort = fakeLlm('[]')
    c.defaultModelSelection = { provider: 'p', model: 'test-model' }
  })
  assert.equal((await startEntry(off.root)).segment.route, 'disabled')

  const noService = await mount({ segment: { enabled: true } }, 'test-key')
  assert.equal((await startEntry(noService.root)).segment.route, 'no-llm-service')

  const noModel = await mount({ segment: { enabled: true } }, 'test-key', (c) => {
    c.llmPort = fakeLlm('[]')
  })
  assert.equal((await startEntry(noModel.root)).segment.route, 'no-default-model')

  // And the shipped default is on, because the whole point of the feature is the case the
  // deterministic splitter cannot see.
  const shipped = await mount({}, 'test-key', (c) => {
    c.llmPort = fakeLlm('[]')
    c.defaultModelSelection = { provider: 'p', model: 'test-model' }
  })
  const start = await startEntry(shipped.root)
  assert.equal(start.segment.enabled, true)
  assert.equal(start.segment.route, 'p/test-model')
})

test('the segmentation budget is clamped inside the write budget', async () => {
  // It shipped at 8s by default, borrowed from the canonical pass (which runs after the deadline).
  // Eight seconds inside a 2.5s hook does not mean "segmentation falls back" — it means the turn's
  // write is abandoned, which is a worse failure than the one the setting was meant to avoid.
  const { root } = await mount(
    { segment: { enabled: true, timeoutMs: 8000 }, writeTimeoutMs: 2500 },
    'test-key',
    (c) => {
      c.llmPort = fakeLlm('[]')
      c.defaultModelSelection = { provider: 'p', model: 'test-model' }
    },
  )
  const start = await startEntry(root)
  const segment = (start as { segment?: { budgetMs?: number } }).segment
  assert.ok(segment, 'the start line reports the segment state')
  // 1600ms with the shipped 2500ms budget: measured segmentation latency is a median 851ms / max
  // 1271ms, the judge a median 342ms, so the rest of the turn still fits.
  assert.equal(segment!.budgetMs, 1600, 'the segment budget leaves room for the judge and the write')
})

test('a segmentation the model refuses falls back to the punctuation splitter', async () => {
  // Fail-open in the only direction that is safe: the write path must never depend on a network
  // round trip, so a refusal leaves today's behaviour exactly as it was.
  const { captured } = await mount(
    { judge: 'auto', segment: { enabled: true } },
    'test-key',
    (c) => {
      c.llmPort = fakeLlm('我觉得这段可以切一下。')
      c.defaultModelSelection = { provider: 'p', model: 'test-model' }
    },
  )
  const session = fakeSession({ events: TURN_EVENTS })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session }, turn: 1, signal: undefined })
  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  assert.equal(
    promoted(await search.execute({ query: 'pnpm' }, { agent: { session } })).length,
    1,
    'the deterministic splitter still produced the candidate',
  )
})

test('injection uses the canonical form only when it is switched on', async () => {
  // Recording and injecting are separate decisions: the first is a convenience, the second
  // changes what the model is shown, so it waits for a person to read samples.
  const recorded = await mount({}, undefined, (c) => {
    c.llmPort = fakeLlm('必须使用 pnpm 管理依赖。')
    c.defaultModelSelection = { provider: 'p', model: 'test-model' }
  })
  const sessionA = fakeSession({ events: TURN_EVENTS })
  await toolFor<WriteArgs, MemoryWriteResult>(recorded.captured, 'memory_write').execute(
    { text: '必须用 pnpm 管理依赖，这是团队约定。', type: 'constraint' },
    { agent: { session: sessionA } },
  )
  await settle()
  const injected = recorded.captured.contexts[0]!.text({ agent: { session: sessionA } })
  assert.match(injected, /必须用 pnpm/u, 'the verbatim sentence is what gets injected by default')
  assert.doesNotMatch(injected, /必须使用 pnpm/u)

  const injecting = await mount({ normalize: { inject: true } }, undefined, (c) => {
    c.llmPort = fakeLlm('必须使用 pnpm 管理依赖。')
    c.defaultModelSelection = { provider: 'p', model: 'test-model' }
  })
  const sessionB = fakeSession({ events: TURN_EVENTS })
  await toolFor<WriteArgs, MemoryWriteResult>(injecting.captured, 'memory_write').execute(
    { text: '必须用 pnpm 管理依赖，这是团队约定。', type: 'constraint' },
    { agent: { session: sessionB } },
  )
  await settle()
  assert.match(injecting.captured.contexts[0]!.text({ agent: { session: sessionB } }), /必须使用 pnpm/u)
})

test('with no route the canonical pass simply does not happen', async () => {
  const { root, captured } = await mount()
  const session = fakeSession({ events: TURN_EVENTS })
  await toolFor<WriteArgs, MemoryWriteResult>(captured, 'memory_write').execute(
    { text: '必须用 pnpm 管理依赖，这是团队约定。', type: 'constraint' },
    { agent: { session } },
  )
  await settle()
  const document = JSON.parse(await readFile(join(root, 'memory.json'), 'utf8')) as {
    records?: Array<Record<string, unknown>>
  }
  assert.equal((document.records ?? [])[0]?.canonical ?? null, null)
  assert.equal((await ledgerEntries(root)).filter((entry) => entry.kind === 'normalize').length, 0)
  // Reported once at mount instead of once per write: a deployment without the service
  // should not have to read a failure line for every memory it ever stores.
  const start = await startEntry(root)
  assert.deepEqual(start?.normalize, { enabled: true, inject: false, ready: false, provider: null, model: null })
})

/**
 * A fake `llm` service that answers the write path with one thing and anything else with another.
 *
 * Needed because `writeMode: 'model'` puts three callers on the same service — the write call, the
 * segmenter and the canonical pass — and a single fixed answer would make the test unable to say
 * which call it was checking.
 */
function llmRouting(writeAnswer: string, otherAnswer = '规范化后的句子。'): unknown {
  return {
    stream: (options: { system?: string }) =>
      (async function* () {
        yield { type: 'text-delta', text: options.system?.includes('长期记忆') ? writeAnswer : otherAnswer }
        yield { type: 'finish' }
      })(),
  }
}

test('writeMode: model writes a requirement the local type whitelist refuses, and pipeline does not', async () => {
  // Taken verbatim from the labelled corpus. The local rule types it `procedure` because of the word
  // 流程, `procedure` is not a memory type, and so `applyGate` refuses a real requirement — by matching
  // a keyword, not by understanding it. 8 of the corpus's 21 positives die the same way, which is the
  // measured reason the model path exists rather than a threshold change to the rules.
  const sentence = '顺便我觉得这个配置流程应该再简化一下。'

  const pipeline = await mount({ writeMode: 'pipeline', segment: { enabled: false } })
  await listenerFor(pipeline.captured, 'agent/turn-stopping')({
    agent: { id: 's1', session: fakeSession({ events: turnWith(sentence) }) },
    turn: 1,
    signal: undefined,
  })
  const refused = await toolFor<SearchArgs, MemorySearchResult>(pipeline.captured, 'memory_search').execute(
    { query: '配置流程简化' },
    { agent: { session: fakeSession({ events: [] }) } },
  )
  assert.equal(promoted(refused).length, 0, 'the deterministic type rule has no memory type for 流程')
  assert.ok(
    (await ledgerEntries(pipeline.root)).some(
      (entry) => entry.kind === 'skip' && entry.reason === 'type-disabled:procedure',
    ),
    'and the ledger names the rule that refused it',
  )

  const model = await mount({ writeMode: 'model' }, undefined, (c) => {
    c.llmPort = llmRouting(
      JSON.stringify([{ message: 0, text: sentence, who: 'user', worth: true, type: 'constraint' }]),
    )
    c.defaultModelSelection = { provider: 'p', model: 'test-model' }
  })
  const session = fakeSession({ events: turnWith(sentence) })
  await listenerFor(model.captured, 'agent/turn-stopping')({ agent: { id: 's1', session }, turn: 1, signal: undefined })

  const found = await toolFor<SearchArgs, MemorySearchResult>(model.captured, 'memory_search').execute(
    { query: '配置流程简化' },
    { agent: { session } },
  )
  assert.equal(promoted(found).length, 1, 'the same sentence, decided by the call instead of the keyword')
  assert.equal(promoted(found)[0]!.text, sentence)
  // The type stored is the one the gate acted on. Storing the local hint instead would write a
  // record that recall then filters out, which is a failure no search-based assertion would see.
  const document = JSON.parse(await readFile(join(model.root, 'memory.json'), 'utf8')) as {
    records?: Array<Record<string, unknown>>
  }
  assert.equal((document.records ?? [])[0]?.type, 'constraint')

  const writePath = (await ledgerEntries(model.root)).find((entry) => entry.kind === 'write-path')
  assert.equal(writePath?.reason, 'ok')
  assert.equal(writePath?.mode, 'model')
  assert.equal(writePath?.kept, 1)
  assert.equal((await startEntry(model.root))?.modelWrite?.route, 'p/test-model')
})

test('the model path keeps only what the person said and called worth remembering', async () => {
  // The triple that was measured (F1 0.69 over 120 rows): attributed to the person, worth
  // remembering, typed as a memory. Each of the three is pinned by a case that would be written if
  // the rule were only "the model returned an item".
  const own = '状态机的边界情况我们决定先不做。'
  const pasted = '这个模块的报错信息最好带上上下文。'
  const message = `${own}${pasted}`
  const { root, captured } = await mount({ writeMode: 'model' }, undefined, (c) => {
    c.llmPort = llmRouting(
      JSON.stringify([
        { message: 0, text: own, who: 'user', worth: true, type: 'decision' },
        { message: 0, text: pasted, who: 'pasted', worth: true, type: 'constraint' },
        { message: 0, text: pasted, who: 'user', worth: true, type: 'other' },
      ]),
    )
    c.defaultModelSelection = { provider: 'p', model: 'test-model' }
  })
  const session = fakeSession({
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: message }] } },
    ],
  })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session }, turn: 1, signal: undefined })

  const search = toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search')
  assert.equal(promoted(await search.execute({ query: '边界情况先不做' }, { agent: { session } })).length, 1)
  assert.equal(
    promoted(await search.execute({ query: '报错信息带上上下文' }, { agent: { session } })).length,
    0,
    'the block was returned twice: once attributed to someone else, once typed as not-a-memory',
  )
  const writePath = (await ledgerEntries(root)).find((entry) => entry.kind === 'write-path')
  assert.equal(writePath?.items, 3)
  assert.equal(writePath?.kept, 1)
  // Two numbers, not one, because the two refusals mean different things. `worth - kept` is the type
  // whitelist still refusing a sentence the model said was worth keeping — on the labelled corpus
  // that is 8 of 21 positives, and it is the count to watch if the whitelist is ever revisited.
  assert.equal(writePath?.worth, 2, 'the model said two of them were worth remembering')
  assert.equal(writePath?.kept, 1, 'and one of those was typed as a memory')
})

test('a model answer that is not verbatim falls back to the deterministic path, and still writes', async () => {
  // The failure the verbatim rule exists for: the model rewrites the sentence while quoting it
  // (measured: 22% of its items, one of them changing 集成 to 继承 — a different claim, stored under
  // the person's name). A refusal must not cost the turn, so the deterministic path runs instead —
  // and it must not call the segmenter to do it, because two round trips do not fit the budget.
  const sentence = '必须把端口固定成 8000。'
  const { root, captured } = await mount({ writeMode: 'model' }, undefined, (c) => {
    c.llmPort = llmRouting(
      JSON.stringify([{ message: 0, text: '必须把端口固定为 8000。', who: 'user', worth: true, type: 'constraint' }]),
    )
    c.defaultModelSelection = { provider: 'p', model: 'test-model' }
  })
  const session = fakeSession({ events: turnWith(sentence) })
  await listenerFor(captured, 'agent/turn-stopping')({ agent: { id: 's1', session }, turn: 1, signal: undefined })

  const found = await toolFor<SearchArgs, MemorySearchResult>(captured, 'memory_search').execute(
    { query: '端口固定成 8000' },
    { agent: { session } },
  )
  assert.equal(promoted(found).length, 1, 'the turn is slower, not lost')
  assert.equal(promoted(found)[0]!.text, sentence, "and what is stored is the person's characters")
  const writePath = (await ledgerEntries(root)).find((entry) => entry.kind === 'write-path')
  assert.equal(writePath?.ok, false)
  assert.equal(writePath?.reason, 'all-refused')
  assert.equal((await ledgerEntries(root)).filter((entry) => entry.kind === 'segment').length, 0, 'no second attempt')
})
