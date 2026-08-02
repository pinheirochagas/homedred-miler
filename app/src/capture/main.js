import { strToU8, zip } from 'fflate'
import { registerSW } from 'virtual:pwa-register'
import { course, dist, lat, lon } from '../data.js'
import {
  MEDIA_EVENT_ID,
  mediaConfigured,
  uploadCapture,
} from '../media.js'
import {
  clearUploadedCaptures,
  getCaptures,
  putCapture,
  updateCapture,
} from './db.js'
import './style.css'

const $ = selector => document.querySelector(selector)
const NAME_KEY = 'homedred-media-contributor'
const MAX_BYTES = {
  photo: 8 * 1024 * 1024,
  video: 35 * 1024 * 1024,
  audio: 15 * 1024 * 1024,
}
const RECORDING_LIMIT_MS = { video: 10000, audio: 120000 }
const CAMERA_SIZE_CONSTRAINTS = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
}

let contributorName = localStorage.getItem(NAME_KEY)?.trim() || ''
let locationWatchId = null
let latestLocation = null
let activeRecording = null
let syncRunning = false
let previewUrls = []
let toastTimer = null
let preferredFacingMode = 'environment'

const captureParams = new URLSearchParams(location.search)
const embeddedMode = captureParams.get('embedded') === '1'
const compactMode = captureParams.get('compact') === '1'
document.body.classList.toggle('embedded', embeddedMode)
document.body.classList.toggle('compact', compactMode)

function showToast(message, duration = 3200) {
  const toast = $('#toast')
  clearTimeout(toastTimer)
  toast.textContent = message
  toast.hidden = false
  toastTimer = setTimeout(() => { toast.hidden = true }, duration)
}

function hideToast() {
  clearTimeout(toastTimer)
  const toast = $('#toast')
  toast.hidden = true
  toast.textContent = ''
}

function updateNetworkState() {
  const state = $('#network-state')
  const online = navigator.onLine
  state.textContent = online ? 'online' : 'offline · saving locally'
  state.className = `network-state ${online ? 'online' : 'offline'}`
}

const radians = degrees => degrees * Math.PI / 180

function geoDistance(aLat, aLon, bLat, bLon) {
  const dLat = radians(bLat - aLat)
  const dLon = radians(bLon - aLon)
  const q = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLon / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(q))
}

function projectToCourse(location) {
  let bestIndex = 0
  let bestDistance = Infinity
  for (let i = 0; i < course.n; i += 1) {
    const meters = geoDistance(location.latitude, location.longitude, lat(i), lon(i))
    if (meters < bestDistance) {
      bestIndex = i
      bestDistance = meters
    }
  }
  return { nearestMile: dist(bestIndex), routeOffsetM: bestDistance }
}

function normalizePosition(position) {
  const coords = position.coords
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
    altitude: Number.isFinite(coords.altitude) ? coords.altitude : null,
    heading: Number.isFinite(coords.heading) ? coords.heading : null,
    timestamp: position.timestamp || Date.now(),
  }
}

function setCaptureEnabled(enabled) {
  for (const button of document.querySelectorAll('.capture-action')) {
    button.disabled = !enabled
  }
}

function showLocation(location) {
  latestLocation = location
  const projected = projectToCourse(location)
  const accuracy = location.accuracy == null ? 'GPS fix' : `GPS ±${Math.round(location.accuracy)} m`
  $('#location-title').textContent = `${accuracy} · near mile ${projected.nearestMile.toFixed(1)}`
  $('#location-detail').textContent = 'Precise coordinates and device time will be attached to every capture.'
  $('#location-dot').className = 'location-dot ready'
  setCaptureEnabled(true)
}

function showLocationError(error) {
  const messages = {
    1: 'Location permission is required. Enable Precise Location for this site in Settings.',
    2: 'A GPS position is not available yet. Move outdoors and try again.',
    3: 'The GPS request timed out. Keep this screen open and try again.',
  }
  $('#location-title').textContent = 'Location required'
  $('#location-detail').textContent = messages[error?.code] || error?.message || 'Could not read this device location.'
  $('#location-dot').className = 'location-dot error'
  setCaptureEnabled(false)
}

