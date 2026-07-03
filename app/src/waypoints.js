/**
 * Waypoints snapped onto the GPX (mile marks from tools/build_data.py).
 *
 * crew  : vehicle-accessible support point
 * water : 'yes' | 'seasonal' | 'filter' | null
 * gate  : vehicle/lot access window  { spec, what, alt }
 *         spec grammar -> see sun.js resolveWindow()
 * bridge: true = runner-side constraint (GGB east sidewalk hours)
 *
 * Hours verified Jul 2026:
 *  - GGB east sidewalk: 5:00-21:00 PDT / 5:00-18:30 PST (goldengate.org)
 *  - Mt Tam SP roads & lots (Pantoll, Ridgecrest, East Peak): 7:00-sunset (parks.ca.gov)
 *  - Stinson Beach NPS lot: gates open 9:00, close ~1h after sunset (nps.gov)
 *  - Muir Beach lot: 6:00 to 1h after sunset (nps.gov)
 *  - Tennessee Valley lot: generally open 24h (nps.gov)
 *  - Samuel P. Taylor day use: 8:00-sunset (parks.ca.gov)
 *  - Muir Woods: 8:00-sunset, parking by reservation only (gomuirwoods.com)
 */
export const waypoints = [
  {
    id: 'start', mi: 0.0, name: 'Start — Golden Gate Park', kind: 'major',
    crew: true, water: 'yes', gate: null,
    note: 'City streets, 24 h. Stage aid from a parked car.',
  },
  {
    id: 'ggb-s-out', mi: 4.7, name: 'GGB south · Welcome Center', kind: 'minor',
    crew: true, water: 'yes', bridge: true,
    gate: { spec: 'bridge', what: 'east sidewalk', alt: null },
    note: 'Presidio lots (paid). Runner enters east sidewalk here.',
  },
  {
    id: 'ggb-n-out', mi: 6.5, name: 'GGB north · Vista Point', kind: 'major',
    crew: true, water: null, bridge: true,
    gate: { spec: 'bridge', what: 'east sidewalk', alt: null },
    note: 'Vista Point lot. Off US-101 — quick crew hit.',
  },
  {
    id: 'headlands-vc', mi: 13.1, name: 'Headlands Visitor Ctr', kind: 'minor',
    crew: true, water: 'yes', gate: null,
    note: 'Fort Barry. Field Rd open to Rodeo area 24 h.',
  },
  {
    id: 'rodeo', mi: 14.0, name: 'Rodeo Beach', kind: 'major',
    crew: true, water: 'yes',
    gate: { spec: 'sunrise-sunset', what: 'beach lot', alt: 'Bunker Rd shoulder open 24 h' },
    note: 'Restrooms + fountains by the lot.',
  },
  {
    id: 'muir-beach', mi: 20.3, name: 'Muir Beach · Pelican Inn', kind: 'major',
    crew: true, water: 'seasonal',
    gate: { spec: '6:00-sunset+60', what: 'NPS lot', alt: 'Hwy 1 pullouts nearby' },
    note: 'Restrooms at lot. Pelican Inn = real food until ~21:00.',
  },
  {
    id: 'pantoll', mi: 26.0, name: 'Pantoll Ranger Station', kind: 'major',
    crew: true, water: 'yes',
    gate: { spec: '7:00-sunset', what: 'SP lot', alt: 'Panoramic Hwy is 24 h — quick drop only, no after-hours parking' },
    note: 'Year-round spigot + restrooms. Ranger kiosk 415-388-2070.',
  },
  {
    id: 'cardiac', mi: 26.8, name: 'Cardiac Hill', kind: 'minor',
    crew: false, water: null, gate: null,
    note: 'Dipsea/Coastal junction. Foot access only.',
  },
  {
    id: 'stinson', mi: 29.1, name: 'Stinson Beach', kind: 'major',
    crew: true, water: 'yes',
    gate: { spec: '9:00-sunset+60', what: 'NPS lot', alt: 'town streets (Calle del Mar / Hwy 1) 24 h' },
    note: 'Fountains + restrooms. Last big resupply before the north loop.',
  },
  {
    id: 'bofax-gate', mi: 33.5, name: 'Ridgecrest × Bolinas–Fairfax gate', kind: 'minor',
    crew: true, water: null,
    gate: { spec: '7:00-sunset', what: 'Ridgecrest gate', alt: 'BoFax Rd itself open 24 h — park at gate pullout' },
    note: 'Crew parks at the gate; runner crosses BoFax here.',
  },
  {
    id: 'bolinas-ridge', mi: 40.1, name: 'Bolinas Ridge', kind: 'minor',
    crew: false, water: null, gate: null,
    note: 'Long exposed ridge. No access, no water.',
  },
  {
    id: 'tocaloma', mi: 45.3, name: 'Tocaloma · Platform Bridge Rd', kind: 'major',
    crew: true, water: null, gate: null,
    note: 'Sir Francis Drake shoulder, 24 h. Prime night crew stop.',
  },
  {
    id: 'irving', mi: 47.4, name: 'Irving Picnic Area', kind: 'minor',
    crew: true, water: 'yes',
    gate: { spec: '8:00-sunset', what: 'SPT day-use gate', alt: 'meet on Cross Marin Trail from SFD shoulder' },
    note: 'Samuel P. Taylor SP. Water at picnic area.',
  },
  {
    id: 'spt', mi: 48.1, name: 'Samuel P. Taylor camp', kind: 'major',
    crew: true, water: 'yes',
    gate: { spec: '8:00-sunset', what: 'day-use lot', alt: 'SFD roadside 24 h, short walk in' },
    note: 'Campground water year-round. Redwoods, cold at night.',
  },
  {
    id: 'shafter', mi: 52.0, name: 'Shafter Bridge · Peters Dam gate', kind: 'minor',
    crew: true, water: 'filter',
    gate: { spec: 'sunrise-sunset', what: 'MMWD watershed', alt: 'small SFD pullout 24 h' },
    note: 'Lagunitas Ck below bridge (filter). Watershed gate here.',
  },
  {
    id: 'kent-lake', mi: 54.4, name: 'Kent Lake · Peters Dam', kind: 'minor',
    crew: false, water: null, gate: null,
    note: 'MMWD watershed. Foot/bike only.',
  },
  {
    id: 'sg-ridge', mi: 60.0, name: 'San Geronimo Ridge', kind: 'minor',
    crew: false, water: null, gate: null,
    note: 'Remote fire roads, 1,600 ft up. No support.',
  },
  {
    id: 'azalea', mi: 66.6, name: 'Azalea Hill pullout', kind: 'major',
    crew: true, water: null, gate: null,
    note: 'Bolinas–Fairfax Rd, 24 h roadside. Last crew before Tam summit push.',
  },
  {
    id: 'alpine-dam', mi: 68.9, name: 'Alpine Dam', kind: 'minor',
    crew: true, water: 'filter', gate: null,
    note: 'BoFax Rd, 24 h but very tight parking on the dam curve.',
  },
  {
    id: 'cataract', mi: 69.8, name: 'Cataract TH (BoFax hairpin)', kind: 'minor',
    crew: true, water: 'filter', gate: null,
    note: 'Small pullout. Cataract Creek runs most of the year.',
  },
  {
    id: 'laurel-dell', mi: 70.5, name: 'Laurel Dell', kind: 'minor',
    crew: false, water: null, gate: null,
    note: 'Restroom, non-potable. Foot only.',
  },
  {
    id: 'east-peak', mi: 75.9, name: 'Mt Tam East Peak', kind: 'major',
    crew: true, water: 'yes',
    gate: { spec: '7:00-sunset', what: 'E Ridgecrest Blvd', alt: 'NO after-hours vehicle access — cars locked in/out at sunset' },
    note: 'Course high point 2,382 ft. Fountain at visitor center.',
  },
  {
    id: 'west-point', mi: 77.9, name: 'West Point Inn', kind: 'minor',
    crew: false, water: 'yes', gate: null,
    note: 'Fountain on porch, honor-system snacks. Foot only.',
  },
  {
    id: 'mtn-home', mi: 79.8, name: 'Mountain Home Inn', kind: 'major',
    crew: true, water: 'yes', gate: null,
    note: 'Panoramic Hwy lot, 24 h roadside. Fountain at lot.',
  },
  {
    id: 'muir-woods', mi: 82.1, name: 'Muir Woods', kind: 'minor',
    crew: false, water: 'yes',
    gate: { spec: '8:00-sunset', what: 'reservation parking', alt: 'do not plan crew here — road is narrow, parking enforced' },
    note: 'Fountains near visitor center (outside gate).',
  },
  {
    id: 'coyote-ridge', mi: 85.9, name: 'Coyote Ridge', kind: 'minor',
    crew: false, water: null, gate: null,
    note: 'Foot only.',
  },
  {
    id: 'tennessee', mi: 88.3, name: 'Tennessee Valley', kind: 'major',
    crew: true, water: 'seasonal', gate: null,
    note: 'Lot generally open 24 h. Restrooms; fountain unreliable — bring jugs.',
  },
  {
    id: 'ggb-n-ret', mi: 93.5, name: 'GGB north · Vista Point (return)', kind: 'major',
    crew: true, water: null, bridge: true,
    gate: { spec: 'bridge', what: 'east sidewalk', alt: null },
    note: 'THE cutoff that matters: sidewalk gates are automatic.',
  },
  {
    id: 'ggb-s-ret', mi: 95.3, name: 'GGB south (return)', kind: 'minor',
    crew: true, water: 'yes', bridge: true,
    gate: { spec: 'bridge', what: 'east sidewalk', alt: null },
    note: 'Crissy Field fountains. 5 mi of city to the finish.',
  },
  {
    id: 'finish', mi: 100.2, name: 'Finish — Golden Gate Park', kind: 'major',
    crew: true, water: 'yes', gate: null,
    note: 'Done. 100.2 mi, ~15,200 ft of climbing.',
  },
]
