/**
 * The deterministic signal vocabulary shared by candidate extraction and the
 * heuristic judge.
 *
 * Why this exists at all: the judgement layer is allowed to be a language
 * model (Jev), and the plugin must still be useful and testable without one.
 * Signals are the offline half of the same decision — they decide which
 * sentences are even worth a judgement and give the heuristic fallback its
 * labels. They never decide to *write*: the write gate is a deterministic
 * threshold in the plugin, exactly as the Jev discipline requires.
 *
 * Types: the vocabulary is plain data (`type`/`weight`/`patterns`), so it needs
 * no harness type at all; only the two result shapes are spelled out, and they
 * are local interfaces rather than imports because the plugin is zero-dependency.
 *
 * @module dsh/lib/signals
 */

import { looksInterrogative } from './text.ts'

/** One type-signal family: the label it implies, its weight, and its patterns. */
export interface TypeSignalFamily {
  type: string
  weight: number
  patterns: RegExp[]
}

/** The best type-signal match for one sentence. `type` is null when nothing matched. */
export interface TypeSignalMatch {
  type: string | null
  weight: number
  hits: string[]
}

/** The screening decision for one sentence, with the reason the ledger records. */
export interface ScreenDecision {
  keep: boolean
  reason: string | null
}

/**
 * Type signals, most specific first. The first matching family wins when the
 * heuristic has to pick one type for a sentence.
 */
export const TYPE_SIGNALS: TypeSignalFamily[] = [
  {
    type: 'constraint',
    weight: 1,
    patterns: [
      /必须/u,
      /务必/u,
      /一定要/u,
      /千万/u,
      /不能/u,
      /不要/u,
      /别去/u,
      /不准/u,
      /禁止/u,
      /只能/u,
      /统一用/u,
      /约定/u,
      /规范是/u,
      /\bmust\b/iu,
      /\bnever\b/iu,
      /\balways\b/iu,
      /\bdo not\b/iu,
      /\bdon't\b/iu,
      /\brequired\b/iu,
      /\bforbidden\b/iu,
      /\bmandatory\b/iu,
    ],
  },
  {
    type: 'pitfall',
    weight: 0.95,
    patterns: [
      /踩(过|了)?坑/u,
      /坑(是|在于|点)/u,
      /会(报|抛|出)错/u,
      /会失败/u,
      /会挂/u,
      /会导致/u,
      /记得(避开|绕开)/u,
      /注意(别|不要)/u,
      /小心/u,
      /上次.*(问题|失败|崩)/u,
      /曾经.*(失败|崩)/u,
      /\bpitfall\b/iu,
      /\bgotcha\b/iu,
      /\bbreaks?\b/iu,
      /\bcrashe?s?\b/iu,
      /\bfails?\b/iu,
      /\bwatch out\b/iu,
      /\bcaveat\b/iu,
    ],
  },
  {
    type: 'rejected',
    weight: 0.9,
    patterns: [
      /不用/u,
      /不考虑/u,
      /否决/u,
      /排除/u,
      /放弃/u,
      /别用/u,
      /\bruled out\b/iu,
      /\brejected\b/iu,
      /\bnot going to use\b/iu,
    ],
  },
  {
    type: 'decision',
    weight: 0.85,
    patterns: [
      /决定/u,
      /确定(用|了)/u,
      /选择/u,
      /改(成|为)了?/u,
      /换成/u,
      /采用/u,
      /方案(是|定)/u,
      /最终(用|选)/u,
      /\bdecided\b/iu,
      /\bwe chose\b/iu,
      /\bgoing with\b/iu,
      /\binstead of\b/iu,
      /\bsettled on\b/iu,
    ],
  },
  {
    type: 'procedure',
    weight: 0.8,
    patterns: [
      /流程/u,
      /步骤/u,
      /发布前/u,
      /上线前/u,
      /先.+再.+然后/u,
      /\brunbook\b/iu,
      /\bchecklist\b/iu,
      /\bstep \d/iu,
    ],
  },
  {
    type: 'preference',
    weight: 0.7,
    patterns: [
      /我喜欢/u,
      /偏好/u,
      /习惯/u,
      /以后都/u,
      /默认(用|走)/u,
      /\bi prefer\b/iu,
      /\bi like\b/iu,
      /\bby default\b/iu,
    ],
  },
]

