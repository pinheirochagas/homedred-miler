import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import './style.css?v=20260812-race-report'
import {
  course, ptAt, fmtFt, fmtMi,
} from './data.js'
import {
  M_PER_MI,
  FT_PER_M,
  activitySummary,
  activityTrack,
  activityTotalMi,
  activityStartMs,
  activityFinishMs,
  activityPointAtMi,
  activityPointAtElapsed,
  activityElapsedAtMi,
  activityClockAtMi,
  activityMiAtTime,
  activityStatsBetween,
  activityGradeAt,
  activityLineFeature,
  activityEndpointFeatures,
  activityTimeTicks,
  activitySliceFeature,
  nearestActivityPoint,
  matchActivityCheckpoints,
  displayMiFromRawM,
} from './activity-model.js?v=profile-bars-20260810'
import {
  EVENT_DEFS,
  METRIC_BY_KEY,
  eventRanges,
  metricColor,
  metricDomain,
  metricGradient,
  metricSeries,
  metricStatsBetween,
  metricValueAtMi,
} from './activity-metrics.js?v=gap-20260811'
import { waypoints as plannedWaypoints } from './waypoints.js?v=actual-activity-20260810'
import { facilities } from './facilities.js'
import { mediaItems } from './media.js?v=20260810-actual-activity-4'
import {
  raceReportAnchors,
  raceReportChapters,
  raceReportMeta,
} from './race-report.js?v=20260812'
import { crewPlan } from './crew-plan.js?v=20260810-actual-record-6'
import { sunTimes, hhmm } from './sun.js'
import waterFacilityIcon from './assets/facilities/facility-water.png'
import bathroomFacilityIcon from './assets/facilities/facility-bathroom.png'
import parkingFacilityIcon from './assets/facilities/facility-parking.png'
import locationRunnerIcon from './assets/location-runner.png'

const TOKEN = import.meta.env.MAPBOX_TOKEN
const $ = s => document.querySelector(s)

// ---------------------------------------------------------------- state
let sel = null            // {a, b} miles
let hoverMi = null
let filter = 'all'
let renderedFilter = null
let activeMetric = null
const activeEvents = new Set()
const selectedSegmentKeys = new Set()
let orbiting = false
let satellite = false
let relief = false
let locating = false
let userLocation = null
let mediaVisible = true
let selectedMediaId = null
let repositionMediaPopup = () => {}
const mediaWidths = new Map()
const visibleFacilityTypes = new Set()
let railView = 'activity'
let activeReportChapterId = null
let reportSelection = null
let reportMediaRange = null
let reportRendered = false
let reportScrollFrame = null
let reportScrollTargetId = null
let reportScrollTargetTimer = null
let atmosphereMode = null
const atmosphereArchives = new Map()
let atmosphereFrames = []
let atmosphereFrameIndex = 0
let atmosphereCursorS = 0
let atmospherePlaying = false
let atmospherePlaybackTimer = null
let atmosphereRequestId = 0
let atmosphereFrontSlot = 0
let atmosphereRenderedUrl = null

const plannedToActivityMi = mi => mi / course.totalMi * activityTotalMi
const waypoints = matchActivityCheckpoints(plannedWaypoints.map(waypoint => {
  const point = ptAt(waypoint.mi)
  return {
    ...waypoint,
    plannedMi: waypoint.mi,
    expectedMi: plannedToActivityMi(waypoint.mi),
    lat: point.lat,
    lon: point.lon,
  }
})).map(match => ({
  ...match,
  plannedMi: match.plannedMi,
  mi: match.mi,
  actualElapsedS: match.elapsedS,
  actualClock: match.clock,
}))
const waypointById = new Map(waypoints.map(waypoint => [waypoint.id, waypoint]))

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
const ACCESS_WINDOWS = {
  bridge: 'posted pedestrian hours',
  'sunrise-sunset': 'sunrise–sunset',
  '6:00-sunset+60': '06:00–1 h after sunset',
  '7:00-sunset': '07:00–sunset',
  '9:00-sunset+60': '09:00–1 h after sunset',
  '8:00-sunset': '08:00–sunset',
}
const factualAccess = waypoint => waypoint.gate
  ? `${waypoint.bridge ? 'pedestrian crossing' : waypoint.gate.what} · ${ACCESS_WINDOWS[waypoint.gate.spec] || waypoint.gate.spec}`
  : (waypoint.access || (waypoint.crew ? '24 h access' : 'foot only'))
const facilityById = new Map(facilities.map(f => [f.id, f]))
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

let mediaImagesPromise = null
function loadMediaImages() {
  if (mediaImagesPromise) return mediaImagesPromise
  mediaImagesPromise = Promise.all(
    routeMedia.map(item => new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve([item.id, image])
      image.onerror = () => reject(new Error(`Could not load media image ${item.id}`))
      image.src = item.thumbnailSrc || item.src
    })),
  ).then(Object.fromEntries)
  return mediaImagesPromise
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

const routeMedia = mediaItems.map(item => {
  const activityMi = Number.isFinite(item.activityDistanceMi)
    ? displayMiFromRawM(item.activityDistanceMi * M_PER_MI)
    : activityMiAtTime(item.capturedAt) ??
      (Number.isFinite(item.routeMi) ? plannedToActivityMi(item.routeMi) : 0)
  const routePoint = activityPointAtMi(activityMi)
  return {
    ...item,
    mi: activityMi,
    routeLat: routePoint.lat,
    routeLon: routePoint.lon,
    activityElapsedS: routePoint.elapsedS,
    activityClock: new Date(activityStartMs + routePoint.elapsedS * 1000),
    offsetM: geoDistance(item.lat, item.lon, routePoint.lat, routePoint.lon),
  }
})
const mediaById = new Map(routeMedia.map(item => [item.id, item]))
const reportChapterById = new Map(raceReportChapters.map(chapter => [chapter.id, chapter]))
const mediaImageKey = id => `media-${id}`

function nearestCourseLocation(position) {
  const { latitude, longitude, accuracy } = position.coords
  const nearest = nearestActivityPoint(latitude, longitude)

  return {
    lat: latitude,
    lon: longitude,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    routeIndex: nearest.index,
    mi: nearest.mi,
    offsetM: nearest.offsetM,
    timestamp: position.timestamp || Date.now(),
  }
}

function nearestRouteVisit(facility, visitRef) {
  const waypoint = typeof visitRef === 'string' ? waypointById.get(visitRef) : visitRef
  const expectedMi = typeof visitRef === 'string'
    ? waypoint.mi
    : plannedToActivityMi(waypoint.mi)
  const match = nearestActivityPoint(
    facility.lat,
    facility.lon,
    expectedMi,
    typeof visitRef === 'string' ? 1.25 : 0.5,
  )
  return {
    id: `${facility.id}:${waypoint.id}`,
    facility,
    waypoint,
    mi: match.mi,
    elapsedS: match.elapsedS,
    clock: match.clock,
    offsetM: match.offsetM,
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
  fog: '#56758a',
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
    if (layer.id.startsWith('atmosphere-')) continue
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
    pitch: 0,
    bearing: 0,
    antialias: true,
    attributionControl: false,
    // Allow direct one-finger map gestures on mobile.
    cooperativeGestures: false,
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
  fatal(`Map disabled — ${err.message} The profile and crew record below still work.`)
}
if (import.meta.env.DEV) window.__map = map

const bbox = (() => {
  let w = 180, s = 90, e = -180, n = -90
  for (const [x, y] of activityLineFeature.geometry.coordinates) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y)
  }
  return [[w, s], [e, n]]
})()

const ATMOSPHERE_SOURCE_IDS = ['atmosphere-frame-a', 'atmosphere-frame-b']
const ATMOSPHERE_LAYER_IDS = ['atmosphere-frame-a', 'atmosphere-frame-b']
const WIND_SOURCE_ID = 'atmosphere-wind-vectors'
const WIND_LAYER_ID = 'atmosphere-wind-arrows'
const ATMOSPHERE_UI = {
  fog: {
    button: '#ctl-fog',
    label: 'IFR fog probability',
    color: '#56758a',
    gradient: 'linear-gradient(90deg, #496a82, #b4c9d5)',
    legendText: 'likelihood · cloud texture',
    sourceLabel: 'GOES-18 · NOAA / SSEC RealEarth',
    sourceUrl: 'https://realearth.ssec.wisc.edu/',
    fallbackOpacity: 0.68,
  },
  temperature: {
    button: '#ctl-temperature',
    label: '2 m air temperature',
    color: '#b85b35',
    gradient: 'linear-gradient(90deg, #fee08b, #fdae61, #d73027)',
    legendText: '41 · 68 · 95 °F',
    sourceLabel: 'NOAA RTMA · NCSCO',
    sourceUrl: 'https://registry.opendata.aws/noaa-rtma/',
    fallbackOpacity: 0.58,
  },
  wind: {
    button: '#ctl-wind',
    label: '10 m wind direction + speed',
    color: '#4f8297',
    gradient: 'linear-gradient(90deg, #6c2d8d, #3d6fa2, #43b7b0)',
    legendText: '0 · 17 · 34+ mph',
    sourceLabel: 'NOAA HRRR · Open-Meteo',
    sourceUrl: 'https://open-meteo.com/',
    fallbackOpacity: 0.9,
  },
}
const atmosphereClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

function activeAtmosphereArchive() {
  return atmosphereMode ? atmosphereArchives.get(atmosphereMode) : null
}

function atmosphereCoordinates(archive = activeAtmosphereArchive()) {
  if (!archive?.bounds) return []
  const [west, south, east, north] = archive.bounds
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ]
}

function atmosphereFrame() {
  return atmosphereFrames[atmosphereFrameIndex] || atmosphereFrames[0] || null
}

function atmosphereElapsedS() {
  const elapsedS = Number(atmosphereFrame()?.activityElapsedS)
  return Math.max(0, Math.min(activitySummary.elapsedS, elapsedS || 0))
}

function nearestAtmosphereFrameIndex(elapsedS) {
  let nearestIndex = 0
  let nearestDifference = Infinity
  atmosphereFrames.forEach((frame, index) => {
    const difference = Math.abs(Number(frame.activityElapsedS) - elapsedS)
    if (difference < nearestDifference) {
      nearestDifference = difference
      nearestIndex = index
    }
  })
  return nearestIndex
}

function atmosphereTimeGeojson() {
  if (!atmosphereMode || !atmosphereFrame()) return EMPTY
  const point = activityPointAtElapsed(atmosphereElapsedS())
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
    }],
  }
}

function windVectorGeojson() {
  if (atmosphereMode !== 'wind') return EMPTY
  const vectors = atmosphereFrame()?.vectors || []
  return {
    type: 'FeatureCollection',
    features: vectors.map(([lon, lat, speedMph, bearing]) => ({
      type: 'Feature',
      properties: { speedMph, bearing },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    })),
  }
}

function addAtmosphereWindLayer(firstLabel) {
  const archive = atmosphereArchives.get('wind')
  if (!archive || map.getSource(WIND_SOURCE_ID)) return
  map.addSource(WIND_SOURCE_ID, { type: 'geojson', data: windVectorGeojson() })
  map.addLayer({
    id: WIND_LAYER_ID,
    type: 'symbol',
    source: WIND_SOURCE_ID,
    layout: {
      'text-field': '↑',
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
      'text-size': [
        'interpolate', ['linear'], ['get', 'speedMph'],
        0, 16,
        5, 21,
        15, 29,
        30, 36,
      ],
      'text-rotate': ['get', 'bearing'],
      'text-rotation-alignment': 'map',
      'text-pitch-alignment': 'map',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'text-keep-upright': false,
    },
    paint: {
      'text-color': [
        'interpolate', ['linear'], ['get', 'speedMph'],
        0, '#512271',
        8, '#425491',
        18, '#287f96',
        34, '#169d91',
      ],
      'text-opacity': atmosphereMode === 'wind' ? archive.opacity : 0,
      'text-halo-color': 'rgba(255, 255, 255, 0.92)',
      'text-halo-width': 0.65,
      'text-emissive-strength': 1,
    },
  }, firstLabel)
}

