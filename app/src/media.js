import { createClient } from '@supabase/supabase-js'

export const MEDIA_EVENT_ID = 'homedred-2026'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseKey = (
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY
)?.trim()

export const mediaConfigured = Boolean(supabaseUrl && supabaseKey)

export const mediaClient = mediaConfigured
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null

export async function ensureMediaSession() {
  if (!mediaClient) throw new Error('Media archive is not configured')
  const { data: sessionData, error: sessionError } = await mediaClient.auth.getSession()
  if (sessionError) throw sessionError
  if (sessionData.session) return sessionData.session

  const { data, error } = await mediaClient.auth.signInAnonymously()
  if (error) throw error
  if (!data.session) throw new Error('Could not start an upload session')
  return data.session
}

export function mediaPublicUrl(storagePath) {
  if (!mediaClient || !storagePath) return ''
  return mediaClient.storage.from('media').getPublicUrl(storagePath).data.publicUrl
}

export async function fetchPublishedMedia() {
  if (!mediaClient) return []
  const { data, error } = await mediaClient
    .from('media_items')
    .select('*')
    .eq('event_id', MEDIA_EVENT_ID)
    .eq('status', 'ready')
    .order('captured_at', { ascending: false })
  if (error) throw error
  return data.map(item => ({ ...item, url: mediaPublicUrl(item.storage_path) }))
}

export async function uploadCapture(capture) {
  if (!navigator.onLine) throw new Error('Offline')
  const session = await ensureMediaSession()
  const userId = session.user.id

  const { data: event, error: eventError } = await mediaClient
    .from('media_events')
    .select('uploads_enabled')
    .eq('id', MEDIA_EVENT_ID)
    .single()
  if (eventError) throw eventError
  if (!event.uploads_enabled) throw new Error('Uploads are closed for this event')

  const storagePath = `${userId}/${MEDIA_EVENT_ID}/${capture.id}.${capture.extension}`
  const { error: uploadError } = await mediaClient.storage
    .from('media')
    .upload(storagePath, capture.blob, {
      contentType: capture.mimeType,
      cacheControl: '31536000',
      upsert: true,
    })
  if (uploadError) throw uploadError

  const location = capture.location
  const { error: recordError } = await mediaClient
    .from('media_items')
    .upsert({
      id: capture.id,
      event_id: MEDIA_EVENT_ID,
      uploader_id: userId,
      contributor_name: capture.contributorName,
      media_type: capture.mediaType,
      storage_path: storagePath,
      mime_type: capture.mimeType,
      file_size: capture.blob.size,
      duration_ms: capture.durationMs,
      captured_at: capture.capturedAt,
      device_time_zone: capture.deviceTimeZone,
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy_m: location.accuracy,
      altitude_m: location.altitude,
      heading_deg: location.heading,
      nearest_mile: capture.nearestMile,
      route_offset_m: capture.routeOffsetM,
      width: capture.width,
      height: capture.height,
      sha256: capture.sha256,
      caption: capture.caption || null,
      status: 'ready',
    }, { onConflict: 'id' })
  if (recordError) throw recordError

  return { storagePath, url: mediaPublicUrl(storagePath) }
}