/**
 * Signals that raise importance without implying a type: emphasis, an explicit
 * instruction to remember, or a concrete command/path the memory must carry.
 */
export const EMPHASIS_SIGNALS: Array<{ weight: number; patterns: RegExp[] }> = [
  { weight: 0.2, patterns: [/记住/u, /记一下/u, /请牢记/u, /\bremember\b/iu, /\bnote that\b/iu, /\bkeep in mind\b/iu] },
  { weight: 0.15, patterns: [/以后/u, /下次/u, /今后/u, /从现在起/u, /\bfrom now on\b/iu, /\bnext time\b/iu] },
  { weight: 0.12, patterns: [/`[^`]+`/u] },
  { weight: 0.08, patterns: [/\bpnpm\b|\bnpm\b|\bgit\b|\.ya?ml\b|\.json\b|\/[a-z_-]+\//iu] },
]

/**
 * Sentences that carry no durable information on their own: acknowledgements,
 * greetings, and pure continuations. Dropping them here is what keeps the
 * prompt to the judge small and the store free of chatter.
 */
export const NOISE_PATTERNS: RegExp[] = [
  /^(好|好的|好呀|行|可以|嗯|哦|噢|知道了|收到|谢谢|多谢|辛苦了|没问题|继续|开始吧|来吧|ok|okay|yes|yep|no|sure|thanks|thank you|got it|cool|nice|go ahead|continue)[\s。.!！~～]*$/iu,
  /^(嗯+|哦+|啊+|哈+|额+)[。.!！~～]*$/u,
  /^(请)?(继续|接着|往下)(吧|做|写|改)?[。.!！~～]*$/u,
]

/**
 * Match one sentence against a signal family.
 *
 * @param sentence - normalized sentence.
 * @returns the best family match.
 */
export function matchTypeSignals(sentence: string): TypeSignalMatch {
  for (const family of TYPE_SIGNALS) {
    const hits = family.patterns.filter((pattern) => pattern.test(sentence)).map(String)
    if (hits.length > 0) return { type: family.type, weight: family.weight, hits }
  }
  return { type: null, weight: 0, hits: [] }
}

/**
 * Collect emphasis signals for importance scoring.
 *
 * @param sentence - normalized sentence.
 * @returns summed emphasis weight, capped later by the caller.
 */
export function emphasisWeight(sentence: string): number {
  let weight = 0
  for (const signal of EMPHASIS_SIGNALS) {
    if (signal.patterns.some((pattern) => pattern.test(sentence))) weight += signal.weight
  }
  return weight
}

/**
 * @param sentence - normalized sentence.
 * @returns whether the sentence is pure conversational noise.
 */
export function isNoise(sentence: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(sentence))
}

/**
 * Sentences that are instructions to an agent about the current task rather
 * than durable knowledge about the project.
 *
 * This family exists because of a measured failure, not a hunch: in the first
 * live run, a delegated child's "user" message was the parent agent's own task
 * prompt, and three of its sentences ("请严格按下面步骤操作，不要做任何额外的事。",
 * "把第 2、3 步…贴出来，不要改写…") were written as `constraint` memories. They
 * are imperative and contain 不要, so the type signals matched; what separates
 * them from a real constraint is that they are *scoped to this one task*.
 * The veto is narrow on purpose — "不要改动 data/ 目录" must survive it.
 */
export const TASK_INSTRUCTION_PATTERNS: RegExp[] = [
  /按(下面|以下|上述|这个|此)(的)?(步骤|要求|说明|格式|模板)/u,
  /不要做(任何)?(额外|多余)的?(事|工作|动作)/u,
  /第\s*\d+\s*步/u,
  /(调用|使用)\s*`?\w+`?\s*(工具|tool)/iu,
  /把.{2,40}(贴|输出|打印|报告|回复|告诉)(出来|给我)/u,
  /回复(一行|不超过|以下格式|我)/u,
  /(严格)?按(这个|此|上述)?(格式|模板|要求)(回复|输出|返回)/u,
  /不要(改写|总结|解释|评价|自己组织)/u,
  /^(请)?(先|再|直接)?(你)?(帮我|帮忙)(做|写|看|检查|改)/u,
  /^(先|再|然后|接着)?(看|查|检查|确认|列出|读)(一下|看)?[^。]{0,24}(是否|有没有|有哪些)/u,
  // Requests for an explanation or an answer, addressed to the agent.
  //
  // A live session produced four mis-writes in this class ("你先说说整体的设计",
  // "完整说一下怎么测的", "不要有一堆你代码里写的专有名词", "先不急着重启"): each is
  // imperative, several contain 不要, and all of them are about *this
  // conversation* rather than the project. They are unanchored because the
  // request verb usually sits mid-sentence after a lead-in clause.
  /(你|请|麻烦|劳驾)(先|再|直接)?(来)?(说说|说一下|讲一下|讲讲|解释一下|说明一下|描述一下|总结一下|列一下|列出来)/u,
  /^(你|请|麻烦)?(先|再|直接)?(说|讲|解释|说明|总结|描述|列出|回答|回复)(一下|一遍)/u,
  /^(告诉|回复|回答|给我|帮我|请你|麻烦你|我要你)/u,
  /(说一下|说说|讲一下|解释一下|总结一下|列一下)(怎么|如何|为什么|什么|你|我)/u,
]

/**
 * Sentences that explicitly ask for something to be remembered.
 *
 * They exist so the request screen cannot swallow the strongest write signal a
 * user has: "帮我记住：data 目录别动" starts with a request verb and would
 * otherwise be vetoed — the plugin ignoring an explicit instruction in order to
 * avoid a heuristic mistake.
 */
export const REMEMBER_REQUEST_PATTERNS: RegExp[] = [
  /记住/u,
  /记一下/u,
  /记下/u,
  /记录下来?/u,
  /记录一下/u,
  /别忘了/u,
  /\bremember\b/iu,
  /\bnote that\b/iu,
  /\bkeep in mind\b/iu,
]

/**
 * Sentences that are literally a tool call, a JSON payload, or a code block.
 * A memory must be a statement a human made, never a serialized argument list.
 */
export const PAYLOAD_PATTERNS: RegExp[] = [/\{"[^"]+"\s*:/u, /^\s*[[{]/u, /```/u]

/**
 * Sentences carrying a secret.
 *
 * This screen is a hard veto and it runs before anything is judged, because the
 * failure it prevents is unbounded: a memory is injected into every later
 * session's prompt, so a key written once leaks forever. The trigger was
 * concrete rather than hypothetical — the user pasted a TypeSafe API key inside
 * an otherwise ordinary sentence, and that sentence satisfies every other rule
 * (long enough, not noise, not a question, no task-instruction shape).
 */
export const SECRET_PATTERNS: RegExp[] = [
  /\bapikey_[A-Za-z0-9_]{16,}/iu,
  /\b(?:sk|pk|rk|ts|api)[_-][A-Za-z0-9_-]{20,}/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u,
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|bearer)\b\s*[:=]?\s*\S{12,}/iu,
  /\b[0-9a-f]{48,}\b/iu,
]

