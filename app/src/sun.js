// Compact solar calculator (adapted from suncalc, BSD-2)
const rad = Math.PI / 180
const dayMs = 86400000
const J1970 = 2440588
const J2000 = 2451545
const e = rad * 23.4397

const toJulian = d => d.valueOf() / dayMs - 0.5 + J1970
const fromJulian = j => new Date((j + 0.5 - J1970) * dayMs)
const toDays = d => toJulian(d) - J2000

const solarMeanAnomaly = d => rad * (357.5291 + 0.98560028 * d)
const eclipticLongitude = M => {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M))
  return M + C + rad * 102.9372 + Math.PI
}
const declination = l => Math.asin(Math.sin(0) * Math.cos(e) + Math.cos(0) * Math.sin(e) * Math.sin(l))

export function sunTimes(date, lat = 37.9, lng = -122.6) {
  const lw = rad * -lng
  const phi = rad * lat
  const d = toDays(date)
  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI))
  const ds = 0.0009 + lw / (2 * Math.PI) + n
  const M = solarMeanAnomaly(ds)
  const L = eclipticLongitude(M)
  const dec = declination(L)
  const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L)
  const h0 = rad * -0.833
  const cosH = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec))
  const w = Math.acos(Math.min(1, Math.max(-1, cosH)))
  const a = 0.0009 + (w + lw) / (2 * Math.PI) + n
  const Jset = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L)
  const Jrise = Jnoon - (Jset - Jnoon)
  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset) }
}

export function isDST(d) {
  const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset()
  return d.getTimezoneOffset() < jan
}

export const hhmm = d =>
  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false })

export const dayhm = d =>
  d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false })

/**
 * Resolve a window spec into concrete open/close Dates for the day of `at`.
 * Specs: "24h" | "HH:MM-HH:MM" | "HH:MM-sunset" | "HH:MM-sunset+60"
 *        | "sunrise-sunset" | "watershed-parking" | "bridge" (GGB east sidewalk)
 */
export function resolveWindow(spec, at) {
  if (!spec || spec === '24h') return null
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  const sun = sunTimes(new Date(day.getTime() + 12 * 3600000))
  const part = s => {
    if (s === 'sunrise') return sun.sunrise
    const m = s.match(/^sunset(?:\+(\d+))?$/)
    if (m) return new Date(sun.sunset.getTime() + (m[1] ? +m[1] * 60000 : 0))
    const [h, mm] = s.split(':').map(Number)
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mm || 0)
  }
  if (spec === 'bridge') {
    const close = isDST(at) ? '21:00' : '18:30'
    const w = { open: part('5:00'), close: part(close) }
    return { ...w, label: `${hhmm(w.open)}–${hhmm(w.close)}` }
  }
  if (spec === 'watershed-parking') {
    const w = {
      open: new Date(sun.sunrise.getTime() - 30 * 60000),
      close: new Date(sun.sunset.getTime() + 30 * 60000),
    }
    return { ...w, label: `${hhmm(w.open)}–${hhmm(w.close)}` }
  }
  const [o, c] = spec.split('-')
  const w = { open: part(o), close: part(c) }
  return { ...w, label: `${hhmm(w.open)}–${hhmm(w.close)}` }
}

/** 'ok' | 'tight' (≤45min to close) | 'closed' */
export function windowStatus(spec, at) {
  const w = resolveWindow(spec, at)
  if (!w) return { st: 'ok', w: null }
  if (at < w.open || at > w.close) return { st: 'closed', w }
  if (w.close - at < 45 * 60000) return { st: 'tight', w }
  return { st: 'ok', w }
}
