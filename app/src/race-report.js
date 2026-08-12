import reportSource from './race-report.txt?raw'

const normalizedSource = reportSource
  .replace(/\r/g, '')
  .replace(/[\u2028\u2029\f]/g, '\n')
const [preSource = '', postSource = ''] = normalizedSource.split(/\n\s*POST\s*\n/i)

const paragraphs = source => source
  .replace(/^\s*PRE\s*/i, '')
  .split(/\n+/)
  .map(paragraph => paragraph.trim())
  .filter(Boolean)

const pre = paragraphs(preSource)
const post = paragraphs(postSource)
const copy = (source, from, to) => source.slice(from, to)

export const raceReportMeta = {
  eyebrow: 'Voice notes · August 6–10, 2026',
  introduction:
    'Recorded two days before the attempt and one day after it, these notes hold the anticipation, the run itself, and what remained afterward.',
  filmLabel: 'Watch Doug’s race film',
  filmUrl: 'https://www.youtube.com/watch?v=NM-cGuWaJ6k',
}

export const raceReportChapters = [
  {
    id: 'loop-from-home',
    phase: 'D−2',
    title: 'A loop from home',
    context: 'Thu · Aug 6 · Rodeo to Blue Heron Lake',
    paragraphs: copy(pre, 0, 5),
  },
  {
    id: 'before-change',
    phase: 'D−2',
    title: 'Before everything changes',
    context: 'Parenthood on the horizon',
    paragraphs: copy(pre, 5, 8),
  },
  {
    id: 'fear-hooks',
    phase: 'D−2',
    title: 'The fear that hooks me',
    context: 'Injury, uncertainty, and the permission to stop',
    paragraphs: copy(pre, 8, 16),
  },
  {
    id: 'dig-deep',
    phase: 'D−2',
    title: 'Dig deep',
    context: 'The commitment made before the start',
    paragraphs: copy(pre, 16, 24),
  },
  {
    id: 'convergence',
    phase: 'D+1',
    title: 'Convergence',
    context: 'Mon · Aug 10 · Looking back',
    paragraphs: copy(post, 0, 11),
  },
  {
    id: 'keep-moving',
    phase: 'The run',
    title: 'Keep moving',
    context: 'Golden Gate Park to Rodeo Beach',
    fromMi: 0,
    toMi: 10.7,
    paragraphs: copy(post, 11, 14),
  },
  {
    id: 'rodeo-muir',
    phase: 'The run',
    title: 'Rodeo to Muir Beach',
    context: 'Rodeo Beach to Muir Beach',
    fromMi: 10.7,
    toMi: 17.1,
    paragraphs: copy(post, 14, 15),
  },
  {
    id: 'muir-stinson',
    phase: 'The run',
    title: 'Muir Beach to Stinson',
    context: 'Muir Beach to Stinson Beach',
    fromMi: 17.1,
    toMi: 27,
    paragraphs: copy(post, 15, 16),
  },
  {
    id: 'stinson-bolinas',
    phase: 'The run',
    title: 'Stinson to Bolinas Ridge',
    context: 'Stinson Beach to Bolinas Ridge',
    fromMi: 27,
    toMi: 44.2,
    paragraphs: copy(post, 16, 17),
  },
  {
    id: 'slow-motion',
    phase: 'D+1',
    title: 'Slow motion',
    context: 'An interlude from Strawberry Hill',
    paragraphs: copy(post, 17, 18),
  },
  {
    id: 'taken-care-of',
    phase: 'The run',
    title: 'Taken care of',
    context: 'Bolinas Ridge to Sky Oaks',
    fromMi: 44.2,
    toMi: 66.1,
    paragraphs: copy(post, 18, 23),
  },
  {
    id: 'hard-hours',
    phase: 'The run',
    title: 'The hard hours',
    context: 'Sky Oaks to East Peak',
    fromMi: 66.1,
    toMi: 77.9,
    paragraphs: copy(post, 23, 26),
  },
  {
    id: 'inversion',
    phase: 'The run',
    title: 'Inversion',
    context: 'East Peak at sunrise',
    fromMi: 77.9,
    toMi: 82.6,
    paragraphs: copy(post, 26, 28),
  },
  {
    id: 'second-wind',
    phase: 'The run',
    title: 'Second wind',
    context: 'Mountain Home Inn to the Golden Gate',
    fromMi: 82.6,
    toMi: 96.7,
    paragraphs: copy(post, 28, 31),
  },
  {
    id: 'home',
    phase: 'The run',
    title: 'Home',
    context: 'The bridge, the Presidio, and the finish',
    fromMi: 96.7,
    toMi: 102.43,
    paragraphs: copy(post, 31, 33),
  },
  {
    id: 'after',
    phase: 'D+1',
    title: 'After',
    context: 'The shower, the party, and the body returning',
    mediaFromMi: 98.5,
    mediaToMi: 102.43,
    paragraphs: copy(post, 33, 37),
  },
]

export const raceReportAnchors = [
  { id: 'loop-from-home', label: 'before' },
  { id: 'convergence', label: 'reflection' },
  { id: 'keep-moving', label: 'the run' },
  { id: 'after', label: 'after' },
]