function syncAtmosphereLayerVisibility() {
  if (!map) return
  const archive = activeAtmosphereArchive()
  const opacity = Number.isFinite(archive?.opacity)
    ? archive.opacity
    : ATMOSPHERE_UI[atmosphereMode]?.fallbackOpacity || 0
  ATMOSPHERE_LAYER_IDS.forEach((layerId, slot) => {
    if (!map.getLayer(layerId)) return
    map.setPaintProperty(
      layerId,
      'raster-saturation',
      0,
    )
    map.setPaintProperty(
      layerId,
      'raster-opacity',
      atmosphereMode && archive?.renderType !== 'vectors' &&
        slot === atmosphereFrontSlot ? opacity : 0,
    )
  })
  map.getSource(WIND_SOURCE_ID)?.setData(windVectorGeojson())
  if (map.getLayer(WIND_LAYER_ID)) {
    map.setLayoutProperty(
      WIND_LAYER_ID,
      'visibility',
      atmosphereMode === 'wind' ? 'visible' : 'none',
    )
    map.setPaintProperty(
      WIND_LAYER_ID,
      'text-opacity',
      atmosphereMode === 'wind' ? Math.min(1, opacity + 0.08) : 0,
    )
    if (atmosphereMode === 'wind') {
      const beforeLayer = map.getLayer('media-connectors-case')
        ? 'media-connectors-case'
        : map.getLayer('atmosphere-time-halo') ? 'atmosphere-time-halo' : undefined
      if (beforeLayer) map.moveLayer(WIND_LAYER_ID, beforeLayer)
      else map.moveLayer(WIND_LAYER_ID)
    }
  }
  map.getSource('atmosphere-time-position')?.setData(atmosphereTimeGeojson())
}

function addAtmosphereLayers() {
  if (!atmosphereArchives.size) return
  const firstLabel = map.getStyle().layers.find(layer => layer.type === 'symbol')?.id
  const activeArchive = activeAtmosphereArchive()
  const rasterArchive = activeArchive && activeArchive.renderType !== 'vectors'
    ? activeArchive
    : [...atmosphereArchives.values()].find(archive =>
        archive.frames?.some(frame => frame.url))
  const frame = rasterArchive === activeArchive
    ? atmosphereFrame()
    : rasterArchive?.frames?.find(candidate => candidate.url)

  if (rasterArchive && frame?.url && !map.getSource(ATMOSPHERE_SOURCE_IDS[0])) {
    const coordinates = atmosphereCoordinates(rasterArchive)
    ATMOSPHERE_SOURCE_IDS.forEach((sourceId, slot) => {
      map.addSource(sourceId, {
        type: 'image',
        url: frame.url,
        coordinates,
      })
      map.addLayer({
        id: ATMOSPHERE_LAYER_IDS[slot],
        type: 'raster',
        source: sourceId,
        paint: {
          'raster-opacity': 0,
          'raster-opacity-transition': { duration: 220, delay: 0 },
          'raster-fade-duration': 0,
          'raster-resampling': 'linear',
          'raster-saturation': 0,
        },
      }, firstLabel)
    })
    atmosphereFrontSlot = 0
    atmosphereRenderedUrl = frame.url
  }
  addAtmosphereWindLayer(firstLabel)
  syncAtmosphereLayerVisibility()
}

function addAtmosphereTimeLayers() {
  if (!atmosphereArchives.size || map.getSource('atmosphere-time-position')) return
  map.addSource('atmosphere-time-position', {
    type: 'geojson',
    data: atmosphereTimeGeojson(),
  })
  map.addLayer({
    id: 'atmosphere-time-halo',
    type: 'circle',
    source: 'atmosphere-time-position',
    paint: {
      'circle-radius': 7,
      'circle-color': C.paper,
      'circle-opacity': 0.96,
      'circle-stroke-width': 1,
      'circle-stroke-color': C.ink,
      'circle-emissive-strength': 1,
    },
  })
  map.addLayer({
    id: 'atmosphere-time-dot',
    type: 'circle',
    source: 'atmosphere-time-position',
    paint: {
      'circle-radius': 3.5,
      'circle-color': ATMOSPHERE_UI[atmosphereMode]?.color || C.fog,
      'circle-emissive-strength': 1,
    },
  })
}

function preloadAtmosphereFrame(index) {
  const frame = atmosphereFrames[index]
  if (!frame?.url) return
  const image = new Image()
  image.src = frame.url
}

function updateAtmosphereReadout() {
  const frame = atmosphereFrame()
  if (!frame) return
  const elapsedS = atmosphereElapsedS()
  atmosphereCursorS = elapsedS
  const point = activityPointAtElapsed(elapsedS)
  const clock = atmosphereClockFormatter.format(new Date(frame.time))
  const slider = $('#atmosphere-time')
  const progress = elapsedS / activitySummary.elapsedS * 100

  $('#atmosphere-clock').textContent = clock
  $('#atmosphere-position').textContent =
    `mi ${fmtMi(point.mi)} · ${activityDuration(elapsedS)} elapsed`
  slider.value = String(Math.round(elapsedS))
  slider.style.setProperty('--atmosphere-progress', `${progress}%`)
  slider.setAttribute('aria-valuetext', `${clock}, activity mile ${fmtMi(point.mi)}`)
}

function showAtmosphereFrame(index) {
  if (!atmosphereMode || !atmosphereFrames.length) return
  atmosphereFrameIndex = Math.max(
    0,
    Math.min(atmosphereFrames.length - 1, Math.round(index)),
  )
  const frame = atmosphereFrame()
  updateAtmosphereReadout()
  map?.getSource('atmosphere-time-position')?.setData(atmosphereTimeGeojson())
  preloadAtmosphereFrame(atmosphereFrameIndex - 1)
  preloadAtmosphereFrame(atmosphereFrameIndex + 1)

  const archive = activeAtmosphereArchive()
  if (archive?.renderType === 'vectors') {
    syncAtmosphereLayerVisibility()
    return
  }
  if (!frame.url) return
  if (!map?.getSource(ATMOSPHERE_SOURCE_IDS[0])) return
  if (frame.url === atmosphereRenderedUrl) {
    syncAtmosphereLayerVisibility()
    return
  }

  const requestId = ++atmosphereRequestId
  const image = new Image()
  image.decoding = 'async'
  image.onload = () => {
    if (requestId !== atmosphereRequestId || !atmosphereMode) return
    const nextSlot = atmosphereFrontSlot === 0 ? 1 : 0
    const source = map?.getSource(ATMOSPHERE_SOURCE_IDS[nextSlot])
    if (!source) return
    source.updateImage({ url: frame.url, coordinates: atmosphereCoordinates(archive) })
    requestAnimationFrame(() => {
      if (requestId !== atmosphereRequestId || !atmosphereMode) return
      atmosphereFrontSlot = nextSlot
      atmosphereRenderedUrl = frame.url
      syncAtmosphereLayerVisibility()
    })
  }
  image.onerror = () => {
    if (requestId === atmosphereRequestId) {
      $('#atmosphere-position').textContent = 'frame unavailable'
    }
  }
  image.src = frame.url
}

function showAtmosphereElapsed(elapsedS) {
  atmosphereCursorS = Math.max(0, Math.min(activitySummary.elapsedS, elapsedS))
  showAtmosphereFrame(nearestAtmosphereFrameIndex(atmosphereCursorS))
}

function stopAtmospherePlayback() {
  atmospherePlaying = false
  clearInterval(atmospherePlaybackTimer)
  atmospherePlaybackTimer = null
  const button = $('#atmosphere-play')
  button.textContent = 'play'
  button.setAttribute('aria-label', 'Play atmosphere archive')
}

function startAtmospherePlayback() {
  if (!atmosphereMode || atmosphereFrames.length < 2) return
  atmospherePlaying = true
  const button = $('#atmosphere-play')
  button.textContent = 'pause'
  button.setAttribute('aria-label', 'Pause atmosphere archive')
  clearInterval(atmospherePlaybackTimer)
  const cadence = activeAtmosphereArchive()?.expectedCadenceS || 300
  const intervalMs = cadence > 15 * 60 ? 680 : 240
  atmospherePlaybackTimer = setInterval(() => {
    const next = atmosphereFrameIndex >= atmosphereFrames.length - 1
      ? 0
      : atmosphereFrameIndex + 1
    showAtmosphereFrame(next)
  }, intervalMs)
}

function configureAtmospherePlayer() {
  const archive = activeAtmosphereArchive()
  const ui = ATMOSPHERE_UI[atmosphereMode]
  if (!archive || !ui) return
  document.documentElement.style.setProperty('--atmosphere', ui.color)
  document.documentElement.style.setProperty('--atmosphere-gradient', ui.gradient)
  $('#atmosphere-layer-label').textContent = ui.label

  const scale = $('#atmosphere-scale')
  scale.querySelector('span').textContent = ui.legendText
  const source = $('#atmosphere-source')
  source.textContent = ui.sourceLabel
  source.href = ui.sourceUrl

  const player = $('#atmosphere-player')
  player.title = `${archive.description || ''} ${archive.caveat || ''}`.trim()
  if (archive.caveat) player.setAttribute('aria-description', archive.caveat)
  else player.removeAttribute('aria-description')
  if (map?.getLayer('atmosphere-time-dot')) {
    map.setPaintProperty('atmosphere-time-dot', 'circle-color', ui.color)
  }
}

function setAtmosphereMode(mode) {
  if (mode && !atmosphereArchives.has(mode)) return
  stopAtmospherePlayback()
  atmosphereRequestId += 1
  atmosphereMode = mode
  atmosphereFrames = activeAtmosphereArchive()?.frames || []
  atmosphereFrameIndex = atmosphereFrames.length
    ? nearestAtmosphereFrameIndex(atmosphereCursorS)
    : 0
  atmosphereRenderedUrl = null

  for (const [key, ui] of Object.entries(ATMOSPHERE_UI)) {
    const button = $(ui.button)
    const on = key === atmosphereMode
    button.classList.toggle('on', on)
    button.setAttribute('aria-pressed', String(on))
  }

  $('#atmosphere-player').hidden = !atmosphereMode
  document.body.classList.toggle('atmosphere-on', Boolean(atmosphereMode))
  for (const key of Object.keys(ATMOSPHERE_UI)) {
    document.body.classList.toggle(`atmosphere-${key}`, key === atmosphereMode)
  }

  ATMOSPHERE_LAYER_IDS.forEach(layerId => {
    if (map?.getLayer(layerId)) map.setPaintProperty(layerId, 'raster-opacity', 0)
  })
  if (map?.getLayer(WIND_LAYER_ID)) {
    map.setPaintProperty(WIND_LAYER_ID, 'icon-opacity', 0)
  }

  if (atmosphereMode) {
    if (map?.isStyleLoaded()) {
      addAtmosphereLayers()
      addAtmosphereTimeLayers()
    }
    configureAtmospherePlayer()
    stopOrbit()
    showAtmosphereFrame(atmosphereFrameIndex)
  } else {
    syncAtmosphereLayerVisibility()
  }
}

function registerAtmosphereArchive(mode, archive, root = archive) {
  const frames = (archive.frames || [])
      .map(frame => ({
        ...frame,
        url: mode === 'fog' && frame.url
          ? `${frame.url}${frame.url.includes('?') ? '&' : '?'}v=blue-fog-20260811`
          : frame.url,
        timeMs: new Date(frame.time).getTime(),
      }))
      .filter(frame => Number.isFinite(frame.timeMs))
      .sort((a, b) => a.timeMs - b.timeMs)
  if (!frames.length) throw new Error(`${mode} archive contains no frames`)

  const normalized = {
    ...archive,
    bounds: archive.bounds || root.bounds,
    source: archive.source || root.source,
    opacity: Number.isFinite(archive.opacity)
      ? archive.opacity
      : ATMOSPHERE_UI[mode].fallbackOpacity,
    frames,
  }
  atmosphereArchives.set(mode, normalized)

  const button = $(ATMOSPHERE_UI[mode].button)
  button.disabled = false
  const gaps = archive.gaps?.length || 0
  button.title = `${frames.length} archived frames · ${gaps} source gaps`
}