function startLocationWatch() {
  if (locationWatchId != null || !navigator.geolocation) {
    if (!navigator.geolocation) showLocationError(new Error('This browser does not provide GPS access.'))
    return
  }
  locationWatchId = navigator.geolocation.watchPosition(
    position => showLocation(normalizePosition(position)),
    showLocationError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  )
}

function getFreshLocation() {
  if (latestLocation && Date.now() - latestLocation.timestamp < 30000) {
    return Promise.resolve({ ...latestLocation })
  }
  if (!navigator.geolocation) return Promise.reject(new Error('GPS is unavailable'))
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      position => {
        const location = normalizePosition(position)
        showLocation(location)
        resolve(location)
      },
      error => {
        if (latestLocation && Date.now() - latestLocation.timestamp < 120000) {
          resolve({ ...latestLocation })
        }
        else reject(error)
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    )
  })
}

function showCaptureApp() {
  $('#setup').hidden = true
  $('#capture-app').hidden = false
  const firstName = contributorName.split(/\s+/)[0]
  $('#hello').textContent = firstName ? `${firstName}, capture the day.` : 'Capture the day.'
  startLocationWatch()
  navigator.storage?.persist?.().catch(() => {})
}

function showNameSetup() {
  $('#capture-app').hidden = true
  $('#setup').hidden = false
  $('#contributor-name').value = contributorName
  $('#contributor-name').focus()
}

function baseMime(mimeType) {
  return (mimeType || '').split(';')[0].trim().toLowerCase()
}

function extensionFor(mimeType, mediaType) {
  const known = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  }
  return known[mimeType] || { photo: 'jpg', video: 'mp4', audio: 'm4a' }[mediaType]
}

async function sha256(blob) {
  if (!crypto.subtle) return null
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function saveCapture(blob, mediaType, location, metadata = {}) {
  const mimeType = baseMime(metadata.mimeType || blob.type)
  if (!mimeType) throw new Error('The captured file has no media type')
  if (blob.size > MAX_BYTES[mediaType]) {
    throw new Error(`${mediaType} is too large to save (${Math.ceil(blob.size / 1024 / 1024)} MB)`)
  }

  const projected = projectToCourse(location)
  const id = crypto.randomUUID()
  const capture = {
    id,
    eventId: MEDIA_EVENT_ID,
    contributorName,
    mediaType,
    blob,
    mimeType,
    extension: extensionFor(mimeType, mediaType),
    durationMs: metadata.durationMs ?? null,
    capturedAt: metadata.capturedAt || new Date().toISOString(),
    deviceTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    location,
    nearestMile: projected.nearestMile,
    routeOffsetM: projected.routeOffsetM,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    sha256: await sha256(blob),
    caption: null,
    status: 'pending',
    attempts: 0,
    error: null,
    storagePath: null,
  }

  await putCapture(capture)
  await renderQueue()
  hideToast()
  if (navigator.onLine && mediaConfigured) await syncOne(id)
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('This photo format could not be opened'))
    }
    image.src = url
  })
}

function canvasBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
}

async function preparePhoto(file) {
  const fileMime = baseMime(file.type)
  let image
  try {
    image = await loadImage(file)
  } catch (error) {
    if (
      file.size <= MAX_BYTES.photo
      && (fileMime === 'image/heic' || fileMime === 'image/heif')
    ) {
      return { blob: file, mimeType: fileMime, width: null, height: null }
    }
    throw error
  }
  const width = image.naturalWidth
  const height = image.naturalHeight
  const needsConversion = file.size > MAX_BYTES.photo
    || fileMime === 'image/heic'
    || fileMime === 'image/heif'

  if (!needsConversion) {
    return { blob: file, mimeType: fileMime, width, height }
  }

  const scale = Math.min(1, 2560 / Math.max(width, height))
  const outputWidth = Math.max(1, Math.round(width * scale))
  const outputHeight = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight
  canvas.getContext('2d').drawImage(image, 0, 0, outputWidth, outputHeight)

  let blob = await canvasBlob(canvas, 0.84)
  if (blob?.size > MAX_BYTES.photo) blob = await canvasBlob(canvas, 0.68)
  if (!blob) throw new Error('The photo could not be prepared')
  return { blob, mimeType: 'image/jpeg', width: outputWidth, height: outputHeight }
}

