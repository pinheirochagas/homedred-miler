import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import './style.css'
import {
  course, ptAt, statsBetween, gradeAt, fullLine, sliceLine,
  idxAt, dist, ele, cgain, fmtFt, fmtMi,
} from './data.js'
import { waypoints } from './waypoints.js'
import { resolveWindow, windowStatus, sunTimes, hhmm } from './sun.js'

const TOKEN = import.meta.env.MAPBOX_TOKEN
const $ = s => document.querySelector(s)

// ---------------------------------------------------------------- state
const saved = JSON.parse(localStorage.getItem('hm-plan') || 'null')
const plan = {
  start: saved?.start ? new Date(saved.start) : nextSat5am(),
  hours: saved?.hours || 32,
}
let sel = null            // {a, b} miles
let hoverMi = null
let filter = 'all'
let orbiting = false
let satellite = false

function nextSat5am() {
  const d = new Date()
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7))
  d.setHours(5, 0, 0, 0)
  return d
}

// Grade-adjusted, even-effort pace model: 1,000 ft of climb ≈ 2 flat miles.
const effortAt = mi => {
  const i = idxAt(mi)
  return dist(i) + cgain(i) / 500
}
const TOTAL_EFFORT = effortAt(course.totalMi)
const etaAt = mi =>
  new Date(plan.start.getTime() + plan.hours * 3600000 * (effortAt(mi) / TOTAL_EFFORT))

// ---------------------------------------------------------------- map
function fatal(msg) {
  const el = $('#err')
  el.hidden = false
  el.textContent = msg
}

// strict monochrome (mirrors style.css) — plus one botanical green,
// reserved exclusively for the measured segment
const C = {
  paper: '#ffffff',
  ink: '#000000',
  gray: '#8a8a8a',
  moss: '#4d6b4a',
  wash: 'rgba(124, 155, 120, 0.2)',
}
const STYLE_LIGHT = 'mapbox://styles/mapbox/light-v11'
const STYLE_SAT = 'mapbox://styles/mapbox/satellite-streets-v12'

let map = null
try {
  mapboxgl.accessToken = TOKEN
  map = new mapboxgl.Map({
    container: 'map',
    style: STYLE_LIGHT,
    center: [-122.58, 37.895],
    zoom: 10.35,
    pitch: 58,
    bearing: -14,
    antialias: true,
    attributionControl: false,
    // in the stacked touch layout one-finger swipes scroll the page; two fingers pan the map
    cooperativeGestures: matchMedia('(pointer: coarse) and (max-width: 940px)').matches,
  })
  map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right')
  map.on('error', e => {
    const st = e?.error?.status
    if (st === 401 || st === 403) {
      fatal(`Mapbox rejected the token (${st}). Put a valid public token in .env as MAPBOX_TOKEN=pk… and restart.`)
    }
  })
} catch (err) {
  fatal(`Map disabled — ${err.message} The profile and crew plan below still work.`)
}
if (import.meta.env.DEV) window.__map = map

const bbox = (() => {
  let w = 180, s = 90, e = -180, n = -90
  for (const [x, y] of fullLine.geometry.coordinates) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y)
  }
  return [[w, s], [e, n]]
})()

