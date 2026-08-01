import crewPlanCsv from '../../crew/crew_plan.csv?raw'

function parseCsv(text) {
  const rows = []
  let row = []
  let value = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (char === '"' && quoted && next === '"') {
      value += '"'
      i += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(value)
      value = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1
      row.push(value)
      if (row.some(cell => cell.trim())) rows.push(row)
      row = []
      value = ''
    } else {
      value += char
    }
  }

  row.push(value)
  if (row.some(cell => cell.trim())) rows.push(row)
  return rows
}

const clean = value => value?.trim() || ''
const optional = value => /^no need$/i.test(clean(value)) ? '' : clean(value)
const normalizeName = value => optional(value)
  .replace(/\bMargaritta\b/g, 'Margarita')
  .replace(/\bTennesse\b/g, 'Tennessee')
const normalizePacers = value => normalizeName(value)
  .replace(/\b(\d+)\b/g, 'Pacer $1')
const normalizeNotes = value => normalizeName(value)
  .replace(/\b(\d+)\b/g, 'Pacer $1')
  .replace(/\band meet me\b/gi, 'and meets me')
  .replace(/\bJonathan Brings\b/g, 'Jonathan brings')

const [headers, ...records] = parseCsv(crewPlanCsv)
const column = Object.fromEntries(headers.map((header, index) => [header.trim(), index]))

export const crewPlan = records.map(record => ({
  segment: Number(record[column.SEGMENT]),
  sourceDay: clean(record[column.DAY]),
  sourceEta: clean(record[column.ETA]).replace(/:(?=\s*[AP]M$)/i, ''),
  mi: Number(record[column.MILE]),
  name: clean(record[column['AID STATION']]),
  pacerIn: normalizePacers(record[column['PACER IN']]),
  pacerOut: normalizePacers(record[column['PACER OUT']]),
  supplies: normalizeName(record[column['CAR SUPPLY']]),
  transport: normalizeName(record[column.TRANSPORT]),
  notes: normalizeNotes(record[column.NOTES]),
}))
