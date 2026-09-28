/**
 * Reading a credential reference straight out of the harness's credential
 * document.
 *
 * Why this exists next to the credentials service: the service is the right
 * source and it is tried first, but it is resolved through the Cordis context —
 * `ctx.get` only returns providers whose fiber is already active, so a plugin
 * that mounts early can observe `undefined` and would silently fall back to the
 * heuristic judge forever. This reader removes that timing dependency: the
 * document at `$DSH_HOME/.credentials.yaml` is the provider's own writable store
 * (mode 0600), so reading it is reading the same bytes the service would.
 *
 * The parser is deliberately a tiny YAML subset — the `refs:` block, one
 * `NAME: value` per line, optional quotes — because the plugin is zero-dependency
 * and a full YAML parser is not worth a runtime dependency for one flat map. It
 * fails open: anything unexpected yields `undefined`, and the caller continues
 * down its fallback chain rather than throwing inside a turn boundary.
 *
 * @module dsh/lib/credentials
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The credential document's filename inside the harness home. */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/**
 * Extract one reference from the document's `refs:` block.
 *
 * Stops at the first line that leaves the block (a non-indented line), so a
 * `records:` section below cannot be mistaken for a reference — the local
 * provider keeps grants there, and a grant's `secret` must never be read as an
 * API key.
 *
 * @param text - the credential document's contents.
 * @param ref - the reference name to read.
 * @returns the value, or undefined when the block or the name is absent.
 */
export function parseCredentialRef(text: string, ref: string): string | undefined {
  let inRefs = false
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/u, '')
    if (/^refs:\s*(#.*)?$/u.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/u.test(line) && line.trim() !== '') return undefined
    const match = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(line)
    if (!match) continue
    if (match[1] !== ref) continue
    return unquote(match[2])
  }
  return undefined
}

/**
 * Strip one layer of matching quotes and surrounding whitespace.
 *
 * @param raw - the raw scalar as written.
 * @returns the value, or undefined when it is empty.
 */
function unquote(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  const quoted = /^(['"])(.*)\1$/u.exec(value)
  const unquoted = quoted ? quoted[2] : value
  return unquoted === '' ? undefined : unquoted
}

/**
 * Build a reader for one reference under a harness home.
 *
 * Read per call rather than cached: the file is small, and a rotated key must be
 * picked up on the next operation, exactly as the service promises.
 *
 * @param options - wiring.
 * @param options.home - the harness home directory.
 * @param options.ref - the reference name.
 * @param options.read - file reader, injectable for tests.
 * @returns a function resolving the value, or undefined.
 */
export function createCredentialFileReader({
  home,
  ref,
  read = readFile,
}: {
  home: string
  ref: string
  read?: (path: string, encoding: 'utf8') => Promise<string>
}): () => Promise<string | undefined> {
  const path = join(home, CREDENTIALS_FILENAME)
  return async () => {
    try {
      return parseCredentialRef(await read(path, 'utf8'), ref)
    } catch {
      // A missing or unreadable document is a normal state: the plugin then relies
      // on the service, the config, or the environment, and finally on the
      // heuristic judge. It is never a reason to fail a turn.
      return undefined
    }
  }
}
