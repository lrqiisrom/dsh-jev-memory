import assert from 'node:assert/strict'
import { test } from 'node:test'

import { blocksToText, clip, clipAtClause, estimateTokens, hashText, looksInterrogative, normalize, splitSentences } from '../dsh/lib/text.ts'
import {
  DECISION_ASSERTION_PATTERNS,
  isNoise,
  isNoteworthyVeto,
  matchTypeSignals,
  screenSentence,
  signatureOf,
  stripPastedPrefixes,
} from '../dsh/lib/signals.ts'

test('blocksToText keeps only text blocks', () => {
  const content = [
    { type: 'reasoning', text: 'internal thinking' },
    { type: 'text', text: '必须用 pnpm。' },
    { type: 'tool-call', name: 'bash' },
  ]
  assert.equal(blocksToText(content), '必须用 pnpm。')
  assert.equal(blocksToText('plain'), 'plain')
  assert.equal(blocksToText(undefined), '')
})

test('splitSentences splits CJK and latin prose and keeps the terminator', () => {
  assert.deepEqual(splitSentences('必须用 pnpm。不要用 npm！'), ['必须用 pnpm。', '不要用 npm！'])
  assert.deepEqual(splitSentences('one. two?'), ['one.', 'two?'])
  assert.deepEqual(splitSentences('第一行\n第二行'), ['第一行', '第二行'])
})

test('clip and normalize collapse whitespace and bound length', () => {
  assert.equal(normalize('  a \n  b  '), 'a b')
  assert.equal(clip('x'.repeat(10), 5).length, 5)
  assert.ok(clip('x'.repeat(10), 5).endsWith('…'))
})

test('clipAtClause ends a clipped memory on a clause, not mid-word', () => {
  // The person marked several rows `?` with "上下文并不完整": those were cut at exactly 240
  // characters, mid-clause, and a fragment cannot be judged.
  const chinese =
    '你之前还说选一个场景呢：方案 A 定位成 B2B API 产品客服（改动最小）换掉 KnowledgeBase._load_default_docs() 里的零售文档，改成加载 sample_knowledge.js，然后再跑一遍评测'
  const cutChinese = clipAtClause(chinese, 60)
  assert.ok(cutChinese.endsWith('…'))
  assert.equal(cutChinese.includes('KnowledgeBase._lo'), false, 'must not cut inside the identifier')

  // The strongest boundary wins even when a weaker one sits closer to the limit: the `.`
  // inside an identifier used to count as a sentence end, so the cut looked clause-aware
  // and was still mid-word. Here the `，` is later, and the `。` still wins.
  assert.equal(
    clipAtClause('前面铺垫足够长的一句话内容内容内容内容内容。后面还有一点补充说明的句子', 25),
    '前面铺垫足够长的一句话内容内容内容内容内容。…',
  )
  // A boundary inside the first half is refused: trimming a 240-character budget down to a
  // handful of characters costs more than the ragged edge it removes. With `。` at index 6
  // and `，` at 12, a 30-character budget keeps the hard cut; at 20 the `，` is past halfway
  // and the cut lands there instead.
  const ladder = '第一句结束了。然后是第二句，这里还有一点别的也许可以再多写几个字凑够长度'
  assert.equal(clipAtClause(ladder, 30), `${ladder.slice(0, 29)}…`)
  assert.equal(clipAtClause(ladder, 20), '第一句结束了。然后是第二句，…')
  // Nothing to cut on at all: fall back to the hard cut rather than trim to nothing.
  assert.equal(clipAtClause('x'.repeat(50), 20), `${'x'.repeat(19)}…`)
  // Under the limit nothing happens at all.
  assert.equal(clipAtClause('端口固定 8000。', 60), '端口固定 8000。')
})

test('hashText folds case so restatements dedup', () => {
  assert.equal(hashText('必须用 PNPM'), hashText('必须用 pnpm'))
})

test('looksInterrogative separates questions from statements', () => {
  assert.equal(looksInterrogative('为什么必须用 pnpm？'), true)
  assert.equal(looksInterrogative('必须用 pnpm。'), false)
  assert.equal(looksInterrogative('why must we use pnpm'), true)
})