function readVideoMetadata(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve({
        durationMs: Math.round(video.duration * 1000),
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      })
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('This video could not be opened'))
    }
    video.src = url
  })
}

function supportedRecorderMime(mediaType) {
  const candidates = mediaType === 'video'
    ? ['video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
  return candidates.find(type => MediaRecorder.isTypeSupported?.(type)) || ''
}

function cameraConstraints(facingMode = preferredFacingMode, exact = false) {
  return {
    ...CAMERA_SIZE_CONSTRAINTS,
    facingMode: exact ? { exact: facingMode } : { ideal: facingMode },
  }
}

function updateCameraSwitch(recording = activeRecording) {
  const button = $('#switch-camera')
  const cameraReady = recording
    && (recording.mediaType === 'photo' || recording.mediaType === 'video')
    && !recording.recorder
  button.hidden = !cameraReady
  if (!cameraReady) return

  const front = recording.facingMode === 'user'
  button.textContent = front ? 'back camera' : 'front camera'
  button.setAttribute('aria-label', front ? 'Switch to back camera' : 'Switch to front camera for a selfie')
  $('#camera-preview').classList.toggle('selfie-preview', front)
}

function setRecorderVisible(mediaType, visible) {
  const photo = mediaType === 'photo'
  $('#recorder').hidden = !visible
  $('#recorder').classList.toggle('photo-mode', visible && photo)
  $('#camera-preview').hidden = !visible || (mediaType !== 'photo' && mediaType !== 'video')
  $('#audio-visual').hidden = !visible || mediaType !== 'audio'
  $('#recorder-time').hidden = visible && photo
  $('#stop-recording').textContent = photo ? 'take photo' : 'stop and save'
  $('#stop-recording').disabled = false
  $('#switch-camera').hidden = !visible || (mediaType !== 'photo' && mediaType !== 'video')
  if (!visible) {
    $('#camera-preview').srcObject = null
    $('#camera-preview').classList.remove('selfie-preview')
    $('#recorder-time').textContent = '00:00'
    $('#recorder-time').hidden = false
  }
}

function updateRecorderClock() {
  if (!activeRecording) return
  const elapsed = Math.min(Date.now() - activeRecording.startedAt, activeRecording.limitMs)
  const seconds = Math.floor(elapsed / 1000)
  $('#recorder-time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function closeRecording(recording) {
  clearInterval(recording.clock)
  clearTimeout(recording.timeout)
  for (const track of recording.stream.getTracks()) track.stop()
  setRecorderVisible(recording.mediaType, false)
  activeRecording = null
  setCaptureEnabled(Boolean(latestLocation))
}

async function finishRecording(recording) {
  closeRecording(recording)
  if (recording.cancelled) return

  const mimeType = baseMime(recording.recorder.mimeType || recording.chunks[0]?.type)
  const blob = new Blob(recording.chunks, { type: mimeType })
  const durationMs = Math.max(1, Math.min(Date.now() - recording.startedAt, recording.limitMs))
  if (!blob.size) {
    showToast('Nothing was recorded')
    return
  }

  try {
    await saveCapture(blob, recording.mediaType, recording.location, {
      mimeType,
      durationMs,
      capturedAt: new Date(recording.startedAt).toISOString(),
      width: recording.width,
      height: recording.height,
    })
  } catch (error) {
    showToast(error.message, 5000)
  }
}

async function captureLivePhoto(recording) {
  if (recording.capturing) return
  recording.capturing = true
  $('#stop-recording').disabled = true
  $('#stop-recording').textContent = 'saving…'

  try {
    const preview = $('#camera-preview')
    const sourceWidth = preview.videoWidth || recording.width
    const sourceHeight = preview.videoHeight || recording.height
    if (!sourceWidth || !sourceHeight) throw new Error('The camera is not ready yet')

    const scale = Math.min(1, 2560 / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').drawImage(preview, 0, 0, width, height)
    const blob = await canvasBlob(canvas, 0.88)
    if (!blob) throw new Error('The photo could not be saved')

    closeRecording(recording)
    await saveCapture(blob, 'photo', recording.location, {
      mimeType: 'image/jpeg',
      capturedAt: new Date().toISOString(),
      width,
      height,
    })
  } catch (error) {
    if (activeRecording === recording) {
      recording.capturing = false
      $('#stop-recording').disabled = false
      $('#stop-recording').textContent = 'take photo'
    }
    showToast(error.message || 'Photo could not be saved', 5000)
  }
}

async function requestFacingCamera(facingMode) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: cameraConstraints(facingMode, true),
      audio: false,
    })
  } catch (error) {
    if (error.name === 'NotAllowedError') throw error
    return navigator.mediaDevices.getUserMedia({
      video: cameraConstraints(facingMode),
      audio: false,
    })
  }
}

