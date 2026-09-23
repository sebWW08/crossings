# Crossings

How long until the level crossing reopens. Pick a crossing, see whether the
barriers are expected up or down right now, how long until that changes, and
the closures coming up over the next two hours.

Network Rail does not publish barrier state, so this is **inferred from live
train running data**: every train that will pass the crossing is found on
National Rail's Darwin feed, and each one gets a barrier window around the
moment it reaches the road.

## Run it

```
cp .env.example .env     # add a Darwin key, or leave blank for demo data
npm start                # http://localhost:3000
npm test
```

Node 22+; the only dependency is the SVG rasteriser for link-preview
pictures. Without `DARWIN_API_KEY` the app runs on a
synthetic clock-face timetable (badged "demo data") so the UI can be worked
on offline. For live data, get a free key from the
[Rail Data Marketplace](https://raildata.org.uk) — product
*Live Arrival and Departure Boards* (LDBWS) — and put it in `.env`.

## The app

The list opens on a map of the country. "Near me" sorts by distance (once
allowed, it is used quietly on every visit; the last position is remembered
so the list is in order before the browser answers). The star on a card or
a crossing page keeps it under "Your crossings" at the top. Both live in the
browser's localStorage — nothing is sent anywhere.

## Sharing, finding and counting

Every crossing has its own URL — `/milford`, `/liss` — served with a real
title and description (and Open Graph tags) so a link pasted into a group
chat gets a preview and a search for the crossing's name can find it.
`/sitemap.xml` lists them all. The app still routes itself once loaded;
old `#/milford` links are carried over.

The preview picture (`/og/milford.png`, 1200×630) is drawn per crossing —
"Is the barrier down at MILFORD?" over its road and line, in the site's
own type — by `src/card.mjs` from an SVG, rasterised with
`@resvg/resvg-js` (the one dependency) and the vendored Barlow Condensed
font (`assets/`, OFL). Nothing live is on it: chat apps cache previews for
hours, and a stale "open" under our name would be worse than no picture.

`/stats` is the dashboard — people per day, which crossings, where they came
from, feedback taps — drawn from `/api/stats`, a cookieless count of use, per day: people per crossing
(a phone polling every 30 s is one person — a salted hash of address and
browser that changes daily and is never stored), how they arrived (a
crossing link, the home page, the map), which sites sent them, whether the
device had been before (the page says so from its own localStorage), and
"was this right?" taps. It is kept in `data/stats.json` and summarised to
the log each day, since the host's disk does not survive a deploy.

## Hosting

`render.yaml` describes the site for [Render](https://render.com)'s free
tier: connect the GitHub repo as a Blueprint, set `DARWIN_API_KEY` in the
dashboard, done. Auto-deploy on push needs Render's GitHub App installed
on the repo (an OAuth-only connection can read the repo but never hears
about pushes). It is one Node process (build step: `npm ci`); `PORT` is
honoured and `/api/health` answers the health check. The free instance
sleeps after 15 minutes idle — `.github/workflows/keepalive.yml` pings it
every 10 minutes so a shared link never lands on a 50 s cold start — and
its disk is wiped on deploy, which is why "was this right?" reports
(`POST /api/feedback`, one JSON line each in `data/feedback.jsonl`) are
also written to the log and, if `FEEDBACK_WEBHOOK` is set, posted to that
URL. To read them: Render dashboard → the service → Logs, search
`feedback`. `SITE_URL` sets the host used in canonical links and the
sitemap (default `https://crossings.onrender.com`).

## How a crossing is described

`data/crossings.json` (hand-written, pretty-printed) and
`data/generated.json` (the generator's output, one entry per line) make up
the registry; `data/overrides.json` holds per-crossing corrections learnt
from "was this right?" taps (a longer lead at Fen Road, a shorter one at
East Boldon), merged over the entry at load so a regeneration keeps them. The code knows nothing about Liss specifically; each crossing
is data:

```jsonc
{
  "id": "liss", "name": "Liss", "road": "Station Road (B3006)", "lat": …, "lon": …,
  "closeBeforeSec": 90,          // barriers drop this long before the train arrives
  "openAfterSec": 30,            // …and lift this long after it has passed
  "station": {                   // only if the crossing sits at a station
    "crs": "LIS", "platformsSide": "south",   // which side of the road the platforms are
    "platformStartM": 19, "platformEndM": 212, // road → nearest / farthest platform end, along the track
    "assumeCoaches": 12,                       // train length to assume when Darwin gives none
    "holdDuringDwell": false, "dwellSec": 40  // are barriers kept down while it stands?
  },
  "directions": [{
    "key": "north", "towards": "London", "enters": "south",  // approaches from the south
    "board": { "crs": "HSL" },       // arrivals board we read for this direction
    "via": ["PTR", "HAV", …],        // a train must have called here to have crossed
    "references": [                  // nearest timing point first
      { "crs": "PTR", "minutesToCrossing": 4 },   // Petersfield dep + 4 min
      { "crs": "HSL", "minutesToCrossing": -9 }   // fallback: Haslemere arr − 9 min
    ]
  }, …]
}
```

### Why arrivals boards at the *far* station

A departure board drops a train the moment it leaves — which for a crossing a
few minutes down the line is exactly when the barriers are about to drop. The
arrivals board at the next station beyond the crossing keeps the train listed
until it gets there, and its `previousCallingPoints` carry the *actual*
departure time from the near-side station. So each direction is one arrivals
board read, two boards per crossing, cached 30 s.

### Prediction rules (`src/predict.js`)

- Non-stopping train: crossing time = first reference station's
  actual/estimated/scheduled time + `minutesToCrossing`.
- Stopping train, platforms before the barriers: crosses on **departure**
  (barriers are assumed to stay up while it stands, unless `holdDuringDwell`).
- Stopping train, platforms after the barriers: crosses on **arrival**
  (departure time − `dwellSec`), barriers lift once it is in the platform —
  *unless the train is longer than the room beyond the road*, in which case
  its rear stands on the crossing and the barriers stay down until it leaves.
- Where the registry has platform measurements (`platformStartM`,
  `platformEndM`) the fixed offsets give way to a little physics: a train
  pulls away from, or brakes to, a stand at ~0.5 m/s², so the front reaches
  the road √(2·gap/0.5) s after departure (or before the stop), and the rear
  clears it once the gap plus the train's length has been covered. Train
  length is Darwin's `length` (coaches × 20 m) when it is given, else the
  entry's `assumeCoaches`, else "fills the platform". Darwin gives no
  length for SWR trains, so on the Portsmouth line the assumption matters:
  Milford was seen with a 12-car standing across Station Lane for its whole
  stop (2026-09-19, via "was this right?"), which the old rule showed as open.
- **Who closes it matters more than what closes it.** A signaller-controlled
  crossing (Network Rail types CCTV, MCB, MCB-OD, manned gates — `control:
  "signaller"`) goes down when the signaller needs the protecting signal
  clear: about 150 s ahead of a train passing through, and *before* a
  stopping train reaches the platform, staying down until it has left
  (`holdDuringDwell` is true for these). That hold is only for a train that
  stops *before* the road: one that has already crossed lets the barriers
  up once its rear is clear, as at an automatic crossing (Fen Road taps,
  2026-09-21–23: northbound stoppers at Cambridge North reported up
  straight after passing, while the page said closed until they left). An automatic one (AHB, ABCL, AOCL
  — `control: "automatic"`) is struck in by the train itself ~40 s out and
  lifts as soon as it has cleared. This came straight from the first day of
  "was this right?" taps: East Boldon (CCTV) down 3+ min before a non-stop
  and 2 min before a stopping Metro arrived; Fen Road (CCTV) down while a
  train stood at Cambridge North; Liss (CCTV) confirmed on site; Milford
  (AHB) lifting on time.
- A station whose platforms start within 400 m of the road (Cambridge
  North, 300 m from Fen Road) counts as being at the crossing, so a train
  standing there is a stop with the barriers down, not a train in transit.
- Windows within 45 s of each other merge into one closure.
- `et: "Delayed"` marks the closure *uncertain* in the UI; cancelled trains are dropped.

### Generated entries

Most of the registry is produced by `tools/build-registry.mjs` rather than
by hand. Those entries carry `"generated": true` and a few extra fields:

```jsonc
"directions": [{
  "boards": [{ "crs": "NSH", "min": 1.5 }, { "crs": "RMD", "min": 2.5 }, …],
                                 // read the next few stations, not just the
                                 // nearest: fast trains skip the nearest one
  "via": ["MTL", "BNS", …],      // stations on the side the train comes from
  "beyond": ["NSH", "RMD", …],   // stations on the side it is going to
}],
"times": { "BNS": 0.6, "MTL": 0.6, "NSH": 1.5, … },  // run time from the crossing
"bypass": { "WTN": ["HOU", "ISL"] }   // consecutive calls that go round a loop,
                                      // not over this road (Hounslow, Kingston…)
```

With those, the predictor doesn't need a fixed run time: it finds the train's
latest leg from a `via` station to a `beyond` station (the board itself
counts) and places the crossing along that leg in proportion to `times`,
using the actual departure from the near station once it has left. The
split allows for the train pulling away from one call and braking into the
next (~75 s each at 0.4 m/s², covering what ~37 s at speed would), so a
crossing just outside a station is reached later than a straight split
says. A leg in `bypass`, or one scheduled far quicker than the run via the
crossing, means the train came round another way. Hand-written entries (no
`beyond`) use the `references` rule above.

## Crossings covered

The whole of Great Britain: 1,339 road crossings — every one OpenStreetMap
knows about on a line with National Rail stations either side, which is
1,325 of the 1,430 open road crossings on Network Rail's own list (the rest
are on freight-only or heritage lines, or NR's position is too far from any
OSM crossing to match). Ten on the Portsmouth line are hand-written; the
rest are generated.

### Rebuilding the registry

```
curl -o data/source/united-kingdom-latest.osm.pbf \
     https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf   # 2.3 GB
node tools/extract-osm.mjs data/source/united-kingdom-latest.osm.pbf     # ~4 min → data/cache/osm-uk.json
node tools/build-registry.mjs --extract data/cache/osm-uk.json [--dry-run] # ~4 min
node tools/enrich-nr.mjs                                                  # re-match Network Rail data
```

`tools/pbf.mjs` is a small dependency-free reader for the OSM PBF format;
`extract-osm.mjs` streams the file twice and keeps just the running lines,
stations, platforms, crossing nodes and the roads over them (~70 MB of JSON). The
generator then builds one track graph for the country, walks it from each
crossing to the stations either side, and merges the result into
`data/generated.json`. Hand-written entries are never touched and suppress
generated ones at the same spot; a whole-country run replaces the generated
set, a `--bbox` run updates just its box. Footpath, farm and unnamed
depot-access crossings are skipped — unless Network Rail lists a road
crossing at that spot, in which case its word wins (port and works
accesses, gated farm lanes).

The older Overpass path still works for a small area and needs no download:

```
node tools/build-registry.mjs --bbox S,W,N,E [--margin 25] [--tile 0.5,1] [--dry-run]
```

but Overpass refuses country-sized track queries when busy, which is most
evenings; `--tile` splits the box and halves any tile that fails.

### Network Rail's crossing list

`data/source/nr-crossings.json` is Network Rail's level-crossing
risk-assessment spreadsheet (from
[networkrail.co.uk](https://www.networkrail.co.uk/who-we-are/safety-in-the-community/level-crossing-safety/active-level-crossings/),
6,121 crossings, July 2025) converted to JSON. Every generated entry is
matched to the nearest NR crossing (within 150 m) and takes its official
name and protection type from it, which is far more reliable than OSM's
tagging: CCTV/MCB → full barriers, AHB/ABCL → half, AOCL/OC → open (lights
only), MG/MWL/TMO → gates. A crossing NR lists as user-worked or footpath is
dropped even if OSM calls the road public; where NR has a footpath wicket
and a road crossing at the same spot, the road one is taken. The record is
kept under `nr` (with ELR and mileage) and shown on the crossing page.

Entries flagged `parallel` sit on a slow line beside a faster one between the
same stations (Bishton, under the main-line flyover): trains on the other
line never close the barriers and the boards can't tell which line a train
took, so only trains known to have come via the crossing are shown.

The hand-written Portsmouth line entries — positions and road names are from
OpenStreetMap; run times are worked out from track distance:

| Crossing | Road | Barriers | Notes |
| --- | --- | --- | --- |
| Bedhampton | Bedhampton Road / West Street | full | at Bedhampton station; also Fareham–Havant trains |
| Petersfield | Station Road | full | London end of the platforms |
| Kingsfernsden Lane | Kingsfernsden Lane, Sheet | half (AHB) | |
| Sheet | School Lane, Sheet | half (AHB) | per Network Rail's list |
| Princes Bridge | Andlers Ash Road, Liss | half (AHB) | per Network Rail's list |
| Liss | Station Road (B3006) | full | Portsmouth end of the platforms |
| Mill Road | Mill Road, Liss | half (AHB) | NR name: Liss Common |
| Milford | Station Lane | half (AHB) | south end of Milford station; a 12-car stands across the road |
| Farncombe | Farncombe Street | full | Godalming end of the platforms |
| Bourne Road | Bourne Road, Farncombe | full | Guildford end of the platforms |

### What needs checking on the ground

Each registry entry carries a `notes` field with its open questions. The
recurring ones:

- `platformsSide` / `platformStartM` / `platformEndM` — from OSM's platform
  ways projected onto the track either side of the road. Where OSM has no
  platforms drawn, the side falls back to the station node's bearing
  (unreliable when the crossing is within ~50 m of it) and the distances are
  left out, so the old fixed offsets apply.
- Train length where Darwin gives none (`assumeCoaches`): the difference
  between a train that clears the road while it stands and one that doesn't.
- `holdDuringDwell` — whether the signaller keeps the barriers down while a
  train stands in the platform before crossing.
- `stopsClear` — a train too long for the platform draws forward past it
  and opens only the doors that fit, so it never stands on the road. Set
  per station in data/overrides.json from what people report (Cressing:
  7-coach platform, a 10-car opens its rear 7). Milford is the opposite.
- Barrier type at Sheet, Princes Bridge and Mill Road after Network Rail's
  autumn-2025 upgrades (this sets `closeBeforeSec`: ~150 s for signaller-
  controlled full barriers, ~40 s for automatic half barriers).
- Freight and empty-stock trains are not on passenger boards, so a closure
  for one is invisible here (Fen Road at midnight). Nothing to do about it
  without a different data feed.
- `minutesToCrossing` for non-stopping trains: distance ÷ ~110 km/h plus half
  a minute; trim to what the fasts actually do.

Stand at a crossing for an hour with the app open and compare.

## Scaling to every crossing in the UK

The generator above is the plan; what's left:

1. **Run it everywhere** — tile GB into boxes and run each (Overpass won't
   serve the whole country's track in one go). ~6,000 `level_crossing` nodes
   in GB, perhaps a third of them public roads on passenger lines.
2. **Barrier types** — OSM's `crossing:barrier` is patchy, so `closeBeforeSec`
   is a guess for many. Network Rail's open
   [level crossing dataset](https://www.networkrail.co.uk/who-we-are/transparency-and-ethics/transparency/open-data-feeds/)
   has the official name and type (AHB, MCB, CCTV…) — match it on position.
3. **Cost** — each crossing is a handful of board reads per 30 s *while
   someone is looking at it*; boards are cached per station so busy stations
   are shared. RDM allows 100 requests/s with a burst cap and answers 429
   for a while once tripped (a whole-registry sweep at 75/s did it), so
   `src/darwin.js` keeps at most 8 requests in flight, retries a 429 or 5xx
   once, and otherwise serves the last board it got (up to 15 min old,
   flagged `staleSec` and shown on the page) rather than an error.
   Beyond that, move to the Darwin push port (one streaming feed of
   everything) and compute for all crossings continuously.
4. **Ground truth** — done, for the lead time: every "was this right?" tap
   is a measurement of how early the barriers went down relative to what the
   page showed (`src/calibrate.mjs`). Each crossing's `closeBeforeSec` is
   re-estimated from its reports of the last three weeks — the mean of
   (lead in force + error), with the rule's own value weighed in as three
   reports so one odd tap can't move it, bounded by what that kind of
   crossing can do, and only once there are three usable reports. Taps more
   than six minutes from any predicted closure are trains the boards can't
   see and are ignored. Reports live in memory and `data/feedback.jsonl`,
   are published (minus the browser string) at `GET /api/feedback`, and the
   hourly Action keeps them on the `stats` branch, which a fresh process
   seeds from. The crossing page says "timing tuned from N reports here".
   The reopen delay (`openAfterSec`) is estimated the same way from the
   far end of the window: up in the second half of a predicted closure
   means it lifted early, down shortly after the page's last closure ended
   (the page sends when that was) means it hadn't; errors over two minutes
   are a closure that was really two trains, and are ignored. A tap that
   would put the lead outside what that kind of crossing can do (five
   minutes early at an AHB that closes 40 s ahead) is a train the boards
   cannot see, not a lead error — taking those literally had inflated
   Milford to 100 s and Foxton to 240 s. Barriers still up well into a
   closure are kept, held to the shortest lead of its kind: a window too
   wide to be true is exactly what the lead is there to fix. Where a
   closure does merge several trains over more than five minutes the page
   says so, rather than showing one solid block. Run times per

Not a level crossing sensor: **never rely on this at the crossing — obey the lights.**
