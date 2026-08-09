import manifest from './media-manifest.json'

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

export const mediaItems = manifest
  .filter(item => item.status === 'resolved')
  .map(item => ({
    id: item.id,
    type: item.type,
    src: assetUrl(item.outputs.src),
    thumbnailSrc: assetUrl(item.outputs.thumbnailSrc),
    mimeType: item.mimeType,
    title: item.title,
    alt: item.alt,
    capturedAt: item.capturedAt,
    lat: item.lat,
    lon: item.lon,
    routeMi: item.routeMi,
    width: item.width,
    height: item.height,
  }))