async function fetchArchive(url, label) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${label} archive returned ${response.status}`)
  return response.json()
}

async function loadAtmosphereArchives() {
  const [fogResult, weatherResult] = await Promise.allSettled([
    fetchArchive('/fog/manifest.json?v=blue-fog-20260811', 'Fog'),
    fetchArchive('/weather/manifest.json?v=warm-native-vector-wind-20260811', 'Weather'),
  ])

  if (fogResult.status === 'fulfilled') {
    try {
      registerAtmosphereArchive('fog', fogResult.value)
    } catch (error) {
      console.error(error)
    }
  } else {
    console.error(fogResult.reason)
    $('#ctl-fog').textContent = 'fog unavailable'
    $('#ctl-fog').title = fogResult.reason.message
  }

  if (weatherResult.status === 'fulfilled') {
    for (const mode of ['temperature', 'wind']) {
      try {
        registerAtmosphereArchive(
          mode,
          weatherResult.value.layers?.[mode] || {},
          weatherResult.value,
        )
      } catch (error) {
        console.error(error)
        $(ATMOSPHERE_UI[mode].button).textContent = `${mode} unavailable`
        $(ATMOSPHERE_UI[mode].button).title = error.message
      }
    }
  } else {
    console.error(weatherResult.reason)
    for (const mode of ['temperature', 'wind']) {
      $(ATMOSPHERE_UI[mode].button).textContent = `${mode} unavailable`
      $(ATMOSPHERE_UI[mode].button).title = weatherResult.reason.message
    }
  }

  const slider = $('#atmosphere-time')
  slider.max = String(Math.round(activitySummary.elapsedS))
  slider.step = '300'
  if (map?.getSource('activity-track')) {
    addAtmosphereLayers()
    addAtmosphereTimeLayers()
  }
}

function addCourseLayers() {
  desaturateBasemap()

  // quiet the basemap, but keep everything a trail map needs:
  // places, trail/road names, peaks, water, parks, contour elevations.
  // dropped: transit, airports, house numbers, road shields.
  for (const lyr of map.getStyle().layers) {
    if (lyr.type !== 'symbol') continue
    if (lyr.id.startsWith('atmosphere-')) continue
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
  map.setTerrain(relief ? { source: 'dem', exaggeration: 1.5 } : null)
  map.setFog({
    range: [0.7, 10],
    color: '#ffffff',
    'high-color': '#f4f4f4',
    'space-color': '#ffffff',
    'horizon-blend': 0.03,
    'star-intensity': 0,
  })

  if (!map.getSource('course-sel')) {
    map.addSource('course-sel', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    map.addSource('miles', { type: 'geojson', data: mileMarkerGeojson() })
  }

  // Measured actual segment is overlaid in the same yellow as the profile wash.
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
  for (let m = 5; m < activityTotalMi; m += 5) {
    const p = activityPointAtMi(m)
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
  features: waypoints.map(w => ({
      type: 'Feature',
      properties: {
        id: w.id,
        major: w.kind === 'major' ? 1 : 0,
        gated: w.gate ? 1 : 0,
        crew: w.crew ? 1 : 0,
        label: w.name.split(/·|—/)[0].trim(),
      },
      geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
    })),
}
const EMPTY = { type: 'FeatureCollection', features: [] }

function activityTrackGeojson() {
  return activityLineFeature
}

function activityEndpointsGeojson() {
  return activityEndpointFeatures
}

function addActivityLayers() {
  if (map.getSource('activity-track')) return
  map.addSource('activity-track', { type: 'geojson', data: activityTrackGeojson() })
  map.addSource('activity-endpoints', { type: 'geojson', data: activityEndpointsGeojson() })
  map.addLayer({
    id: 'activity-track-case',
    type: 'line',
    source: 'activity-track',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': C.paper,
      'line-opacity': 0.9,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4.5, 14, 9],
    },
  }, 'mile-dots')
  map.addLayer({
    id: 'activity-track-line',
    type: 'line',
    source: 'activity-track',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': C.ink,
      'line-opacity': 1,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.6, 14, 3.4],
    },
  }, 'mile-dots')
  map.addLayer({
    id: 'activity-endpoints',
    type: 'circle',
    source: 'activity-endpoints',
    paint: {
      'circle-radius': 4.5,
      'circle-color': [
        'match', ['get', 'kind'],
        'start', C.paper,
        C.ink,
      ],
      'circle-stroke-width': 1.8,
      'circle-stroke-color': C.ink,
      'circle-emissive-strength': 1,
    },
  })
  // Keep profile selections above the black activity track and below its markers.
  map.moveLayer('course-sel-line', 'mile-dots')
}

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

function visibleRouteMedia() {
  if (!mediaVisible) return []
  if (railView !== 'report') return routeMedia
  if (!reportMediaRange) return []
  const { fromMi, toMi } = reportMediaRange
  return routeMedia.filter(item => item.mi >= fromMi && item.mi <= toMi)
}

function mediaGeojson() {
  return {
    type: 'FeatureCollection',
    features: visibleRouteMedia().map(item => ({
      type: 'Feature',
      id: item.id,
      properties: { id: item.id, icon: mediaImageKey(item.id) },
      geometry: { type: 'Point', coordinates: [item.lon, item.lat] },
    })),
  }
}

function mediaConnectorGeojson() {
  return {
    type: 'FeatureCollection',
    features: visibleRouteMedia()
      .filter(item => item.offsetM > 8)
      .map(item => ({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [[item.routeLon, item.routeLat], [item.lon, item.lat]],
        },
      })),
  }
}

function mediaBadge(image, type) {
  const width = 84
  const height = 98
  const centerX = width / 2
  const centerY = 40
  const imageRadius = 31
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(centerX, 70)
  ctx.lineTo(centerX, 94)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 8
  ctx.stroke()
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(centerX, centerY, 36, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.save()
  ctx.beginPath()
  ctx.arc(centerX, centerY, imageRadius, 0, Math.PI * 2)
  ctx.clip()
  const diameter = imageRadius * 2
  const scale = Math.max(diameter / image.width, diameter / image.height)
  const imageWidth = image.width * scale
  const imageHeight = image.height * scale
  ctx.drawImage(
    image,
    centerX - imageWidth / 2,
    centerY - imageHeight / 2,
    imageWidth,
    imageHeight,
  )
  ctx.restore()

  if (type === 'video') {
    ctx.beginPath()
    ctx.arc(centerX, centerY, 13, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
    ctx.fill()
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(centerX - 3.5, centerY - 6)
    ctx.lineTo(centerX + 6, centerY)
    ctx.lineTo(centerX - 3.5, centerY + 6)
    ctx.closePath()
    ctx.fillStyle = '#000000'
    ctx.fill()
  } else if (type === 'audio') {
    ctx.beginPath()
    ctx.arc(centerX, centerY, 13, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
    ctx.fill()
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 2
    for (const [dx, halfHeight] of [[-6, 3], [-2, 6], [2, 4.5], [6, 2]]) {
      ctx.beginPath()
      ctx.moveTo(centerX + dx, centerY - halfHeight)
      ctx.lineTo(centerX + dx, centerY + halfHeight)
      ctx.stroke()
    }
  }

  return ctx.getImageData(0, 0, width, height)
}

async function addMediaLayers() {
  const images = await loadMediaImages()
  for (const item of routeMedia) {
    const key = mediaImageKey(item.id)
    if (!map.hasImage(key)) map.addImage(key, mediaBadge(images[item.id], item.type), { pixelRatio: 2 })
  }

  map.addSource('media-connectors', { type: 'geojson', data: mediaConnectorGeojson() })
  map.addLayer({
    id: 'media-connectors-case',
    type: 'line',
    source: 'media-connectors',
    paint: {
      'line-color': '#ffffff',
      'line-width': 3,
      'line-opacity': 0.8,
    },
  })
  map.addLayer({
    id: 'media-connectors',
    type: 'line',
    source: 'media-connectors',
    paint: {
      'line-color': '#000000',
      'line-width': 1,
      'line-opacity': 0.55,
      'line-dasharray': [2, 2],
    },
  })
  map.addSource('media', { type: 'geojson', data: mediaGeojson() })
  map.addLayer({
    id: 'media-icons',
    type: 'symbol',
    source: 'media',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.72, 11, 0.86, 13, 1],
      'icon-anchor': 'bottom',
      'icon-offset': [0, -2],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-emissive-strength': 1 },
  })

  map.on('click', 'media-icons', e => {
    const id = e.features?.[0]?.properties?.id
    if (!id) return
    const overlappingIds = [...new Set([
      id,
      ...map.queryRenderedFeatures(e.point, { layers: ['media-icons'] })
        .map(feature => feature.properties?.id)
        .filter(candidateId => candidateId && candidateId !== id),
    ])].sort((a, b) =>
      new Date(mediaById.get(a)?.capturedAt) - new Date(mediaById.get(b)?.capturedAt))
    focusMedia(id, true, overlappingIds)
  })
  map.on('mouseenter', 'media-icons', () => (map.getCanvas().style.cursor = 'pointer'))
  map.on('mouseleave', 'media-icons', () => (map.getCanvas().style.cursor = ''))
}

function updateMediaSources() {
  map?.getSource('media')?.setData(mediaGeojson())
  map?.getSource('media-connectors')?.setData(mediaConnectorGeojson())
}

function setMediaVisibility(visible) {
  mediaVisible = Boolean(visible)
  const button = $('#ctl-media')
  button.classList.toggle('on', mediaVisible)
  button.setAttribute('aria-pressed', String(mediaVisible))
  if (!mediaVisible) mediaPopup?.remove()
  updateMediaSources()
  renderProfile()
}

const mediaTimestamp = value => new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Los_Angeles',
  timeZoneName: 'short',
}).format(new Date(value))

function mediaPopupContent(item, overlappingIds = []) {
  const card = document.createElement('article')
  card.className = 'media-card expanded'

  const mediaFrame = document.createElement('div')
  mediaFrame.className = 'media-card-image'
  let media
  if (item.type === 'audio') {
    mediaFrame.classList.add('media-card-audio')
    const waveformTrack = document.createElement('div')
    waveformTrack.className = 'media-audio-waveform'
    waveformTrack.setAttribute('role', 'slider')
    waveformTrack.setAttribute('tabindex', '0')
    waveformTrack.setAttribute('aria-label', 'Audio position')
    waveformTrack.setAttribute('aria-valuemin', '0')
    waveformTrack.title = 'Drag to seek'
    const waveform = document.createElement('img')
    waveform.className = 'media-audio-bars media-audio-bars-muted'
    waveform.src = item.thumbnailSrc
    waveform.alt = item.alt
    const playedWaveform = document.createElement('img')
    playedWaveform.className = 'media-audio-bars media-audio-bars-played'
    playedWaveform.src = item.thumbnailSrc
    playedWaveform.alt = ''
    playedWaveform.setAttribute('aria-hidden', 'true')
    const playhead = document.createElement('span')
    playhead.className = 'media-audio-playhead'
    playhead.setAttribute('aria-hidden', 'true')
    const scale = document.createElement('div')
    scale.className = 'media-audio-scale'
    const scaleStart = document.createElement('span')
    scaleStart.textContent = '0:00'
    const scaleEnd = document.createElement('span')
    scaleEnd.textContent = '–:––'
    scale.append(scaleStart, scaleEnd)
    waveformTrack.append(waveform, playedWaveform, playhead, scale)

    const elapsed = document.createElement('output')
    elapsed.className = 'media-audio-time'
    elapsed.setAttribute('aria-label', 'Elapsed time')
    elapsed.textContent = '00:00.00'

    const controls = document.createElement('div')
    controls.className = 'media-audio-controls'
    const skipButton = (direction, label) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `media-audio-skip ${direction}`
      button.setAttribute('aria-label', label)
      const transform = direction === 'forward' ? ' transform="translate(40 0) scale(-1 1)"' : ''
      button.innerHTML = `
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <g${transform}>
            <path d="M12 9A14 14 0 1 0 31 14" />
            <path d="M12 3v8h8" />
          </g>
          <text x="20" y="25">15</text>
        </svg>`
      return button
    }
    const skipBack = skipButton('back', 'Back 15 seconds')
    const playButton = document.createElement('button')
    playButton.type = 'button'
    playButton.className = 'media-audio-toggle'
    playButton.setAttribute('aria-label', 'Play')
    playButton.dataset.playing = 'false'
    const playIcon = document.createElement('span')
    playIcon.setAttribute('aria-hidden', 'true')
    playButton.appendChild(playIcon)
    const skipForward = skipButton('forward', 'Forward 15 seconds')
    controls.append(skipBack, playButton, skipForward)

    media = document.createElement('audio')
    media.src = item.src
    media.preload = 'metadata'
    media.setAttribute('aria-label', item.title)

    let playbackTimer = null
    let scrubbing = false
    const shortTime = value => {
      const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    }
    const preciseTime = value => {
      const centiseconds = Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * 100))
      const minutes = Math.floor(centiseconds / 6000)
      const seconds = Math.floor((centiseconds % 6000) / 100)
      return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
    }
    const updatePlayhead = () => {
      const duration = Number.isFinite(media.duration) ? media.duration : 0
      const progress = duration ? Math.min(1, Math.max(0, media.currentTime / duration)) : 0
      const playheadX = 4 + progress * Math.max(0, waveformTrack.clientWidth - 8)
      playhead.style.transform = `translate3d(${playheadX}px, 0, 0)`
      playedWaveform.style.clipPath = `inset(0 ${100 - progress * 100}% 0 0)`
      const time = preciseTime(media.currentTime)
      if (elapsed.textContent !== time) elapsed.textContent = time
      waveformTrack.setAttribute('aria-valuemax', String(Math.round(duration)))
      waveformTrack.setAttribute('aria-valuenow', String(Math.round(media.currentTime)))
      waveformTrack.setAttribute('aria-valuetext', `${shortTime(media.currentTime)} of ${shortTime(duration)}`)
    }
    const stopPlaybackTimer = () => {
      if (playbackTimer == null) return
      clearInterval(playbackTimer)
      playbackTimer = null
    }
    const startPlayhead = () => {
      playButton.dataset.playing = 'true'
      playButton.setAttribute('aria-label', 'Pause')
      updatePlayhead()
      stopPlaybackTimer()
      playbackTimer = setInterval(() => {
        if (!media.isConnected || media.paused || media.ended) {
          stopPlaybackTimer()
          return
        }
        updatePlayhead()
      }, 25)
    }
    const stopPlayhead = () => {
      stopPlaybackTimer()
      playButton.dataset.playing = 'false'
      playButton.setAttribute('aria-label', 'Play')
      updatePlayhead()
    }
    const seek = clientX => {
      if (!Number.isFinite(media.duration) || media.duration <= 0) return
      const bounds = waveformTrack.getBoundingClientRect()
      const progress = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width))
      media.currentTime = progress * media.duration
      updatePlayhead()
    }
    waveformTrack.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      scrubbing = true
      try {
        waveformTrack.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture is optional in embedded browsers.
      }
      seek(event.clientX)
    })
    waveformTrack.addEventListener('pointermove', event => {
      if (!scrubbing) return
      event.preventDefault()
      event.stopPropagation()
      seek(event.clientX)
    })
    const finishScrubbing = event => {
      if (!scrubbing) return
      scrubbing = false
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'pointerup') {
        seek(event.clientX)
      }
    }
    waveformTrack.addEventListener('pointerup', finishScrubbing)
    waveformTrack.addEventListener('pointercancel', finishScrubbing)
    waveformTrack.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowRight' ? 1 : -1
      media.currentTime = Math.min(media.duration || 0, Math.max(0, media.currentTime + direction))
      updatePlayhead()
    })
    playButton.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      if (media.paused || media.ended) {
        if (media.ended) media.currentTime = 0
        media.play().catch(() => stopPlayhead())
      } else {
        media.pause()
      }
    })
    skipBack.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      media.currentTime = Math.max(0, media.currentTime - 15)
      updatePlayhead()
    })
    skipForward.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      media.currentTime = Math.min(media.duration || 0, media.currentTime + 15)
      updatePlayhead()
    })
    media.addEventListener('loadedmetadata', () => {
      scaleEnd.textContent = shortTime(media.duration)
      updatePlayhead()
    })
    media.addEventListener('timeupdate', updatePlayhead)
    media.addEventListener('seeking', updatePlayhead)
    media.addEventListener('seeked', updatePlayhead)
    media.addEventListener('play', startPlayhead)
    media.addEventListener('pause', stopPlayhead)
    media.addEventListener('ended', stopPlayhead)
    card.addEventListener('mediaresize', updatePlayhead)
    mediaFrame.append(waveformTrack, elapsed, controls, media)
  } else if (item.type === 'video') {
    media = document.createElement('video')
    media.src = item.src
    media.poster = item.thumbnailSrc
    media.controls = true
    media.playsInline = true
    media.preload = 'metadata'
    media.setAttribute('aria-label', item.alt)
  } else {
    media = document.createElement('img')
    media.src = item.src
    media.alt = item.alt
  }
  if (item.type !== 'audio') {
    mediaFrame.appendChild(media)
  }

  const mediaDimensions = () => ({
    width: media.videoWidth || media.naturalWidth || item.width || 4,
    height: media.videoHeight || media.naturalHeight || item.height || 3,
  })
  const widthRange = () => {
    const { width, height } = mediaDimensions()
    const ratio = width / height
    const max = Math.max(1, Math.min(480, window.innerWidth - 24, (window.innerHeight - 86) * ratio))
    return { min: Math.min(96, max), max }
  }
  const applyWidth = (value, remember = false) => {
    const { min, max } = widthRange()
    const width = Math.min(max, Math.max(min, value))
    card.style.width = `${Math.floor(width)}px`
    if (remember) mediaWidths.set(item.id, width)
    card.dispatchEvent(new CustomEvent('mediaresize'))
  }
  const sizeMedia = () => {
    const { width, height } = mediaDimensions()
    mediaFrame.style.aspectRatio = `${width} / ${height}`
    const preferredWidth = mediaWidths.get(item.id) ?? 200
    applyWidth(preferredWidth)
  }
  media.addEventListener(item.type === 'photo' ? 'load' : 'loadedmetadata', sizeMedia, { once: true })
  sizeMedia()

  const copy = document.createElement('div')
  copy.className = 'media-card-copy'
  const title = document.createElement('div')
  title.className = 'media-card-title'
  title.textContent = item.title
  const meta = document.createElement('div')
  meta.className = 'media-card-meta'
  meta.textContent = [
    `actual mile ${fmtMi(item.mi)}`,
    item.capturedAt ? mediaTimestamp(item.capturedAt) : null,
    Number.isFinite(item.activityElapsedS)
      ? `${activityDuration(item.activityElapsedS)} elapsed`
      : null,
    item.creator ? `by ${item.creator}` : null,
  ].filter(Boolean).join(' · ')
  copy.append(title, meta)
  const overlappingItems = overlappingIds
    .map(id => mediaById.get(id))
    .filter(Boolean)
  const overlappingIndex = overlappingItems.findIndex(candidate => candidate.id === item.id)
  if (overlappingItems.length > 1 && overlappingIndex >= 0) {
    const stack = document.createElement('div')
    stack.className = 'media-card-stack'
    const label = document.createElement('span')
    label.className = 'media-card-stack-label'
    label.textContent = `${overlappingIndex + 1} / ${overlappingItems.length} overlapping`
    const addButton = (direction, glyph, action) => {
      const targetIndex = (overlappingIndex + direction + overlappingItems.length) %
        overlappingItems.length
      const target = overlappingItems[targetIndex]
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = glyph
      button.setAttribute(
        'aria-label',
        `${action} overlapping media${target.creator ? ` by ${target.creator}` : ''}`,
      )
      button.addEventListener('click', event => {
        event.stopPropagation()
        focusMedia(target.id, false, overlappingItems.map(candidate => candidate.id))
      })
      return button
    }
    stack.append(
      label,
      addButton(-1, '‹', 'Previous'),
      addButton(1, '›', 'Next'),
    )
    copy.append(stack)
  }

  const resizeHandle = document.createElement('button')
  resizeHandle.type = 'button'
  resizeHandle.className = 'media-card-resize'
  resizeHandle.setAttribute('aria-label', 'Resize media')
  resizeHandle.title = 'Drag to resize'
  resizeHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = card.getBoundingClientRect().width
    resizeHandle.classList.add('dragging')
    try {
      resizeHandle.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture can be unavailable in embedded browsers; resizing still works.
    }

    const move = moveEvent => {
      moveEvent.preventDefault()
      applyWidth(startWidth + moveEvent.clientX - startX, true)
    }
    const finish = () => {
      resizeHandle.classList.remove('dragging')
      resizeHandle.removeEventListener('pointermove', move)
      resizeHandle.removeEventListener('pointerup', finish)
      resizeHandle.removeEventListener('pointercancel', finish)
    }
    resizeHandle.addEventListener('pointermove', move)
    resizeHandle.addEventListener('pointerup', finish)
    resizeHandle.addEventListener('pointercancel', finish)
  })
  resizeHandle.addEventListener('keydown', event => {
    const direction = ['ArrowRight', 'ArrowUp'].includes(event.key)
      ? 1
      : ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 0
    if (!direction) return
    event.preventDefault()
    event.stopPropagation()
    const step = event.shiftKey ? 40 : 16
    applyWidth(card.getBoundingClientRect().width + direction * step, true)
  })

  card.append(mediaFrame, copy, resizeHandle)
  return card
}

function focusMedia(id, fly = false, overlappingIds = []) {
  const item = mediaById.get(id)
  if (!item || !map) return
  popup?.remove()
  selectedMediaId = id
  renderProfile()
  const positionPopup = () => {
    const content = mediaPopup.getElement()?.querySelector('.mapboxgl-popup-content')
    const card = content?.querySelector('.media-card')
    if (!content || !card) return
    content.style.removeProperty('transform')
    const top = card.getBoundingClientRect().top
    if (top < 12) content.style.transform = `translateY(${12 - top}px)`
  }
  repositionMediaPopup = positionPopup
  const showPopup = () => {
    if (!mediaVisible || selectedMediaId !== id) return
    const content = mediaPopupContent(item, overlappingIds)
    content.addEventListener('mediaresize', () => {
      requestAnimationFrame(repositionMediaPopup)
    })
    mediaPopup
      .setLngLat([item.lon, item.lat])
      .setDOMContent(content)
      .addTo(map)
    document.body.classList.add('media-photo-expanded')
    requestAnimationFrame(positionPopup)
  }

  if (fly) {
    stopOrbit()
    map.stop()
    showPopup()
    map.once('moveend', positionPopup)
    map.flyTo({
      center: [item.lon, item.lat],
      zoom: Math.max(map.getZoom(), 14.5),
      pitch: relief ? 45 : 0,
      offset: [0, Math.min(160, map.getContainer().clientHeight * 0.44)],
      duration: 1200,
      essential: true,
    })
  } else {
    showPopup()
  }
}

const reportClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
})

function reportRouteRange(chapter) {
  if (!Number.isFinite(chapter?.fromMi) || !Number.isFinite(chapter?.toMi)) return null
  return {
    a: Math.max(0, chapter.fromMi),
    b: Math.min(activityTotalMi, chapter.toMi),
  }
}

function reportChapterMediaRange(chapter) {
  const routeRange = reportRouteRange(chapter)
  const fromMi = Number.isFinite(chapter?.mediaFromMi)
    ? chapter.mediaFromMi
    : routeRange?.a
  const toMi = Number.isFinite(chapter?.mediaToMi)
    ? chapter.mediaToMi
    : routeRange?.b
  if (!Number.isFinite(fromMi) || !Number.isFinite(toMi)) return null
  return {
    fromMi: Math.max(0, fromMi),
    toMi: Math.min(activityTotalMi, toMi),
  }
}

function reportMediaForChapter(chapter) {
  const range = reportChapterMediaRange(chapter)
  if (!range) return []
  return routeMedia.filter(item => item.mi >= range.fromMi && item.mi <= range.toMi)
}

function representativeReportMedia(items, maximum = 9) {
  if (items.length <= maximum) return items
  const sampled = []
  for (let index = 0; index < maximum; index += 1) {
    const itemIndex = Math.round(index * (items.length - 1) / (maximum - 1))
    if (!sampled.includes(items[itemIndex])) sampled.push(items[itemIndex])
  }
  return sampled
}

function reportElement(tagName, className, text = '') {
  const element = document.createElement(tagName)
  if (className) element.className = className
  if (text) element.textContent = text
  return element
}

function reportChapterDetails(chapter) {
  const range = reportRouteRange(chapter)
  if (!range) return chapter.context
  const stats = activityStatsBetween(range.a, range.b)
  return [
    `${fmtMi(range.a)}–${fmtMi(range.b)} mi`,
    `${reportClock.format(stats.startAt)}–${reportClock.format(stats.finishAt)}`,
    `${activityDuration(stats.elapsedS)} elapsed`,
  ].join(' · ')
}

function renderReportMedia(chapter) {
  const items = reportMediaForChapter(chapter)
  if (!items.length) return null

  const media = reportElement('div', 'report-media')
  const summary = reportElement('div', 'report-media-summary')
  const count = reportElement(
    'span',
    '',
    `${items.length} ${items.length === 1 ? 'moment' : 'moments'} along this passage`,
  )
  const creators = [...new Set(items.map(item => item.creator).filter(Boolean))]
  const byline = reportElement('small', '', creators.join(' · '))
  summary.append(count, byline)

  const strip = reportElement('div', 'report-filmstrip')
  representativeReportMedia(items).forEach(item => {
    const button = reportElement('button', 'report-media-item')
    button.type = 'button'
    button.setAttribute(
      'aria-label',
      `Open ${item.type} at actual mile ${fmtMi(item.mi)}${item.creator ? ` by ${item.creator}` : ''}`,
    )

    const image = document.createElement('img')
    image.src = item.thumbnailSrc || item.src
    image.alt = ''
    image.loading = 'lazy'
    image.decoding = 'async'

    const caption = reportElement('span', 'report-media-caption')
    caption.append(
      reportElement('b', '', `mi ${fmtMi(item.mi)}`),
      reportElement('small', '', item.creator || item.type),
    )
    button.append(image)
    if (item.type === 'video') {
      const play = reportElement('i', 'report-media-play', '▶')
      play.setAttribute('aria-hidden', 'true')
      button.append(play)
    }
    button.append(caption)
    button.addEventListener('click', () => {
      if (!mediaVisible) setMediaVisibility(true)
      focusMedia(item.id, true)
    })
    strip.appendChild(button)
  })

  media.append(summary, strip)
  return media
}

function clearReportScrollTarget() {
  reportScrollTargetId = null
  if (reportScrollTargetTimer != null) {
    clearTimeout(reportScrollTargetTimer)
    reportScrollTargetTimer = null
  }
}

function scrollToReportChapter(id) {
  const section = $(`#report-${id}`)
  if (!section) return
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'
  clearReportScrollTarget()
  reportScrollTargetId = id
  section.scrollIntoView({ behavior, block: 'start' })
  activateReportChapter(id)
  reportScrollTargetTimer = setTimeout(() => {
    if (reportScrollTargetId !== id) return
    clearReportScrollTarget()
    scheduleReportScrollSync()
  }, behavior === 'smooth' ? 1200 : 0)
}