// The second live false positive: a question with no question mark, starting with
// a URL, was stored as a `constraint`.
test('looksInterrogative catches Chinese questions without a question mark', () => {
  assert.equal(looksInterrogative('这个 dsh 的插件难道只能用 js 写吗'), true)
  assert.equal(
    looksInterrogative('https://github.com/zilliztech/memsearch 参考这个吧 我看这个插件的语言都是 python 多一点，这个 dsh 的插件难道只能用 js 写吗'),
    true,
  )
  assert.equal(looksInterrogative('必须用 pnpm 吗'), true)
  assert.equal(looksInterrogative('这个方案是不是更好'), true)
  assert.equal(looksInterrogative('我们是不是该换个思路'), true)
  assert.equal(looksInterrogative('必须用 pnpm 管理依赖，这是团队约定。'), false)
  assert.equal(looksInterrogative('不要改动 data/ 目录下的任何文件。'), false)
})

test('estimateTokens over-counts CJK and never returns zero for text', () => {
  assert.equal(estimateTokens('中文四个字'), 5)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens(''), 0)
})

test('the imperative 别 needs a verb, not just the character', () => {
  // Found by running one message through the real pipeline: "端口别乱改啊，定 8000 了" — the
  // example the design notes call *the* memory worth keeping — typed as `fact` and was then
  // refused by the write gate's type whitelist. The bare `/别/` is not the fix: measured on the
  // 181 decided rows it rescues one and admits seven, because 分别, 别人 and 区别 all contain
  // the character. The narrow form costs nothing on that corpus and catches this case.
  assert.equal(matchTypeSignals('端口别乱改啊，定 8000 了。').type, 'constraint')
  assert.equal(matchTypeSignals('服务端口固定用 8000，别乱改').type, 'constraint')
  for (const sentence of ['hinted_type 有几种类型，分别解释一下', '所以实现别的 agent 只需要定义子 agent 吗', '这两条有什么区别']) {
    assert.notEqual(matchTypeSignals(sentence).type, 'constraint', sentence)
  }
})

test('matchTypeSignals picks the most specific family first', () => {
  assert.equal(matchTypeSignals('必须用 pnpm 而不是 npm').type, 'constraint')
  assert.equal(matchTypeSignals('这个命令会报错').type, 'pitfall')
  assert.equal(matchTypeSignals('我们决定用 SQLite').type, 'decision')
  assert.equal(matchTypeSignals('今天天气不错').type, null)
})

test('isNoise drops acknowledgements only', () => {
  assert.equal(isNoise('好的'), true)
  assert.equal(isNoise('继续'), true)
  assert.equal(isNoise('必须用 pnpm'), false)
})

test('signatureOf collapses ids, numbers and paths for dedup', () => {
  assert.equal(
    signatureOf('read 失败：ENOENT: /a/b/c.txt at 12345'),
    signatureOf('read 失败：ENOENT: /a/d/e.txt at 99999'),
  )
  assert.notEqual(signatureOf('read 失败：EPERM'), signatureOf('bash 失败：EPERM'))
})

// These three sentences are the real false positives from the first live run:
// a delegated child's task prompt was written as `constraint` memories.
test('screenSentence rejects task instructions that the type signals matched', () => {
  assert.deepEqual(screenSentence('请严格按下面步骤操作，不要做任何额外的事。'), { keep: false, reason: 'task-instruction' })
  assert.deepEqual(screenSentence('把第 2、3 步两个工具调用返回的原始结果（JSON 或文本，原样）贴出来，不要改写、不要总结成自己的话。'), {
    keep: false,
    reason: 'task-instruction',
  })
  assert.equal(screenSentence('回复一行：TOOLS AVAILABLE 或 TOOLS UNAVAILABLE。').keep, false)
  assert.equal(screenSentence('先看你当前可用的工具列表里是否有 memory_write 工具。').keep, false)
})

