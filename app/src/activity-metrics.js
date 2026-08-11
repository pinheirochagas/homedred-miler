import {
  M_PER_MI,
  activityEvents,
  activityGradeAt,
  activityPointAtElapsed,
  activityPointAtMi,
  activitySampleIntervalS,
  activityTrack,
  activityTrackColumn,
  activityZones,
  displayMiFromRawM,
} from './activity-model.js?v=profile-bars-20260810'

const palette = (...colors) => colors

export const METRIC_DEFS = [
  {
    key: 'pace',
    label: 'pace',
    column: 'speedMps',
    color: '#2f7887',
    colors: palette('#dce8ea', '#afcdd2', '#79aab3', '#4a8b98', '#2f7887', '#1b5662'),
    smoothS: 90,
    invertAxis: true,
    reverseScale: true,
    valid: value => value > 0.35,
    transform: speedMps => M_PER_MI / speedMps,
    format: value => `${formatDuration(value)}/mi`,
  },
  {
    key: 'gradeAdjustedPace',
    label: 'grade-adjusted pace',
    color: '#536a8a',
    colors: palette('#e0e5ec', '#bdc8d7', '#94a5bd', '#7087a5', '#536a8a', '#394c69'),
    smoothS: 90,
    invertAxis: true,
    reverseScale: true,
    derived: 'gradeAdjustedPace',
    format: value => `${formatDuration(value)}/mi`,
  },
  {
    key: 'heartRate',
    label: 'heart rate',
    column: 'heartRateBpm',
    color: '#a54461',
    colors: palette('#f0e1e6', '#dfb9c5', '#ca879d', '#b65f79', '#9d3e5a', '#74253e'),
    smoothS: 90,
    valid: value => value > 0,
    zones: () => activityZones.heartRateHighBpm,
    format: value => `${Math.round(value)} bpm`,
  },
  {
    key: 'power',
    label: 'power',
    column: 'powerW',
    color: '#695a9c',
    colors: palette('#e8e4f0', '#c9c1df', '#a99bc9', '#8b79b5', '#695a9c', '#493a76'),
    smoothS: 90,
    valid: value => value >= 0,
    zones: () => activityZones.powerHighW,
    format: value => `${Math.round(value)} W`,
  },
  {
    key: 'cadence',
    label: 'cadence',
    column: 'cadenceSpm',
    color: '#3d7b5d',
    colors: palette('#e0ebe4', '#b7d2c1', '#85b19a', '#5c9475', '#3d7b5d', '#27553f'),
    smoothS: 60,
    valid: value => value > 20,
    format: value => `${Math.round(value)} spm`,
  },
  {
    key: 'temperature',
    label: 'device temp',
    column: 'temperatureC',
    color: '#a45f3b',
    colors: palette('#efe5df', '#dec5b6', '#c99e83', '#b77a58', '#a45f3b', '#744025'),
    smoothS: 600,
    valid: Number.isFinite,
    format: value => `${Math.round(value * 9 / 5 + 32)} °F`,
  },
  {
    key: 'verticalOscillation',
    label: 'vertical oscillation',
    column: 'verticalOscillationMm',
    color: '#4f6f91',
    colors: palette('#e1e7ed', '#bdcad8', '#91a8bf', '#6988a7', '#4f6f91', '#354d69'),
    smoothS: 60,
    valid: value => value > 0,
    format: value => `${(value / 25.4).toFixed(2)} in`,
  },
  {
    key: 'groundContact',
    label: 'ground contact',
    column: 'groundContactMs',
    color: '#86634e',
    colors: palette('#ece5e0', '#d8c5b8', '#bea08c', '#a27d64', '#86634e', '#604536'),
    smoothS: 60,
    valid: value => value > 0,
    format: value => `${Math.round(value)} ms`,
  },
  {
    key: 'verticalRatio',
    label: 'vertical ratio',
    column: 'verticalRatioPct',
    color: '#727642',
    colors: palette('#eaebdf', '#d4d6b8', '#b6ba88', '#92995d', '#727642', '#50542e'),
    smoothS: 60,
    valid: value => value > 0,
    format: value => `${value.toFixed(1)}%`,
  },
  {
    key: 'strideLength',
    label: 'stride length',
    column: 'strideLengthMm',
    color: '#3d7772',
    colors: palette('#dfebe9', '#b5d2ce', '#82b0ab', '#5b918b', '#3d7772', '#28534f'),
    smoothS: 60,
    valid: value => value > 0,
    format: value => `${(value / 304.8).toFixed(2)} ft`,
  },
  {
    key: 'grade',
    label: 'grade',
    color: '#95613a',
    colors: palette('#4e7287', '#91acb7', '#e5e6df', '#c69a68', '#95613a'),
    symmetric: true,
    derived: 'grade',
    format: value => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`,
  },
  {
    key: 'verticalSpeed',
    label: 'vertical speed',
    color: '#875a77',
    colors: palette('#4f7184', '#93abb5', '#e5e6e1', '#bb8da8', '#875a77'),
    symmetric: true,
    derived: 'verticalSpeed',
    format: value => `${value >= 0 ? '+' : ''}${Math.round(value * 196.8504)} ft/min`,
  },
]

export const METRIC_BY_KEY = Object.fromEntries(METRIC_DEFS.map(def => [def.key, def]))

export const EVENT_DEFS = {
  movement: {
    label: 'run / walk',
    color: '#4f7562',
    colors: {
      run: '#4f7562',
      walk: '#a0834f',
      stand: '#8a6262',
    },
  },
  climbs: {
    label: 'climbs',
    color: '#6e668e',
  },
  offCourse: {
    label: 'off course',
    color: '#a54461',
  },
}

const seriesCache = new Map()
const domainCache = new Map()
const eventRangesCache = new Map()

function formatDuration(seconds) {
  const rounded = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(rounded / 60)
  return `${minutes}:${String(rounded % 60).padStart(2, '0')}`
}

function directSeries(def) {
  const column = activityTrackColumn[def.column]
  if (!Number.isInteger(column)) return activityTrack.map(() => null)
  return activityTrack.map(sample => {
    const source = sample[column]
    if (!Number.isFinite(source) || !def.valid(source)) return null
    return def.transform ? def.transform(source) : source
  })
}

function gradeSeries() {
  return activityTrack.map(sample =>
    activityGradeAt(displayMiFromRawM(sample[3]), 0.18))
}

function gradeAdjustedPaceSeries() {
  const speedColumn = activityTrackColumn.speedMps
  const grades = gradeSeries()
  return activityTrack.map((sample, index) => {
    const speed = sample[speedColumn]
    if (!Number.isFinite(speed) || speed <= 0.35) return null
    const grade = Math.min(0.25, Math.max(-0.25, grades[index] / 100))
    const cost =
      155.4 * grade ** 5 -
      30.4 * grade ** 4 -
      43.3 * grade ** 3 +
      46.3 * grade ** 2 +
      19.5 * grade +
      3.6
    const effortFactor = Math.min(2.5, Math.max(0.5, cost / 3.6))
    return M_PER_MI / speed / effortFactor
  })
}

function verticalSpeedSeries() {
  const radius = Math.max(1, Math.round(60 / activitySampleIntervalS))
  return activityTrack.map((sample, index) => {
    const from = activityTrack[Math.max(0, index - radius)]
    const to = activityTrack[Math.min(activityTrack.length - 1, index + radius)]
    const seconds = to[4] - from[4]
    return seconds > 0 ? (to[2] - from[2]) / seconds : null
  })
}

function smooth(values, seconds) {
  if (!seconds) return values
  const radius = Math.max(1, Math.round(seconds / activitySampleIntervalS / 2))
  const sums = new Float64Array(values.length + 1)
  const counts = new Uint32Array(values.length + 1)
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    sums[index + 1] = sums[index] + (Number.isFinite(value) ? value : 0)
    counts[index + 1] = counts[index] + (Number.isFinite(value) ? 1 : 0)
  }
  return values.map((value, index) => {
    if (!Number.isFinite(value)) return null
    const from = Math.max(0, index - radius)
    const to = Math.min(values.length, index + radius + 1)
    const count = counts[to] - counts[from]
    return count ? (sums[to] - sums[from]) / count : null
  })
}

export function metricSeries(key) {
  if (seriesCache.has(key)) return seriesCache.get(key)
  const def = METRIC_BY_KEY[key]
  if (!def) return []
  let values
  if (def.derived === 'grade') values = gradeSeries()
  else if (def.derived === 'gradeAdjustedPace') values = gradeAdjustedPaceSeries()
  else if (def.derived === 'verticalSpeed') values = verticalSpeedSeries()
  else values = directSeries(def)
  const result = smooth(values, def.smoothS)
  seriesCache.set(key, result)
  return result
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0
  const position = (sorted.length - 1) * ratio
  const low = Math.floor(position)
  const high = Math.ceil(position)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

export function metricDomain(key) {
  if (domainCache.has(key)) return domainCache.get(key)
  const def = METRIC_BY_KEY[key]
  const values = metricSeries(key).filter(Number.isFinite).sort((a, b) => a - b)
  let min = percentile(values, 0.02)
  let max = percentile(values, 0.98)
  if (def?.symmetric) {
    const extent = Math.max(Math.abs(min), Math.abs(max), 1)
    min = -extent
    max = extent
  } else if (min === max) {
    min -= 1
    max += 1
  }
  const domain = { min, max }
  domainCache.set(key, domain)
  return domain
}

function zoneIndex(def, value) {
  const boundaries = (def.zones?.() || []).filter(Number.isFinite)
  if (!boundaries.length) return null
  const index = boundaries.findIndex(boundary => value <= boundary)
  return index < 0 ? boundaries.length : index
}

export function metricColor(key, value) {
  const def = METRIC_BY_KEY[key]
  if (!def || !Number.isFinite(value)) return null
  const zone = zoneIndex(def, value)
  if (zone != null) return def.colors[Math.min(def.colors.length - 1, zone)]
  const { min, max } = metricDomain(key)
  let ratio = Math.min(1, Math.max(0, (value - min) / (max - min || 1)))
  if (def.reverseScale) ratio = 1 - ratio
  return def.colors[Math.round(ratio * (def.colors.length - 1))]
}

export function metricGradient(key) {
  const def = METRIC_BY_KEY[key]
  if (!def) return ''
  const colors = def.reverseScale ? [...def.colors].reverse() : def.colors
  return `linear-gradient(90deg, ${colors.join(', ')})`
}

export function metricValueAtMi(key, mi) {
  const values = metricSeries(key)
  const point = activityPointAtMi(mi)
  if (!point || !values.length) return null
  const index = point.index
  if (index === 0) return values[0]
  const a = activityTrack[index - 1]
  const b = activityTrack[index]
  const av = values[index - 1]
  const bv = values[index]
  if (!Number.isFinite(av)) return Number.isFinite(bv) ? bv : null
  if (!Number.isFinite(bv)) return av
  const ratio = b[3] === a[3]
    ? 0
    : Math.min(1, Math.max(0, (point.rawDistanceM - a[3]) / (b[3] - a[3])))
  return av + (bv - av) * ratio
}

export function metricStatsBetween(key, aMi, bMi) {
  const values = metricSeries(key)
  const from = activityPointAtMi(Math.min(aMi, bMi))
  const to = activityPointAtMi(Math.max(aMi, bMi))
  if (!from || !to) return null
  const selected = values
    .slice(Math.max(0, from.index - 1), to.index + 1)
    .filter(Number.isFinite)
  if (!selected.length) return null
  return {
    min: Math.min(...selected),
    max: Math.max(...selected),
    avg: selected.reduce((sum, value) => sum + value, 0) / selected.length,
  }
}

export function eventRanges(kind) {
  if (eventRangesCache.has(kind)) return eventRangesCache.get(kind)
  let ranges = []
  if (kind === 'movement') {
    const colors = EVENT_DEFS.movement.colors
    ranges = activityEvents.movement.map(([startS, finishS, mode]) => ({
      a: activityPointAtElapsed(startS).mi,
      b: activityPointAtElapsed(finishS).mi,
      type: mode,
      color: colors[mode],
    }))
  } else if (kind === 'climbs') {
    ranges = activityEvents.climbs.map(([startM, finishM, category]) => ({
      a: displayMiFromRawM(startM),
      b: displayMiFromRawM(finishM),
      type: `category ${category}`,
      category,
      color: EVENT_DEFS.climbs.color,
    }))
  } else if (kind === 'offCourse') {
    ranges = activityEvents.offCourse.map(([startS, finishS]) => ({
      a: activityPointAtElapsed(startS).mi,
      b: activityPointAtElapsed(finishS).mi,
      type: 'off course',
      color: EVENT_DEFS.offCourse.color,
    }))
  }
  const valid = ranges.filter(range =>
    Number.isFinite(range.a) && Number.isFinite(range.b) && range.b > range.a)
  eventRangesCache.set(kind, valid)
  return valid
}
