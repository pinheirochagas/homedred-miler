import coastalTrailThumbnail from './assets/media/IMG_2550.jpg'
import coastalTrailPhoto from './assets/media/IMG_2550-full.jpg'
import bolinasRidgeVideo from './assets/media/IMG_1971.mp4'
import bolinasRidgePoster from './assets/media/IMG_1971-poster.jpg'
import voiceMemo from './assets/media/voice-memo-test.m4a'
import voiceMemoWaveform from './assets/media/voice-memo-test-waveform.svg'

export const mediaItems = [
  {
    id: 'img-2550',
    type: 'photo',
    src: coastalTrailPhoto,
    thumbnailSrc: coastalTrailThumbnail,
    title: 'Coastal Trail',
    alt: 'Fog settling over the Marin coastline, seen from the Coastal Trail.',
    capturedAt: '2026-07-18T18:13:36.000Z',
    lat: 37.85152,
    lon: -122.559655,
    width: 2268,
    height: 4032,
  },
  {
    id: 'img-1971',
    type: 'video',
    src: bolinasRidgeVideo,
    thumbnailSrc: bolinasRidgePoster,
    mimeType: 'video/mp4',
    title: 'Mt Tam East Peak',
    alt: 'Running down a rocky trail near Mt Tam East Peak.',
    lat: 37.9288,
    lon: -122.5758,
    width: 720,
    height: 1280,
  },
  {
    id: 'voice-memo-test',
    type: 'audio',
    src: voiceMemo,
    thumbnailSrc: voiceMemoWaveform,
    mimeType: 'audio/mp4',
    title: 'Pre-race voice memo',
    alt: 'Waveform for a short pre-race voice memo.',
    lat: 37.832388,
    lon: -122.479907,
    width: 720,
    height: 720,
  },
]