function stepReportChapter(direction) {
  const currentIndex = Math.max(
    0,
    raceReportChapters.findIndex(chapter => chapter.id === activeReportChapterId),
  )
  const nextIndex = Math.max(
    0,
    Math.min(raceReportChapters.length - 1, currentIndex + direction),
  )
  scrollToReportChapter(raceReportChapters[nextIndex].id)
}

function renderRaceReport() {
  if (reportRendered) return
  reportRendered = true

  const lede = $('#report-lede')
  const filmLink = reportElement('a', 'report-film-link', `${raceReportMeta.filmLabel} ↗`)
  filmLink.href = raceReportMeta.filmUrl
  filmLink.target = '_blank'
  filmLink.rel = 'noreferrer'
  lede.append(
    reportElement('span', 'report-eyebrow', raceReportMeta.eyebrow),
    reportElement('p', 'report-introduction', raceReportMeta.introduction),
    filmLink,
  )

  const nav = $('#report-nav')
  const previous = reportElement('button', 'report-step report-previous', '←')
  previous.type = 'button'
  previous.setAttribute('aria-label', 'Previous report section')
  previous.addEventListener('click', () => stepReportChapter(-1))
  nav.appendChild(previous)

  raceReportAnchors.forEach(anchor => {
    const button = reportElement('button', 'report-anchor', anchor.label)
    button.type = 'button'
    button.dataset.reportTarget = anchor.id
    button.addEventListener('click', () => scrollToReportChapter(anchor.id))
    nav.appendChild(button)
  })

  const next = reportElement('button', 'report-step report-next', '→')
  next.type = 'button'
  next.setAttribute('aria-label', 'Next report section')
  next.addEventListener('click', () => stepReportChapter(1))
  nav.appendChild(next)

  const body = $('#report-body')
  raceReportChapters.forEach(chapter => {
    const section = reportElement('section', 'report-chapter')
    section.id = `report-${chapter.id}`
    section.dataset.reportChapter = chapter.id

    const header = reportElement('header', 'report-chapter-head')
    const heading = reportElement('div', 'report-chapter-heading')
    heading.append(
      reportElement('span', 'report-phase', chapter.phase),
      reportElement('h3', '', chapter.title),
    )
    header.append(
      heading,
      reportElement('p', 'report-chapter-context', reportChapterDetails(chapter)),
    )

    const range = reportRouteRange(chapter)
    if (range) {
      const mapButton = reportElement(
        'button',
        'report-map-range',
        `show mi ${fmtMi(range.a)}–${fmtMi(range.b)}`,
      )
      mapButton.type = 'button'
      mapButton.addEventListener('click', () => activateReportChapter(chapter.id, { fit: true }))
      header.appendChild(mapButton)
    }

    const copy = reportElement('div', 'report-copy')
    chapter.paragraphs.forEach(paragraph => {
      copy.appendChild(reportElement('p', '', paragraph))
    })
    section.append(header, copy)

    const media = renderReportMedia(chapter)
    if (media) section.appendChild(media)
    body.appendChild(section)
  })

  const scroller = $('#report-scroll')
  scroller.addEventListener('scroll', scheduleReportScrollSync, { passive: true })
  scroller.addEventListener('wheel', clearReportScrollTarget, { passive: true })
  scroller.addEventListener('touchstart', clearReportScrollTarget, { passive: true })
  scroller.addEventListener('pointerdown', clearReportScrollTarget, { passive: true })
  window.addEventListener('scroll', scheduleReportScrollSync, { passive: true })
  window.addEventListener('resize', scheduleReportScrollSync)
}

