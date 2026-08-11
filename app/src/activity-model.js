import activity from './data/activity.json?v=profile-bars-20260810'
import activitySummaryOverrides from './data/activity-summary.json'

export const M_PER_MI = 1609.344
export const FT_PER_M = 3.28084
export const activitySummary = { ...activity.summary, ...activitySummaryOverrides }
export const activityTrack = activity.track
export const activityTrackColumns = activity.trackColumns || [
  'lon', 'lat', 'altitudeM', 'distanceM', 'elapsedS',
]
export const activityTrackColumn = Object.fromEntries(
  activityTrackColumns.map((name, index) => [name, index]),
)
export const activitySampleIntervalS = activity.sampleIntervalS || 5
export const activityZones = activity.zones || {}
export const activityEvents = activity.events || {
  climbs: [],
  movement: [],
  offCourse: [],
}
export const activityTotalMi = activitySummary.distanceM / M_PER_MI
export const activityStartMs = new Date(activitySummary.startAt).getTime()
export const activityFinishMs = activityStartMs + activitySummary.elapsedS * 1000

const lastTrackPoint = activityTrack.at(-1)
export const rawTrackDistanceM = lastTrackPoint?.[3] || activitySummary.distanceM
const distanceScale = activitySummary.distanceM / rawTrackDistanceM

export const displayMiFromRawM = rawM => rawM * distanceScale / M_PER_MI
export const rawMFromDisplayMi = mi => mi * M_PER_MI / distanceScale

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const interpolate = (a, b, t) => a + (b - a) * t

