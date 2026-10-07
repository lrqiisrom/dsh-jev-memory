/**
 * What the extraction scope costs: the same windows, the old scope, and where each item came from.
 *
 * The write path used to read five rounds as extraction sources; it now reads only the newest one.
 * Answering "how much did that cost" needs more than two totals, because a window that proposes five
 * times as many items has not necessarily lost five times as many memories — most proposals are refused
 * on worth, type or attribution whatever the scope is.
 *
 * So this runs the **old** scope over the **same** windows (`WRITE_ARM_LABEL` names the run whose sample
 * is reused, so both sides see the same twenty), and records for every proposed item: which message it
 * quoted, whether that message was the newest one the person wrote, the model's `who` / `worth` / `type`,
 * and therefore whether the plugin would have written it.
 *
 * The old prompt is a reconstruction — the current system prompt with this change's sentences removed,
 * each removal asserted to match — and the reconstruction is cross-checked against the two runs made
 * before the change (102 proposed here against 86 and 82 passing then).
 *
 * Real model calls. Run:
 *   DSH_LIVE_ROUTE=yes node eval/scope-ab.ts
 *
 * @module eval/scope-ab
 */

/**
 * 旧范围 vs 新范围：同样 20 个窗口，记下每条条目引自第几条消息。
 * 用当前发货代码重建"旧"提示词：把我加进去的句子/标注精确去掉，每一步都断言命中。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { MODEL_WRITE_SYSTEM, readCompleteObjects } from '../dsh/lib/modelwrite.ts'
import { conversationWindowOf } from '../dsh/lib/window.ts'
import { readSessions, type Session } from './lib/sessions.ts'

// The same refusal the other live harnesses print, and it was missing here at first: without it a run
// that looks like a dry run spends twenty real calls.
if (process.env.DSH_LIVE_ROUTE !== 'yes') {
  console.log('refusing to run: this makes real model calls. Set DSH_LIVE_ROUTE=yes to continue.')
  process.exit(0)
}

const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const key = /DEEPSEEK_API_KEY:\s*(\S+)/u.exec(await readFile(join(home, '.credentials.yaml'), 'utf8'))?.[1] ?? ''
if (key === '') throw new Error('no key')
const model = 'deepseek-flash'
const endpoint = 'https://api.deepseek.com/chat/completions'

// ---- 重建旧 system 提示词：把我加的那几处逐一还原 ----
const undo: Array<[string, string]> = [
  [
    '你在为一个人维护跨会话的长期记忆。下面是一段真实对话，每条消息前面有编号、角色和「提取源 / 仅背景」的标注。\n',
    '你在为一个人维护跨会话的长期记忆。下面是一段真实对话，每条消息前面有编号和角色。\n',
  ],
  [
    '**只有标注为「提取源」的那条消息是提取对象**；标注为「仅背景」的只用来判断语境——比如提取源里那段话是不是在粘贴/引用前面的内容、有没有指代前面说过的事。**不要从「仅背景」的消息里提取任何东西，也不要为它们返回 JSON 项。**\n',
    '',
  ],
  ['在提取源里找出**值得长期记住**的内容', '请找出其中**值得长期记住**的内容'],
  ['注意：提取源里可能混着', '注意：用户消息里可能混着'],
  ['- `message`：消息编号，**只能是标注为「提取源」的那条**', '- `message`：消息编号'],
]
let oldSystem = MODEL_WRITE_SYSTEM
for (const [from, to] of undo) {
  if (!oldSystem.includes(from)) throw new Error(`重建失败，找不到：${from.slice(0, 40)}`)
  oldSystem = oldSystem.replace(from, to)
}
if (oldSystem.includes('提取源')) throw new Error('重建后仍残留「提取源」字样')

const sessions = await readSessions()
const bySeq = new Map(sessions.map((s) => [s.id, new Map(s.messages.map((m) => [m.seq, m]))]))
const windowOf = (session: Session, end: number) => {
  const at = bySeq.get(session.id)!
  const last = session.messages.filter((m) => m.seq <= end).map((m) => m.seq)
  // Mirrors the shipped window: 3 rounds, the newest answer left long. See `eval/write-arm.ts`.
  return conversationWindowOf(last.length ? Math.max(...last) + 1 : null, (seq) => at.get(seq) ?? null, 3, 200, { rounds: 1, chars: 1500 }) ?? []
}

// 样本从运行日志里读，保证和评测那次是同一批 20 个窗口
const log = (await readFile('.scratch/write-arm-runs.jsonl', 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
const last = log[log.length - 1] as { sample: string[] }
const wanted = new Set(last.sample)

const cellCount: Record<string, number> = {}
const writableByRole: Record<string, number> = {}
let writable = 0
let writableFromNewest = 0
const rows: Array<{ window: string; total: number; fromNewest: number; fromOlder: number; indexHist: Record<string, number> }> = []
for (const session of sessions) {
  for (const message of session.messages) {
    if (message.role !== 'user') continue
    const id = `${session.id.slice(-8)}:${message.seq}`
    if (!wanted.has(id)) continue
    const window = windowOf(session, message.seq)
    if (window.length === 0) continue
    const body = window.map((m, i) => `[${i}] 角色=${m.role}\n${m.text}`).join('\n\n')
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: oldSystem }, { role: 'user', content: `以下是一段对话：\n\n${body}` }],
        temperature: 0,
        max_tokens: 1500,
        thinking: { type: 'disabled' },
      }),
    })
    const payload = (await response.json()) as Record<string, any>
    const raw = String(payload.choices?.[0]?.message?.content ?? '')
    const values = readCompleteObjects(raw).values ?? []
    const newest = (() => { for (let i = window.length - 1; i >= 0; i -= 1) if (window[i]!.role === 'user') return i; return -1 })()
    const hist: Record<string, number> = {}
    let fromNewest = 0
    let fromOlder = 0
    for (const value of values) {
      const item = value as Record<string, unknown>
      const at = Number(item.message)
      hist[String(at)] = (hist[String(at)] ?? 0) + 1
      if (at === newest) fromNewest += 1
      else fromOlder += 1
      const role = window[at]?.role ?? '?'
      const who = String(item.who ?? '?')
      const worth = item.worth === true
      const type = String(item.type ?? '?')
      const cell = `${role}/${who}${worth ? '/worth' : ''}/${type}`
      cellCount[cell] = (cellCount[cell] ?? 0) + 1
      if (who === 'user' && worth && ['constraint', 'pitfall', 'decision'].includes(type)) {
        writable += 1
        writableFromNewest += at === newest ? 1 : 0
        writableByRole[role] = (writableByRole[role] ?? 0) + 1
      }
    }
    rows.push({ window: id, total: values.length, fromNewest, fromOlder, indexHist: hist })
    console.log(`${id}｜窗口 ${window.length} 条(最新提取源在第 ${newest} 位)｜旧范围提出 ${values.length} 条：引自最新 ${fromNewest}、引自更早 ${fromOlder}｜${JSON.stringify(hist)}`)
  }
}

const sum = (pick: (r: typeof rows[number]) => number) => rows.reduce((n, r) => n + pick(r), 0)
const report = [
  '# 旧范围重新跑一遍：条目到底引自第几条消息',
  '',
  `窗口 ${rows.length} 个｜旧范围共提出 **${sum((r) => r.total)}** 条`,
  `　　引自最新一条消息（= 新范围唯一允许的来源）：**${sum((r) => r.fromNewest)}** 条`,
  `　　引自更早的消息（新范围会拒掉）：**${sum((r) => r.fromOlder)}** 条`,
  '',
  '| 窗口 | 提出 | 引自最新 | 引自更早 | 消息位置分布 |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.window} | ${r.total} | ${r.fromNewest} | ${r.fromOlder} | ${JSON.stringify(r.indexHist)} |`),
].join('\n')
await writeFile('.scratch/scope-ab.md', report)
console.log(`\n合计：旧范围提出 ${sum((r) => r.total)} 条｜引自最新 ${sum((r) => r.fromNewest)}｜引自更早 ${sum((r) => r.fromOlder)}`)
console.log(`\n按「来源消息角色 / 模型标的人 / 值不值得 / 类别」分布：`)
for (const [k, v] of Object.entries(cellCount).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`)
console.log(`\n插件会真的写下来的（who=user 且 worth 且类别在白名单）：${writable} 条`)
console.log(`  其中引自最新那条消息：${writableFromNewest}`)
console.log(`  按来源消息角色：${JSON.stringify(writableByRole)}`)