async function replaceCameraStream(recording, facingMode) {
  const preview = $('#camera-preview')
  const audioTracks = recording.stream.getAudioTracks()
  for (const track of recording.stream.getVideoTracks()) track.stop()
  preview.srcObject = null

  const cameraStream = await requestFacingCamera(facingMode)
  if (activeRecording !== recording) {
    for (const track of cameraStream.getTracks()) track.stop()
    throw new DOMException('Camera switch cancelled', 'AbortError')
  }
  const videoTracks = cameraStream.getVideoTracks()
  const nextStream = new MediaStream([...videoTracks, ...audioTracks])
  const settings = videoTracks[0]?.getSettings() || {}
  recording.stream = nextStream
  recording.width = settings.width || null
  recording.height = settings.height || null
  recording.facingMode = settings.facingMode || facingMode
  preview.srcObject = nextStream
  await preview.play()
}

async function switchCamera() {
  const recording = activeRecording
  if (
    !recording
    || (recording.mediaType !== 'photo' && recording.mediaType !== 'video')
    || recording.recorder
    || recording.capturing
    || recording.switchingCamera
  ) return

  const previousFacingMode = recording.facingMode || preferredFacingMode
  const nextFacingMode = previousFacingMode === 'user' ? 'environment' : 'user'
  const button = $('#switch-camera')
  recording.switchingCamera = true
  button.disabled = true
  button.textContent = 'switching…'

  try {
    await replaceCameraStream(recording, nextFacingMode)
    preferredFacingMode = recording.facingMode
  } catch (error) {
    if (activeRecording !== recording) return
    try {
      await replaceCameraStream(recording, previousFacingMode)
    } catch {
      closeRecording(recording)
    }
    showToast(error.message || 'The other camera is unavailable.', 5000)
  } finally {
    if (activeRecording === recording) {
      recording.switchingCamera = false
      button.disabled = false
      updateCameraSwitch(recording)
    }
  }
}