/**
 * A line from a pasted dialogue: a speaker label at the start of the sentence.
 *
 * Why this exists: whole interview transcripts were pasted into sessions, and since
 * they arrive as ordinary user messages, every line inside them looked like something
 * the user had said. Of 38 rows labelled from real sessions, 9 were transcript lines
 * and the person marked all 9 "do not remember" — an interview being rehearsed is not
 * the user's project knowledge, and the plugin was memorizing questions an interviewer
 * had asked.
 *
 * The cost was measured on those labels before shipping: this rule rejects those 9
 * rows and not one labelled "remember" among them. The signal is structural — `你:`
 * is a transcript convention, not how a person types their own claim — so it is not
 * fitted to the sample the way a tuned keyword threshold would be.
 */
export const TRANSCRIPT_PATTERNS: RegExp[] = [
  /^(?:你|我|他|她|面试官|面试者|面试人|候选人|提问者|回答者|用户|助手|ai|assistant|user|human|interviewer|candidate)\s*[:：]/iu,
]

/**
 * A pasted fragment with no sentence of its own: a line of code, or structural
 * markdown that survived the paste.
 *
 * Measured on the 38 labelled sentences pattern by pattern before shipping. Every
 * pattern below rejects at least one row and **none of them rejects a row marked
 * "remember"**:
 *
 * | pattern                                  | rows | marked remember |
 * |------------------------------------------|------|-----------------|
 * | code comment at the start (`//…`)        | 3    | 0               |
 * | trailing semicolon                       | 3    | 0               |
 * | code keyword at the start (`if`, `class`) | 1    | 0               |
 * | markdown structure at the start (`**`, `---`, `#`, `|`) | 1 | 0 |
 *
 * **Two patterns I expected to ship are deliberately absent**, because the measurement
 * said no: a leading `\end{itemize}` and an ephemeral path (`/var/folders/...`) both
 * appear on sentences the person marked as worth remembering. Those rows are keepers
 * with a dirty prefix — the fix for them is cleaning the text, not dropping it, and
 * dropping them would have destroyed exactly the memories the plugin exists for.
 */
