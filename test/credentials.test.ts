import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createCredentialFileReader, parseCredentialRef } from '../dsh/lib/credentials.ts'

const DOCUMENT = `version: 1
refs:
  TYPESAFE_API_KEY: apikey_abc_def
  DEEPSEEK_API_KEY: "sk-quoted-value"
records:
  client-connection/browser-session:
    kind: grant
    payload:
      secret: must-never-be-read-as-a-key
`

test('parseCredentialRef reads one reference out of the refs block', () => {
  assert.equal(parseCredentialRef(DOCUMENT, 'TYPESAFE_API_KEY'), 'apikey_abc_def')
  assert.equal(parseCredentialRef(DOCUMENT, 'DEEPSEEK_API_KEY'), 'sk-quoted-value')
  assert.equal(parseCredentialRef(DOCUMENT, 'NOT_THERE'), undefined)
})

// The document also stores authorization grants below `refs:`. Their payloads
// contain secrets too, and reading one as an API key would be a leak with extra
// steps — so the parser must stop at the end of the block.
test('parseCredentialRef never reads past the refs block', () => {
  assert.equal(parseCredentialRef(DOCUMENT, 'secret'), undefined)
  assert.equal(parseCredentialRef(DOCUMENT, 'kind'), undefined)
  assert.equal(parseCredentialRef('version: 1\nrecords:\n  x: y\n', 'x'), undefined)
})

test('parseCredentialRef tolerates an empty, absent or malformed document', () => {
  assert.equal(parseCredentialRef('', 'TYPESAFE_API_KEY'), undefined)
  assert.equal(parseCredentialRef('refs:\n', 'TYPESAFE_API_KEY'), undefined)
  assert.equal(parseCredentialRef('refs:\n  TYPESAFE_API_KEY:\n', 'TYPESAFE_API_KEY'), undefined)
  assert.equal(parseCredentialRef('refs:\n  TYPESAFE_API_KEY: ""\n', 'TYPESAFE_API_KEY'), undefined)
  assert.equal(parseCredentialRef(null as unknown as string, 'TYPESAFE_API_KEY'), undefined)
})

test('createCredentialFileReader resolves a value and fails open on errors', async () => {
  const reader = createCredentialFileReader({
    home: '/home/test',
    ref: 'TYPESAFE_API_KEY',
    read: async (path) => {
      assert.equal(path, '/home/test/.credentials.yaml')
      return DOCUMENT
    },
  })
  assert.equal(await reader(), 'apikey_abc_def')

  const missing = createCredentialFileReader({
    home: '/home/test',
    ref: 'TYPESAFE_API_KEY',
    read: async () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(await missing(), undefined)
})
