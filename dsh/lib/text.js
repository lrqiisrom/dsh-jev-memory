/**
 * Text helpers shared by extraction, judgement, dedup and recall.
 *
 * Design note: nothing in this module rewrites a memory's content. The plugin
 * stores the user's own sentence (clipped) as the memory text, so a memory can
 * always be traced back to a verbatim quote in a session log. Judgement may
 * label a sentence, never paraphrase it — that is what keeps "记错" auditable.
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
 * @param {unknown} content - a `Message['content']` value (or anything else).
 * @returns {string} the concatenated text blocks, newline separated.
 */
export function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Collapse whitespace so two spellings of the same sentence hash identically.
 *
 * @param {string} text - raw text.
 * @returns {string} single-spaced, trimmed text.
 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Clip on a grapheme-safe boundary, appending an ellipsis when shortened.
 *
 * @param {string} text - normalized text.
 * @param {number} max - maximum characters, excluding the ellipsis.
 * @returns {string} the clipped text.
 */
export function clip(text, max = DEFAULT_MAX_MEMORY_CHARS) {
  const value = normalize(text)
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * Stable content hash used for dedup and for the record id.
 *
 * Case is folded because "必须用 pnpm" and "必须用 PNPM" are the same memory.
 *
 * @param {string} text - normalized or raw text.
 * @returns {string} 12 lowercase hex characters.
 */
export function hashText(text) {
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
 * @param {string} text - raw message text.
 * @returns {string[]} trimmed, non-empty sentences.
 */
export function splitSentences(text) {
  const raw = String(text ?? '').replace(/\r\n?/gu, '\n')
  const out = []
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
 * @param {string} text - the text to estimate.
 * @returns {number} an upper-bound token estimate.
 */
export function estimateTokens(text) {
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
 * @param {string} sentence - a normalized sentence.
 * @returns {boolean} whether it looks interrogative.
 */
export function looksInterrogative(sentence) {
  const value = normalize(sentence)
  if (!value) return false
  if (/[?？]$/u.test(value)) return true
  return /^(什么|怎么|如何|为什么|哪|谁|何时|多少|是否|能不能|可不可以|有没有|why|what|how|which|who|when|where|is |are |can |could |should |do |does |did )/iu.test(
    value,
  )
}

/**
 * Truncate for ledger/log lines without breaking the surrounding JSON.
 *
 * @param {string} text - any text.
 * @param {number} max - maximum characters to keep.
 * @returns {string} a single-line excerpt.
 */
export function excerpt(text, max = 160) {
  const value = normalize(text)
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
