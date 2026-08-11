import crewPlanCsv from '../../crew/crew_plan.csv?raw&v=actual-record-20260810'
import { waypoints } from './waypoints.js?v=actual-activity-20260810'

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
const optional = value => /^(?:no need|n\/a)$/i.test(clean(value)) ? '' : clean(value)
const normalizeName = value => optional(value)
  .replace(/\bMargaritta\b/g, 'Margarita')
  .replace(/\bTennesse\b/g, 'Tennessee')
const normalizePacers = value => normalizeName(value)
  .replace(/\b(\d+)\b/g, 'Pacer $1')
const elapsedSeconds = value => {
  const parts = clean(value).split(':').map(Number)
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null
  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

const [headers, ...records] = parseCsv(crewPlanCsv)
const column = Object.fromEntries(headers.map((header, index) => [header.trim(), index]))
const crewWaypoints = waypoints.filter(waypoint => waypoint.crew)
const cell = (record, header) => {
  const index = column[header]
  return index == null ? '' : record[index]
}

export const crewPlan = records.map(record => {
  const segment = Number(cell(record, 'SEGMENT'))
  const waypoint = crewWaypoints[segment - 1]
  if (!waypoint) throw new Error(`Crew plan segment ${segment} has no matching waypoint`)
  const mileValue = clean(cell(record, 'MILE'))
  const csvMile = mileValue === '' ? null : Number(mileValue)
  const actualMileValue = clean(cell(record, 'ACTUAL MILE'))
  const actualMi = actualMileValue === '' ? null : Number(actualMileValue)
  return {
    segment,
    waypointId: waypoint.id,
    mi: Number.isFinite(csvMile) ? csvMile : waypoint.mi,
    actualMi: Number.isFinite(actualMi) ? actualMi : null,
    arrived: clean(cell(record, 'ARRIVED')),
    elapsedS: elapsedSeconds(cell(record, 'ELAPSED')),
    name: clean(cell(record, 'AID STATION')) || waypoint.name,
    pacerIn: normalizePacers(cell(record, 'PACER IN')),
    pacerOut: normalizePacers(cell(record, 'PACER OUT')),
    supplies: normalizeName(cell(record, 'CAR SUPPLY')),
    transport: normalizeName(cell(record, 'TRANSPORT')),
    notes: normalizeName(cell(record, 'NOTES')),
  }
})