export const FRAGMENT_PATTERNS: RegExp[] = [
  // A line of code, not a statement about the project.
  /^\s*(?:\/\/|\/\*|\*\/|#!)/u,
  /^\s*(?:if|else|for|while|switch|return|const|let|var|function|class|public|private|protected|package|import|export|void|int|string|def|func|struct|impl)\b/u,
  /;\s*$/u,
  // Structural markdown with no sentence around it. `#{1,6}\s` needs the space, so a
  // reference like `#83` is not matched.
  /^\s*(?:\*\*|---+|#{1,6}\s|\|\s)/u,
]

/**
 * Strip garbage that a paste left in front of, or inside, a real sentence.
 *
 * Why this is cleaning and not screening: measured against the labelled corpus, the two
 * families below appear on sentences the person marked as worth remembering. Dropping
 * them would have destroyed the memories the plugin exists for; what is wrong with them
 * is the prefix, not the content.
 *
 *  - **Structural residue from a pasted LaTeX/markdown block** (`\end{itemize}`,
 *    `\item`, `\textbf`) — the sentence behind it is real, and the residue is why the
 *    sentence used to slip past the task-instruction screen: `请你按照这个格式去写简历
 *    …` is a one-off task instruction, and a `\end{itemize}` in front of it changed the
 *    verdict. There is a test that pins both halves of that.
 *  - **Ephemeral paths** (`/var/folders/...`, `/tmp/...`, a paste staging directory).
 *    They point at a file that no longer exists, so a later session can do nothing with
 *    them. Deliberately *not* general paths: a path to a config file can be the whole
 *    point of a memory.
 *
 * The replacement is the `<path>` placeholder the signature already uses, rather than
 * deletion, so the text still shows that something was there.
 */
export function stripPastedPrefixes(sentence: string): string {
  return String(sentence ?? '')
    .replace(/^\s*\\+(?:end|begin)\{[^}]*\}\s*/u, '')
    .replace(/^\s*\\+(?:item|hline)\b[\s\d.]*/u, '')
    .replace(/^\s*\\+(?:textbf|textit|emph|texttt)\{([^}]*)\}\s*/u, '$1')
    .replace(
      /\/private\/var\/folders\/\S+|\/var\/folders\/\S+|\/tmp\/\S+|modlens-dsh-paste-\S+/gu,
      '<path>',
    )
    .replace(/\s{2,}/gu, ' ')
    .trim()
}

/**
 * Chinese question markers, unanchored — the other half of the question screen.
 *
 * Why unanchored: `looksInterrogative` anchors its markers at the start or the end of a
 * sentence, and the splitter does not break on `，`. So in a message like "能说一下一次
 * mcp 调用的流程吗，然后 mcp 是在 function calling 上面做了个什么层面的限制和封装" the
 * `吗` sits in the middle and every anchored pattern misses. Measured on the 38 labelled
 * rows: the anchored screen rejected **none** of the questions the person had marked
 * "just a question", which is why they reached the judge at all.
 */
export const QUESTION_MARKERS =
  /哪些|啥|能不能|可不可以|是什么|怎么|为什么|如何|吗|呢|多少|是不是|有没有/u