function fitReportChapter(chapter) {
  const range = reportRouteRange(chapter)
  if (!range || !map) return
  const feature = activitySliceFeature(range.a, range.b)
  const bounds = new mapboxgl.LngLatBounds()
  feature.geometry.coordinates.forEach(coordinates => bounds.extend(coordinates))
  stopOrbit()
  map.fitBounds(bounds, {
    padding: fitPad(),
    duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1100,
    essential: true,
  })
}

function activateReportChapter(id, { fit = false } = {}) {
  const chapter = reportChapterById.get(id)
  if (!chapter) return
  activeReportChapterId = chapter.id
  reportSelection = reportRouteRange(chapter)
  reportMediaRange = reportChapterMediaRange(chapter)

  document.querySelectorAll('.report-chapter').forEach(section => {
    section.classList.toggle('active', section.dataset.reportChapter === chapter.id)
  })

  const chapterIndex = raceReportChapters.findIndex(candidate => candidate.id === chapter.id)
  let activeAnchorId = raceReportAnchors[0]?.id
  raceReportAnchors.forEach(anchor => {
    const anchorIndex = raceReportChapters.findIndex(candidate => candidate.id === anchor.id)
    if (anchorIndex <= chapterIndex) activeAnchorId = anchor.id
  })
  document.querySelectorAll('#report-nav [data-report-target]').forEach(button => {
    button.classList.toggle('on', button.dataset.reportTarget === activeAnchorId)
  })
  $('.report-previous').disabled = chapterIndex === 0
  $('.report-next').disabled = chapterIndex === raceReportChapters.length - 1

  const selected = selectedMediaId ? mediaById.get(selectedMediaId) : null
  if (selected && (
    !reportMediaRange ||
    selected.mi < reportMediaRange.fromMi ||
    selected.mi > reportMediaRange.toMi
  )) {
    mediaPopup?.remove()
  }

  syncSelToMap()
  updateMediaSources()
  renderProfile()
  if (fit) fitReportChapter(chapter)
}

function reportScrollProgress() {
  const scroller = $('#report-scroll')
  if (!scroller) return 0
  if (!matchMedia('(max-width: 940px)').matches) {
    const maximum = scroller.scrollHeight - scroller.clientHeight
    return maximum > 0 ? scroller.scrollTop / maximum : 0
  }
  const pageTop = scroller.getBoundingClientRect().top + window.scrollY
  const maximum = Math.max(1, scroller.offsetHeight - window.innerHeight)
  return (window.scrollY - pageTop) / maximum
}

function syncReportScrollPosition() {
  reportScrollFrame = null
  if (railView !== 'report') return
  const scroller = $('#report-scroll')
  const sections = [...document.querySelectorAll('.report-chapter')]
  if (!scroller || !sections.length) return

  const stacked = matchMedia('(max-width: 940px)').matches
  const anchorY = stacked
    ? Math.min(170, window.innerHeight * 0.24)
    : scroller.getBoundingClientRect().top + Math.min(170, scroller.clientHeight * 0.28)
  let activeSection = sections[0]
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= anchorY) activeSection = section
    else break
  }
  const visibleChapterId = activeSection.dataset.reportChapter
  if (reportScrollTargetId === visibleChapterId) {
    clearReportScrollTarget()
  } else if (!reportScrollTargetId && visibleChapterId !== activeReportChapterId) {
    activateReportChapter(activeSection.dataset.reportChapter)
  }

  const progress = Math.max(0, Math.min(1, reportScrollProgress()))
  $('#report-progress i').style.transform = `scaleX(${progress})`
}

function scheduleReportScrollSync() {
  if (reportScrollFrame != null) return
  reportScrollFrame = requestAnimationFrame(syncReportScrollPosition)
}

function setRailView(view) {
  if (!['activity', 'report'].includes(view)) return
  railView = view
  if (view === 'report') renderRaceReport()

  $('#activity-index').hidden = view !== 'activity'
  $('#race-report').hidden = view !== 'report'
  document.body.classList.toggle('report-view', view === 'report')
  document.querySelectorAll('#rail-views button').forEach(button => {
    const on = button.dataset.railView === view
    button.classList.toggle('on', on)
    button.setAttribute('aria-pressed', String(on))
  })

  if (view === 'report') {
    activateReportChapter(activeReportChapterId || raceReportChapters[0]?.id)
    requestAnimationFrame(syncReportScrollPosition)
  } else {
    reportSelection = null
    reportMediaRange = null
    syncSelToMap()
    updateMediaSources()
    renderProfile()
  }
}

