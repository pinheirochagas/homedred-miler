import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import './style.css'
import {
  course, ptAt, statsBetween, gradeAt, fullLine, sliceLine,
  idxAt, lat, lon, dist, ele, cgain, fmtFt, fmtMi,
} from './data.js'
import { waypoints } from './waypoints.js'
import { facilities } from './facilities.js'
import { resolveWindow, windowStatus, sunTimes, hhmm } from './sun.js'
import waterFacilityIcon from './assets/facilities/facility-water.png'
import bathroomFacilityIcon from './assets/facilities/facility-bathroom.png'
import parkingFacilityIcon from './assets/facilities/facility-parking.png'
import locationRunnerIcon from './assets/location-runner.png'

const TOKEN = import.meta.env.MAPBOX_TOKEN
const $ = s => document.querySelector(s)

// ---------------------------------------------------------------- state
// race day: Sat Aug 8 2026, 12:00 · 24 h target
// Version the key so plans saved under older defaults do not override noon.
const saved = JSON.parse(localStorage.getItem('hm-plan-v3') || 'null')
const plan = {
  start: saved?.start ? new Date(saved.start) : new Date(2026, 7, 8, 12, 0),
  hours: saved?.hours || 24,
}
let sel = null            // {a, b} miles
let hoverMi = null
let filter = 'all'
let renderedFilter = null
const selectedSegmentKeys = new Set()
let orbiting = false
let satellite = false
let locating = false
let userLocation = null
const visibleFacilityTypes = new Set(['water'])

// Grade-adjusted, even-effort pace model: 1,000 ft of climb ≈ 2 flat miles.
const effortAt = mi => {
  const i = idxAt(mi)
  return dist(i) + cgain(i) / 500
}
const TOTAL_EFFORT = effortAt(course.totalMi)
const etaAt = mi =>
  new Date(plan.start.getTime() + plan.hours * 3600000 * (effortAt(mi) / TOTAL_EFFORT))

const crewPoints = waypoints.filter(w => w.crew)
const crewSegments = crewPoints.slice(0, -1).map((from, i) => {
  const to = crewPoints[i + 1]
  return { key: `${from.id}:${to.id}`, index: i + 1, from, to }
})

const FACILITY_TYPES = {
  water: { icon: waterFacilityIcon },
  bathrooms: { icon: bathroomFacilityIcon },
  parking: { icon: parkingFacilityIcon },
}
const facilityById = new Map(facilities.map(f => [f.id, f]))
const waypointById = new Map(waypoints.map(w => [w.id, w]))
const facilityIconKey = type => `facility-${type}`

let facilityIconImagesPromise = null
function loadFacilityIconImages() {
  if (facilityIconImagesPromise) return facilityIconImagesPromise
  facilityIconImagesPromise = Promise.all(
    Object.entries(FACILITY_TYPES).map(([type, meta]) => new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve([type, image])
      image.onerror = () => reject(new Error(`Could not load ${type} facility icon`))
      image.src = meta.icon
    })),
  ).then(Object.fromEntries)
  return facilityIconImagesPromise
}

let locationRunnerImagePromise = null
function loadLocationRunnerImage() {
  if (locationRunnerImagePromise) return locationRunnerImagePromise
  locationRunnerImagePromise = new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not load location runner icon'))
    image.src = locationRunnerIcon
  })
  return locationRunnerImagePromise
}

const geoDistance = (aLat, aLon, bLat, bLon) => {
  const rad = n => n * Math.PI / 180
  const dLat = rad(bLat - aLat)
  const dLon = rad(bLon - aLon)
  const q = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(q))
}

function expectedCourseMile(timeMs) {
  const start = plan.start.getTime()
  const finish = start + plan.hours * 3600000
  if (timeMs < start || timeMs > finish) return null
  let lo = 0
  let hi = course.totalMi
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2
    if (etaAt(mid).getTime() < timeMs) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function nearestCourseLocation(position) {
  const { latitude, longitude, accuracy } = position.coords
  const distances = new Float64Array(course.n)
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < course.n; i++) {
    const meters = geoDistance(latitude, longitude, lat(i), lon(i))
    distances[i] = meters
    if (meters < bestDistance) {
      best = i
      bestDistance = meters
    }
  }

  // On overlapping out-and-back portions, race time disambiguates which pass
  // should be marked on the elevation profile.
  const expectedMi = expectedCourseMile(position.timestamp || Date.now())
  if (expectedMi != null) {
    const tolerance = Math.max(8, Math.min(30, Number.isFinite(accuracy) ? accuracy : 8))
    let progressError = Math.abs(dist(best) - expectedMi)
    for (let i = 0; i < course.n; i++) {
      if (distances[i] > bestDistance + tolerance) continue
      const candidateError = Math.abs(dist(i) - expectedMi)
      if (candidateError < progressError) {
        best = i
        progressError = candidateError
      }
    }
    bestDistance = distances[best]
  }

  return {
    lat: latitude,
    lon: longitude,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    routeIndex: best,
    mi: dist(best),
    offsetM: bestDistance,
    timestamp: position.timestamp || Date.now(),
  }
}

