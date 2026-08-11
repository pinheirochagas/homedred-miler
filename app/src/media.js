import manifest from './media-manifest.json?v=20260810-actual-activity-4'

const assets = import.meta.glob('./assets/media/*', {
  eager: true,
  query: '?url',
  import: 'default',
})

function assetUrl(path) {
  const url = assets[`./${path}`]
  if (!url) throw new Error(`Missing generated media asset: ${path}`)
  return url
}

const retrospectiveTitle = title =>
  title?.replace(/\s*·\s*mile\s+\d+(?:\.\d+)?\s*$/i, '') || 'Activity media'
const retrospectiveAlt = alt =>
  alt?.replace(/\s+near planned-route mile\s+\d+(?:\.\d+)?\.?$/i, '.') || ''

export const mediaItems = manifest
  .filter(item => item.status === 'resolved')
  .map(item => ({
    id: item.id,
    type: item.type,
    src: assetUrl(item.outputs.src),
    thumbnailSrc: assetUrl(item.outputs.thumbnailSrc),
    mimeType: item.mimeType,
    title: retrospectiveTitle(item.title),
    alt: retrospectiveAlt(item.alt),
    creator: item.creator,
    capturedAt: item.capturedAt,
    lat: item.lat,
    lon: item.lon,
    routeMi: item.routeMi,
    activityDistanceMi: item.activityDistanceMi,
    activityLat: item.activityLat,
    activityLon: item.activityLon,
    width: item.width,
    height: item.height,
  }))
  .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt))