function focusFacility(id, visitId = null, fly = false) {
  const facility = facilityById.get(id)
  if (!facility || !map) return
  mediaPopup?.remove()
  const visits = facilityVisits.filter(visit => visit.facility.id === id)
  const selected = visits.find(visit => visit.id === visitId) || visits[0]
  const meta = FACILITY_TYPES[facility.type]

  document.querySelectorAll('.facility-stop').forEach(li =>
    li.classList.toggle('sel', li.dataset.visitId === selected?.id))
  $(`.facility-stop[data-visit-id="${selected?.id}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

  const visitRows = visits.map(visit => {
    return `<div class="pop-row"><b>mi ${fmtMi(visit.mi)}</b> · ${Math.round(visit.offsetM)} m away · passed ${hhmm(visit.clock)} ${weekday(visit.clock)} · ${activityDuration(visit.elapsedS)} elapsed</div>`
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
  const p = activityPointAtMi(mi)
  src.setData({
    type: 'Feature', properties: {},
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  })
}

// Keep route framing clear of map controls and the optional atmosphere player.
const fitPad = () =>
  matchMedia('(max-width: 940px)').matches
    ? { top: 30, bottom: atmosphereMode ? 120 : 30, left: 30, right: 30 }
    : { top: 55, bottom: atmosphereMode ? 125 : 70, left: 70, right: 70 }

let popup = null
let mediaPopup = null
if (map) {
  map.on('style.load', async () => {
    addAtmosphereLayers()
    addCourseLayers()
    addActivityLayers()
    addAtmosphereTimeLayers()
    addWaypointLayers()
    try {
      await addFacilityLayers()
    } catch (error) {
      console.error(error)
    }
    try {
      await addMediaLayers()
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
      pitch: 0, bearing: 0, duration: 2600, essential: true,
    })
  })
  popup = new mapboxgl.Popup({ className: 'wp-pop', offset: 16, maxWidth: '300px' })
  mediaPopup = new mapboxgl.Popup({
    className: 'media-pop',
    anchor: 'bottom',
    offset: 32,
    maxWidth: '480px',
  })
  mediaPopup.on('close', () => {
    document.body.classList.remove('media-photo-expanded')
    repositionMediaPopup = () => {}
    selectedMediaId = null
    renderProfile()
  })
  map.on('mousedown', stopOrbit)
}

function focusWaypoint(id, fromMap = false) {
  const w = waypoints.find(x => x.id === id)
  document.querySelectorAll('.wp').forEach(li =>
    li.classList.toggle('sel', li.dataset.id === id))
  $(`.wp[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  if (!map) return
  mediaPopup?.remove()

  const accessDetail = factualAccess(w)
  popup.setLngLat([w.lon, w.lat]).setHTML(`
    <div class="pop-nm">${w.name}</div>
    <div class="pop-mi">actual mile ${fmtMi(w.mi)} · ${fmtFt(w.altitudeM * FT_PER_M)} ft</div>
    <div class="pop-row">arrived <b>${hhmm(w.actualClock)}</b> ${weekday(w.actualClock)} · ${activityDuration(w.actualElapsedS)} elapsed</div>
    <div class="pop-row">${accessDetail}</div>
    <div class="pop-row">${w.note}</div>
    ${w.gate?.alt ? `<div class="pop-row">${w.gate.alt}</div>` : ''}
  `).addTo(map)

  if (!fromMap) {
    stopOrbit()
    map.flyTo({
      center: [w.lon, w.lat],
      zoom: 13.6,
      pitch: relief ? 65 : 0,
      duration: 1900,
      essential: true,
    })
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
      mediaPopup?.remove()
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
  relief = !relief
  $('#ctl-3d').classList.toggle('on', relief)
  $('#ctl-3d').setAttribute('aria-pressed', String(relief))
  if (relief) {
    map.setTerrain({ source: 'dem', exaggeration: 1.5 })
    map.easeTo({ pitch: 58, bearing: -14, duration: 900 })
  } else {
    map.setTerrain(null)
    map.easeTo({ pitch: 0, bearing: 0, duration: 900 })
  }
})
$('#ctl-orbit').addEventListener('click', () => (orbiting ? stopOrbit() : startOrbit()))
$('#ctl-location').addEventListener('click', captureUserLocation)
document.querySelectorAll('#rail-views button').forEach(button => {
  button.addEventListener('click', () => setRailView(button.dataset.railView))
})
$('#ctl-media').addEventListener('click', () => setMediaVisibility(!mediaVisible))
for (const mode of Object.keys(ATMOSPHERE_UI)) {
  $(ATMOSPHERE_UI[mode].button).addEventListener('click', () => {
    setAtmosphereMode(atmosphereMode === mode ? null : mode)
  })
}
$('#atmosphere-time').addEventListener('input', event => {
  stopAtmospherePlayback()
  showAtmosphereElapsed(Number(event.target.value))
})
$('#atmosphere-play').addEventListener('click', () => {
  if (atmospherePlaying) stopAtmospherePlayback()
  else startAtmospherePlayback()
})
loadAtmosphereArchives()
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
document.querySelectorAll('#metric-controls [data-metric]').forEach(button => {
  const key = button.dataset.metric
  const def = METRIC_BY_KEY[key]
  button.style.setProperty('--metric-color', def.color)
  button.style.setProperty('--metric-gradient', metricGradient(key))
  button.title = `Show ${def.label} on the elevation profile`
  button.addEventListener('click', () => {
    activeMetric = activeMetric === key ? null : key
    document.querySelectorAll('#metric-controls [data-metric]').forEach(metricButton => {
      const on = metricButton.dataset.metric === activeMetric
      metricButton.classList.toggle('on', on)
      metricButton.setAttribute('aria-pressed', String(on))
    })
    renderProfile()
  })
})
document.querySelectorAll('#metric-controls [data-event]').forEach(button => {
  const key = button.dataset.event
  const def = EVENT_DEFS[key]
  const colors = def.colors ? Object.values(def.colors) : [def.color, def.color]
  button.style.setProperty('--metric-color', def.color)
  button.style.setProperty('--metric-gradient', `linear-gradient(90deg, ${colors.join(', ')})`)
  button.title = `Toggle ${def.label} on the elevation profile`
  button.addEventListener('click', () => {
    if (activeEvents.has(key)) activeEvents.delete(key)
    else activeEvents.add(key)
    const on = activeEvents.has(key)
    button.classList.toggle('on', on)
    button.setAttribute('aria-pressed', String(on))
    renderProfile()
  })
})
$('#ctl-fit').addEventListener('click', () => {
  if (!map) return
  stopOrbit()
  map.fitBounds(bbox, {
    padding: fitPad(),
    pitch: relief ? 45 : 0,
    bearing: relief ? -14 : 0,
    duration: 1600,
  })
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

// ---------------------------------------------------------------- actual summary
const compactClock = value => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
}).format(new Date(value))
$('#actual-date').textContent = 'Aug 8–9, 2026'
$('#actual-distance').textContent = activityTotalMi.toFixed(2)
$('#actual-elapsed').textContent = activityDuration(activitySummary.elapsedS)
$('#actual-moving').textContent = activityDuration(activitySummary.movingS)
$('#actual-start').textContent = compactClock(activitySummary.startAt)
$('#actual-finish').textContent = compactClock(activitySummary.finishAt)
$('#actual-gain').textContent =
  `${Math.round(activitySummary.elevationGainM * FT_PER_M).toLocaleString('en-US')} ft`
$('#actual-pace').textContent =
  `${activityPace(activitySummary.averagePaceSecondsPerKm * 1.609344, 1)} /mi`
$('#actual-effort').textContent = activitySummary.relativeEffort.toLocaleString('en-US')
$('#actual-calories').textContent = activitySummary.calories.toLocaleString('en-US')
$('#actual-condition').textContent = activitySummary.weather.condition
$('#actual-temperature').textContent =
  `${Math.round(activitySummary.weather.temperatureC * 9 / 5 + 32)} °F`
$('#actual-humidity').textContent = `${activitySummary.weather.humidityPercent}%`
$('#actual-feels').textContent =
  `${Math.round(activitySummary.weather.feelsLikeC * 9 / 5 + 32)} °F`
$('#actual-wind').textContent =
  `${(activitySummary.weather.windSpeedKph / 1.609344).toFixed(1)} mph`
$('#actual-wind-direction').textContent = activitySummary.weather.windDirection

// ---------------------------------------------------------------- waypoint list
document.querySelectorAll('#filters button').forEach(b =>
  b.addEventListener('click', () => {
    filter = filter === b.dataset.f ? 'all' : b.dataset.f
    document.querySelectorAll('#filters button').forEach(x =>
      x.classList.toggle('on', x.dataset.f === filter))
    renderList()
  }))

function visible(w) {
  if (filter === 'crew') return w.crew
  if (filter === 'gated') return !!w.gate
  if (filter === 'all') return true
  return true
}

function activityDuration(seconds) {
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remaining = total % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

function activityPace(seconds, distance) {
  const pace = Math.round(seconds / distance)
  return `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, '0')}`
}

function renderList() {
  const ol = $('#wplist')
  const summary = $('#segment-summary')
  const scrollTop = renderedFilter === filter ? ol.scrollTop : 0
  renderedFilter = filter
  ol.innerHTML = ''
  $('#legend').hidden = filter === 'crew'
  if (filter === 'crew') {
    summary.hidden = true
    renderCrewPlan(ol)
    ol.scrollTop = scrollTop
    return
  }
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
      const s = activityStatsBetween(prev.mi, w.mi)
      const leg = document.createElement('li')
      leg.className = 'leg'
      leg.textContent = `${s.mi.toFixed(1)} mi · +${fmtFt(s.gain)} ft · −${fmtFt(s.loss)} ft`
      ol.appendChild(leg)
    }
    const arrived = w.actualClock
    const li = document.createElement('li')
    li.className = 'wp' +
      (w.crew ? '' : ' foot') +
      (w.gate ? ' gate gated' : '')
    li.dataset.id = w.id
    const accessText = w.gate
      ? `<span class="g">${factualAccess(w)}</span>`
      : (w.access || (w.crew ? '24 h access' : '<span class="f">foot only</span>'))
    li.innerHTML = `
      <span class="mi">${fmtMi(w.mi)}<em>${fmtFt(w.altitudeM * FT_PER_M)} ft</em></span>
      <span>
        <span class="nm">${w.name}</span>
        <div class="meta">${accessText}</div>
      </span>
      <span class="eta"><span>${hhmm(arrived)}</span><em>${activityDuration(w.actualElapsedS)} elapsed</em></span>`
    li.addEventListener('click', () => focusWaypoint(w.id))
    ol.appendChild(li)
  })
  ol.scrollTop = scrollTop
}

function appendCrewValue(element, value) {
  const pieces = value.split(/(Pacer \d+)/g)
  for (const piece of pieces) {
    if (!piece) continue
    if (/^Pacer \d+$/.test(piece)) {
      const placeholder = document.createElement('span')
      placeholder.className = 'crew-pacer-chip'
      placeholder.textContent = piece
      element.appendChild(placeholder)
    } else {
      element.append(document.createTextNode(piece))
    }
  }
}

function appendPacerSeparator(element, value, state = false) {
  const separator = document.createElement('span')
  separator.className = state ? 'crew-pacer-state' : 'crew-pacer-separator'
  separator.textContent = value
  element.appendChild(separator)
}

function appendPacerGroup(element, value) {
  const pacer = document.createElement('span')
  pacer.className = 'crew-pacer-chip'
  pacer.textContent = value
  element.appendChild(pacer)
}

function crewPacingLine(stop) {
  if (!stop.pacerIn && !stop.pacerOut) return null
  const line = document.createElement('div')
  line.className = 'crew-plan-line pacing'
  const key = document.createElement('span')
  key.className = 'crew-plan-key'
  key.textContent = 'pacing'
  const text = document.createElement('span')
  text.className = 'crew-pacing-value'

  if (stop.segment === 1 && stop.pacerOut) {
    appendPacerGroup(text, stop.pacerOut)
    appendPacerSeparator(text, 'starts', true)
  } else if (stop.pacerIn && stop.pacerOut && stop.pacerIn === stop.pacerOut) {
    appendPacerGroup(text, stop.pacerOut)
    appendPacerSeparator(text, 'continues', true)
  } else if (stop.pacerIn && stop.pacerOut) {
    appendPacerGroup(text, stop.pacerIn)
    appendPacerSeparator(text, '→')
    appendPacerGroup(text, stop.pacerOut)
  } else if (stop.pacerOut) {
    appendPacerGroup(text, stop.pacerOut)
    appendPacerSeparator(text, 'starts', true)
  } else {
    appendPacerGroup(text, stop.pacerIn)
    appendPacerSeparator(text, 'finishes', true)
  }

  line.append(key, text)
  return line
}

function crewPlanLine(label, value, tone) {
  if (!value) return null
  const line = document.createElement('div')
  line.className = `crew-plan-line ${tone}`
  const key = document.createElement('span')
  key.className = 'crew-plan-key'
  key.textContent = label
  const text = document.createElement('span')
  appendCrewValue(text, value)
  line.append(key, text)
  return line
}

function renderCrewPlan(ol) {
  const placeholders = [...new Set(
    crewPlan.flatMap(stop =>
      `${stop.pacerIn} ${stop.pacerOut}`.match(/Pacer \d+/g) || []),
  )].sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))

  const intro = document.createElement('li')
  intro.className = 'crew-plan-intro'
  const introTitle = document.createElement('b')
  introTitle.textContent = 'Crew & pacers'
  const introText = document.createElement('span')
  if (placeholders.length) {
    placeholders.forEach((placeholder, index) => {
      if (index) introText.append(', ')
      const chip = document.createElement('span')
      chip.className = 'crew-pacer-chip'
      chip.textContent = placeholder
      introText.appendChild(chip)
    })
    introText.append(' appear exactly as recorded in the source. Times below are GPS-matched arrivals.')
  } else {
    introText.textContent = 'Historical handoffs with GPS-matched arrival times and verified activity miles.'
  }
  intro.append(introTitle, introText)
  ol.appendChild(intro)

  for (const stop of crewPlan) {
    const waypoint = waypointById.get(stop.waypointId) || crewPoints.reduce((nearest, candidate) =>
      Math.abs(candidate.plannedMi - stop.mi) < Math.abs(nearest.plannedMi - stop.mi)
        ? candidate
        : nearest, crewPoints[0])
    const arrived = waypoint.actualClock
    const li = document.createElement('li')
    li.className = 'crew-plan-stop'
    li.dataset.id = waypoint.id

    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(
      'aria-label',
      `${stop.name}, actual mile ${fmtMi(waypoint.mi)}, arrived ${hhmm(arrived)}`,
    )

    const number = document.createElement('span')
    number.className = 'crew-plan-no'
    number.textContent = String(stop.segment).padStart(2, '0')

    const main = document.createElement('span')
    main.className = 'crew-plan-main'
    const heading = document.createElement('span')
    heading.className = 'crew-plan-heading'
    const name = document.createElement('span')
    name.className = 'crew-plan-name'
    name.textContent = stop.name
    const mile = document.createElement('span')
    mile.className = 'crew-plan-mile'
    mile.textContent = `actual mile ${fmtMi(waypoint.mi)}`
    heading.append(name, mile)

    const details = document.createElement('span')
    details.className = 'crew-plan-details'
    const lines = [
      crewPacingLine(stop),
      crewPlanLine('supplies', stop.supplies, 'supplies'),
      crewPlanLine('transport', stop.transport, 'transport'),
      crewPlanLine('notes', stop.notes, 'notes'),
    ].filter(Boolean)
    details.append(...lines)
    main.append(heading, details)

    const time = document.createElement('span')
    time.className = 'crew-plan-time'
    const clock = document.createElement('span')
    clock.textContent = hhmm(arrived)
    const day = document.createElement('em')
    day.textContent = `${weekday(arrived)} · ${activityDuration(waypoint.actualElapsedS)}`
    time.append(clock, day)

    button.append(number, main, time)
    button.addEventListener('click', () => focusWaypoint(waypoint.id))
    li.appendChild(button)
    ol.appendChild(li)
  }
}