function nearestRouteVisit(facility, visitRef) {
  const waypoint = typeof visitRef === 'string' ? waypointById.get(visitRef) : visitRef
  const searchRadius = typeof visitRef === 'string' ? 1.25 : 0.4
  const from = idxAt(Math.max(0, waypoint.mi - searchRadius))
  const to = idxAt(Math.min(course.totalMi, waypoint.mi + searchRadius))
  let best = from
  let bestDistance = Infinity
  for (let i = from; i <= to; i++) {
    const d = geoDistance(facility.lat, facility.lon, lat(i), lon(i))
    if (d < bestDistance) {
      best = i
      bestDistance = d
    }
  }
  return {
    id: `${facility.id}:${waypoint.id}`,
    facility,
    waypoint,
    mi: dist(best),
    offsetM: bestDistance,
  }
}

const facilityVisits = facilities
  .flatMap(facility => facility.visits.map(visit => nearestRouteVisit(facility, visit)))
  .sort((a, b) => a.mi - b.mi)

// ---------------------------------------------------------------- map
function fatal(msg) {
  const el = $('#err')
  el.hidden = false
  el.textContent = msg
}

// Map drawing colors stay muted so route, facility, and GPS overlays remain legible.
const C = {
  paper: '#ffffff',
  ink: '#000000',
  gray: '#8a8a8a',
  location: '#4f8297',
  highlight: '#f1f17c',
  // Calibrated darker for the narrow WebGL stroke so it reads like the
  // broader profile wash against a gray basemap.
  routeHighlight: '#d7d85b',
  wash: '#f1f17c',
}
// outdoors carries the topo detail (trail names, contours, peaks, parks);
// the canvas grayscale filter in style.css keeps it monochrome
const STYLE_LIGHT = 'mapbox://styles/mapbox/outdoors-v12'
const STYLE_SAT = 'mapbox://styles/mapbox/satellite-streets-v12'

// Desaturate only Mapbox's own style layers. A CSS filter on the whole canvas
// would also strip the yellow from our selected route.
const colorParser = document.createElement('canvas').getContext('2d')
function grayscaleColor(value) {
  if (typeof value !== 'string') return value
  const sentinel = '#010203'
  colorParser.fillStyle = sentinel
  colorParser.fillStyle = value
  const parsed = colorParser.fillStyle
  if (parsed === sentinel && value.toLowerCase() !== sentinel) return value

  let r, g, b, a = 1
  const hex = parsed.match(/^#([0-9a-f]{6})$/i)
  const rgb = parsed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/i)
  if (hex) {
    r = parseInt(hex[1].slice(0, 2), 16)
    g = parseInt(hex[1].slice(2, 4), 16)
    b = parseInt(hex[1].slice(4, 6), 16)
  } else if (rgb) {
    r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; a = rgb[4] == null ? 1 : +rgb[4]
  } else {
    return value
  }
  const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
  return a < 1 ? `rgba(${y}, ${y}, ${y}, ${a})` : `rgb(${y}, ${y}, ${y})`
}

function grayscaleStyleValue(value) {
  if (typeof value === 'string') return grayscaleColor(value)
  if (!Array.isArray(value)) return value
  if ((value[0] === 'rgb' || value[0] === 'rgba') &&
      value.slice(1, 4).every(Number.isFinite)) {
    const y = Math.round(0.2126 * value[1] + 0.7152 * value[2] + 0.0722 * value[3])
    return [value[0], y, y, y, ...value.slice(4)]
  }
  return value.map((part, i) => i === 0 ? part : grayscaleStyleValue(part))
}

