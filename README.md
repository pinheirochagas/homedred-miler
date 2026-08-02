# Homedred Miler — Course Console

Minimal planning dashboard for the SF → Marin loop
(`course_v4.gpx`, Strava route). 3D satellite map, elevation profile with
segment measuring, and a crew plan that projects ETAs onto every access
point and flags gate/parking-hour conflicts.

## Run

```bash
cd app
npm install
npm run dev        # http://localhost:5173
```

The Mapbox token is read from `../.env` (`MAPBOX_TOKEN=pk…`). Only the
public `pk.` token is exposed to the browser; `MAPBOX_SECRET` stays local
(see `app/vite.config.js` — `envPrefix` is deliberately `MAPBOX_TOKEN`).
`tools/mint_public_token.py` can re-mint the pk token from the secret one.

The media archive also needs the browser-safe values
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; copy
`.env.example` when setting up a new environment.

## Media capture

Open `/capture/` on iPhone or Android to save GPS-tagged photos,
10-second videos, and two-minute voice memos. Captures are written to
IndexedDB first, so recording works without signal. The queue syncs to
Supabase when the page is open and connectivity returns, and can also be
exported as a ZIP with a JSON metadata manifest.

The main dashboard's `media` tab reads the shared archive and places each
capture at its exact location on the map and nearest mile on the elevation
profile. Supabase schema, storage limits, and row-level security policies
live in `supabase/migrations/`.

## Using it

- **Map** — drag/rotate freely. `satellite` imagery toggle, `relief`
  terrain (1.5× exaggeration), `orbit` slow spin, `frame` reframe. Click
  any dot for the full waypoint card (ETA, access window, water, notes).
- **Profile** (bottom) — hover to scrub a ghost dot along the map with
  live mile / elevation / grade / ETA. **Drag to measure any segment**:
  distance, gain, loss, and projected time span. `Esc` clears. Blue bands
  are the hours you'll be running in the dark; ☀/☾ mark sunrise/sunset.
- **Crew plan** (right) — set start time and target finish; ETAs are
  grade-adjusted (1,000 ft climb ≈ 2 flat miles of effort). Alerts list
  every point where a lot or gate is shut at your projected ETA, with the
  24 h fallback. Filter the list to crew stops, water, or gated points.

## Access hours encoded (verified Jul 2026 — reconfirm before race day)

| Point | Window | Source |
|---|---|---|
| GGB east sidewalk (runner!) | 5:00–21:00 PDT / 5:00–18:30 PST, automatic gates | goldengate.org |
| Mt Tam SP roads (Pantoll, Ridgecrest → East Peak) | 7:00–sunset, cars locked in/out | parks.ca.gov |
| Stinson Beach NPS lot | 9:00 to ~1 h after sunset | nps.gov |
| Muir Beach lot | 6:00 to 1 h after sunset | nps.gov |
| Rodeo Beach / GGNRA lots | sunrise–sunset | nps.gov |
| Tennessee Valley lot | generally 24 h | nps.gov |
| Samuel P. Taylor day use | 8:00–sunset | parks.ca.gov |
| Muir Woods | 8:00–sunset, parking is reservation-only | gomuirwoods.com |

Waypoint mile marks were snapped from the GPX itself
(`tools/build_data.py`, which also emits `app/src/data/course.json`:
per-point cumulative distance and hysteresis-smoothed gain/loss, so any
segment's stats are O(1) prefix-sum lookups).

Pantoll kiosk (road conditions): 415-388-2070.