function renderFacilityList(ol, type) {
  const visits = facilityVisits.filter(visit => visit.facility.type === type)
  visits.forEach((visit, i) => {
    if (i > 0) {
      const previous = visits[i - 1]
      const s = activityStatsBetween(previous.mi, visit.mi)
      const leg = document.createElement('li')
      leg.className = 'leg'
      leg.textContent = `${s.mi.toFixed(1)} mi · +${fmtFt(s.gain)} ft · −${fmtFt(s.loss)} ft`
      ol.appendChild(leg)
    }
    const li = document.createElement('li')
    li.className = 'wp facility-stop'
    li.dataset.id = visit.facility.id
    li.dataset.visitId = visit.id
    li.innerHTML = `
      <span class="mi">${fmtMi(visit.mi)}<em>${Math.round(visit.offsetM)} m away</em></span>
      <span>
        <span class="nm">${visit.facility.name}</span>
      </span>
      <span class="eta">${hhmm(visit.clock)}<em>${activityDuration(visit.elapsedS)} elapsed</em></span>`
    li.addEventListener('click', () => focusFacility(visit.facility.id, visit.id, true))
    ol.appendChild(li)
  })
}

const weekday = d => d.toLocaleDateString('en-US', { weekday: 'short' })

const selectedCrewSegments = () =>
  crewSegments.filter(segment => selectedSegmentKeys.has(segment.key))

function segmentTotals(segments = selectedCrewSegments()) {
  return segments.reduce((total, { from, to }) => {
    const s = activityStatsBetween(from.mi, to.mi)
    total.mi += s.mi
    total.gain += s.gain
    total.loss += s.loss
    total.duration += s.elapsedS * 1000
    return total
  }, { mi: 0, gain: 0, loss: 0, duration: 0 })
}