function desaturateBasemap() {
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'raster') {
      map.setPaintProperty(layer.id, 'raster-saturation', -1)
    }
    for (const [property, value] of Object.entries(layer.paint || {})) {
      if (property.endsWith('-color')) {
        map.setPaintProperty(layer.id, property, grayscaleStyleValue(value))
      }
    }
  }
}

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
  map.addControl(new mapboxgl.ScaleControl({ maxWidth: 100, unit: 'imperial' }), 'bottom-right')
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
  desaturateBasemap()

  // quiet the basemap, but keep everything a trail map needs:
  // places, trail/road names, peaks, water, parks, contour elevations.
  // dropped: transit, airports, house numbers, road shields.
  for (const lyr of map.getStyle().layers) {
    if (lyr.type !== 'symbol') continue
    if (/^(settlement-|water-|waterway-|natural-|poi-label|road-label|path-pedestrian-label|contour-label)/.test(lyr.id)) continue
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
      'line-opacity': 1,
    },
  })
  // measured segment is overlaid in the same yellow as the profile wash
  map.addLayer({
    id: 'course-sel-line', type: 'line', source: 'course-sel',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': C.routeHighlight,
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
  syncSelToMap()
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

function userLocationGeojson() {
  if (!userLocation) return EMPTY
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [userLocation.lon, userLocation.lat] },
    }],
  }
}

function locationRunnerMapImage(image) {
  const size = 48
  const iconBox = 40
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const scale = Math.min(iconBox / image.width, iconBox / image.height)
  const width = image.width * scale
  const height = image.height * scale
  ctx.drawImage(image, (size - width) / 2, (size - height) / 2, width, height)
  return ctx.getImageData(0, 0, size, size)
}

