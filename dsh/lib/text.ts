/**
 * Text helpers shared by extraction, judgement, dedup and recall.
 *
 * Design note: nothing in this module rewrites a memory's content. The plugin
 * stores the user's own sentence (clipped) as the memory text, so a memory can
 * always be traced back to a verbatim quote in a session log. Judgement may
 * label a sentence, never paraphrase it — that is what keeps "记错" auditable.
 *
 * Types: the parameters that begin life as untyped data (a `Message['content']`
 * value, a field read back from a hand-edited JSON document) are declared
 * `unknown` rather than `any`, matching what the implementations already do —
 * every one of them starts by coercing its input with `String(value ?? '')`.
 * Nothing here imports a type from the harness: the plugin is zero-dependency
 * on purpose, so a host-shaped value is described structurally where it is read.
 *
 * @module dsh/lib/text
 */

import { createHash } from 'node:crypto'

/** Default upper bound for one stored memory sentence. */
export const DEFAULT_MAX_MEMORY_CHARS = 240

/**
 * Flatten Cordis content blocks into plain text.
 *
 * Only `text` blocks survive; reasoning and tool-call blocks are dropped on
 * purpose — a memory should never be built out of the model's private
 * reasoning, which is neither user intent nor a durable fact.
 *
 * @param content - a `Message['content']` value (or anything else).
 * @returns the concatenated text blocks, newline separated.
 */
export function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as unknown[]) {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Collapse whitespace so two spellings of the same sentence hash identically.
 *
 * @param text - raw text.
 * @returns single-spaced, trimmed text.
 */
export function normalize(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Clip on a grapheme-safe boundary, appending an ellipsis when shortened.
 *
 * @param text - normalized text.
 * @param max - maximum characters, excluding the ellipsis.
 * @returns the clipped text.
 */
export function clip(text: unknown, max: number = DEFAULT_MAX_MEMORY_CHARS): string {
  const value = normalize(text)
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * Stable content hash used for dedup and for the record id.
 *
 * Case is folded because "必须用 pnpm" and "必须用 PNPM" are the same memory.
 *
 * @param text - normalized or raw text.
 * @returns 12 lowercase hex characters.
 */
export function hashText(text: unknown): string {
  return createHash('sha1').update(normalize(text).toLowerCase()).digest('hex').slice(0, 12)
}

/**
 * Split a message into sentences for CJK and latin prose.
 *
 * The separators are kept on the sentence that precedes them so a stored
 * memory reads exactly like the source sentence did.
 *
 * A latin period only ends a sentence when whitespace and a word character
 * follow it, so `main.py`, `v1.2` and `node_modules/x.d.ts` survive intact —
 * those are exactly the tokens a memory usually has to preserve verbatim.
 *
 * @param text - raw message text.
 * @returns trimmed, non-empty sentences.
 */
export function splitSentences(text: unknown): string[] {
  const raw = String(text ?? '').replace(/\r\n?/gu, '\n')
  const out: string[] = []
  let buffer = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    buffer += char
    if ('。！？!?；;\n'.includes(char)) {
      const sentence = normalize(buffer)
      if (sentence) out.push(sentence)
      buffer = ''
      continue
    }
    if (char === '.' && /^\s+[\w"'“(\u4e00-\u9fff]/u.test(raw.slice(index + 1))) {
      const sentence = normalize(buffer)
      if (sentence) out.push(sentence)
      buffer = ''
    }
  }
  const tail = normalize(buffer)
  if (tail) out.push(tail)
  return out
}

/**
 * Count characters, not tokens: DSH has a token meter but it is not reachable
 * from a synchronous prompt-context callback, and an injection budget only
 * needs to be conservative and stable. CJK is ~1 token per character, latin
 * ~1 token per 4 characters; this estimator deliberately over-counts CJK.
 *
 * @param text - the text to estimate.
 * @returns an upper-bound token estimate.
 */
export function estimateTokens(text: unknown): number {
  const value = String(text ?? '')
  let cjk = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1
    else if (code >= 0xf900 && code <= 0xfaff) cjk += 1
    else if (code >= 0xff00 && code <= 0xffef) cjk += 1
  }
  const latin = value.length - cjk
  return cjk + Math.ceil(latin / 4)
}

/**
 * True when the sentence asks something rather than states something.
 *
 * A question is a request for information, not information: memorizing it
 * would inject the user's open question into a later session as if it were
 * settled fact.
 *
 * @param sentence - a normalized sentence.
 * @returns whether it looks interrogative.
 */
export function looksInterrogative(sentence: string): boolean {
  const value = normalize(sentence)
  if (!value) return false
  if (/[?？]$/u.test(value)) return true
  // Chinese questions frequently carry no question mark at all: "…只能用 js 写吗"
  // ends in a particle, and "难道…" is rhetorical. This is not a nicety — the
  // second live run memorized exactly such a sentence as a `constraint`, because
  // the sentence began with a URL and ended in 吗.
  if (/[吗嗎呢]$/u.test(value)) return true
  if (/难道|岂不|是不是|要不要|有没有/u.test(value)) return true
  return /^(什么|怎么|如何|为什么|哪|谁|何时|多少|是否|能不能|可不可以|有没有|why|what|how|which|who|when|where|is |are |can |could |should |do |does |did )/iu.test(
    value,
  )
}

/**
 * Truncate for ledger/log lines without breaking the surrounding JSON.
 *
 * @param text - any text.
 * @param max - maximum characters to keep.
 * @returns a single-line excerpt.
 */
export function excerpt(text: unknown, max: number = 160): string {
  const value = normalize(text)
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
