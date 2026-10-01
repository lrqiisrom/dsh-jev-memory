/**
 * Reading the labelling CSVs.
 *
 * Both the harvester and the report need this, and the reason it is a shared module
 * rather than a few lines in each is a bug that already happened: a naive
 * `split(',')` reported 240 labelled rows where the real count was 3, because the
 * sentence column contains commas, quotes and newlines. Two copies of a parser is
 * two chances to make that mistake again.
 *
 * @module eval/lib/csv
 */

/**
 * Parse CSV text into records of cells, honouring quotes.
 *
 * @param text - the whole file.
 * @returns one array of cells per record.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  // A `"` only opens a quoted cell at the very start of that cell. In the middle of
  // an unquoted cell it is a literal character, which is what the file produced by
  // the labeller's spreadsheet and by Python's csv module actually contains: one
  // row's id embeds transcript JSON, so `…max_output_tokens":<n>}` carries a bare
  // quote. Treating that as an opening quote swallowed everything after it up to the
  // next quote, commas and newlines included, and the file read as 97 rows instead
  // of 147 with one 131-cell record.
  let atCellStart = true
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char !== '"') {
        cell += char
      } else if (text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = false
      }
      continue
    }
    if (char === '"' && atCellStart) {
      quoted = true
      atCellStart = false
    } else if (char === ',') {
      cells.push(cell)
      cell = ''
      atCellStart = true
    } else if (char === '\n') {
      cells.push(cell)
      records.push(cells)
      cells = []
      cell = ''
      atCellStart = true
    } else if (char === '\r' && text[index + 1] === '\n') {
      // CRLF files: the CR belongs to the line ending, not to the cell.
    } else {
      cell += char
      atCellStart = false
    }
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell)
    records.push(cells)
  }
  return records
}

/**
 * One CSV file as records keyed by column name.
 *
 * @param text - the whole file.
 * @returns one object per data row, missing cells as ''.
 */
export function parseCsvRecords(text: string): Array<Record<string, string>> {
  const records = parseCsv(text)
  const header = records[0] ?? []
  return records
    .slice(1)
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
    .map((cells) => {
      const row: Record<string, string> = {}
      for (const [index, name] of header.entries()) row[name] = cells[index] ?? ''
      return row
    })
}

/**
 * The labels already present in a CSV, by row id.
 *
 * @param text - the previous file, or '' when there is none.
 * @returns row id → its label and note.
 */
export function carriedLabels(text: string): Map<string, { label: string; note: string }> {
  const carried = new Map<string, { label: string; note: string }>()
  const records = parseCsv(text)
  const header = records[0] ?? []
  const idAt = header.indexOf('id')
  const labelAt = header.indexOf('label')
  const noteAt = header.indexOf('note')
  if (idAt < 0 || labelAt < 0) return carried
  for (const cells of records.slice(1)) {
    const id = (cells[idAt] ?? '').trim()
    const label = (cells[labelAt] ?? '').trim()
    if (id !== '' && label !== '') carried.set(id, { label, note: (cells[noteAt] ?? '').trim() })
  }
  return carried
}

/**
 * One CSV field, quoted when it contains a comma, a quote or a newline.
 *
 * @param value - the cell's text.
 * @returns a field safe to join with commas.
 */
export function csvField(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}