async function addUserLocationLayers() {
  const runnerImage = await loadLocationRunnerImage()
  if (map.getSource('user-location')) return
  if (!map.hasImage('user-location-runner')) {
    map.addImage('user-location-runner', locationRunnerMapImage(runnerImage), { pixelRatio: 2 })
  }
  map.addSource('user-location', { type: 'geojson', data: userLocationGeojson() })
  map.addLayer({
    id: 'user-location-frame',
    type: 'circle',
    source: 'user-location',
    paint: {
      'circle-radius': 13,
      'circle-color': C.paper,
      'circle-stroke-width': 1.3,
      'circle-stroke-color': C.ink,
      'circle-emissive-strength': 1,
    },
  })
  map.addLayer({
    id: 'user-location-runner',
    type: 'symbol',
    source: 'user-location',
    layout: {
      'icon-image': 'user-location-runner',
      'icon-size': 1,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-emissive-strength': 1 },
  })
}

function updateUserLocationSource() {
  map?.getSource('user-location')?.setData(userLocationGeojson())
}

function addWaypointLayers() {
  map.addSource('wps', { type: 'geojson', data: wpGeojson })
  map.addSource('ghost', { type: 'geojson', data: EMPTY })

  // Crew stops use the same yellow as a selected route; foot-only stays hollow.
  map.addLayer({
    id: 'wp-dots', type: 'circle', source: 'wps',
    paint: {
      'circle-radius': ['case', ['==', ['get', 'major'], 1], 4.6, 3],
      'circle-color': ['case', ['==', ['get', 'crew'], 0], C.paper, C.routeHighlight],
      'circle-stroke-width': 1.1,
      'circle-stroke-color': C.ink,
      'circle-emissive-strength': 1,
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

function facilityGeojson() {
  return {
    type: 'FeatureCollection',
    features: facilities
      .filter(facility => visibleFacilityTypes.has(facility.type))
      .map(facility => ({
        type: 'Feature',
        properties: {
          id: facility.id,
          icon: facilityIconKey(facility.type),
          type: facility.type,
        },
        geometry: { type: 'Point', coordinates: [facility.lon, facility.lat] },
      })),
  }
}

function facilityBadge(type, image) {
  const height = 52
  const width = 52
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.beginPath()
  ctx.arc(width / 2, height / 2, 23, 0, Math.PI * 2)
  ctx.fillStyle = type === 'water' ? '#6d9fb3' : type === 'bathrooms' ? '#78b98a' : '#000000'
  ctx.fill()

  const iconBox = 36
  const scale = Math.min(iconBox / image.width, iconBox / image.height)
  const iconWidth = image.width * scale
  const iconHeight = image.height * scale
  const iconCanvas = document.createElement('canvas')
  iconCanvas.width = width
  iconCanvas.height = height
  const iconCtx = iconCanvas.getContext('2d')
  iconCtx.drawImage(
    image,
    (width - iconWidth) / 2,
    (height - iconHeight) / 2,
    iconWidth,
    iconHeight,
  )
  iconCtx.globalCompositeOperation = 'source-in'
  iconCtx.fillStyle = '#ffffff'
  iconCtx.fillRect(0, 0, width, height)
  ctx.drawImage(iconCanvas, 0, 0)

  ctx.beginPath()
  ctx.arc(width / 2, height / 2, 23, 0, Math.PI * 2)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2
  ctx.stroke()
  return ctx.getImageData(0, 0, width, height)
}

async function addFacilityLayers() {
  const images = await loadFacilityIconImages()
  for (const type of Object.keys(FACILITY_TYPES)) {
    const key = facilityIconKey(type)
    if (!map.hasImage(key)) map.addImage(key, facilityBadge(type, images[type]), { pixelRatio: 2 })
  }

  map.addSource('facilities', { type: 'geojson', data: facilityGeojson() })
  map.addLayer({
    id: 'facility-icons',
    type: 'symbol',
    source: 'facilities',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.72, 11, 0.88, 13, 1],
      'icon-anchor': 'center',
      'icon-offset': [0, 0],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-emissive-strength': 1 },
  })

  map.on('click', 'facility-icons', e => {
    const id = e.features?.[0]?.properties?.id
    if (id) focusFacility(id)
  })
  map.on('mouseenter', 'facility-icons', () => (map.getCanvas().style.cursor = 'pointer'))
  map.on('mouseleave', 'facility-icons', () => (map.getCanvas().style.cursor = ''))
}

function updateFacilitySource() {
  map?.getSource('facilities')?.setData(facilityGeojson())
}

function focusFacility(id, visitId = null, fly = false) {
  const facility = facilityById.get(id)
  if (!facility || !map) return
  const visits = facilityVisits.filter(visit => visit.facility.id === id)
  const selected = visits.find(visit => visit.id === visitId) || visits[0]
  const meta = FACILITY_TYPES[facility.type]

  document.querySelectorAll('.facility-stop').forEach(li =>
    li.classList.toggle('sel', li.dataset.visitId === selected?.id))
  $(`.facility-stop[data-visit-id="${selected?.id}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

  const visitRows = visits.map(visit => {
    const eta = etaAt(visit.mi)
    return `<div class="pop-row"><b>mi ${fmtMi(visit.mi)}</b> · ${Math.round(visit.offsetM)} m away · ETA ${hhmm(eta)} ${weekday(eta)}</div>`
  }).join('')
  popup.setLngLat([facility.lon, facility.lat]).setHTML(`
    <div class="pop-nm facility-title"><img class="facility-inline-icon" src="${meta.icon}" alt="" aria-hidden="true">${facility.name}</div>
    ${visitRows}
  `).addTo(map)

  if (fly) {
    stopOrbit()
    map.flyTo({
      center: [facility.lon, facility.lat],
      zoom: 18,
      pitch: 0,
      bearing: 0,
      duration: 1200,
      essential: true,
    })
  }
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
  map.on('style.load', async () => {
    addCourseLayers()
    addWaypointLayers()
    try {
      await addFacilityLayers()
    } catch (error) {
      console.error(error)
    }
    try {
      await addUserLocationLayers()
    } catch (error) {
      console.error(error)
    }
  })
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
  const access = w.access || (w.crew ? 'open 24 h' : 'foot only')
  popup.setLngLat([p.lon, p.lat]).setHTML(`
    <div class="pop-nm">${w.name}</div>
    <div class="pop-mi">mile ${fmtMi(w.mi)} · ${fmtFt(p.ele)} ft</div>
    <div class="pop-row">ETA <b>${hhmm(eta)}</b> ${eta.toLocaleDateString('en-US', { weekday: 'short' })}
      ${w.gate ? ` · ${w.gate.what} <b>${gate.label}</b>${st === 'closed' ? ' — <b>closed at your ETA</b>' : st === 'tight' ? ' — tight' : ''}` : ` · ${access}`}</div>
    <div class="pop-row">${w.note}</div>
    ${w.gate?.alt ? `<div class="pop-row">alt: ${w.gate.alt}</div>` : ''}
  `).addTo(map)

  if (!fromMap) {
    stopOrbit()
    map.flyTo({ center: [p.lon, p.lat], zoom: 13.6, pitch: 65, duration: 1900, essential: true })
  }
}

let locationResetTimer = null
function showLocationError(error) {
  locating = false
  const button = $('#ctl-location')
  button.removeAttribute('aria-busy')
  const message = error?.code === 1
    ? 'location blocked'
    : error?.code === 3
      ? 'GPS timeout'
      : 'GPS unavailable'
  button.textContent = message
  button.title = error?.message || message
  clearTimeout(locationResetTimer)
  locationResetTimer = setTimeout(() => {
    button.textContent = 'my location'
    button.title = ''
  }, 4000)
}

function captureUserLocation() {
  if (locating) return
  if (!navigator.geolocation) {
    showLocationError({ message: 'This device or browser does not provide location.' })
    return
  }

  locating = true
  const button = $('#ctl-location')
  clearTimeout(locationResetTimer)
  button.textContent = 'locating…'
  button.setAttribute('aria-busy', 'true')

  navigator.geolocation.getCurrentPosition(position => {
    locating = false
    userLocation = nearestCourseLocation(position)
    button.textContent = 'my location'
    button.removeAttribute('aria-busy')
    button.classList.add('on')
    button.title = [
      userLocation.accuracy == null ? 'GPS location' : `GPS ±${Math.round(userLocation.accuracy)} m`,
      `profile mile ${fmtMi(userLocation.mi)}`,
      `${Math.round(userLocation.offsetM)} m from course`,
    ].join(' · ')
    updateUserLocationSource()
    renderProfile()

    if (map) {
      popup?.remove()
      stopOrbit()
      map.flyTo({
        center: [userLocation.lon, userLocation.lat],
        zoom: Math.max(map.getZoom(), 15),
        duration: 1200,
        essential: true,
      })
    }
  }, showLocationError, {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 5000,
  })
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
$('#ctl-location').addEventListener('click', captureUserLocation)
for (const [type, id] of [
  ['water', '#ctl-water'],
  ['bathrooms', '#ctl-bathrooms'],
  ['parking', '#ctl-parking'],
]) {
  const button = $(id)
  button.addEventListener('click', () => {
    if (visibleFacilityTypes.has(type)) visibleFacilityTypes.delete(type)
    else visibleFacilityTypes.add(type)
    const on = visibleFacilityTypes.has(type)
    button.classList.toggle('on', on)
    button.setAttribute('aria-pressed', String(on))
    updateFacilitySource()
  })
}
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
  localStorage.setItem('hm-plan-v3', JSON.stringify({ start: plan.start.toISOString(), hours: plan.hours }))
  $('#plan-hours-out').textContent = `${plan.hours} h`
  const fin = etaAt(course.totalMi)
  $('#plan-finish').textContent =
    `finish ${fin.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(fin)}`
  renderList()
  renderProfile()
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
  if (filter === 'gated') return !!w.gate
  if (filter === 'all') return w.crew
  return true
}

function renderList() {
  const ol = $('#wplist')
  const summary = $('#segment-summary')
  const scrollTop = renderedFilter === filter ? ol.scrollTop : 0
  renderedFilter = filter
  ol.innerHTML = ''
  if (filter === 'segments') {
    renderSegmentSummary(summary)
    renderSegments(ol)
    ol.scrollTop = scrollTop
    return
  }
  summary.hidden = true
  if (FACILITY_TYPES[filter]) {
    renderFacilityList(ol, filter)
    ol.scrollTop = scrollTop
    return
  }
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
      (w.gate ? ' gate gated' : '')
    li.dataset.id = w.id
    const gateTxt = w.gate
      ? `<span class="g${st === 'closed' ? ' bad' : ''}">${w.bridge ? 'ped gates' : w.gate.what} ${resolveWindow(w.gate.spec, eta).label}${st === 'closed' ? ' — closed at ETA' : st === 'tight' ? ' — tight' : ''}</span>`
      : (w.access || (w.crew ? '24 h access' : '<span class="f">foot only</span>'))
    li.innerHTML = `
      <span class="mi">${fmtMi(w.mi)}<em>${fmtFt(ptAt(w.mi).ele)} ft</em></span>
      <span>
        <span class="nm">${w.name}</span>
        <div class="meta">${gateTxt}</div>
      </span>
      <span class="eta"><span class="${st !== 'ok' ? (st === 'closed' ? 'closed' : 'tight') : ''}">${hhmm(eta)}</span><em>${eta.toLocaleDateString('en-US', { weekday: 'short' })}</em></span>`
    li.addEventListener('click', () => focusWaypoint(w.id))
    ol.appendChild(li)
  })
  ol.scrollTop = scrollTop
}

function renderFacilityList(ol, type) {
  const visits = facilityVisits.filter(visit => visit.facility.type === type)
  visits.forEach((visit, i) => {
    if (i > 0) {
      const previous = visits[i - 1]
      const s = statsBetween(previous.mi, visit.mi)
      const leg = document.createElement('li')
      leg.className = 'leg'
      leg.textContent = `${s.mi.toFixed(1)} mi · +${fmtFt(s.gain)} ft · −${fmtFt(s.loss)} ft`
      ol.appendChild(leg)
    }
    const eta = etaAt(visit.mi)
    const li = document.createElement('li')
    li.className = 'wp facility-stop'
    li.dataset.id = visit.facility.id
    li.dataset.visitId = visit.id
    li.innerHTML = `
      <span class="mi">${fmtMi(visit.mi)}<em>${Math.round(visit.offsetM)} m away</em></span>
      <span>
        <span class="nm">${visit.facility.name}</span>
      </span>
      <span class="eta">${hhmm(eta)}<em>${weekday(eta)}</em></span>`
    li.addEventListener('click', () => focusFacility(visit.facility.id, visit.id, true))
    ol.appendChild(li)
  })
}

const weekday = d => d.toLocaleDateString('en-US', { weekday: 'short' })
const fmtDuration = ms => {
  const minutes = Math.round(ms / 60000)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`
}

const selectedCrewSegments = () =>
  crewSegments.filter(segment => selectedSegmentKeys.has(segment.key))

function segmentTotals(segments = selectedCrewSegments()) {
  return segments.reduce((total, { from, to }) => {
    const s = statsBetween(from.mi, to.mi)
    total.mi += s.mi
    total.gain += s.gain
    total.loss += s.loss
    total.duration += etaAt(to.mi) - etaAt(from.mi)
    return total
  }, { mi: 0, gain: 0, loss: 0, duration: 0 })
}

function selectionRanges() {
  const segments = selectedCrewSegments()
  if (segments.length) return segments.map(({ from, to }) => ({ a: from.mi, b: to.mi }))
  if (!sel) return []
  return [{ a: Math.min(sel.a, sel.b), b: Math.max(sel.a, sel.b) }]
}

function renderSegmentSummary(summary) {
  summary.hidden = false
  const segments = selectedCrewSegments()
  if (!segments.length) {
    summary.className = 'empty'
    summary.textContent = 'Select one or more segments to combine.'
    return
  }

  const total = segmentTotals(segments)
  summary.className = ''
  summary.innerHTML = `
    <span>
      <b>Combined · ${segments.length} segment${segments.length === 1 ? '' : 's'}</b>
      <small>${total.mi.toFixed(1)} mi · +${fmtFt(total.gain)} ft · −${fmtFt(total.loss)} ft · ${fmtDuration(total.duration)}</small>
    </span>
    <button type="button">clear</button>`
  summary.querySelector('button').addEventListener('click', clearSegmentSelection)
}

function renderSegments(ol) {
  for (const segment of crewSegments) {
    const { from, to } = segment
    const s = statsBetween(from.mi, to.mi)
    const depart = etaAt(from.mi)
    const arrive = etaAt(to.mi)
    const selected = selectedSegmentKeys.has(segment.key)
    const li = document.createElement('li')
    li.className = 'segment' + (selected ? ' sel' : '')

    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-pressed', selected ? 'true' : 'false')
    button.setAttribute('aria-label',
      `${from.name} to ${to.name}: ${s.mi.toFixed(1)} miles, ${fmtFt(s.gain)} feet gain`)
    button.innerHTML = `
      <span class="seg-no">${String(segment.index).padStart(2, '0')}</span>
      <span class="seg-body">
        <span class="seg-route">
          <span>${from.name}</span><i aria-hidden="true">→</i><span>${to.name}</span>
        </span>
        <span class="seg-stats">${s.mi.toFixed(1)} mi · +${fmtFt(s.gain)} ft · −${fmtFt(s.loss)} ft</span>
        <span class="seg-eta">
          ETA ${hhmm(depart)} ${weekday(depart)} → ${hhmm(arrive)} ${weekday(arrive)}
          <i>· ${fmtDuration(arrive - depart)}</i>
        </span>
      </span>`
    button.addEventListener('click', () => selectSegment(segment))
    li.appendChild(button)
    ol.appendChild(li)
  }
}

function selectSegment(segment) {
  if (selectedSegmentKeys.has(segment.key)) selectedSegmentKeys.delete(segment.key)
  else selectedSegmentKeys.add(segment.key)
  sel = null
  hoverMi = null
  popup?.remove()
  syncSelToMap()
  renderList()
  renderProfile()
}

function clearSegmentSelection() {
  selectedSegmentKeys.clear()
  syncSelToMap()
  renderList()
  renderProfile()
}

// ---------------------------------------------------------------- profile
const chart = $('#pchart')
const NS = 'http://www.w3.org/2000/svg'
let geom = null // {W,H,padL,padR,padT,padB, x(), y(), miAtX()}

function renderProfile() {
  const W = chart.clientWidth, H = chart.clientHeight
  if (!W || !H) return
  const padL = 46, padR = 48, padT = 12, padB = 20
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
  // Secondary elevation axis in round metric intervals.
  const axisX = W - padR
  const ftPerM = 3.28084
  const firstMeter = Math.ceil((eMin / ftPerM) / 200) * 200
  const lastMeter = Math.floor((eMax / ftPerM) / 200) * 200
  svg.appendChild(line(axisX, padT, axisX, H - padB, 'rgba(0,0,0,0.12)', 1))
  for (let m = firstMeter; m <= lastMeter; m += 200) {
    const py = y(m * ftPerM)
    svg.appendChild(line(axisX, py, axisX + 4, py, 'rgba(0,0,0,0.3)', 1))
    svg.appendChild(text(axisX + 7, py + 3, `${m} m`, 'start', 8.5, 'rgba(0,0,0,0.35)'))
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

  const ranges = selectionRanges()
  const defs = document.createElementNS(NS, 'defs')
  ranges.forEach((range, i) => {
    const clip = document.createElementNS(NS, 'clipPath')
    clip.setAttribute('id', `selclip-${i}`)
    clip.appendChild(rect(x(range.a), 0, Math.max(1, x(range.b) - x(range.a)), H, C.wash))
    defs.appendChild(clip)
  })
  svg.appendChild(defs)

  // Every selected range gets a yellow wash; the black drawing stays untouched.
  ranges.forEach((range, i) => {
    const selWash = path(dArea, C.wash, 'none', 0)
    selWash.setAttribute('clip-path', `url(#selclip-${i})`)
    svg.appendChild(selWash)
  })
  const boundaries = new Set(ranges.flatMap(range => [range.a, range.b]))
  for (const m of boundaries) {
    svg.appendChild(line(x(m), padT, x(m), H - padB, C.highlight, 1))
  }
  // Draw the contour after the wash so it remains solid black and fully opaque.
  svg.appendChild(path(dLine, 'none', C.ink, 1.4))

  // waypoint ticks (crew stops only, keeps it clean)
  for (const w of waypoints) {
    if (!w.crew || w.kind !== 'major') continue
    const px = x(w.mi), py = y(ptAt(w.mi).ele)
    const c = document.createElementNS(NS, 'circle')
    c.setAttribute('cx', px); c.setAttribute('cy', py); c.setAttribute('r', 2.3)
    c.setAttribute('fill', C.routeHighlight)
    c.setAttribute('stroke', C.ink)
    c.setAttribute('stroke-width', 1.1)
    svg.appendChild(c)
  }

  // sunset / sunrise hairlines with labels
  for (const ev of sunEvents()) {
    const px = x(ev.mi)
    svg.appendChild(line(px, padT, px, H - padB, 'rgba(0,0,0,0.3)', 1, '2 3'))
    svg.appendChild(text(px + 4, padT + 8, `${ev.icon} ${hhmm(ev.t)}`, 'start', 8.5, 'rgba(0,0,0,0.5)'))
  }

  // GPS position is projected onto the nearest course mile.
  if (userLocation) {
    const px = x(userLocation.mi)
    const py = y(ptAt(userLocation.mi).ele)
    svg.appendChild(line(px, padT, px, H - padB, 'rgba(79,130,151,0.55)', 1.2, '3 3'))
    const c = document.createElementNS(NS, 'circle')
    c.setAttribute('cx', px); c.setAttribute('cy', py); c.setAttribute('r', 3)
    c.setAttribute('fill', C.location); c.setAttribute('stroke', C.paper); c.setAttribute('stroke-width', 1.5)
    svg.appendChild(c)
    const markerSize = 18
    const runner = document.createElementNS(NS, 'image')
    runner.setAttribute('href', locationRunnerIcon)
    runner.setAttribute('x', px - markerSize / 2)
    runner.setAttribute('y', Math.max(padT, py - markerSize - 4))
    runner.setAttribute('width', markerSize)
    runner.setAttribute('height', markerSize)
    runner.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    svg.appendChild(runner)
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
  if (selectedSegmentKeys.size) {
    selectedSegmentKeys.clear()
    if (filter === 'segments') renderList()
  }
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
  if (e.key === 'Escape') {
    sel = null
    selectedSegmentKeys.clear()
    syncSelToMap()
    if (filter === 'segments') renderList()
    renderProfile()
  }
})

function syncSelToMap() {
  const src = map?.getSource('course-sel')
  if (!src) return
  src.setData({
    type: 'FeatureCollection',
    features: selectionRanges().map(range => sliceLine(range.a, range.b)),
  })
}

const fmtKm = mi => (mi * 1.609344).toFixed(1)
const fmtM = ft => Math.round(ft / 3.28084).toLocaleString()
const statsColumns = (imperial, time, metric) =>
  `<span class="imperial">${imperial}</span>` +
  `<span class="time">${time}</span>` +
  `<span class="metric">${metric}</span>`

function renderStats() {
  const el = $('#pstats-main')
  const segments = selectedCrewSegments()
  if (segments.length) {
    const total = segmentTotals(segments)
    const imperial =
      `<b>${segments.length} segment${segments.length === 1 ? '' : 's'}</b> <span class="dim">·</span> ` +
      `<b>${total.mi.toFixed(1)} mi</b> <span class="dim">·</span> ` +
      `<b>+${fmtFt(total.gain)} ft</b> <span class="dim">/ −${fmtFt(total.loss)} ft</span>`
    const metric =
      `<b>${fmtKm(total.mi)} km</b> <span class="dim">·</span> ` +
      `<b>+${fmtM(total.gain)} m</b> <span class="dim">/ −${fmtM(total.loss)} m</span>`
    let time = `<b>${fmtDuration(total.duration)}</b> <span class="dim">combined</span>`
    if (segments.length === 1) {
      const { from, to } = segments[0]
      time = `${hhmm(etaAt(from.mi))}→${hhmm(etaAt(to.mi))} ` +
        `<span class="dim">(${fmtDuration(total.duration)})</span>`
    }
    el.innerHTML = statsColumns(imperial, time, metric)
  } else if (sel) {
    const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b)
    const s = statsBetween(a, b)
    const t0 = etaAt(a), t1 = etaAt(b)
    const imperial =
      `mi ${fmtMi(a)}–${fmtMi(b)} <span class="dim">·</span> <b>${s.mi.toFixed(1)} mi</b> ` +
      `<span class="dim">·</span> <b>+${fmtFt(s.gain)} ft</b> <span class="dim">/ −${fmtFt(s.loss)} ft</span>`
    const time =
      `${hhmm(t0)}→${hhmm(t1)} <span class="dim">(${((t1 - t0) / 3600000).toFixed(1)} h)</span>`
    const metric =
      `km ${fmtKm(a)}–${fmtKm(b)} <span class="dim">·</span> <b>${fmtKm(s.mi)} km</b> ` +
      `<span class="dim">·</span> <b>+${fmtM(s.gain)} m</b> <span class="dim">/ −${fmtM(s.loss)} m</span>`
    el.innerHTML = statsColumns(imperial, time, metric)
  } else if (hoverMi != null) {
    const p = ptAt(hoverMi)
    const g = gradeAt(hoverMi)
    const t = etaAt(hoverMi)
    const grade = `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`
    const imperial =
      `mile <b>${fmtMi(hoverMi)}</b> <span class="dim">·</span> ${fmtFt(p.ele)} ft ` +
      `<span class="dim">·</span> ${grade}`
    const metric =
      `km <b>${fmtKm(hoverMi)}</b> <span class="dim">·</span> ${fmtM(p.ele)} m ` +
      `<span class="dim">·</span> ${grade}`
    el.innerHTML = statsColumns(imperial, `ETA ${hhmm(t)}`, metric)
  } else {
    const imperial =
      `<b>${course.totalMi} mi</b> <span class="dim">·</span> <b>+${fmtFt(course.gainFt)} ft</b> ` +
      `<span class="dim">/ −${fmtFt(course.lossFt)} ft</span> <span class="dim">·</span> ` +
      `${fmtFt(course.minEleFt)}–${fmtFt(course.maxEleFt)} ft`
    const metric =
      `<b>${fmtKm(course.totalMi)} km</b> <span class="dim">·</span> <b>+${fmtM(course.gainFt)} m</b> ` +
      `<span class="dim">/ −${fmtM(course.lossFt)} m</span> <span class="dim">·</span> ` +
      `${fmtM(course.minEleFt)}–${fmtM(course.maxEleFt)} m`
    el.innerHTML = statsColumns(imperial, '', metric)
  }
}

new ResizeObserver(() => renderProfile()).observe(chart)

// ---------------------------------------------------------------- boot
$('#totals').textContent =
  `${course.totalMi} mi · +${fmtFt(course.gainFt)} ft · high ${fmtFt(course.maxEleFt)} ft`
refreshPlan()