function upperIndex(fieldIndex, target) {
  let lo = 0
  let hi = activityTrack.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (activityTrack[mid][fieldIndex] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function activityPointAtMi(mi) {
  if (!activityTrack.length) return null
  const rawM = clamp(rawMFromDisplayMi(mi), 0, rawTrackDistanceM)
  const index = upperIndex(3, rawM)
  if (index === 0) {
    const sample = activityTrack[0]
    return {
      index: 0,
      lon: sample[0],
      lat: sample[1],
      altitudeM: sample[2],
      rawDistanceM: rawM,
      elapsedS: sample[4],
      mi: displayMiFromRawM(rawM),
    }
  }
  const a = activityTrack[index - 1]
  const b = activityTrack[index]
  const ratio = b[3] === a[3] ? 0 : clamp((rawM - a[3]) / (b[3] - a[3]), 0, 1)
  return {
    index,
    lon: interpolate(a[0], b[0], ratio),
    lat: interpolate(a[1], b[1], ratio),
    altitudeM: interpolate(a[2], b[2], ratio),
    rawDistanceM: rawM,
    elapsedS: interpolate(a[4], b[4], ratio),
    mi: displayMiFromRawM(rawM),
  }
}

export function activityPointAtElapsed(elapsedS) {
  if (!activityTrack.length) return null
  const elapsed = clamp(elapsedS, 0, activitySummary.elapsedS)
  const index = upperIndex(4, elapsed)
  if (index === 0) return activityPointAtMi(0)
  const a = activityTrack[index - 1]
  const b = activityTrack[index]
  const ratio = b[4] === a[4] ? 0 : clamp((elapsed - a[4]) / (b[4] - a[4]), 0, 1)
  const rawDistanceM = interpolate(a[3], b[3], ratio)
  return {
    index,
    lon: interpolate(a[0], b[0], ratio),
    lat: interpolate(a[1], b[1], ratio),
    altitudeM: interpolate(a[2], b[2], ratio),
    rawDistanceM,
    elapsedS: elapsed,
    mi: displayMiFromRawM(rawDistanceM),
  }
}

export const activityElapsedAtMi = mi => activityPointAtMi(mi)?.elapsedS ?? null

export function activityClockAtMi(mi) {
  const elapsedS = activityElapsedAtMi(mi)
  return elapsedS == null ? null : new Date(activityStartMs + elapsedS * 1000)
}

export function activityMiAtTime(value) {
  const timeMs = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!Number.isFinite(timeMs)) return null
  return activityPointAtElapsed((timeMs - activityStartMs) / 1000)?.mi ?? null
}

const cumulativeGainM = new Float64Array(activityTrack.length)
const cumulativeLossM = new Float64Array(activityTrack.length)
for (let index = 1; index < activityTrack.length; index += 1) {
  const delta = activityTrack[index][2] - activityTrack[index - 1][2]
  cumulativeGainM[index] = cumulativeGainM[index - 1] + Math.max(0, delta)
  cumulativeLossM[index] = cumulativeLossM[index - 1] + Math.max(0, -delta)
}
const rawGainM = cumulativeGainM.at(-1) || 1
const rawLossM = cumulativeLossM.at(-1) || 1
const netElevationM = (activityTrack.at(-1)?.[2] || 0) - (activityTrack[0]?.[2] || 0)
const verifiedLossM = Math.max(0, activitySummary.elevationGainM - netElevationM)
const gainScale = activitySummary.elevationGainM / rawGainM
const lossScale = verifiedLossM / rawLossM

export function activityStatsBetween(aMi, bMi) {
  const fromMi = clamp(Math.min(aMi, bMi), 0, activityTotalMi)
  const toMi = clamp(Math.max(aMi, bMi), 0, activityTotalMi)
  const from = activityPointAtMi(fromMi)
  const to = activityPointAtMi(toMi)
  const fromIndex = from?.index ?? 0
  const toIndex = to?.index ?? fromIndex
  const distanceMi = Math.max(0, toMi - fromMi)
  const netFt = ((to?.altitudeM ?? 0) - (from?.altitudeM ?? 0)) * FT_PER_M
  const elapsedS = Math.max(0, (to?.elapsedS ?? 0) - (from?.elapsedS ?? 0))
  return {
    mi: distanceMi,
    gain: (cumulativeGainM[toIndex] - cumulativeGainM[fromIndex]) * gainScale * FT_PER_M,
    loss: (cumulativeLossM[toIndex] - cumulativeLossM[fromIndex]) * lossScale * FT_PER_M,
    netFt,
    gradePct: distanceMi ? netFt / (distanceMi * 5280) * 100 : 0,
    elapsedS,
    startElapsedS: from?.elapsedS ?? 0,
    finishElapsedS: to?.elapsedS ?? 0,
    startAt: new Date(activityStartMs + (from?.elapsedS ?? 0) * 1000),
    finishAt: new Date(activityStartMs + (to?.elapsedS ?? 0) * 1000),
  }
}

export function activityGradeAt(mi, windowMi = 0.22) {
  return activityStatsBetween(mi - windowMi, mi + windowMi).gradePct
}

export const activityLineFeature = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'LineString',
    coordinates: activityTrack.map(sample => sample.slice(0, 2)),
  },
}

export function activitySliceFeature(aMi, bMi) {
  const fromMi = clamp(Math.min(aMi, bMi), 0, activityTotalMi)
  const toMi = clamp(Math.max(aMi, bMi), 0, activityTotalMi)
  const from = activityPointAtMi(fromMi)
  const to = activityPointAtMi(toMi)
  const coordinates = [[from.lon, from.lat]]
  for (let index = from.index; index < to.index; index += 1) {
    coordinates.push(activityTrack[index].slice(0, 2))
  }
  coordinates.push([to.lon, to.lat])
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  }
}

export const activityEndpointFeatures = {
  type: 'FeatureCollection',
  features: [activityTrack[0], activityTrack.at(-1)].filter(Boolean).map((sample, index) => ({
    type: 'Feature',
    properties: { kind: index === 0 ? 'start' : 'finish' },
    geometry: { type: 'Point', coordinates: sample.slice(0, 2) },
  })),
}

