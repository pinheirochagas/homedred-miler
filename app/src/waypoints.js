/**
 * Waypoints snapped onto the GPX (mile marks from tools/build_data.py).
 *
 * crew  : vehicle-accessible support point
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
 *  - Leo T. Cronin Fish Viewing Area: sunrise-sunset (marinwater.org)
 *  - Marin Water parking: 30 min before sunrise–30 min after sunset,
 *    12 h maximum (Marin Water District Code §9.04.04)
 */
export const waypoints = [
  {
    id: 'start', mi: 0.0, name: 'Start — Golden Gate Park', kind: 'major',
    crew: true, gate: null,
    note: 'City streets with parking around Golden Gate Park.',
  },
  {
    id: 'ggb-s-out', mi: 4.1, name: 'GGB south · Welcome Center', kind: 'minor',
    crew: true, bridge: true,
    gate: { spec: 'bridge', what: 'east sidewalk', alt: null },
    note: 'Presidio lots (paid). The route entered the east sidewalk here.',
  },
  {
    id: 'ggb-n-out', mi: 5.9, name: 'GGB north · Vista Point', kind: 'major',
    crew: true, bridge: true,
    gate: { spec: 'bridge', what: 'east sidewalk', alt: null },
    note: 'Vista Point lot off US-101.',
  },
  {
    id: 'rodeo', mi: 10.8, name: 'Rodeo Beach', kind: 'major',
    crew: true,
    gate: { spec: 'sunrise-sunset', what: 'beach lot', alt: 'Bunker Rd shoulder open 24 h' },
    note: 'Restrooms + fountains by the lot.',
  },
  {
    id: 'muir-beach', mi: 17.2, name: 'Muir Beach parking lot', kind: 'major',
    crew: true,
    gate: { spec: '6:00-sunset+60', what: 'NPS lot', alt: 'Hwy 1 pullouts nearby' },
    note: 'The route passed through the lot. Restrooms; no drinking water.',
  },
  {
    id: 'pantoll', mi: 22.9, name: 'Pantoll Ranger Station', kind: 'major',
    crew: true,
    gate: { spec: '7:00-sunset', what: 'SP lot', alt: 'Panoramic Hwy is 24 h — quick drop only, no after-hours parking' },
    note: 'Year-round spigot + restrooms. Ranger kiosk 415-388-2070.',
  },
  {
    id: 'stinson', mi: 26.9, name: 'Stinson Beach', kind: 'major',
    crew: true,
    gate: { spec: '9:00-sunset+60', what: 'NPS lot', alt: 'town streets (Calle del Mar / Hwy 1) 24 h' },
    note: 'Fountains, restrooms, and the crew resupply before the north loop.',
  },
  {
    id: 'bolinas-ridge-th', mi: 43.5, name: 'Bolinas Ridge Trailhead', kind: 'major',
    crew: true, gate: null,
    access: 'roadside trailhead',
    note: 'NPS-designated shoulder parking on Sir Francis Drake Blvd; posted restrictions apply.',
  },
  {
    id: 'leo-cronin', mi: 49.5, name: 'Leo T. Cronin Fish Viewing Area', kind: 'major',
    crew: true, gate: null,
    access: 'roadside handoff',
    note: 'Roadside access from Sir Francis Drake Blvd; legal pullout restrictions apply.',
  },
  {
    id: 'sky-oaks-junction', mi: 65.0, name: 'Bolinas Rd × Sky Oaks Rd', kind: 'major',
    crew: true, gate: null,
    access: 'public-road junction',
    note: 'Public-road junction at the base of Sky Oaks Road; parking restrictions apply.',
  },
  {
    id: 'east-peak', mi: 76.1, name: 'Mt Tam East Peak', kind: 'major',
    crew: true,
    gate: { spec: '7:00-sunset', what: 'E Ridgecrest Blvd', alt: 'after-hours vehicle access is restricted' },
    note: 'Course high point 2,545 ft. Fountain at visitor center.',
  },
  {
    id: 'mtn-home', mi: 80.5, name: 'Mountain Home Inn', kind: 'major',
    crew: true, gate: null,
    note: 'Panoramic Hwy lot, 24 h roadside. Fountain at lot.',
  },
  {
    id: 'muir-woods', mi: 82.8, name: 'Muir Woods', kind: 'minor',
    crew: false,
    gate: { spec: '8:00-sunset', what: 'reservation parking', alt: 'road is narrow and parking is enforced' },
    note: 'Fountains near visitor center (outside gate).',
  },
  {
    id: 'tennessee', mi: 88.9, name: 'Tennessee Valley', kind: 'major',
    crew: true, gate: null,
    note: 'Lot generally open 24 h. Restrooms; fountain unreliable — bring jugs.',
  },
  {
    id: 'ggb-n-ret', mi: 94.1, name: 'GGB north · Vista Point (return)', kind: 'major',
    crew: true, bridge: true,
    gate: { spec: 'bridge', what: 'east sidewalk', alt: null },
    note: 'The east-sidewalk gates are automatic.',
  },
  {
    id: 'ggb-s-ret', mi: 95.9, name: 'GGB south (return)', kind: 'minor',
    crew: true, bridge: true,
    gate: { spec: 'bridge', what: 'east sidewalk', alt: null },
    note: 'Crissy Field fountains. 4 mi of city to the finish.',
  },
  {
    id: 'finish', mi: 100.0, name: 'Finish — Golden Gate Park', kind: 'major',
    crew: true, gate: null,
    note: 'Finished after 102.43 verified miles and 17,871 ft of climbing.',
  },
]
