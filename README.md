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

## How a crossing is described

`data/crossings.json` is the registry. The code knows nothing about Liss
specifically; each crossing is data:

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
using the actual departure from the near station once it has left. A leg in
`bypass`, or one scheduled far quicker than the run via the crossing, means
the train came round another way. Hand-written entries (no `beyond`) use the
`references` rule above.

## Crossings covered

The Portsmouth Harbour – London Waterloo route by hand (there are none
between Portsmouth and Bedhampton, Havant and Petersfield, Liss and Milford,
or Guildford and Waterloo), plus every public road crossing OpenStreetMap
knows about in a box around London (51.25–51.75 N, 0.75 W–0.45 E: Woking to
Brentwood, St Albans to Sevenoaks) — 58 of them, generated.

To add an area:

```
node tools/build-registry.mjs --bbox S,W,N,E [--margin 25] [--dry-run]
```

It fetches the crossings in the box and the track and stations for the box
plus a margin from Overpass (cached in `data/cache/`), walks the track graph
from each crossing to the stations either side, and merges the result into
`data/crossings.json`. Hand-written entries are never touched and suppress
generated ones at the same spot; re-running an area updates its generated
entries in place. Footpath, farm and unnamed depot-access crossings are
skipped. Expect a couple of minutes for a London-sized box.

The hand-written Portsmouth line entries — positions and road names are from
OpenStreetMap; run times are worked out from track distance:

| Crossing | Road | Barriers | Notes |
| --- | --- | --- | --- |
| Bedhampton | Bedhampton Road / West Street | full | at Bedhampton station; also Fareham–Havant trains |
| Petersfield | Station Road | full | London end of the platforms |
| Kingsfernsden Lane | Kingsfernsden Lane, Sheet | half (AHB) | |
| Sheet | School Lane, Sheet | new barriers 2025, type unconfirmed | |
| Princes Bridge | Andlers Ash Road, Liss | new barriers 2025, type unconfirmed | |
| Liss | Station Road (B3006) | full | Portsmouth end of the platforms |
| Mill Road | Mill Road, Liss | type unconfirmed | |
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
