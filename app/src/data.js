import raw from './data/course.json'

// pts rows: [lat, lon, eleFt, distMi, cumGainFt, cumLossFt]
const P = raw.pts
const N = P.length

export const course = {
  name: raw.name,
  totalMi: raw.totalMi,
  gainFt: raw.gainFt,
  lossFt: raw.lossFt,
  minEleFt: raw.minEleFt,
  maxEleFt: raw.maxEleFt,
  n: N,
}

export const lat = i => P[i][0]
export const lon = i => P[i][1]
export const ele = i => P[i][2]
export const dist = i => P[i][3]
export const cgain = i => P[i][4]
export const closs = i => P[i][5]

export function idxAt(mi) {
  let lo = 0, hi = N - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (P[mid][3] < mi) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function ptAt(mi) {
  const i = Math.min(Math.max(idxAt(mi), 1), N - 1)
  const a = P[i - 1], b = P[i]
  const t = b[3] === a[3] ? 0 : (mi - a[3]) / (b[3] - a[3])
  const cl = x => Math.min(1, Math.max(0, x))
  const k = cl(t)
  return {
    lat: a[0] + (b[0] - a[0]) * k,
    lon: a[1] + (b[1] - a[1]) * k,
    ele: a[2] + (b[2] - a[2]) * k,
  }
}

export function statsBetween(aMi, bMi) {
  const ia = idxAt(aMi), ib = idxAt(bMi)
  const d = dist(ib) - dist(ia)
  const g = cgain(ib) - cgain(ia)
  const l = closs(ib) - closs(ia)
  const de = ele(ib) - ele(ia)
  return { mi: d, gain: g, loss: l, netFt: de, gradePct: d > 0 ? de / (d * 5280) * 100 : 0 }
}

// local grade (%) over +/- window
export function gradeAt(mi, win = 0.22) {
  const a = idxAt(Math.max(0, mi - win))
  const b = idxAt(Math.min(course.totalMi, mi + win))
  const d = (dist(b) - dist(a)) * 5280
  return d > 0 ? (ele(b) - ele(a)) / d * 100 : 0
}

export function lineCoords(aMi = 0, bMi = course.totalMi) {
  const ia = idxAt(aMi), ib = idxAt(bMi)
  const out = []
  for (let i = ia; i <= ib; i++) out.push([P[i][1], P[i][0]])
  return out
}

export const fullLine = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: lineCoords() },
}

export function sliceLine(aMi, bMi) {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: lineCoords(aMi, bMi) },
  }
}

export const fmtFt = x => Math.round(x).toLocaleString('en-US')
export const fmtMi = x => x.toFixed(1)