/**
 * Instruction shapes that keep a question marker from making the sentence a question.
 *
 * The list is broad on purpose, because its job is to *protect* sentences: a sentence that
 * tells the agent to do something is a requirement or an instruction, and one that merely
 * contains 怎么 or 什么 is not a question. Measured on the same 38 rows: unanchored markers
 * alone reject 12 sentences including **2 the person marked as requirements** ("我要求你说
 * 设计是怎么设计的，一些变量名啊什么东西的不要说出来…", "…请你一定要根据代码事实来，不要
 * 凭空捏造"). Requiring the absence of an instruction shape rejects 7 — 5 questions marked
 * "do not remember", 2 marked unsure, and **none marked remember**.
 */
export const INSTRUCTION_MARKERS = /不要|不准|别|必须|应当|应该|请|改|加|删|禁止|务必/u

/**
 * Decide whether one sentence may become a memory at all.
 *
 * Returns a reason instead of a boolean so the ledger can record *why* a
 * sentence was rejected — the write-precision metric depends on knowing which
 * screen fired, not just that nothing was written.
 *
 * @param sentence - a normalized, non-empty sentence.
 * @returns the screening decision.
 */
export function screenSentence(sentence: string): ScreenDecision {
  // Quoted material is rejected before anything else looks at the sentence: a line
  // from a pasted transcript can satisfy every other rule — long enough, no secret,
  // no task-instruction shape, not a question — while being somebody else's words.
  if (TRANSCRIPT_PATTERNS.some((pattern) => pattern.test(sentence))) return { keep: false, reason: 'transcript' }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(sentence))) return { keep: false, reason: 'secret' }
  // An explicit "remember this" outranks the request screen: the user is telling
  // the plugin to write, which is the strongest signal there is.
  const wantsRemember = REMEMBER_REQUEST_PATTERNS.some((pattern) => pattern.test(sentence))
  if (!wantsRemember && TASK_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(sentence))) {
    return { keep: false, reason: 'task-instruction' }
  }
  if (PAYLOAD_PATTERNS.some((pattern) => pattern.test(sentence))) return { keep: false, reason: 'payload' }
  if (FRAGMENT_PATTERNS.some((pattern) => pattern.test(sentence))) return { keep: false, reason: 'fragment' }
  // Chatter and questions live here rather than in the extractor, so there is one
  // screen entry point: the write-precision harness runs the same screens the
  // plugin does, and a sentence cannot be screened in one path but not the other.
  if (isNoise(sentence)) return { keep: false, reason: 'noise' }
  // Two ways to be a question, and the second one exists because the first cannot see a
  // marker in the middle of a sentence: either the anchored test fires, or a marker appears
  // anywhere *and* the sentence carries no instruction shape. The conjunction is what keeps
  // a requirement that happens to contain 什么 from being thrown away — see the note on
  // INSTRUCTION_MARKERS for the two sentences that made this necessary.
  if (looksInterrogative(sentence)) return { keep: false, reason: 'question' }
  if (QUESTION_MARKERS.test(sentence) && !INSTRUCTION_MARKERS.test(sentence)) {
    return { keep: false, reason: 'question' }
  }
  return { keep: true, reason: null }
}

/**
 * The reasons worth a ledger line when a sentence is rejected.
 *
 * Chatter and questions are dropped silently: recording every "好的" would bury
 * the rejections that carry information under the ones that never did.
 *
 * @param reason - the reason `screenSentence` returned.
 * @returns whether the rejection deserves an audit line.
 */
export function isNoteworthyVeto(reason: string | null): boolean {
  return (
    reason === 'secret' ||
    reason === 'task-instruction' ||
    reason === 'payload' ||
    reason === 'fragment' ||
    // A transcript line is dropped in bulk, but it is worth counting: a batch of
    // them means the user pasted a dialogue, which is a different situation from a
    // sentence that merely looked like chatter.
    reason === 'transcript'
  )
}

/**
 * Placeholder normalization used for dedup keys: two errors that differ only
 * in ids, numbers, or quoted paths are the same pitfall.
 *
 * @param text - raw sentence or derived signature.
 * @returns the signature-normalized text.
 */
export function signatureOf(text: string): string {
  return String(text ?? '')
    .replace(/`[^`]*`/gu, '<code>')
    .replace(/'(?:[^'\\]|\\.)*'/gu, '<str>')
    .replace(/"(?:[^"\\]|\\.)*"/gu, '<str>')
    .replace(/\b[\w./-]*\/(?:[\w.-]+\/?)+/gu, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/giu, '<hex>')
    .replace(/\d+/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
}