function selectionRanges() {
  if (reportSelection) return [reportSelection]
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
      <b>Combined · ${segments.length} split${segments.length === 1 ? '' : 's'}</b>
      <small>${total.mi.toFixed(1)} mi · +${fmtFt(total.gain)} ft · −${fmtFt(total.loss)} ft · ${activityDuration(total.duration / 1000)} elapsed</small>
    </span>
    <button type="button">clear</button>`
  summary.querySelector('button').addEventListener('click', clearSegmentSelection)
}

function renderSegments(ol) {
  for (const segment of crewSegments) {
    const { from, to } = segment
    const s = activityStatsBetween(from.mi, to.mi)
    const depart = s.startAt
    const arrive = s.finishAt
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
          ${hhmm(depart)} ${weekday(depart)} → ${hhmm(arrive)} ${weekday(arrive)}
          <i>· ${activityDuration(s.elapsedS)} · ${activityPace(s.elapsedS, s.mi)} /mi</i>
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

function appendEventProfileOverlays(svg, x, padT, padB, height) {
  if (activeEvents.has('climbs')) {
    for (const range of eventRanges('climbs')) {
      const band = rect(
        x(range.a),
        padT,
        Math.max(0.7, x(range.b) - x(range.a)),
        height - padT - padB,
        EVENT_DEFS.climbs.color,
      )
      band.setAttribute('opacity', 0.09)
      svg.appendChild(band)
    }
  }

  if (activeEvents.has('offCourse')) {
    for (const range of eventRanges('offCourse')) {
      const band = rect(
        x(range.a),
        padT,
        Math.max(0.7, x(range.b) - x(range.a)),
        height - padT - padB,
        EVENT_DEFS.offCourse.color,
      )
      band.setAttribute('opacity', 0.1)
      svg.appendChild(band)
      svg.appendChild(line(
        x(range.a),
        padT,
        x(range.a),
        height - padB,
        EVENT_DEFS.offCourse.color,
        0.8,
        '2 2',
      ))
    }
  }

}

function appendMovementProfileBars(svg, x, padB, height) {
  const plotLeft = x(0)
  const plotWidth = x(activityTotalMi) - plotLeft
  const barCount = Math.max(40, Math.min(160, Math.floor(plotWidth / 5)))
  const scores = {
    run: new Float32Array(barCount),
    walk: new Float32Array(barCount),
    stand: new Float32Array(barCount),
  }
  const milesPerBar = activityTotalMi / barCount
  for (const range of eventRanges('movement')) {
    const from = Math.max(0, Math.min(activityTotalMi, range.a))
    const to = Math.max(from, Math.min(activityTotalMi, range.b))
    const first = Math.min(barCount - 1, Math.floor(from / milesPerBar))
    const last = Math.min(barCount - 1, Math.floor(to / milesPerBar))
    for (let bin = first; bin <= last; bin += 1) {
      const overlap = Math.max(
        0,
        Math.min(to, (bin + 1) * milesPerBar) - Math.max(from, bin * milesPerBar),
      )
      scores[range.type][bin] += overlap
    }
  }

  const step = plotWidth / barCount
  const barWidth = Math.max(1, step * 0.7)
  const heights = { run: 26, walk: 15, stand: 6 }
  const grouped = new Map()
  for (let bin = 0; bin < barCount; bin += 1) {
    const mode = ['run', 'walk', 'stand'].reduce((best, candidate) =>
      scores[candidate][bin] > scores[best][bin] ? candidate : best)
    if (scores[mode][bin] <= 0) continue
    const barHeight = heights[mode]
    const left = plotLeft + bin * step + (step - barWidth) / 2
    const top = height - padB - barHeight
    const command = `M ${left.toFixed(1)} ${top.toFixed(1)} ` +
      `h ${barWidth.toFixed(1)} v ${barHeight} h ${(-barWidth).toFixed(1)} Z`
    grouped.set(mode, `${grouped.get(mode) || ''} ${command}`)
  }
  for (const [mode, d] of grouped) {
    const bars = path(d, EVENT_DEFS.movement.colors[mode], 'none', 0)
    bars.setAttribute('opacity', 0.88)
    svg.appendChild(bars)
  }
}

function appendMetricBars(
  svg,
  key,
  def,
  values,
  yMetric,
  padL,
  padR,
  padT,
  padB,
  width,
  height,
) {
  const plotWidth = width - padL - padR
  const barCount = Math.max(40, Math.min(160, Math.floor(plotWidth / 5)))
  const sums = new Float64Array(barCount)
  const counts = new Uint16Array(barCount)
  for (let index = 0; index < activityTrack.length; index += 1) {
    const value = values[index]
    if (!Number.isFinite(value)) continue
    const mi = displayMiFromRawM(activityTrack[index][3])
    const bin = Math.min(barCount - 1, Math.floor(mi / activityTotalMi * barCount))
    sums[bin] += value
    counts[bin] += 1
  }

  const step = plotWidth / barCount
  const barWidth = Math.max(1, step * 0.7)
  const clampY = value => Math.min(height - padB, Math.max(padT, value))
  const baseline = def.symmetric ? clampY(yMetric(0)) : height - padB
  const grouped = new Map()
  for (let bin = 0; bin < barCount; bin += 1) {
    if (!counts[bin]) continue
    const value = sums[bin] / counts[bin]
    const valueY = clampY(yMetric(value))
    const top = Math.min(baseline, valueY)
    const barHeight = Math.max(1, Math.abs(baseline - valueY))
    const left = padL + bin * step + (step - barWidth) / 2
    const color = metricColor(key, value) || def.color
    const command = `M ${left.toFixed(1)} ${top.toFixed(1)} ` +
      `h ${barWidth.toFixed(1)} v ${barHeight.toFixed(1)} ` +
      `h ${(-barWidth).toFixed(1)} Z`
    grouped.set(color, `${grouped.get(color) || ''} ${command}`)
  }

  if (def.symmetric) {
    svg.appendChild(line(padL, baseline, width - padR, baseline, def.color, 0.75))
  }
  for (const [color, d] of grouped) {
    const bars = path(d, color, 'none', 0)
    bars.setAttribute('opacity', 0.64)
    svg.appendChild(bars)
  }
}

function renderProfile() {
  const W = chart.clientWidth, H = chart.clientHeight
  if (!W || !H) return
  const activeDef = activeMetric ? METRIC_BY_KEY[activeMetric] : null
  const activeDomain = activeMetric ? metricDomain(activeMetric) : null
  const activeValues = activeMetric ? metricSeries(activeMetric) : null
  const padL = 46, padR = 76, padT = 20, padB = 20
  const eMin = Math.floor(activitySummary.minAltitudeM * FT_PER_M / 500) * 500
  const eMax = Math.ceil(activitySummary.maxAltitudeM * FT_PER_M / 500) * 500
  const x = mi => padL + (mi / activityTotalMi) * (W - padL - padR)
  const y = e => padT + (1 - (e - eMin) / (eMax - eMin)) * (H - padT - padB)
  const yMetric = value => {
    const ratio = (value - activeDomain?.min) /
      ((activeDomain?.max - activeDomain?.min) || 1)
    return padT + (activeDef?.invertAxis ? ratio : 1 - ratio) * (H - padT - padB)
  }
  const miAtX = px => Math.min(activityTotalMi, Math.max(0,
    (px - padL) / (W - padL - padR) * activityTotalMi))
  geom = { W, H, padL, padR, padT, padB, x, y, miAtX }

  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)

  // Night bands follow the recorded clock, not a projected pace.
  for (const [m0, m1] of nightBands()) {
    const r = rect(x(m0), padT, Math.max(1, x(m1) - x(m0)), H - padT - padB,
      'rgba(0,0,0,0.04)')
    svg.appendChild(r)
  }
  appendEventProfileOverlays(svg, x, padT, padB, H)

  // elevation gridlines
  for (let e = eMin; e <= eMax; e += 500) {
    svg.appendChild(line(padL, y(e), W - padR, y(e), 'rgba(0,0,0,0.05)', 1))
    svg.appendChild(text(padL - 6, y(e) + 3, e.toLocaleString(), 'end', 9.25, 'rgba(0,0,0,0.48)'))
  }
  // The right axis follows the active signal; otherwise it mirrors elevation in metres.
  const axisX = W - padR
  svg.appendChild(line(axisX, padT, axisX, H - padB, 'rgba(0,0,0,0.12)', 1))
  if (activeDef) {
    for (const ratio of [0, 0.5, 1]) {
      const value = activeDef.invertAxis
        ? activeDomain.min + (activeDomain.max - activeDomain.min) * ratio
        : activeDomain.max - (activeDomain.max - activeDomain.min) * ratio
      const py = padT + ratio * (H - padT - padB)
      svg.appendChild(line(axisX, py, axisX + 4, py, activeDef.color, 1))
      svg.appendChild(text(
        axisX + 7,
        py + 3,
        activeDef.format(value),
        'start',
        9,
        activeDef.color,
      ))
    }
  } else {
    const ftPerM = 3.28084
    const firstMeter = Math.ceil((eMin / ftPerM) / 200) * 200
    const lastMeter = Math.floor((eMax / ftPerM) / 200) * 200
    for (let m = firstMeter; m <= lastMeter; m += 200) {
      const py = y(m * ftPerM)
      svg.appendChild(line(axisX, py, axisX + 4, py, 'rgba(0,0,0,0.3)', 1))
      svg.appendChild(text(axisX + 7, py + 3, `${m} m`, 'start', 9.25, 'rgba(0,0,0,0.48)'))
    }
  }
  // Mile ticks
  for (let m = 10; m < activityTotalMi; m += 10) {
    svg.appendChild(line(x(m), H - padB, x(m), H - padB + 4, 'rgba(0,0,0,0.3)', 1))
    svg.appendChild(text(x(m), H - 6, m, 'middle', 9.25, 'rgba(0,0,0,0.48)'))
  }

  // Recorded elapsed-time ticks form a second, non-linear x-axis.
  for (const tick of activityTimeTicks()) {
    const px = x(tick.mi)
    const hours = Math.round(tick.elapsedS / 3600)
    svg.appendChild(line(px, padT, px, H - padB, 'rgba(0,0,0,0.08)', 1, '2 3'))
    svg.appendChild(text(
      px,
      10,
      tick.elapsedS >= activitySummary.elapsedS ? 'finish' : `${hours}h`,
      'middle',
      9.25,
      'rgba(0,0,0,0.52)',
    ))
  }

  // Actual elevation path; closed variant is used for the selection wash.
  const maxPoints = Math.max(300, Math.floor(W * 1.5))
  const trackStep = Math.max(1, Math.floor(activityTrack.length / maxPoints))
  const profilePoint = sample =>
    `${x(displayMiFromRawM(sample[3])).toFixed(1)} ${y(sample[2] * FT_PER_M).toFixed(1)}`
  let dLine = `M ${profilePoint(activityTrack[0])}`
  for (let index = trackStep; index < activityTrack.length; index += trackStep) {
    dLine += ` L ${profilePoint(activityTrack[index])}`
  }
  dLine += ` L ${profilePoint(activityTrack.at(-1))}`
  const dArea = dLine + ` L ${x(activityTotalMi)} ${H - padB} L ${x(0)} ${H - padB} Z`

  const ranges = selectionRanges()
  const defs = document.createElementNS(NS, 'defs')
  ranges.forEach((range, i) => {
    const clip = document.createElementNS(NS, 'clipPath')
    clip.setAttribute('id', `selclip-${i}`)
    clip.appendChild(rect(x(range.a), 0, Math.max(1, x(range.b) - x(range.a)), H, C.wash))
    defs.appendChild(clip)
  })
  svg.appendChild(defs)

  if (activeMetric) {
    appendMetricBars(
      svg,
      activeMetric,
      activeDef,
      activeValues,
      yMetric,
      padL,
      padR,
      padT,
      padB,
      W,
      H,
    )
  }
  if (activeEvents.has('movement')) {
    appendMovementProfileBars(svg, x, padB, H)
  }

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

  // Actual crew-stop passages.
  for (const w of waypoints) {
    if (!w.crew || w.kind !== 'major') continue
    const px = x(w.mi), py = y(w.altitudeM * FT_PER_M)
    const c = document.createElementNS(NS, 'circle')
    c.setAttribute('cx', px); c.setAttribute('cy', py); c.setAttribute('r', 2.3)
    c.setAttribute('fill', C.routeHighlight)
    c.setAttribute('stroke', C.ink)
    c.setAttribute('stroke-width', 1.1)
    svg.appendChild(c)
  }

  // Route media use their poster image as the profile marker.
  if (mediaVisible && selectedMediaId) {
    routeMedia
      .filter(item => item.id === selectedMediaId)
      .forEach((item, index) => {
      const px = x(item.mi)
      const py = y(activityPointAtMi(item.mi).altitudeM * FT_PER_M)
      const selected = item.id === selectedMediaId
      const markerSize = selected ? 20 : 16
      const markerX = px - markerSize / 2
      const markerY = Math.max(padT + 1, py - markerSize - 8)

      svg.appendChild(line(
        px,
        markerY + markerSize,
        px,
        Math.max(markerY + markerSize, py - 3),
        selected ? C.ink : 'rgba(0,0,0,0.38)',
        selected ? 1.4 : 1,
      ))

      const clip = document.createElementNS(NS, 'clipPath')
      clip.setAttribute('id', `media-profile-clip-${index}`)
      const clipRect = rect(markerX, markerY, markerSize, markerSize, '#ffffff')
      clipRect.setAttribute('rx', 2)
      clip.appendChild(clipRect)
      defs.appendChild(clip)

      const group = document.createElementNS(NS, 'g')
      group.classList.add('profile-media-marker')
      group.setAttribute('role', 'button')
      group.setAttribute('tabindex', '0')
      group.setAttribute(
        'aria-label',
        `Open ${item.type === 'video' ? 'video' : item.type === 'audio' ? 'audio' : 'photo'} from ${item.title}, mile ${fmtMi(item.mi)}`,
      )

      const frame = rect(markerX - 2, markerY - 2, markerSize + 4, markerSize + 4, C.paper)
      frame.setAttribute('rx', 3)
      frame.setAttribute('stroke', C.ink)
      frame.setAttribute('stroke-width', selected ? 1.8 : 1)
      const image = document.createElementNS(NS, 'image')
      image.setAttribute('href', item.thumbnailSrc || item.src)
      image.setAttribute('x', markerX)
      image.setAttribute('y', markerY)
      image.setAttribute('width', markerSize)
      image.setAttribute('height', markerSize)
      image.setAttribute('preserveAspectRatio', 'xMidYMid slice')
      image.setAttribute('clip-path', `url(#media-profile-clip-${index})`)
      group.append(frame, image)
      if (item.type === 'video' || item.type === 'audio') {
        const centerY = markerY + markerSize / 2
        const iconBackground = document.createElementNS(NS, 'circle')
        iconBackground.setAttribute('cx', px)
        iconBackground.setAttribute('cy', centerY)
        iconBackground.setAttribute('r', 5.5)
        iconBackground.setAttribute('fill', 'rgba(255,255,255,0.9)')
        iconBackground.setAttribute('stroke', C.ink)
        iconBackground.setAttribute('stroke-width', 0.8)
        group.appendChild(iconBackground)
        if (item.type === 'video') {
          const play = document.createElementNS(NS, 'polygon')
          play.setAttribute(
            'points',
            `${px - 1.7},${centerY - 3} ${px + 3},${centerY} ${px - 1.7},${centerY + 3}`,
          )
          play.setAttribute('fill', C.ink)
          group.appendChild(play)
        } else {
          for (const [dx, halfHeight] of [[-2.5, 2], [0, 3.5], [2.5, 1.5]]) {
            group.appendChild(line(px + dx, centerY - halfHeight, px + dx, centerY + halfHeight, C.ink, 1))
          }
        }
      }

      const activate = event => {
        event.preventDefault()
        event.stopPropagation()
        focusMedia(item.id, true)
      }
      group.addEventListener('pointerdown', event => event.stopPropagation())
      group.addEventListener('pointerup', event => event.stopPropagation())
      group.addEventListener('click', activate)
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') activate(event)
      })
      svg.appendChild(group)
      })
  }

  // sunset / sunrise hairlines with labels
  for (const ev of sunEvents()) {
    const px = x(ev.mi)
    svg.appendChild(line(px, padT, px, H - padB, 'rgba(0,0,0,0.3)', 1, '2 3'))
    svg.appendChild(text(px + 4, padT + 8, `${ev.icon} ${hhmm(ev.t)}`, 'start', 9.25, 'rgba(0,0,0,0.58)'))
  }

  // GPS position is projected onto the nearest course mile.
  if (userLocation) {
    const px = x(userLocation.mi)
    const py = y(activityPointAtMi(userLocation.mi).altitudeM * FT_PER_M)
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
    const px = x(hoverMi)
    const py = y(activityPointAtMi(hoverMi).altitudeM * FT_PER_M)
    svg.appendChild(line(px, padT, px, H - padB, 'rgba(0,0,0,0.25)', 1))
    const c = document.createElementNS(NS, 'circle')
    c.setAttribute('cx', px); c.setAttribute('cy', py); c.setAttribute('r', 3)
    c.setAttribute('fill', C.ink); c.setAttribute('stroke', '#ffffff'); c.setAttribute('stroke-width', 1.4)
    svg.appendChild(c)
    if (activeMetric) {
      const value = metricValueAtMi(activeMetric, hoverMi)
      if (Number.isFinite(value)) {
        const signalDot = document.createElementNS(NS, 'circle')
        signalDot.setAttribute('cx', px)
        signalDot.setAttribute(
          'cy',
          Math.min(H - padB, Math.max(padT, yMetric(value))),
        )
        signalDot.setAttribute('r', 3.2)
        signalDot.setAttribute('fill', activeDef.color)
        signalDot.setAttribute('stroke', C.paper)
        signalDot.setAttribute('stroke-width', 1.4)
        svg.appendChild(signalDot)
      }
    }
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

// Dark segments of the recorded activity, in verified activity miles.
function nightBands() {
  const bands = []
  const stepMi = activityTotalMi / 400
  let dark = isDark(activityClockAtMi(0))
  let bandStart = dark ? 0 : null
  for (let m = stepMi; m <= activityTotalMi; m += stepMi) {
    const d = isDark(activityClockAtMi(m))
    if (d && !dark) bandStart = m
    if (!d && dark) { bands.push([bandStart, m]); bandStart = null }
    dark = d
  }
  if (dark && bandStart != null) bands.push([bandStart, activityTotalMi])
  return bands
}
function isDark(t) {
  const s = sunTimes(t)
  return t < s.sunrise || t > s.sunset
}
// Sunset/sunrise crossings mapped onto the recorded timeline.
function sunEvents() {
  const out = []
  const stepMi = activityTotalMi / 600
  let prev = isDark(activityClockAtMi(0))
  for (let m = stepMi; m <= activityTotalMi; m += stepMi) {
    const t = activityClockAtMi(m)
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
      const p = activityPointAtMi(mi)
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
  const ranges = selectionRanges()
  src.setData({
    type: 'FeatureCollection',
    features: ranges.map(range => activitySliceFeature(range.a, range.b)),
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
    let time = `<b>${activityDuration(total.duration / 1000)}</b> <span class="dim">elapsed</span>`
    if (segments.length === 1) {
      const { from, to } = segments[0]
      time = `${hhmm(activityClockAtMi(from.mi))}→${hhmm(activityClockAtMi(to.mi))} ` +
        `<span class="dim">(${activityDuration(total.duration / 1000)})</span>`
    }
    el.innerHTML = statsColumns(imperial, time, metric)
  } else if (sel) {
    const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b)
    const s = activityStatsBetween(a, b)
    const t0 = s.startAt, t1 = s.finishAt
    const signalStats = activeMetric ? metricStatsBetween(activeMetric, a, b) : null
    const signal = signalStats
      ? ` <span class="signal" style="color:${METRIC_BY_KEY[activeMetric].color}">` +
        `<span class="dim">·</span> avg ${METRIC_BY_KEY[activeMetric].label} ` +
        `<b>${METRIC_BY_KEY[activeMetric].format(signalStats.avg)}</b></span>`
      : ''
    const imperial =
      `mi ${fmtMi(a)}–${fmtMi(b)} <span class="dim">·</span> <b>${s.mi.toFixed(1)} mi</b> ` +
      `<span class="dim">·</span> <b>+${fmtFt(s.gain)} ft</b> ` +
      `<span class="dim">/ −${fmtFt(s.loss)} ft</span>${signal}`
    const time =
      `${hhmm(t0)}→${hhmm(t1)} <span class="dim">(${activityDuration(s.elapsedS)} elapsed)</span>`
    const metric =
      `km ${fmtKm(a)}–${fmtKm(b)} <span class="dim">·</span> <b>${fmtKm(s.mi)} km</b> ` +
      `<span class="dim">·</span> <b>+${fmtM(s.gain)} m</b> <span class="dim">/ −${fmtM(s.loss)} m</span>`
    el.innerHTML = statsColumns(imperial, time, metric)
  } else if (hoverMi != null) {
    const p = activityPointAtMi(hoverMi)
    const g = activityGradeAt(hoverMi)
    const t = activityClockAtMi(hoverMi)
    const grade = `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`
    const signalValue = activeMetric ? metricValueAtMi(activeMetric, hoverMi) : null
    const signal = Number.isFinite(signalValue)
      ? ` <span class="signal" style="color:${METRIC_BY_KEY[activeMetric].color}">` +
        `<span class="dim">·</span> ${METRIC_BY_KEY[activeMetric].label} ` +
        `<b>${METRIC_BY_KEY[activeMetric].format(signalValue)}</b></span>`
      : ''
    const imperial =
      `mile <b>${fmtMi(hoverMi)}</b> <span class="dim">·</span> ${fmtFt(p.altitudeM * FT_PER_M)} ft ` +
      `<span class="dim">·</span> ${grade}${signal}`
    const metric =
      `km <b>${fmtKm(hoverMi)}</b> <span class="dim">·</span> ${Math.round(p.altitudeM)} m ` +
      `<span class="dim">·</span> ${grade}`
    el.innerHTML = statsColumns(
      imperial,
      `${hhmm(t)} <span class="dim">· ${activityDuration(p.elapsedS)} elapsed</span>`,
      metric,
    )
  } else {
    const minFt = activitySummary.minAltitudeM * FT_PER_M
    const maxFt = activitySummary.maxAltitudeM * FT_PER_M
    const gainFt = activitySummary.elevationGainM * FT_PER_M
    const imperial =
      `<b>${activityTotalMi.toFixed(2)} mi</b> <span class="dim">·</span> <b>+${fmtFt(gainFt)} ft</b> ` +
      `<span class="dim">·</span> ${fmtFt(minFt)}–${fmtFt(maxFt)} ft`
    const metric =
      `<b>${(activitySummary.distanceM / 1000).toFixed(2)} km</b> <span class="dim">·</span> ` +
      `<b>+${Math.round(activitySummary.elevationGainM).toLocaleString()} m</b> <span class="dim">·</span> ` +
      `${Math.round(activitySummary.minAltitudeM)}–${Math.round(activitySummary.maxAltitudeM)} m`
    el.innerHTML = statsColumns(
      imperial,
      `${hhmm(new Date(activityStartMs))}→${hhmm(new Date(activityFinishMs))} ` +
        `<span class="dim">(${activityDuration(activitySummary.elapsedS)})</span>`,
      metric,
    )
  }
}

new ResizeObserver(() => renderProfile()).observe(chart)

// ---------------------------------------------------------------- boot
renderList()
renderProfile()
