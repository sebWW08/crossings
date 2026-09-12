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
*Live Arrival Board – Arrivals* (LDBWS) — and put it in `.env`.

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

## Crossings covered

Every road crossing on the Portsmouth Harbour – London Waterloo route (there
are none between Portsmouth and Bedhampton, Havant and Petersfield, Liss and
Milford, or Guildford and Waterloo). Positions and road names are from
OpenStreetMap; run times are worked out from track distance.

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

The app is already generic; the work is producing registry entries.

1. **Where the crossings are** — OpenStreetMap has every `railway=level_crossing`
   node (~6,000 in GB) with road names, and Network Rail's open
   [level crossing dataset](https://www.networkrail.co.uk/who-we-are/transparency-and-ethics/transparency/open-data-feeds/)
   has the official name, type (AHB, MCB, CCTV, footpath…) and Engineer's Line Reference / mileage.
2. **Which stations sit either side** — walk the OSM `railway=rail` ways from each
   crossing node in both directions until you hit a station node, collect the
   CRS codes (from the NaPTAN / Network Rail station list), and turn track
   distance into `minutesToCrossing` using the line speed (OSM `maxspeed` on
   the way, else a per-class default). That gives `board`, `references` and
   `via` automatically; `via` is just "all stations further along that branch".
3. **Junctions and branches** — where the walk hits a junction before a station,
   the `via` list branches; the current shape handles that as long as every
   branch is listed. Crossings inside big junction complexes will need hand
   entries.
4. **Cost** — each crossing is two board reads per 30 s *while someone is
   looking at it*; boards are cached per station so busy stations are shared.
   RDM's free tier is plenty for hundreds of concurrent crossings. Beyond that,
   move to the Darwin push port (one streaming feed of everything) and compute
   for all crossings continuously.
5. **Ground truth** — once there are users, "was it actually closed?" taps at
   the crossing become calibration data for `closeBeforeSec` / run times per crossing.

Not a level crossing sensor: **never rely on this at the crossing — obey the lights.**
