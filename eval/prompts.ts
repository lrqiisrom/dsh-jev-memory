/**
 * Print the exact text this plugin sends outbound, verbatim, from the real builders.
 *
 * Copying prompts into a doc makes them drift; the only trustworthy answer to "what
 * did you actually send" is the code that sends it. Run:
 *
 *   node eval/prompts.ts            # all four
 *   node eval/prompts.ts segment    # just the segmentation request
 *   node eval/prompts.ts write      # just the summarise request
 *   node eval/prompts.ts jev        # just the Jev request body
 *   node eval/prompts.ts ask        # just the question put to the human
 *
 * The example conversation is fixed, so two runs are byte-identical and a change in
 * any prompt shows up as a diff here.
 *
 * @module eval/prompts
 */

import { SEGMENT_SYSTEM, buildSegmentPrompt } from '../dsh/lib/segment.ts'
import { MODEL_WRITE_SYSTEM, buildModelWritePrompt } from '../dsh/lib/modelwrite.ts'
import { buildRequestBody, REMEMBER_QUESTION, JEV_DEFAULTS } from '../dsh/lib/jev.ts'
import { buildConflictQuestion } from '../dsh/lib/conflict.ts'

/** Which block to print; no argument means all of them. */
const only = process.argv[2] ?? null
const wants = (name: string): boolean => only === null || only === name

/** A fixed four-message window: two human turns, two answers in between. */
const window = [
  { seq: 1, role: 'user', text: '帮我把 report 脚本的输出目录换成 data/ 下面' },
  { seq: 2, role: 'assistant', text: '已改成写 data/reports/。' },
  { seq: 3, role: 'user', text: '可以随便改 data/ 目录下的文件，不用问我' },
  { seq: 4, role: 'assistant', text: '好，之后 data/ 下的文件我直接改。' },
]

if (wants('segment')) {
console.log('#'.repeat(78))
console.log('① 分段 segment —— 决定哪些消息可以拿去抽记忆')
console.log('#'.repeat(78))
console.log('--- system ---')
console.log(SEGMENT_SYSTEM)
console.log('--- user ---')
console.log(buildSegmentPrompt(window))
}

if (wants('write')) {
console.log('#'.repeat(78))
console.log('② 总结 modelwrite —— 把原文改写成一句第三人称的记忆')
console.log('#'.repeat(78))
console.log('--- system ---')
console.log(MODEL_WRITE_SYSTEM)
console.log('--- user ---')
console.log(buildModelWritePrompt(window))
}

if (wants('jev')) {
console.log('#'.repeat(78))
console.log('③ Jev —— 一次请求问完所有候选')
console.log('#'.repeat(78))
const body = buildRequestBody({
  model: 'jev-latest',
  candidates: [
    { key: 'c0', text: '可以随便改 data/ 目录下的文件', hintedType: 'constraint', signalScore: 0.5, signals: ['/不要/u'] },
    { key: 'c1', text: 'report 脚本的输出改到 data/reports/', hintedType: 'decision', signalScore: 0.4, signals: [] },
  ],
  types: ['constraint', 'pitfall', 'decision'],
  known: ['不要改动 data/ 目录下的任何文件。', '提交信息用中文写。'],
  partners: ['不要改动 data/ 目录下的任何文件。', null],
  importanceLevels: JEV_DEFAULTS.importanceLevels,
  rememberQuestion: REMEMBER_QUESTION,
  project: '/Users/rom/Documents/projectSDK',
  conversation: ['帮我把 report 脚本的输出目录换成 data/ 下面', '可以随便改 data/ 目录下的文件，不用问我'],
})
console.log(JSON.stringify(body, null, 2))
}

if (wants('ask')) {
  // The only message that goes to the *person* rather than to a model. Both sides are quoted
  // verbatim and dated, because the person is being asked to overrule their own past statement
  // and must see exactly what each side said.
  //
  // The record id here is the *real* shape — a folded signature, where numbers became `<n>` and
  // quoted strings became `<str>` — because that is what the first live card printed. An earlier
  // version of this file made up a tidy-looking `mem_7f3a91`, which hid the one defect the example
  // existed to expose. An example that is prettier than the system is a lie about the system.
  console.log('#'.repeat(78))
  console.log('④ HITL —— 问人的那句话（只在"拿不准"的中段出现）')
  console.log('#'.repeat(78))
  console.log(JSON.stringify(
    buildConflictQuestion(
      {
        incoming: '用户定了关系判定三选一规则：同一条规矩的新说法则新替换旧（旧的留档不再注入）、完全同义则新不记、不同规矩则两条都留。',
        existing: {
          id: '<n>.<n> 到 <n>.<n>（它拿不准） → 先入库但标成<str>（不注入），然后问你，三选一：用新的覆盖旧的 / 保留旧的那条 / 两条都留着；',
          text: '0.3 到 0.7（它拿不准） → 先入库但标成"待确认"（不注入），然后问你，三选一：用新的覆盖旧的 / 保留旧的那条 / 两条都留着；',
          createdAt: Date.parse('2026-10-05T09:38:19Z'),
        },
        score: 0.323,
        shared: ['三', '选', '一', '的', '旧', '注入', '不', '两'],
      } as never,
      '用户定了关系判定三选一规则：同一条规矩的新说法则新替换旧（旧的留档不再注入）、完全同义则新不记、不同规矩则两条都留。',
    ),
    null,
    2,
  ))
  console.log('\n--- 渲染出来给人看的样子 ---\n')
  const card = buildConflictQuestion(
    {
      incoming: '用户定了关系判定三选一规则：同一条规矩的新说法则新替换旧（旧的留档不再注入）、完全同义则新不记、不同规矩则两条都留。',
      existing: {
        id: '<n>.<n> 到 <n>.<n>（它拿不准） → 先入库但标成<str>（不注入），然后问你，三选一：用新的覆盖旧的 / 保留旧的那条 / 两条都留着；',
        text: '0.3 到 0.7（它拿不准） → 先入库但标成"待确认"（不注入），然后问你，三选一：用新的覆盖旧的 / 保留旧的那条 / 两条都留着；',
        createdAt: Date.parse('2026-10-05T09:38:19Z'),
      },
      score: 0.323,
      shared: ['三', '选', '一', '的', '旧', '注入', '不', '两'],
    } as never,
    'incoming-id',
  )
  console.log(card.header)
  console.log(card.question)
  console.log('')
  console.log(card.detail)
  console.log('')
  card.options.forEach((option, at) => console.log(`  ${at + 1}. ${option.label}    ${option.description}`))
}
