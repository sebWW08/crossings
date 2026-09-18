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

Node 22+, no dependencies. Without `DARWIN_API_KEY` the app runs on a
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

## How a crossing is described

`data/crossings.json` (hand-written, pretty-printed) and
`data/generated.json` (the generator's output, one entry per line) make up
the registry. The code knows nothing about Liss specifically; each crossing
is data:

```jsonc
{
  "id": "liss", "name": "Liss", "road": "Station Road (B3006)", "lat": …, "lon": …,
  "closeBeforeSec": 90,          // barriers drop this long before the train arrives
  "openAfterSec": 30,            // …and lift this long after it has passed
  "station": {                   // only if the crossing sits at a station
    "crs": "LIS", "platformsSide": "south",   // which side of the road the platforms are
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
  (departure time − `dwellSec`), barriers lift once it is in the platform.
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
stations, crossing nodes and the roads over them (65 MB of JSON). The
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
| Milford | Station Lane | half (AHB) | at Milford station, which end is a guess |
| Farncombe | Farncombe Street | full | Godalming end of the platforms |
| Bourne Road | Bourne Road, Farncombe | full | Guildford end of the platforms |

### What needs checking on the ground

Each registry entry carries a `notes` field with its open questions. The
recurring ones:

- `platformsSide` — which end of the platforms the road is on, taken from the
  crossing's position relative to OSM's station node (unreliable when the
  crossing is within ~50 m of it, as at Milford).
- `holdDuringDwell` — whether the signaller keeps the barriers down while a
  train stands in the platform before crossing.
- Barrier type at Sheet, Princes Bridge and Mill Road after Network Rail's
  autumn-2025 upgrades (this sets `closeBeforeSec`: ~90 s for full barriers,
  ~40 s for automatic half barriers).
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
   are shared. RDM's free tier is plenty for hundreds of concurrent crossings.
   Beyond that, move to the Darwin push port (one streaming feed of
   everything) and compute for all crossings continuously.
4. **Ground truth** — once there are users, "was it actually closed?" taps at
   the crossing become calibration data for `closeBeforeSec` / run times per crossing.

Not a level crossing sensor: **never rely on this at the crossing — obey the lights.**
