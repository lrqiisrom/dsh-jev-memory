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
]

/**
 * Sentences that are literally a tool call, a JSON payload, or a code block.
 * A memory must be a statement a human made, never a serialized argument list.
 */
export const PAYLOAD_PATTERNS: RegExp[] = [/\{"[^"]+"\s*:/u, /^\s*[[{]/u, /```/u]

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
  if (TASK_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(sentence))) return { keep: false, reason: 'task-instruction' }
  if (PAYLOAD_PATTERNS.some((pattern) => pattern.test(sentence))) return { keep: false, reason: 'payload' }
  return { keep: true, reason: null }
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