export function activityTimeTicks(stepSeconds = 4 * 3600) {
  const ticks = []
  for (let elapsedS = 0; elapsedS <= activitySummary.elapsedS; elapsedS += stepSeconds) {
    ticks.push(activityPointAtElapsed(elapsedS))
  }
  if (ticks.at(-1)?.elapsedS !== activitySummary.elapsedS) {
    ticks.push(activityPointAtElapsed(activitySummary.elapsedS))
  }
  return ticks.filter(Boolean)
}

const radians = value => value * Math.PI / 180
function haversineM(aLat, aLon, bLat, bLon) {
  const dLat = radians(bLat - aLat)
  const dLon = radians(bLon - aLon)
  const q = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLon / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(q))
}

export function nearestActivityPoint(targetLat, targetLon, expectedMi = null, windowMi = 7) {
  let lowIndex = 0
  let highIndex = activityTrack.length - 1
  if (Number.isFinite(expectedMi)) {
    lowIndex = upperIndex(3, rawMFromDisplayMi(Math.max(0, expectedMi - windowMi)))
    highIndex = upperIndex(3, rawMFromDisplayMi(Math.min(activityTotalMi, expectedMi + windowMi)))
  }
  let bestIndex = lowIndex
  let bestDistanceM = Infinity
  for (let index = lowIndex; index <= highIndex; index += 1) {
    const sample = activityTrack[index]
    const distanceM = haversineM(targetLat, targetLon, sample[1], sample[0])
    if (distanceM < bestDistanceM) {
      bestDistanceM = distanceM
      bestIndex = index
    }
  }
  const sample = activityTrack[bestIndex]
  return {
    index: bestIndex,
    offsetM: bestDistanceM,
    lon: sample[0],
    lat: sample[1],
    altitudeM: sample[2],
    rawDistanceM: sample[3],
    mi: displayMiFromRawM(sample[3]),
    elapsedS: sample[4],
    clock: new Date(activityStartMs + sample[4] * 1000),
  }
}

export function matchActivityCheckpoints(checkpoints, windowMi = 7) {
  let minimumIndex = 0
  return checkpoints.map(checkpoint => {
    const expectedMi = clamp(checkpoint.expectedMi, 0, activityTotalMi)
    const lowMi = Math.max(0, expectedMi - windowMi)
    const highMi = Math.min(activityTotalMi, expectedMi + windowMi)
    const lowIndex = Math.max(minimumIndex, upperIndex(3, rawMFromDisplayMi(lowMi)))
    const highIndex = Math.max(lowIndex, upperIndex(3, rawMFromDisplayMi(highMi)))
    let bestIndex = checkpoint.id === 'start'
      ? 0
      : checkpoint.id === 'finish'
        ? activityTrack.length - 1
        : lowIndex
    let bestDistanceM = Infinity
    if (checkpoint.id === 'start' || checkpoint.id === 'finish') {
      const sample = activityTrack[bestIndex]
      bestDistanceM = haversineM(checkpoint.lat, checkpoint.lon, sample[1], sample[0])
    } else {
      for (let index = lowIndex; index <= highIndex; index += 1) {
        const sample = activityTrack[index]
        const distanceM = haversineM(checkpoint.lat, checkpoint.lon, sample[1], sample[0])
        if (distanceM < bestDistanceM) {
          bestDistanceM = distanceM
          bestIndex = index
        }
      }
    }
    minimumIndex = bestIndex
    const sample = activityTrack[bestIndex]
    return {
      ...checkpoint,
      trackIndex: bestIndex,
      offsetM: bestDistanceM,
      lon: sample[0],
      lat: sample[1],
      altitudeM: sample[2],
      rawDistanceM: checkpoint.id === 'start' ? 0 : sample[3],
      mi: checkpoint.id === 'start' ? 0 : displayMiFromRawM(sample[3]),
      elapsedS: sample[4],
      clock: new Date(activityStartMs + sample[4] * 1000),
    }
  })
}