function addCourseLayers() {
  // quiet the basemap: keep major settlements and water names, drop the rest
  for (const lyr of map.getStyle().layers) {
    if (lyr.type !== 'symbol') continue
    if (/^(settlement-major-label|water-point-label|water-line-label|natural-point-label|natural-line-label)/.test(lyr.id)) continue
    map.setLayoutProperty(lyr.id, 'visibility', 'none')
  }

  if (!map.getSource('dem')) {
    map.addSource('dem', {
      type: 'raster-dem',
      url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
      tileSize: 512,
      maxzoom: 14,
    })
  }
  map.setTerrain({ source: 'dem', exaggeration: 1.5 })
  map.setFog({
    range: [0.7, 10],
    color: '#ffffff',
    'high-color': '#f4f4f4',
    'space-color': '#ffffff',
    'horizon-blend': 0.03,
    'star-intensity': 0,
  })

  if (!map.getSource('course')) {
    map.addSource('course', { type: 'geojson', data: fullLine, lineMetrics: true })
    map.addSource('course-sel', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    map.addSource('miles', { type: 'geojson', data: mileMarkerGeojson() })
  }

  // white halo keeps the line legible over map labels and satellite
  map.addLayer({
    id: 'course-case', type: 'line', source: 'course',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': C.paper, 'line-opacity': 0.9,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4.5, 14, 9],
    },
  })
  // a single black line, like a drawing
  map.addLayer({
    id: 'course-line', type: 'line', source: 'course',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': C.ink,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.6, 14, 3.4],
      'line-opacity': sel ? 0.22 : 1,
    },
  })
  // measured segment turns green; the rest of the course fades
  map.addLayer({
    id: 'course-sel-line', type: 'line', source: 'course-sel',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': C.moss,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.4, 14, 5],
    },
  })
  map.addLayer({
    id: 'mile-dots', type: 'circle', source: 'miles',
    paint: {
      'circle-radius': 2.1, 'circle-color': C.paper,
      'circle-stroke-width': 1.1, 'circle-stroke-color': C.ink,
    },
  })
  map.addLayer({
    id: 'mile-labels', type: 'symbol', source: 'miles',
    filter: ['==', ['%', ['get', 'm'], 10], 0],
    layout: {
      'text-field': ['get', 'm'],
      'text-font': ['DIN Pro Regular', 'Arial Unicode MS Regular'],
      'text-size': 10.5, 'text-offset': [0, -1.15], 'text-allow-overlap': true,
    },
    paint: {
      'text-color': C.ink,
      'text-halo-color': C.paper, 'text-halo-width': 1.3,
    },
  })
  if (sel) map.getSource('course-sel').setData(sliceLine(sel.a, sel.b))
}

function mileMarkerGeojson() {
  const feats = []
  for (let m = 5; m < course.totalMi; m += 5) {
    const p = ptAt(m)
    feats.push({
      type: 'Feature', properties: { m },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })
  }
  return { type: 'FeatureCollection', features: feats }
}

// Waypoints + hover ghost live in draped layers (DOM markers drift on 3D terrain).
const wpGeojson = {
  type: 'FeatureCollection',
  features: waypoints.map(w => {
    const p = ptAt(w.mi)
    return {
      type: 'Feature',
      properties: {
        id: w.id,
        major: w.kind === 'major' ? 1 : 0,
        gated: w.gate ? 1 : 0,
        crew: w.crew ? 1 : 0,
        label: w.name.split(/·|—/)[0].trim(),
      },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    }
  }),
}
const EMPTY = { type: 'FeatureCollection', features: [] }

function addWaypointLayers() {
  map.addSource('wps', { type: 'geojson', data: wpGeojson })
  map.addSource('ghost', { type: 'geojson', data: EMPTY })

  // crew stops solid black, foot-only hollow — nothing else
  map.addLayer({
    id: 'wp-dots', type: 'circle', source: 'wps',
    paint: {
      'circle-radius': ['case', ['==', ['get', 'major'], 1], 4.6, 3],
      'circle-color': ['case', ['==', ['get', 'crew'], 0], C.paper, C.ink],
      'circle-stroke-width': 1.1,
      'circle-stroke-color': ['case', ['==', ['get', 'crew'], 0], C.ink, C.paper],
    },
  })
  map.addLayer({
    id: 'wp-labels', type: 'symbol', source: 'wps',
    filter: ['==', ['get', 'major'], 1],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['DIN Pro Regular', 'Arial Unicode MS Regular'],
      'text-size': 10.5,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-letter-spacing': 0.02,
    },
    paint: {
      'text-color': C.ink,
      'text-halo-color': 'rgba(255,255,255,0.95)',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'ghost-dot', type: 'circle', source: 'ghost',
    paint: {
      'circle-radius': 5,
      'circle-color': C.ink,
      'circle-stroke-width': 1.6,
      'circle-stroke-color': C.paper,
      'circle-emissive-strength': 1,
    },
  })

  map.on('click', 'wp-dots', e => {
    const id = e.features?.[0]?.properties?.id
    if (id) focusWaypoint(id, true)
  })
  map.on('mouseenter', 'wp-dots', () => (map.getCanvas().style.cursor = 'pointer'))
  map.on('mouseleave', 'wp-dots', () => (map.getCanvas().style.cursor = ''))
}

