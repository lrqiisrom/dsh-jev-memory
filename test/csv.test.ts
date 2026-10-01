/**
 * The labelling CSVs are read with this parser, so a quoting mistake here silently
 * changes how many labelled rows the report sees.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { carriedLabels, csvField, parseCsv, parseCsvRecords } from '../eval/lib/csv.ts'

test('parseCsv honours quoted cells holding separators and newlines', () => {
  assert.deepEqual(parseCsv('a,"b,c",d\n'), [['a', 'b,c', 'd']])
  assert.deepEqual(parseCsv('a,"line1\nline2",d\n'), [['a', 'line1\nline2', 'd']])
  assert.deepEqual(parseCsv('a,"say ""hi""",d\n'), [['a', 'say "hi"', 'd']])
  assert.deepEqual(parseCsv('a,,"",d\n'), [['a', '', '', 'd']])
})

test('parseCsv treats a quote inside an unquoted cell as a literal', () => {
  // Real row: the id column embeds transcript JSON, so it carries a bare quote and
  // commas. Reading that quote as an opening quote swallowed the rest of the file.
  const text = 'row,id,text\n7,<str>max_output_tokens":<n>},"ok"\n8,next,row\n'
  assert.deepEqual(parseCsv(text), [
    ['row', 'id', 'text'],
    ['7', '<str>max_output_tokens":<n>}', 'ok'],
    ['8', 'next', 'row'],
  ])
})

test('parseCsv survives a round trip through csvField', () => {
  const rows = [
    ['row', 'text'],
    ['1', '带,逗号 和 "引号"'],
    ['2', '多行\n文本'],
    ['3', '结尾引号"'],
  ]
  const text = `${rows.map((cells) => cells.map(csvField).join(',')).join('\n')}\n`
  assert.deepEqual(parseCsv(text), rows)
})

test('parseCsv accepts CRLF and drops the trailing empty record', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']])
})

test('parseCsvRecords maps cells onto the header and skips blank lines', () => {
  const records = parseCsvRecords('row,label,note\n1,1,ok\n2,,\n\n')
  assert.deepEqual(records, [
    { row: '1', label: '1', note: 'ok' },
    { row: '2', label: '', note: '' },
  ])
})

test('carriedLabels reads labelled rows only', () => {
  const carried = carriedLabels('row,id,label,note\n1,abc,1,理由\n2,def,,\n3,ghi,0,\n')
  assert.equal(carried.size, 2)
  assert.deepEqual(carried.get('abc'), { label: '1', note: '理由' })
  assert.deepEqual(carried.get('ghi'), { label: '0', note: '' })
})