async function startPhotoCamera() {
  if (activeRecording) return
  if (!navigator.mediaDevices?.getUserMedia) {
    $('#photo-input').value = ''
    $('#photo-input').click()
    return
  }

  let stream = null
  let recording = null
  try {
    const location = await getFreshLocation()
    stream = await navigator.mediaDevices.getUserMedia({
      video: cameraConstraints(),
      audio: false,
    })
    const settings = stream.getVideoTracks()[0]?.getSettings() || {}
    recording = {
      mediaType: 'photo',
      location,
      stream,
      recorder: null,
      startedAt: Date.now(),
      width: settings.width || null,
      height: settings.height || null,
      facingMode: settings.facingMode || preferredFacingMode,
      cancelled: false,
      capturing: false,
      switchingCamera: false,
      clock: null,
      timeout: null,
    }
    activeRecording = recording
    preferredFacingMode = recording.facingMode

    $('#recorder-label').textContent = 'Photo · live camera'
    setRecorderVisible('photo', true)
    setCaptureEnabled(false)
    $('#camera-preview').srcObject = stream
    await $('#camera-preview').play()
    updateCameraSwitch(recording)
  } catch (error) {
    if (recording) closeRecording(recording)
    else for (const track of stream?.getTracks?.() || []) track.stop()
    showToast(
      error.name === 'NotAllowedError'
        ? 'Allow Camera access to take a photo here.'
        : error.message || 'The camera could not open.',
      5000,
    )
  }
}

async function startVideoCamera() {
  if (activeRecording) return
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    $('#video-input').value = ''
    $('#video-input').click()
    return
  }

  let stream = null
  let recording = null
  try {
    const location = await getFreshLocation()
    stream = await navigator.mediaDevices.getUserMedia({
      video: cameraConstraints(),
      audio: true,
    })
    const settings = stream.getVideoTracks()[0]?.getSettings() || {}
    recording = {
      mediaType: 'video',
      location,
      stream,
      recorder: null,
      chunks: [],
      startedAt: null,
      limitMs: RECORDING_LIMIT_MS.video,
      width: settings.width || null,
      height: settings.height || null,
      facingMode: settings.facingMode || preferredFacingMode,
      cancelled: false,
      capturing: false,
      switchingCamera: false,
      clock: null,
      timeout: null,
    }
    activeRecording = recording
    preferredFacingMode = recording.facingMode

    $('#recorder-label').textContent = 'Video · ready'
    setRecorderVisible('video', true)
    setCaptureEnabled(false)
    $('#stop-recording').textContent = 'start recording'
    $('#camera-preview').srcObject = stream
    await $('#camera-preview').play()
    updateCameraSwitch(recording)
  } catch (error) {
    if (recording) closeRecording(recording)
    else for (const track of stream?.getTracks?.() || []) track.stop()
    showToast(
      error.name === 'NotAllowedError'
        ? 'Allow Camera and Microphone access to record here.'
        : error.message || 'The camera could not open.',
      5000,
    )
  }
}

function beginVideoRecording(recording) {
  if (activeRecording !== recording || recording.mediaType !== 'video' || recording.recorder) return

  try {
    const mimeType = supportedRecorderMime('video')
    const recorder = mimeType ? new MediaRecorder(recording.stream, { mimeType }) : new MediaRecorder(recording.stream)
    recording.recorder = recorder
    recording.chunks = []
    recording.startedAt = Date.now()

    recorder.ondataavailable = event => {
      if (event.data?.size) recording.chunks.push(event.data)
    }
    recorder.onerror = event => {
      recording.cancelled = true
      showToast(event.error?.message || 'Recording failed', 5000)
      if (recorder.state !== 'inactive') recorder.stop()
    }
    recorder.onstop = () => finishRecording(recording)

    $('#recorder-label').textContent = 'Recording video'
    $('#stop-recording').textContent = 'stop and save'
    $('#switch-camera').hidden = true
    recorder.start()
    recording.clock = setInterval(updateRecorderClock, 250)
    recording.timeout = setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop()
    }, recording.limitMs)
  } catch (error) {
    recording.recorder = null
    recording.startedAt = null
    $('#stop-recording').textContent = 'start recording'
    updateCameraSwitch(recording)
    showToast(error.message || 'Video recording could not start.', 5000)
  }
}