test('screenSentence rejects serialized tool calls and code payloads', () => {
  assert.deepEqual(screenSentence('调用 `memory_write`，参数：{"text": "语言不要选 Java", "type": "constraint"}'), {
    keep: false,
    reason: 'payload',
  })
  assert.equal(screenSentence('配置长这样：```yaml\n- id: x\n```').keep, false)
})

test('screenSentence keeps real constraints that look imperative', () => {
  for (const sentence of [
    '必须用 pnpm 管理依赖，这是团队约定。',
    '不要改动 data/ 目录下的任何文件。',
    '这个命令会清空缓存，注意别在生产库上跑。',
    '我们决定用 SQLite 而不是 Postgres，只在自己机器上跑。',
  ]) {
    assert.deepEqual(screenSentence(sentence), { keep: true, reason: null }, sentence)
  }
})

// Not hypothetical: the user pasted a real key inside an ordinary sentence, and
// that sentence passes every other screen. A memory is injected into every later
// session, so a secret written once leaks forever.
test('screenSentence vetoes secrets before anything else can accept them', () => {
  assert.deepEqual(
    screenSentence(
      'TypeSafe key: apikey_0123456789abcdef0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ),
    { keep: false, reason: 'secret' },
  )
  assert.equal(screenSentence('把 token 设置成 sk-abcdefghijklmnopqrstuvwxyz123456').keep, false)
  assert.equal(screenSentence('password: hunter2hunter2').keep, false)
  assert.equal(screenSentence('Authorization: Bearer abcdefghijklmnop').keep, false)
  assert.equal(screenSentence('必须用 pnpm 管理依赖。').keep, true)
})

// The fourth live mis-write class: sentences that ask *the agent* to explain or do
// something right now. They are imperative, they often contain 不要, and they were
// all stored as project constraints.
test('screenSentence vetoes requests addressed to the agent', () => {
  for (const sentence of [
    '先不急着重启，你先说说整体的设计，和你已经测试的结果是什么',
    '你完整说一下怎么测的',
    '解释一下这段代码为什么这么写',
    '告诉我这个文件在哪',
    '麻烦你先看一下日志再动手',
  ]) {
    const decision = screenSentence(sentence)
    assert.equal(decision.keep, false, sentence)
    assert.equal(decision.reason, 'task-instruction', sentence)
  }
})

test('an explicit request to remember overrides the request screen', () => {
  assert.deepEqual(screenSentence('帮我记住：不要改动 data/ 目录下的文件。'), { keep: true, reason: null })
  assert.deepEqual(screenSentence('记住必须用 pnpm 管理依赖。'), { keep: true, reason: null })
  assert.deepEqual(screenSentence('别忘了端口固定 8000。'), { keep: true, reason: null })
})

test('a question phrased with 是什么 is still a question', () => {
  assert.equal(looksInterrogative('重启的命令是什么'), true)
  assert.equal(looksInterrogative('这个项目有哪些约定'), true)
  assert.equal(looksInterrogative('入口在哪里'), true)
  assert.equal(looksInterrogative('入口是 api/main.py。'), false)
  assert.equal(looksInterrogative('必须用 pnpm 管理依赖。'), false)
})

test('a pasted transcript line is not the user speaking', () => {
  // Measured on the labelled corpus before this rule existed: 9 of 38 rows were
  // transcript lines and the person marked all 9 "do not remember". The plugin was
  // memorizing questions an interviewer had asked, inside an interview being
  // rehearsed.
  assert.deepEqual(screenSentence('面试官:我们就是做了假，假设啊，假设你当你是当时在设计这个方案嘛。'), {
    keep: false,
    reason: 'transcript',
  })
  assert.deepEqual(screenSentence('你:呃，collation呢，我们有一个指标是它的一个成功率的一个指标。'), {
    keep: false,
    reason: 'transcript',
  })
  assert.equal(isNoteworthyVeto('transcript'), true, 'a pasted batch is worth counting')

  // A first-person statement is untouched: the label needs the colon to be a
  // transcript marker, so an ordinary sentence that happens to start with 我 or a
  // code label that reads like prose survives.
  assert.deepEqual(screenSentence('我明确一下，语言不要选 Java，所以 DSH 的 Java Native 插件方案不做。'), { keep: true, reason: null })
  assert.deepEqual(screenSentence('我认为：端口固定 8000 比较合适。'), { keep: true, reason: null })
})

test('a pasted code line or markdown remnant is refused as a fragment', () => {
  // Each of these was measured against the labelled rows first: every one rejects at
  // least one row and none of them rejects a row marked "remember".
  assert.deepEqual(screenSentence('// volatile 不能省！'), { keep: false, reason: 'fragment' })
  assert.equal(screenSentence('if (instance == null) { // 必须有人调用才进这里').keep, false)
  assert.equal(screenSentence('const cache = new Map<string, number>()').keep, false)
  assert.equal(screenSentence('** --- # 六、注意：captured 和 committed 不是一回事').keep, false)
  assert.equal(isNoteworthyVeto('fragment'), true, 'a pasted fragment is worth counting')
})

test('the two fragment rules the measurement rejected stay out', () => {
  // Both of these are labelled "remember" in the corpus. They are keepers with a dirty
  // prefix, so the answer is to clean the text rather than to drop the memory — and a
  // rule that dropped them would have destroyed exactly what the plugin is for.
  assert.deepEqual(screenSentence('\\end{itemize} 请你按照这个格式去写简历，测试部分的先不要说'), { keep: true, reason: null })
  assert.equal(
    screenSentence('此外这个agent框架 还有一个sandbox的封装（dsl coding没用到），如图： /var/folders/6t/x').keep,
    true,
  )

  // And the ordinary sentences must survive the boundary cases: a `#` reference is not
  // a markdown heading, and a colon is not a code line.
  assert.deepEqual(screenSentence('参考 #83 那条，端口固定 8000。'), { keep: true, reason: null })
  assert.deepEqual(screenSentence('必须用 pnpm 管理依赖，不要用 npm。'), { keep: true, reason: null })
  assert.deepEqual(screenSentence('提交前必须保证 node --test test/*.test.ts 全绿。'), { keep: true, reason: null })
})

test('a pasted prefix is stripped, and it no longer decides the verdict', () => {
  // The content behind the residue is real — that is why this is cleaning, not a screen.
  assert.equal(stripPastedPrefixes('\\end{itemize} 此外这个agent框架 还有一个sandbox的封装'), '此外这个agent框架 还有一个sandbox的封装')
  assert.equal(stripPastedPrefixes('\\item 端口固定 8000'), '端口固定 8000')
  // An ephemeral path becomes the placeholder the signature already uses, so the text
  // still shows that something was elided. A general path is left alone: a config file
  // path can be the whole point of a memory.
  assert.equal(
    stripPastedPrefixes('如图： /var/folders/6t/abc/T/modlens-dsh-paste-Ulvt1u/paste.png 你可以分析一下'),
    '如图： <path> 你可以分析一下',
  )
  assert.equal(stripPastedPrefixes('配置在 /etc/app/config.yaml'), '配置在 /etc/app/config.yaml')

  // A bare list ordinal glued to the end of the sentence before it: the person writes
  // "…问题：" and then a numbered list, and the splitter leaves the ordinal behind. 8
  // labelled rows end this way. Screening them was measured and rejected — one of the 8 is
  // marked "remember", so the rule would have destroyed a real requirement to delete four
  // characters. Cleaning them keeps all 8.
  assert.equal(
    stripPastedPrefixes('第一个项目的源码，我明天会给你，有了这个上下文会更全面 2.'),
    '第一个项目的源码，我明天会给你，有了这个上下文会更全面',
  )
  assert.equal(
    stripPastedPrefixes('我觉得我需要明确一下，简历应该在对话栏这边可以选择哪个简历 2.'),
    '我觉得我需要明确一下，简历应该在对话栏这边可以选择哪个简历',
  )
  // But a sentence that is *only* an ordinal keeps it: stripping would leave nothing, and an
  // empty candidate is a different bug from a dirty one.
  assert.equal(stripPastedPrefixes('1.'), '1.')

  // The half that matters: with the residue gone, the existing task-instruction screen
  // can finally see the sentence for what it is. Before this, `\end{itemize}` in front of
  // a one-off instruction *changed* the screen's verdict, which is the prefix deciding
  // policy rather than the sentence.
  assert.deepEqual(
    screenSentence('请你按照这个格式去写简历，测试部分的先不要说，我后面会补评测，先只说技术亮点'),
    { keep: false, reason: 'task-instruction' },
  )
})

test('a question whose marker sits mid-sentence is still a question', () => {
  // The splitter does not break on `，`, and every anchored pattern needs the marker at the
  // start or the end, so this reached the judge as if it were a statement. Measured on the
  // 38 labelled rows: the anchored screen rejected *none* of the questions the person had
  // marked "just a question".
  assert.equal(
    screenSentence('能说一下一次mcp调用的流程吗，然后mcp是在function calling上面做了个什么层面的限制和封装').keep,
    false,
  )
  assert.equal(screenSentence('mysql执行查询操作的时候会经历哪些步骤').keep, false)
})

test('a requirement that merely contains a question word is not a question', () => {
  // Both of these are labelled "remember" in the corpus, and unanchored markers alone
  // rejected them — measured: 12 rejections including these 2. Requiring the absence of an
  // instruction shape rejects 7 and none marked remember.
  assert.deepEqual(
    screenSentence('我要求你说设计是怎么设计的，一些变量名啊什么东西的不要说出来，你就说流程就行了。'),
    { keep: true, reason: null },
  )
  assert.deepEqual(
    screenSentence('简历上原本这么写的应该可以优化吧，你觉得怎么写简历好点，请你一定要根据代码事实来，不要凭空捏造'),
    { keep: true, reason: null },
  )
  // And the anchored behaviour is unchanged for questions that end in a particle.
  assert.deepEqual(screenSentence('这个项目有哪些约定'), { keep: false, reason: 'question' })
})

test('a question that also states a decision is not screened out', () => {
  // Both rows are labelled "remember" and both were rejected as questions. Measured on the
  // 165 decided rows: this exemption rescues both and admits no row marked "don't remember"
  // (precision 20% → 21%, recall 90% → 100%). Loosening the anchored screen to "also require
  // no instruction shape" rescues one and admits 18.
  assert.deepEqual(
    screenSentence('对抗复核、误改率、规则贡献率 这玩意换个场景也不一定就适用啊 我再次申明一点哈，这个能不能改成通用的框架？'),
    { keep: true, reason: null },
  )
  assert.deepEqual(
    screenSentence('你觉得需要有JD的这部分吗，我觉得不需要吧，有些jd就写的很笼统很模糊，而且我是计算机专业的，jd一般都长差不多'),
    { keep: true, reason: null },
  )
  assert.deepEqual(screenSentence('我觉得不是，你用AST和AST+LSP去进行代码评审，他们的误报率肯定是大有不同的。'), {
    keep: true,
    reason: null,
  })
  // A decision about something else does not license the question itself: without a decision
  // assertion these stay rejected, which is what keeps the exemption from becoming a hole.
  assert.deepEqual(screenSentence('这个面试记录里面各个问题的评分是怎么评的？'), { keep: false, reason: 'question' })
  assert.deepEqual(screenSentence('jev是不是可以用于HITL？'), { keep: false, reason: 'question' })
})

test('the decision exemption is narrow enough to name every word it matches', () => {
  // The list was read off two rows, so it is deliberately small. This test fails the moment
  // someone adds a broad marker like 我觉得 on its own — which would readmit the questions
  // the previous test pins as rejected.
  const fires = (sentence: string): boolean =>
    DECISION_ASSERTION_PATTERNS.some((pattern) => pattern.test(sentence))
  for (const sentence of ['我再次申明一点', '我觉得不需要吧', '我认为不用改', '我要求不要动这个文件', '我们决定用 pnpm', '不需要吧', '不用吧']) {
    assert.equal(fires(sentence), true, sentence)
  }
  for (const sentence of ['我觉得这个方案还需要再讨论一下', '我认为这个改动挺大的', '我们决定了吗', '这个需要吗']) {
    assert.equal(fires(sentence), false, sentence)
  }
})