function setGhost(mi) {
  const src = map?.getSource('ghost')
  if (!src) return
  if (mi == null) { src.setData(EMPTY); return }
  const p = ptAt(mi)
  src.setData({
    type: 'Feature', properties: {},
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  })
}

// masthead sits over the map top-left; on the stacked mobile layout it spans the top
const fitPad = () =>
  matchMedia('(max-width: 940px)').matches
    ? { top: 205, bottom: 30, left: 24, right: 24 }
    : { top: 60, bottom: 70, left: 240, right: 70 }

let popup = null
if (map) {
  map.on('style.load', () => { addCourseLayers(); addWaypointLayers() })
  map.once('load', () => {
    map.fitBounds(bbox, {
      padding: fitPad(),
      pitch: 52, bearing: -14, duration: 2600, essential: true,
    })
  })
  popup = new mapboxgl.Popup({ className: 'wp-pop', offset: 16, maxWidth: '300px' })
  map.on('mousedown', stopOrbit)
}

function focusWaypoint(id, fromMap = false) {
  const w = waypoints.find(x => x.id === id)
  const p = ptAt(w.mi)
  document.querySelectorAll('.wp').forEach(li =>
    li.classList.toggle('sel', li.dataset.id === id))
  $(`.wp[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  if (!map) return

  const eta = etaAt(w.mi)
  const gate = w.gate ? resolveWindow(w.gate.spec, eta) : null
  const st = w.gate ? windowStatus(w.gate.spec, eta).st : 'ok'
  popup.setLngLat([p.lon, p.lat]).setHTML(`
    <div class="pop-nm">${w.name}</div>
    <div class="pop-mi">mile ${fmtMi(w.mi)} · ${fmtFt(p.ele)} ft</div>
    <div class="pop-row">ETA <b>${hhmm(eta)}</b> ${eta.toLocaleDateString('en-US', { weekday: 'short' })}
      ${w.gate ? ` · ${w.gate.what} <b>${gate.label}</b>${st === 'closed' ? ' — <b>closed at your ETA</b>' : st === 'tight' ? ' — tight' : ''}` : ' · open 24 h'}</div>
    ${w.water ? `<div class="pop-row">water: <b>${w.water}</b></div>` : ''}
    <div class="pop-row">${w.note}</div>
    ${w.gate?.alt ? `<div class="pop-row">alt: ${w.gate.alt}</div>` : ''}
  `).addTo(map)

  if (!fromMap) {
    stopOrbit()
    map.flyTo({ center: [p.lon, p.lat], zoom: 13.6, pitch: 65, duration: 1900, essential: true })
  }
}

// ---------------------------------------------------------------- controls
$('#ctl-style').addEventListener('click', () => {
  if (!map) return
  satellite = !satellite
  $('#ctl-style').classList.toggle('on', satellite)
  document.body.classList.toggle('satellite', satellite)
  map.setStyle(satellite ? STYLE_SAT : STYLE_LIGHT)
})
$('#ctl-3d').addEventListener('click', () => {
  if (!map) return
  const on = $('#ctl-3d').classList.toggle('on')
  if (on) {
    map.setTerrain({ source: 'dem', exaggeration: 1.5 })
    map.easeTo({ pitch: 58, duration: 900 })
  } else {
    map.setTerrain(null)
    map.easeTo({ pitch: 0, bearing: 0, duration: 900 })
  }
})
$('#ctl-orbit').addEventListener('click', () => (orbiting ? stopOrbit() : startOrbit()))
$('#ctl-fit').addEventListener('click', () => {
  if (!map) return
  stopOrbit()
  map.fitBounds(bbox, { padding: fitPad(), pitch: 45, duration: 1600 })
})

let orbitRaf = null
function startOrbit() {
  if (!map) return
  orbiting = true
  $('#ctl-orbit').classList.add('on')
  const spin = () => {
    if (!orbiting) return
    map.setBearing(map.getBearing() + 0.045)
    orbitRaf = requestAnimationFrame(spin)
  }
  spin()
}
function stopOrbit() {
  orbiting = false
  $('#ctl-orbit').classList.remove('on')
  if (orbitRaf) cancelAnimationFrame(orbitRaf)
}

// ---------------------------------------------------------------- plan UI
function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
$('#plan-start').value = toLocalInput(plan.start)
$('#plan-hours').value = plan.hours

$('#plan-start').addEventListener('change', e => {
  const v = new Date(e.target.value)
  if (!isNaN(v)) { plan.start = v; refreshPlan() }
})
$('#plan-hours').addEventListener('input', e => {
  plan.hours = +e.target.value
  refreshPlan()
})

function refreshPlan() {
  localStorage.setItem('hm-plan', JSON.stringify({ start: plan.start.toISOString(), hours: plan.hours }))
  $('#plan-hours-out').textContent = `${plan.hours} h`
  const fin = etaAt(course.totalMi)
  $('#plan-finish').textContent =
    `finish ${fin.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(fin)}`
  renderAlerts()
  renderList()
  renderProfile()
}

function renderAlerts() {
  const box = $('#plan-alerts')
  box.innerHTML = ''
  for (const w of waypoints) {
    if (!w.gate) continue
    const eta = etaAt(w.mi)
    const { st, w: win } = windowStatus(w.gate.spec, eta)
    if (st === 'ok') continue
    const div = document.createElement('div')
    div.className = 'alert' + (st === 'tight' ? ' warn' : '')
    const what = w.bridge ? 'sidewalk' : w.gate.what
    div.innerHTML = st === 'closed'
      ? `<b>${w.name}</b> — ${what} closed at ETA ${hhmm(eta)} (${win.label}).${w.gate.alt ? ` ${w.gate.alt}.` : ''}`
      : `<b>${w.name}</b> — ${what} closes ${hhmm(win.close)}, ETA ${hhmm(eta)}. Tight.`
    box.appendChild(div)
  }
}

// ---------------------------------------------------------------- waypoint list
document.querySelectorAll('#filters button').forEach(b =>
  b.addEventListener('click', () => {
    filter = b.dataset.f
    document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('on', x === b))
    renderList()
  }))

function visible(w) {
  if (filter === 'crew') return w.crew
  if (filter === 'water') return !!w.water
  if (filter === 'gated') return !!w.gate
  return true
}

function renderList() {
  const ol = $('#wplist')
  ol.innerHTML = ''
  const shown = waypoints.filter(visible)
  shown.forEach((w, i) => {
    if (i > 0) {
      const prev = shown[i - 1]
      const s = statsBetween(prev.mi, w.mi)
      const leg = document.createElement('li')
      leg.className = 'leg'
      leg.textContent = `${s.mi.toFixed(1)} mi · +${fmtFt(s.gain)} ft · −${fmtFt(s.loss)} ft`
      ol.appendChild(leg)
    }
    const eta = etaAt(w.mi)
    const st = w.gate ? windowStatus(w.gate.spec, eta).st : 'ok'
    const li = document.createElement('li')
    li.className = 'wp' +
      (w.crew ? '' : ' foot') +
      (w.gate ? ' gate gated' : '') +
      (w.water ? ' has-water' : '')
    li.dataset.id = w.id
    const gateTxt = w.gate
      ? `<span class="g${st === 'closed' ? ' bad' : ''}">${w.bridge ? 'ped gates' : w.gate.what} ${resolveWindow(w.gate.spec, eta).label}${st === 'closed' ? ' — closed at ETA' : st === 'tight' ? ' — tight' : ''}</span>`
      : (w.crew ? '24 h access' : '<span class="f">foot only</span>')
    li.innerHTML = `
      <span class="mi">${fmtMi(w.mi)}<em>${fmtFt(ptAt(w.mi).ele)} ft</em></span>
      <span>
        <span class="nm">${w.name}</span>
        <div class="meta">${w.water ? `<span class="w">◦ water${w.water !== 'yes' ? ` (${w.water})` : ''}</span> · ` : ''}${gateTxt}</div>
      </span>
      <span class="eta"><span class="${st !== 'ok' ? (st === 'closed' ? 'closed' : 'tight') : ''}">${hhmm(eta)}</span><em>${eta.toLocaleDateString('en-US', { weekday: 'short' })}</em></span>`
    li.addEventListener('click', () => focusWaypoint(w.id))
    ol.appendChild(li)
  })
}

// ---------------------------------------------------------------- profile
const chart = $('#pchart')
const NS = 'http://www.w3.org/2000/svg'
let geom = null // {W,H,padL,padR,padT,padB, x(), y(), miAtX()}

function renderProfile() {
  const W = chart.clientWidth, H = chart.clientHeight
  if (!W || !H) return
  const padL = 46, padR = 16, padT = 12, padB = 20
  const eMin = Math.floor(course.minEleFt / 500) * 500
  const eMax = Math.ceil(course.maxEleFt / 500) * 500
  const x = mi => padL + (mi / course.totalMi) * (W - padL - padR)
  const y = e => padT + (1 - (e - eMin) / (eMax - eMin)) * (H - padT - padB)
  const miAtX = px => Math.min(course.totalMi, Math.max(0, (px - padL) / (W - padL - padR) * course.totalMi))
  geom = { W, H, padL, padR, padT, padB, x, y, miAtX }

  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)

  // night bands from the pace model
  for (const [m0, m1] of nightBands()) {
    const r = rect(x(m0), padT, Math.max(1, x(m1) - x(m0)), H - padT - padB,
      'rgba(0,0,0,0.04)')
    svg.appendChild(r)
  }

  // elevation gridlines
  for (let e = eMin; e <= eMax; e += 500) {
    svg.appendChild(line(padL, y(e), W - padR, y(e), 'rgba(0,0,0,0.05)', 1))
    svg.appendChild(text(padL - 6, y(e) + 3, e.toLocaleString(), 'end', 8.5, 'rgba(0,0,0,0.35)'))
  }
  // mile ticks
  for (let m = 10; m < course.totalMi; m += 10) {
    svg.appendChild(line(x(m), H - padB, x(m), H - padB + 4, 'rgba(0,0,0,0.3)', 1))
    svg.appendChild(text(x(m), H - 6, m, 'middle', 8.5, 'rgba(0,0,0,0.35)'))
  }

  // line path (sample every ~2px); closed variant used only for the selection wash
  const step = course.totalMi / Math.max(180, Math.floor(W / 2))
  let dLine = `M ${x(0)} ${y(ptAt(0).ele)}`
  for (let m = step; m <= course.totalMi + 1e-9; m += step) {
    const mm = Math.min(m, course.totalMi)
    dLine += ` L ${x(mm).toFixed(1)} ${y(ptAt(mm).ele).toFixed(1)}`
  }
  const dArea = dLine + ` L ${x(course.totalMi)} ${H - padB} L ${x(0)} ${H - padB} Z`

  const defs = document.createElementNS(NS, 'defs')
  defs.innerHTML = `
    <clipPath id="selclip"><rect x="${sel ? x(Math.min(sel.a, sel.b)) : 0}" y="0"
      width="${sel ? Math.max(1, Math.abs(x(sel.b) - x(sel.a))) : 0}" height="${H}"/></clipPath>`
  svg.appendChild(defs)

  // the profile is a single line drawing; it fades while a segment is measured
  svg.appendChild(path(dLine, 'none', sel ? 'rgba(0,0,0,0.18)' : C.ink, 1.4))

  if (sel) {
    const selWash = path(dArea, C.wash, 'none', 0)
    selWash.setAttribute('clip-path', 'url(#selclip)')
    svg.appendChild(selWash)
    const selLine = path(dLine, 'none', C.moss, 1.8)
    selLine.setAttribute('clip-path', 'url(#selclip)')
    svg.appendChild(selLine)
    for (const m of [Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)]) {
      svg.appendChild(line(x(m), padT, x(m), H - padB, C.moss, 1))
    }
  }

  // waypoint ticks (crew stops only, keeps it clean)
  for (const w of waypoints) {
    if (!w.crew || w.kind !== 'major') continue
    const px = x(w.mi), py = y(ptAt(w.mi).ele)
    const c = document.createElementNS(NS, 'circle')
    c.setAttribute('cx', px); c.setAttribute('cy', py); c.setAttribute('r', 2.3)
    c.setAttribute('fill', '#ffffff')
    c.setAttribute('stroke', sel ? 'rgba(0,0,0,0.25)' : C.ink)
    c.setAttribute('stroke-width', 1.1)
    svg.appendChild(c)
  }

  // sunset / sunrise hairlines with labels
  for (const ev of sunEvents()) {
    const px = x(ev.mi)
    svg.appendChild(line(px, padT, px, H - padB, 'rgba(0,0,0,0.3)', 1, '2 3'))
    svg.appendChild(text(px + 4, padT + 8, `${ev.icon} ${hhmm(ev.t)}`, 'start', 8.5, 'rgba(0,0,0,0.5)'))
  }

  // hover crosshair
  if (hoverMi != null && !dragging) {
    const px = x(hoverMi), py = y(ptAt(hoverMi).ele)
    svg.appendChild(line(px, padT, px, H - padB, 'rgba(0,0,0,0.25)', 1))
    const c = document.createElementNS(NS, 'circle')
    c.setAttribute('cx', px); c.setAttribute('cy', py); c.setAttribute('r', 3)
    c.setAttribute('fill', C.ink); c.setAttribute('stroke', '#ffffff'); c.setAttribute('stroke-width', 1.4)
    svg.appendChild(c)
  }

  chart.innerHTML = ''
  chart.appendChild(svg)
  renderStats()
}

const rect = (x, y, w, h, fill) => {
  const r = document.createElementNS(NS, 'rect')
  r.setAttribute('x', x); r.setAttribute('y', y)
  r.setAttribute('width', w); r.setAttribute('height', h)
  r.setAttribute('fill', fill)
  return r
}
const line = (x1, y1, x2, y2, stroke, sw, dash) => {
  const l = document.createElementNS(NS, 'line')
  l.setAttribute('x1', x1); l.setAttribute('y1', y1)
  l.setAttribute('x2', x2); l.setAttribute('y2', y2)
  l.setAttribute('stroke', stroke); l.setAttribute('stroke-width', sw)
  if (dash) l.setAttribute('stroke-dasharray', dash)
  return l
}
const text = (x, y, str, anchor, size, fill) => {
  const t = document.createElementNS(NS, 'text')
  t.setAttribute('x', x); t.setAttribute('y', y)
  t.setAttribute('text-anchor', anchor); t.setAttribute('font-size', size)
  t.setAttribute('fill', fill); t.setAttribute('font-family', 'Archivo, Helvetica, sans-serif')
  t.textContent = str
  return t
}
const path = (d, fill, stroke, sw) => {
  const p = document.createElementNS(NS, 'path')
  p.setAttribute('d', d); p.setAttribute('fill', fill)
  p.setAttribute('stroke', stroke); p.setAttribute('stroke-width', sw)
  if (stroke !== 'none') p.setAttribute('stroke-linejoin', 'round')
  return p
}

// dark segments of the run, in course miles, from the pace model
function nightBands() {
  const bands = []
  const stepMi = course.totalMi / 400
  let dark = isDark(etaAt(0))
  let bandStart = dark ? 0 : null
  for (let m = stepMi; m <= course.totalMi; m += stepMi) {
    const d = isDark(etaAt(m))
    if (d && !dark) bandStart = m
    if (!d && dark) { bands.push([bandStart, m]); bandStart = null }
    dark = d
  }
  if (dark && bandStart != null) bands.push([bandStart, course.totalMi])
  return bands
}
function isDark(t) {
  const s = sunTimes(t)
  return t < s.sunrise || t > s.sunset
}
// sunset/sunrise crossings mapped onto course miles
function sunEvents() {
  const out = []
  const stepMi = course.totalMi / 600
  let prev = isDark(etaAt(0))
  for (let m = stepMi; m <= course.totalMi; m += stepMi) {
    const t = etaAt(m)
    const d = isDark(t)
    if (d !== prev) out.push({ mi: m, t, icon: d ? '☾' : '☀' })
    prev = d
  }
  return out
}

// ---------------------------------------------------------------- profile interactions
let dragging = false
let dragStart = null

// offsetX is relative to e.target (an SVG child under the cursor), so
// always derive chart-local x from clientX against the container box.
const localX = e => e.clientX - chart.getBoundingClientRect().left

chart.addEventListener('pointerdown', e => {
  if (!geom) return
  dragging = true
  dragStart = geom.miAtX(localX(e))
  sel = null
  chart.setPointerCapture(e.pointerId)
})
chart.addEventListener('pointermove', e => {
  if (!geom) return
  const mi = geom.miAtX(localX(e))
  if (dragging) {
    if (Math.abs(mi - dragStart) > 0.15) {
      sel = { a: dragStart, b: mi }
      syncSelToMap()
    }
  }
  hoverMi = mi
  setGhost(mi)
  renderProfile()
})
chart.addEventListener('pointerup', e => {
  if (!geom) return
  const mi = geom.miAtX(localX(e))
  if (dragging && (!sel || Math.abs(sel.b - sel.a) < 0.15)) {
    // treat as click: fly the map there
    sel = null
    syncSelToMap()
    if (map) {
      const p = ptAt(mi)
      stopOrbit()
      map.flyTo({ center: [p.lon, p.lat], zoom: 13.2, duration: 1600 })
    }
  }
  dragging = false
  renderProfile()
})
chart.addEventListener('pointerleave', () => {
  hoverMi = null
  setGhost(null)
  renderProfile()
})
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { sel = null; syncSelToMap(); renderProfile() }
})

function syncSelToMap() {
  const src = map?.getSource('course-sel')
  if (!src) return
  src.setData(sel
    ? sliceLine(Math.min(sel.a, sel.b), Math.max(sel.a, sel.b))
    : { type: 'FeatureCollection', features: [] })
  // fade the rest of the drawing while a segment is measured
  if (map.getLayer('course-line'))
    map.setPaintProperty('course-line', 'line-opacity', sel ? 0.22 : 1)
}

function renderStats() {
  const el = $('#pstats-main')
  if (sel) {
    const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b)
    const s = statsBetween(a, b)
    const t0 = etaAt(a), t1 = etaAt(b)
    el.innerHTML =
      `mi ${fmtMi(a)}–${fmtMi(b)} <span class="dim">·</span> <b>${s.mi.toFixed(1)} mi</b> ` +
      `<span class="dim">·</span> <b>+${fmtFt(s.gain)} ft</b> <span class="dim">/ −${fmtFt(s.loss)} ft</span> ` +
      `<span class="dim">·</span> ${hhmm(t0)}→${hhmm(t1)} <span class="dim">(${((t1 - t0) / 3600000).toFixed(1)} h)</span>`
  } else if (hoverMi != null) {
    const p = ptAt(hoverMi)
    const g = gradeAt(hoverMi)
    const t = etaAt(hoverMi)
    el.innerHTML =
      `mile <b>${fmtMi(hoverMi)}</b> <span class="dim">·</span> ${fmtFt(p.ele)} ft ` +
      `<span class="dim">·</span> ${g >= 0 ? '+' : ''}${g.toFixed(1)}% ` +
      `<span class="dim">·</span> ETA ${hhmm(t)}`
  } else {
    el.innerHTML =
      `<b>${course.totalMi} mi</b> <span class="dim">·</span> <b>+${fmtFt(course.gainFt)} ft</b> ` +
      `<span class="dim">/ −${fmtFt(course.lossFt)} ft</span> <span class="dim">·</span> ` +
      `${fmtFt(course.minEleFt)}–${fmtFt(course.maxEleFt)} ft`
  }
}

new ResizeObserver(() => renderProfile()).observe(chart)

// ---------------------------------------------------------------- boot
$('#totals').textContent =
  `${course.totalMi} mi · +${fmtFt(course.gainFt)} ft · high ${fmtFt(course.maxEleFt)} ft`
refreshPlan()