async function startRecording(mediaType) {
  if (mediaType === 'video') {
    await startVideoCamera()
    return
  }
  if (activeRecording) return
  let stream = null
  let recording = null
  try {
    const location = await getFreshLocation()
    stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true })
    const mimeType = supportedRecorderMime(mediaType)
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    const trackSettings = stream.getVideoTracks()[0]?.getSettings() || {}
    recording = {
      mediaType,
      location,
      stream,
      recorder,
      chunks: [],
      startedAt: Date.now(),
      limitMs: RECORDING_LIMIT_MS[mediaType],
      width: trackSettings.width || null,
      height: trackSettings.height || null,
      cancelled: false,
      clock: null,
      timeout: null,
    }
    activeRecording = recording

    recorder.ondataavailable = event => {
      if (event.data?.size) recording.chunks.push(event.data)
    }
    recorder.onerror = event => {
      recording.cancelled = true
      showToast(event.error?.message || 'Recording failed', 5000)
      if (recorder.state !== 'inactive') recorder.stop()
    }
    recorder.onstop = () => finishRecording(recording)

    $('#recorder-label').textContent = 'Recording voice memo'
    setRecorderVisible(mediaType, true)
    setCaptureEnabled(false)
    recorder.start()
    recording.clock = setInterval(updateRecorderClock, 250)
    recording.timeout = setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop()
    }, recording.limitMs)
  } catch (error) {
    if (recording) {
      recording.cancelled = true
      closeRecording(recording)
    } else {
      for (const track of stream?.getTracks?.() || []) track.stop()
    }
    const permission = 'Microphone'
    showToast(
      error.name === 'NotAllowedError'
        ? `Allow ${permission} access to record here.`
        : error.message || `${permission} access is required.`,
      5000,
    )
  }
}

function stopRecording(cancelled = false) {
  if (!activeRecording) return
  if (activeRecording.mediaType === 'photo') {
    if (cancelled) closeRecording(activeRecording)
    else captureLivePhoto(activeRecording)
    return
  }
  if (activeRecording.mediaType === 'video' && !activeRecording.recorder) {
    if (cancelled) closeRecording(activeRecording)
    else beginVideoRecording(activeRecording)
    return
  }
  activeRecording.cancelled = cancelled
  if (activeRecording.recorder.state !== 'inactive') activeRecording.recorder.stop()
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function captureLabel(capture) {
  return { photo: 'Photo', video: 'Video', audio: 'Voice memo' }[capture.mediaType]
}

async function renderQueue() {
  for (const url of previewUrls) URL.revokeObjectURL(url)
  previewUrls = []

  const captures = await getCaptures()
  const pending = captures.filter(capture => capture.status !== 'uploaded').length
  const list = $('#capture-list')
  list.replaceChildren()
  $('#queue-count').textContent = `${captures.length} ${captures.length === 1 ? 'item' : 'items'}`
  $('#compact-queue-label').textContent = pending
    ? `${pending} pending`
    : captures.length ? 'all synced' : 'queue empty'
  $('#empty-queue').hidden = captures.length > 0
  $('#clear-uploaded').disabled = !captures.some(capture => capture.status === 'uploaded')

  for (const capture of captures) {
    const item = document.createElement('li')
    item.className = 'capture-item'

    let thumb
    if (capture.mediaType === 'photo') {
      const url = URL.createObjectURL(capture.blob)
      previewUrls.push(url)
      thumb = document.createElement('img')
      thumb.src = url
      thumb.alt = ''
    } else {
      thumb = document.createElement('span')
      thumb.textContent = capture.mediaType === 'video' ? 'VIDEO' : 'AUDIO'
    }
    thumb.className = 'capture-thumb'

    const detail = document.createElement('span')
    const title = document.createElement('b')
    title.textContent = captureLabel(capture)
    const metadata = document.createElement('small')
    const when = new Date(capture.capturedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const route = Number.isFinite(capture.nearestMile) ? `mile ${capture.nearestMile.toFixed(1)}` : 'off course'
    metadata.textContent = `${when} · ${route} · ${formatBytes(capture.blob.size)}`
    detail.append(title, metadata)
    if (capture.error) {
      const error = document.createElement('small')
      error.textContent = capture.error
      detail.append(error)
    }

    const status = document.createElement('button')
    status.type = 'button'
    status.className = `capture-status ${capture.status}`
    status.textContent = capture.status === 'failed' ? 'retry' : capture.status
    status.disabled = capture.status === 'uploaded' || capture.status === 'uploading'
    status.addEventListener('click', () => syncOne(capture.id))

    item.append(thumb, detail, status)
    list.append(item)
  }
}

function cleanUploadError(error) {
  const message = error?.message || 'Upload failed'
  if (/offline|network|fetch/i.test(message)) return 'Waiting for internet'
  return message.slice(0, 140)
}

async function syncOne(id) {
  if (!mediaConfigured) {
    showToast('Supabase sync is not configured yet', 5000)
    return false
  }
  if (!navigator.onLine) {
    showToast('Saved locally. Sync will resume when internet returns.')
    return false
  }

  const capture = (await getCaptures()).find(item => item.id === id)
  if (!capture || capture.status === 'uploaded') return true
  await updateCapture(id, {
    status: 'uploading',
    attempts: (capture.attempts || 0) + 1,
    error: null,
  })
  await renderQueue()

  try {
    const uploaded = await uploadCapture(capture)
    await updateCapture(id, {
      status: 'uploaded',
      storagePath: uploaded.storagePath,
      error: null,
    })
    await renderQueue()
    return true
  } catch (error) {
    await updateCapture(id, { status: 'failed', error: cleanUploadError(error) })
    await renderQueue()
    return false
  }
}

async function syncAll() {
  if (syncRunning) return
  if (!mediaConfigured) {
    showToast('Captures are safe locally; remote sync is not configured yet.', 5000)
    return
  }
  if (!navigator.onLine) {
    showToast('Offline. Captures remain safe on this device.')
    return
  }

  syncRunning = true
  $('#sync-all').disabled = true
  const captures = await getCaptures()
  const waiting = captures.filter(capture => capture.status !== 'uploaded')
  let uploaded = 0
  for (const capture of waiting) {
    if (!navigator.onLine) break
    if (await syncOne(capture.id)) uploaded += 1
  }
  syncRunning = false
  $('#sync-all').disabled = false
  if (uploaded) showToast(`${uploaded} ${uploaded === 1 ? 'capture' : 'captures'} uploaded`)
}

function zipFiles(files) {
  return new Promise((resolve, reject) => {
    zip(files, { level: 0 }, (error, data) => {
      if (error) reject(error)
      else resolve(data)
    })
  })
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

async function exportBackup() {
  const captures = await getCaptures()
  if (!captures.length) {
    showToast('There is nothing to export yet')
    return
  }
  const totalBytes = captures.reduce((sum, capture) => sum + capture.blob.size, 0)
  if (totalBytes > 250 * 1024 * 1024) {
    showToast('This backup is over 250 MB. Clear uploaded captures or export from a computer.', 6000)
    return
  }

  $('#export-all').disabled = true
  showToast('Preparing backup…', 60000)
  try {
    const files = {}
    const manifest = []
    for (const capture of captures) {
      const stamp = capture.capturedAt.replace(/[:.]/g, '-')
      const fileName = `media/${stamp}-${capture.id.slice(0, 8)}.${capture.extension}`
      files[fileName] = new Uint8Array(await capture.blob.arrayBuffer())
      const { blob, ...metadata } = capture
      manifest.push({ ...metadata, fileName, fileSize: blob.size })
    }
    files['manifest.json'] = strToU8(JSON.stringify({
      eventId: MEDIA_EVENT_ID,
      exportedAt: new Date().toISOString(),
      contributorName,
      captures: manifest,
    }, null, 2))
    const archive = await zipFiles(files)
    const date = new Date().toISOString().slice(0, 10)
    downloadBlob(new Blob([archive], { type: 'application/zip' }), `homedred-media-${date}.zip`)
    showToast('Backup ready')
  } catch (error) {
    showToast(error.message || 'Backup could not be created', 5000)
  } finally {
    $('#export-all').disabled = false
  }
}

function setCompactQueueOpen(open) {
  document.body.classList.toggle('queue-open', open)
  $('#compact-queue-toggle').setAttribute('aria-expanded', String(open))
  $('#compact-queue-action').textContent = open ? 'back to recorder' : 'view queue'
}

$('#name-form').addEventListener('submit', event => {
  event.preventDefault()
  contributorName = $('#contributor-name').value.trim()
  if (!contributorName) return
  localStorage.setItem(NAME_KEY, contributorName)
  showCaptureApp()
})

$('#change-name').addEventListener('click', showNameSetup)
$('#take-photo').addEventListener('click', startPhotoCamera)
$('#record-video').addEventListener('click', () => startRecording('video'))
$('#record-audio').addEventListener('click', () => startRecording('audio'))
$('#switch-camera').addEventListener('click', switchCamera)
$('#stop-recording').addEventListener('click', () => stopRecording(false))
$('#cancel-recording').addEventListener('click', () => stopRecording(true))
$('#sync-all').addEventListener('click', syncAll)
$('#compact-sync').addEventListener('click', syncAll)
$('#compact-queue-toggle').addEventListener('click', () => {
  setCompactQueueOpen(!document.body.classList.contains('queue-open'))
})
$('#export-all').addEventListener('click', exportBackup)
$('#clear-uploaded').addEventListener('click', async () => {
  if (!confirm('Remove uploaded copies from this device? They will remain in the shared archive.')) return
  await clearUploadedCaptures()
  await renderQueue()
  showToast('Uploaded device copies cleared')
})

$('#photo-input').addEventListener('change', async event => {
  const file = event.target.files?.[0]
  if (!file) return
  showToast('Preparing photo…', 60000)
  try {
    const [location, prepared] = await Promise.all([getFreshLocation(), preparePhoto(file)])
    await saveCapture(prepared.blob, 'photo', location, {
      mimeType: prepared.mimeType,
      width: prepared.width,
      height: prepared.height,
      capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
    })
  } catch (error) {
    showToast(error.message || 'Photo could not be saved', 5000)
  }
})

$('#video-input').addEventListener('change', async event => {
  const file = event.target.files?.[0]
  if (!file) return
  showToast('Checking video…', 60000)
  try {
    const [location, metadata] = await Promise.all([getFreshLocation(), readVideoMetadata(file)])
    if (!Number.isFinite(metadata.durationMs) || metadata.durationMs > 11000) {
      throw new Error('Video must be 10 seconds or shorter')
    }
    await saveCapture(file, 'video', location, {
      ...metadata,
      mimeType: baseMime(file.type) || 'video/quicktime',
      capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
    })
  } catch (error) {
    showToast(error.message || 'Video could not be saved', 5000)
  }
})

window.addEventListener('online', () => {
  updateNetworkState()
  syncAll()
})
window.addEventListener('offline', updateNetworkState)
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.data?.type !== 'homedred:capture-close') return
  stopRecording(true)
  setCompactQueueOpen(false)
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && navigator.onLine) syncAll()
})
window.addEventListener('beforeunload', event => {
  if (!activeRecording) return
  event.preventDefault()
})

registerSW({
  immediate: true,
  onOfflineReady: () => showToast('Capture app is ready offline'),
})

updateNetworkState()
if (compactMode) $('#compact-queue-bar').hidden = false
renderQueue()
if (!mediaConfigured) {
  $('#capture-help').textContent = 'Captures save on this phone and can be exported. Remote sync still needs its deployment keys.'
}
if (contributorName) showCaptureApp()
else showNameSetup()
if (navigator.onLine && contributorName) syncAll()
