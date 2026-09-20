// Pure registry-building logic: OSM rail ways + stations + crossing nodes in,
// crossing entries (the shape in data/crossings.json) out. No network access,
// so it can be tested on a toy graph.

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const POINTS4 = ['north', 'east', 'south', 'west'];
const POINTS8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export const compass = (deg, n = 4) => (n === 8 ? POINTS8 : POINTS4)[Math.round((deg % 360) / (360 / n)) % n];

/** Smallest angle between two bearings. */
const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// ---------- speed ----------

/** OSM maxspeed ("60 mph", "100", "125 mph") in m/s; falls back by usage. */
export function lineSpeedMps(tags = {}) {
  const m = /^(\d+(?:\.\d+)?)\s*(mph)?/.exec(tags.maxspeed ?? '');
  let mph;
  if (m) mph = m[2] ? Number(m[1]) : Number(m[1]) / 1.609;
  else mph = { main: 75, branch: 50 }[tags.usage] ?? 60;
  return mph * 0.44704;
}

/** Trains don't run at line speed everywhere: run time = distance at 80 % of
 *  the limit, plus half a minute for braking/acceleration. */
export const RUN_FACTOR = 0.8;
export const RUN_PAD_MIN = 0.5;

// ---------- graph ----------

/**
 * Build an undirected graph from OSM ways. Sidings, yards and spurs are
 * skipped: trains that pass a road crossing are on running lines.
 * @returns {{ adj: Map<number, Array<{to:number, len:number, min:number, way:object}>>, nodes: Map<number, {lat:number, lon:number}>, waysByNode: Map<number, object[]> }}
 */
export function buildGraph(elements) {
  const nodes = new Map();
  const ways = [];
  for (const el of elements) {
    if (el.type === 'node') nodes.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags });
    // Spurs stay: OSM tags some passenger branches that way (Felixstowe), and
    // a spur with no station beyond it drops out in the walk anyway.
    else if (el.type === 'way' && el.tags?.railway === 'rail' && !/^(yard|siding)$/.test(el.tags.service ?? '')) ways.push(el);
  }
  const adj = new Map();
  const waysByNode = new Map();
  const link = (a, b, len, min, way) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, len, min, way });
  };
  for (const way of ways) {
    const mps = lineSpeedMps(way.tags) * RUN_FACTOR;
    for (let i = 0; i < way.nodes.length; i++) {
      const id = way.nodes[i];
      if (!waysByNode.has(id)) waysByNode.set(id, []);
      waysByNode.get(id).push(way);
      if (i === 0) continue;
      const a = nodes.get(way.nodes[i - 1]), b = nodes.get(id);
      if (!a || !b) continue;
      const len = distM(a, b);
      const min = len / mps / 60;
      link(way.nodes[i - 1], id, len, min, way);
      link(id, way.nodes[i - 1], len, min, way);
    }
  }
  return { adj, nodes, waysByNode };
}

// ---------- stations ----------

/** Coarse grid so "which station is this node near?" is O(1). */
export function stationIndex(stations, radiusM = 150) {
  const cell = radiusM / 111_000 * 2; // degrees, ≥ 2 radii so a 3×3 probe covers it
  const grid = new Map();
  const key = (la, lo) => la * 1_000_000 + lo; // numeric: this runs once per graph node
  for (const s of stations) {
    const k = key(Math.floor(s.lat / cell), Math.floor(s.lon / cell));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  return {
    radiusM,
    /** Nearest station within `r` metres (default: the index radius). */
    near(p, r = radiusM) {
      const la = Math.floor(p.lat / cell), lo = Math.floor(p.lon / cell);
      let best = null, bestD = r;
      const span = Math.ceil(r / (cell * 111_000)) + 1;
      for (let i = -span; i <= span; i++) for (let j = -span; j <= span; j++) {
        const bucket = grid.get(key(la + i, lo + j));
        if (!bucket) continue;
        for (const s of bucket) {
          const d = distM(p, s);
          if (d < bestD) { best = s; bestD = d; }
        }
      }
      return best;
    },
  };
}

// ---------- platforms ----------

/** Platform ways (railway=platform) bucketed by ~500 m cell, so those near a
 *  crossing are found without scanning the country. Each is { id, pts: [[lat,lon],…] }. */
export function platformIndex(platforms, radiusM = 500) {
  const cell = (radiusM / 111_000) * 2;
  const grid = new Map();
  const key = (la, lo) => la * 1_000_000 + lo;
  for (const pl of platforms) {
    const cells = new Set(pl.pts.map(([lat, lon]) => key(Math.floor(lat / cell), Math.floor(lon / cell))));
    for (const k of cells) (grid.get(k) ?? grid.set(k, []).get(k)).push(pl);
  }
  return {
    near(p) {
      const la = Math.floor(p.lat / cell), lo = Math.floor(p.lon / cell);
      const out = new Set();
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const pl of grid.get(key(la + i, lo + j)) ?? []) out.add(pl);
      return [...out];
    },
  };
}

/** Track out from `nodeId` along one side's first hops, as segments with
 *  their distance from the crossing, up to `maxM` of track. Every branch
 *  is followed: a platform on a loop line beside the crossing still counts. */
export function trackSegments(graph, nodeId, edges, maxM = 500, heading = null) {
  const segs = [];
  const seen = new Set([nodeId]);
  const queue = edges.map((e) => ({ from: nodeId, e, d0: 0 }));
  while (queue.length) {
    const { from, e, d0 } = queue.shift();
    if (seen.has(e.to)) continue;
    const a = graph.nodes.get(from), b = graph.nodes.get(e.to);
    // A crossover lets the walk turn round and come back down the other
    // track; anything heading back towards the crossing is not this side.
    if (heading != null && angleBetween(bearing(a, b), heading) > 120) continue;
    seen.add(e.to);
    segs.push({ a, b, d0, len: e.len });
    if (d0 + e.len < maxM) for (const n of graph.adj.get(e.to) ?? []) if (!seen.has(n.to)) queue.push({ from: e.to, e: n, d0: d0 + e.len });
  }
  return segs;
}

/**
 * Where a station's platforms lie relative to the road: for each side of
 * the crossing, the nearest and farthest platform ends measured along the
 * track (the far end is where the front of a stopping train ends up).
 * Platform points more than `lateralM` from the track are somebody else's.
 * Returns [{ startM, endM }|null, …] in the order of `split`.
 */
export function platformExtent(graph, nodeId, split, platforms, { maxM = 500, lateralM = 25 } = {}) {
  const p = graph.nodes.get(nodeId);
  const kx = 111_320 * Math.cos(toRad(p.lat)), ky = 111_320;
  const xy = (q) => [((q.lon ?? q[1]) - p.lon) * kx, ((q.lat ?? q[0]) - p.lat) * ky];
  return split.map((side) => {
    const segs = trackSegments(graph, nodeId, side.edges, maxM, side.bearing).map((s) => {
      const [ax, ay] = xy(s.a), [bx, by] = xy(s.b);
      return { ax, ay, dx: bx - ax, dy: by - ay, d0: s.d0, len: s.len };
    });
    let startM = Infinity, endM = -Infinity;
    for (const pl of platforms) {
      for (const pt of pl.pts) {
        // A point beside the road on the other side would project onto this
        // side's first segment at 0 m; it has to lie this way from the road.
        if (angleBetween(bearing(p, { lat: pt[0], lon: pt[1] }), side.bearing) > 90) continue;
        const [x, y] = xy(pt);
        for (const s of segs) {
          const l2 = s.dx * s.dx + s.dy * s.dy;
          if (!l2) continue;
          const t = Math.max(0, Math.min(1, ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / l2));
          const lat = Math.hypot(x - (s.ax + t * s.dx), y - (s.ay + t * s.dy));
          if (lat > lateralM) continue;
          const along = s.d0 + t * Math.sqrt(l2);
          if (along < startM) startM = along;
          if (along > endM) endM = along;
        }
      }
    }
    return endM > startM + 20 ? { startM: Math.round(startM), endM: Math.round(endM) } : null;
  });
}

// ---------- the walk ----------

/**
 * Dijkstra (by run time) outwards from `start` through the given first hops,
 * never re-entering `start`. Every station passed within the index radius is
 * recorded with its run time from the crossing and which station (if any)
 * was passed first on the way — that parent link is what tells branches apart.
 */
export function walk(graph, index, start, seeds, { maxMin = 45, exclude = new Set(), blockM = 40 } = {}) {
  const origin = graph.nodes.get(start);
  const lastStation = new Map([[start, null]]);
  const found = new Map(); // crs -> { station, min, distM, parent }
  const settled = new Set([start]);
  const heap = new MinHeap();
  for (const e of seeds) heap.push({ node: e.to, min: e.min, len: e.len, from: start, left: false });
  while (heap.size) {
    const { node, min, len, from, left } = heap.pop();
    if (settled.has(node)) continue;
    if (min > maxMin) break;
    // The other track's node at the same crossing, or a crossover right by
    // it, would let the walk double back past the road: once the walk has
    // left the crossing's immediate radius it may not come back into it.
    const inside = blockM > 0 && distM(origin, graph.nodes.get(node)) < blockM;
    if (left && inside) continue;
    settled.add(node);
    let last = lastStation.get(from) ?? null;
    const s = index.near(graph.nodes.get(node));
    if (s && !exclude.has(s.crs)) {
      if (!found.has(s.crs)) found.set(s.crs, { station: s, min, distM: len, parent: last, node });
      last = s.crs;
    }
    lastStation.set(node, last);
    for (const e of graph.adj.get(node) ?? []) {
      if (e.to === start || settled.has(e.to)) continue;
      heap.push({ node: e.to, min: min + e.min, len: len + e.len, from: node, left: left || !inside });
    }
  }
  return [...found.values()].sort((a, b) => a.min - b.min);
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a;
    a.push(x);
    for (let i = a.length - 1; i > 0;) {
      const j = (i - 1) >> 1;
      if (a[j].min <= a[i].min) break;
      [a[i], a[j]] = [a[j], a[i]];
      i = j;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].min < a[m].min) m = l;
        if (r < a.length && a[r].min < a[m].min) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/** Split a crossing node's neighbours into the two sides of the road. */
export function sides(graph, nodeId) {
  const p = graph.nodes.get(nodeId);
  const edges = graph.adj.get(nodeId) ?? [];
  if (edges.length < 2) return null;
  const withBearing = edges.map((e) => ({ e, b: bearing(p, graph.nodes.get(e.to)) }));
  const a = [withBearing[0]], b = [];
  for (const x of withBearing.slice(1)) (angleBetween(x.b, withBearing[0].b) < 90 ? a : b).push(x);
  if (!b.length) return null;
  const mean = (xs) => xs.reduce((acc, x) => acc + x.b, 0) / xs.length;
  return [
    { edges: a.map((x) => x.e), bearing: mean(a) },
    { edges: b.map((x) => x.e), bearing: mean(b) },
  ];
}

// ---------- entry assembly ----------

const round = (x, step) => Number((Math.round(x / step) * step).toFixed(3)); // toFixed: 61 * 0.1 is 6.1000000000000005
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function barrierFromTags(tags = {}) {
  const b = tags['crossing:barrier'] ?? '';
  if (/double_half|full|yes/.test(b)) return 'full';
  if (/^half$/.test(b)) return 'half';
  return 'unknown';
}
export const CLOSE_BEFORE = { full: 90, half: 40, gates: 120, open: 30, unknown: 60 };
// A signaller-controlled crossing (CCTV, MCB, gates) closes when the
// signaller needs the protecting signal clear, well ahead of the train:
// seen at East Boldon as 3+ minutes for a non-stop, and at Liss, East
// Boldon and Fen Road as "down before a stopping train even reaches the
// platform" (via the app's "was this right?" taps, 19–20 Sep 2026). An
// automatic one (AHB, ABCL, AOCL) is struck in by the train itself, so its
// timing is fixed and short.
export const SIGNALLER_TYPES = /^(CCTV|MCB|MCB\/MB|MCBOD|MCBR|MCB-CCTV|AFBCL|MG[HW]?|MWL[GBOW]|MBWM?|TMO[BG]|TO[BG])$/;
export const CLOSE_BEFORE_SIGNALLER = 150;
export const controlOf = (nrType) => (nrType ? (SIGNALLER_TYPES.test(nrType) ? 'signaller' : 'automatic') : 'unknown');

// ---------- Network Rail's level crossing list ----------
// data/source/nr-crossings.json: every crossing on the NR network with its
// official name and protection type (from the risk-assessment spreadsheet on
// networkrail.co.uk). The type codes say what actually protects the road.

/** NR crossing types that are public road crossings, and what they mean for us. */
export const NR_ROAD_TYPES = {
  CCTV: 'full', 'MCB/MB': 'full', MCB: 'full', MCBOD: 'full', MCBR: 'full', 'MCB-CCTV': 'full', AFBCL: 'full',
  AHB: 'half', 'AHB-X': 'half', ABCL: 'half', 'ABCL-X': 'half', AOCLB: 'half',
  AOCL: 'open', AOCR: 'open', OC: 'open', OD: 'open',
  MGH: 'gates', MG: 'gates', MGW: 'gates', MWLG: 'gates', MWLB: 'gates', MWLO: 'gates', MWLW: 'gates',
  MBW: 'gates', MBWM: 'gates', TMOB: 'gates', TMOG: 'gates', TOB: 'gates', TOG: 'gates',
};
// WG / WAG (wicket gates) and the FP* / UWC* types are the pedestrian gates
// beside a road crossing or standalone footpath / farm crossings; NR lists
// them as separate records, often within a metre of the road one.

/**
 * Nearest Network Rail crossing of any type to a point, or null. Road types
 * are matched within `withinM`; a footpath or user-worked crossing only
 * counts when it is right on the spot, and then it tells us OSM's "road" is
 * really a farm track or footpath (see applyNR).
 */
export function matchNR(nr, at, { withinM = 150, otherWithinM = 30 } = {}) {
  let road = null, other = null;
  for (const c of nr) {
    if (Math.abs(c.lat - at.lat) > 0.003 || Math.abs(c.lon - at.lon) > 0.005) continue;
    const d = distM(c, at);
    if (c.type in NR_ROAD_TYPES) { if (d <= withinM && (!road || d < road.d)) road = { ...c, d: Math.round(d) }; }
    else if (d <= otherWithinM && (!other || d < other.d)) other = { ...c, d: Math.round(d) };
  }
  // The road record wins over a footpath wicket at the same spot.
  return road ?? other;
}

/**
 * Fold an NR match into a generated entry: official name, barrier type, close
 * time. Returns null when NR says the crossing is not a public road crossing
 * (user-worked, footpath…) — those do not belong in the app.
 */
export function applyNR(entry, nr) {
  if (!nr) { const { nameFromRoad, ...rest } = entry; return rest; }
  const barrierType = NR_ROAD_TYPES[nr.type];
  if (!barrierType) return null;
  // "Liss MCB", "Bourne Road AHB" — the type code trails the name.
  const official = nr.name.replace(/\s+(CCTV|MCB[^\s]*|AHB(-X)?|ABCL(-X)?|AOCL[^\s]*|AOCR|AFBCL|OC|OD|MG[HW]?|MWL[GBOW]|MBWM?|TMO[BG]|TO[BG]|WA?G)$/i, '').trim();
  const name = entry.nameFromRoad && official ? official : entry.name;
  const { nameFromRoad, ...rest } = entry;
  const control = controlOf(nr.type);
  // Signaller-controlled: barriers down through a station stop, and a
  // longer lead for trains passing through. Straddling platforms hold anyway.
  const station = rest.station
    ? { ...rest.station, holdDuringDwell: rest.station.holdDuringDwell || control === 'signaller' }
    : undefined;
  return {
    ...rest,
    ...(station ? { station } : {}),
    name,
    barrierType,
    control,
    closeBeforeSec: control === 'signaller' && barrierType === 'full' ? CLOSE_BEFORE_SIGNALLER : CLOSE_BEFORE[barrierType],
    nr: { uid: nr.uid, name: nr.name, type: nr.type, status: nr.status, elr: nr.elr, miles: nr.miles, chains: nr.chains, distM: nr.d },
    notes: `${rest.notes.replace(/ Barrier type not tagged in OSM[^.]*\./, '')} Barrier type from Network Rail's crossing list (${nr.type}, ${nr.d} m from the OSM node).`,
  };
}

/** A crossing we'd want in the app: a public road, not a farm track or footpath. */
export function isRoadCrossing(highway) {
  if (!highway) return false;
  const t = highway.tags ?? {};
  if (/^(footway|path|steps|bridleway|cycleway|track|pedestrian|corridor)$/.test(t.highway ?? '')) return false;
  if (/^(private|no)$/.test(t.access ?? '') && !t.name) return false;
  // Unnamed service roads over the railway are depot, yard and works accesses.
  if (t.highway === 'service' && !t.name) return false;
  return true;
}

/**
 * Build one registry entry.
 * @param {object} p
 * @param {object} p.graph  from buildGraph
 * @param {object} p.index  from stationIndex
 * @param {number} p.nodeId  the crossing node (one of the pair)
 * @param {object} p.tags  the crossing node's tags
 * @param {object[]} p.highways  highway ways through the crossing
 * @param {{lat:number,lon:number}} p.at  display position
 */
/** How far off a station's platforms may start and still count as "at" the crossing. */
const NEAR_STATION_M = 400;

export function buildEntry({ graph, index, nodeId, tags = {}, highways = [], at, today = new Date(), directCache = new Map(), platforms = [] }) {
  const p = graph.nodes.get(nodeId);
  if (!p) return { skip: 'crossing node is not on a running line' };
  const split = sides(graph, nodeId);
  if (!split) return { skip: 'crossing is at a dead end' };

  // A station right at the crossing belongs to both directions. So does one
  // a few hundred metres off whose platforms reach towards the road (Fen
  // Road, 300 m south of Cambridge North): trains stand there with the
  // barriers already down, which is a station stop as far as the road is
  // concerned, not a train passing through.
  let atStation = index.near(p);
  let nearExt = null;
  if (!atStation && platforms.length) {
    const ext = platformExtent(graph, nodeId, split, platforms);
    const i = ext.findIndex((e) => e && e.startM <= NEAR_STATION_M);
    if (i >= 0) {
      const cand = index.near(p, NEAR_STATION_M + 150);
      if (cand && angleBetween(bearing(p, cand), split[i].bearing) < 90) { atStation = cand; nearExt = ext; }
    }
  }
  let exclude = new Set(atStation ? [atStation.crs] : []);
  let walks = split.map((s) => walk(graph, index, nodeId, s.edges, { exclude }));
  // A terminus a few hundred metres off (King's Lynn, Hampton Court) is the
  // only station on its side: attaching it would leave that side with no
  // board to read, so it stays the far-side station instead.
  if (nearExt && walks.some((w) => !w.length)) {
    atStation = null; nearExt = null; exclude = new Set();
    walks = split.map((s) => walk(graph, index, nodeId, s.edges, { exclude }));
  }
  // Loops (Hounslow, Kingston…) let a walk reach the same station from both
  // sides; it belongs to the side it is nearer from.
  const minOn = walks.map((w) => new Map(w.map((f) => [f.station.crs, f.min])));
  walks = walks.map((w, i) => {
    const kept = w.filter((f) => !(minOn[1 - i].get(f.station.crs) < f.min));
    const crs = new Set(kept.map((f) => f.station.crs));
    // A station whose parent moved to the other side is now first on its branch.
    return kept.map((f) => (f.parent && !crs.has(f.parent) ? { ...f, parent: null } : f));
  });

  // Label by where that side of the line goes overall (the mean bearing to
  // every station reached), not by the first bend out of the crossing.
  const keyFor = (i) => {
    if (!walks[i].length) return compass(split[i].bearing);
    let x = 0, y = 0;
    for (const f of walks[i]) { const b = toRad(bearing(p, f.station)); x += Math.sin(b); y += Math.cos(b); }
    return compass((toDeg(Math.atan2(x, y)) + 360) % 360);
  };
  let keys = [keyFor(0), keyFor(1)];
  if (keys[0] === keys[1]) keys = [compass(split[0].bearing, 8), compass(split[1].bearing, 8)];
  if (keys[0] === keys[1]) keys = [compass(split[0].bearing, 8), compass(split[0].bearing + 180, 8)];

  const depth = (list) => (n) => (n.parent ? 1 + depth(list)(list.find((x) => x.station.crs === n.parent)) : 0);
  const directions = [];
  const times = atStation ? { [atStation.crs]: 0 } : {};
  // Station pairs (one each side) whose direct rail route is clearly shorter
  // than going via the crossing: a train calling at both in turn went round
  // a loop, not over this road. Found once here so the predictor needn't.
  // Run times between stations don't depend on the crossing, so the walk out
  // from each station is shared across every crossing in the run.
  const bypass = {};
  const directFrom = (x) => {
    let m = directCache.get(x.station.crs);
    if (!m) {
      m = new Map(walk(graph, index, x.node, graph.adj.get(x.node) ?? [], { blockM: 0, maxMin: 40 }).map((f) => [f.station.crs, f.min]));
      directCache.set(x.station.crs, m);
    }
    return m;
  };
  const SIDE_CAP = 40;
  for (let i = 0; i < 2; i++) {
    for (const x of walks[1 - i].slice(0, SIDE_CAP)) {
      const direct = directFrom(x);
      for (const y of walks[i].slice(0, SIDE_CAP)) {
        const d = direct.get(y.station.crs);
        if (d != null && d < 0.9 * (x.min + y.min)) (bypass[x.station.crs] ??= []).push(y.station.crs);
      }
    }
  }
  // When even the two nearest stations are joined more directly some other
  // way, this road is on a slow/relief line beside a faster one (Bishton, under
  // the main-line flyover). Boards can't tell which line a train takes, so the
  // predictions here are only the trains that definitely came this way.
  const parallel = !!(walks[0][0] && walks[1][0] && bypass[walks[0][0].station.crs]?.includes(walks[1][0].station.crs));
  for (let i = 0; i < 2; i++) {
    const far = walks[i], near = walks[1 - i];
    // Boards: the next station on each branch and the couple beyond it, so a
    // fast train skipping the first is still listed somewhere.
    const boards = far.filter((f) => depth(far)(f) <= 2).slice(0, 4);
    if (!boards.length || !near.length) continue; // nothing to read a board from
    const via = [...(atStation ? [atStation.crs] : []), ...near.slice(0, SIDE_CAP).map((n) => n.station.crs)];
    const beyond = far.slice(0, SIDE_CAP).map((f) => f.station.crs);
    for (const f of [...near, ...far]) times[f.station.crs] = round(f.min, 0.1);
    const refs = near.filter((n) => depth(near)(n) <= 1).slice(0, 5)
      .map((n) => ({ crs: n.station.crs, name: n.station.name, minutesToCrossing: round(n.min + RUN_PAD_MIN, 0.5) }));
    directions.push({
      key: keys[i],
      label: `${cap(keys[i])}bound`,
      towards: boards[0].station.name,
      enters: keys[1 - i],
      boards: boards.map((b) => ({ crs: b.station.crs, name: b.station.name, min: round(b.min + RUN_PAD_MIN, 0.5) })),
      via,
      beyond,
      references: refs,
    });
  }
  if (!directions.length) return { skip: 'no station with a CRS code within reach on both sides' };
  // Same station read from both sides means the "line" loops straight back: a depot.
  if (walks[0][0]?.station.crs === walks[1][0]?.station.crs) return { skip: 'depot or yard loop' };

  const road = highways.find((h) => h.tags?.name)?.tags.name ?? highways[0]?.tags?.ref ?? (highways[0] ? `${highways[0].tags.highway} road` : 'unnamed road');
  // "Station Road" on its own identifies nothing; tag it with the nearest station.
  const nearest = [walks[0][0], walks[1][0]].filter(Boolean).sort((a, b) => a.min - b.min)[0];
  const name = tags.name ?? (atStation ? atStation.name : nearest ? `${road} (${nearest.station.name})` : road);
  const nameFromRoad = !tags.name && !atStation;
  const barrierType = barrierFromTags(tags);
  const lineName = graph.waysByNode.get(nodeId)?.find((w) => w.tags?.name)?.tags.name
    ?? `${walks[1][0]?.station.name ?? '?'} – ${walks[0][0]?.station.name ?? '?'} line`;

  let station = null, platformNote = null;
  if (atStation) {
    // Which side the platforms are on, and how far they reach, from OSM's
    // platform ways beside the track: that is what decides whether a
    // stopping train's rear is still on the road while it stands. Without
    // platforms, the station node's bearing is the best guess.
    // A platform starting further off than that belongs to the next station.
    const ext = (nearExt ?? (platforms.length ? platformExtent(graph, nodeId, split, platforms) : [null, null])).map((e) => (e && e.startM <= NEAR_STATION_M ? e : null));
    const start = (e) => (e ? e.startM : Infinity);
    let side;
    if (ext[0] || ext[1]) {
      const i = start(ext[0]) <= start(ext[1]) ? 0 : 1;
      side = keys[i];
      // Platforms starting at the road on both sides: the station straddles
      // it and a stopping train stands across it whichever way it faces.
      const straddles = Boolean(ext[1 - i] && ext[1 - i].startM < 60);
      platformNote = `Platforms ${ext[i].startM}–${ext[i].endM} m ${keys[i]} of the road (OSM)`
        + (straddles ? `, and ${ext[1 - i].startM}–${ext[1 - i].endM} m ${keys[1 - i]}: trains stand across the road` : '')
        + '.';
      station = { crs: atStation.crs, name: atStation.name, platformsSide: side, platformStartM: ext[i].startM, platformEndM: ext[i].endM, holdDuringDwell: straddles, dwellSec: 40 };
    } else {
      const b = bearing(p, atStation);
      side = angleBetween(b, split[0].bearing) < angleBetween(b, split[1].bearing) ? keys[0] : keys[1];
      platformNote = `platformsSide is the station node's bearing from the crossing (${Math.round(distM(p, atStation))} m away); no platform geometry in OSM.`;
      station = { crs: atStation.crs, name: atStation.name, platformsSide: side, holdDuringDwell: false, dwellSec: 40 };
    }
  }

  const notes = [
    `Generated from OpenStreetMap ${today.toISOString().slice(0, 10)}; nothing checked on site.`,
    barrierType === 'unknown' ? 'Barrier type not tagged in OSM (closeBeforeSec assumes 60 s).' : null,
    platformNote,
    'Run times are track distance at 80 % of line speed plus 30 s.',
    parallel ? 'On a line paralleled by a faster route between the same stations: trains on the other line never close these barriers, and the boards cannot tell the two apart.' : null,
  ].filter(Boolean).join(' ');

  return {
    entry: {
      id: null, // assigned at merge time
      osm: nodeId,
      generated: true,
      name, road, line: lineName,
      ...(nameFromRoad ? { nameFromRoad } : {}),
      lat: Math.round((at?.lat ?? p.lat) * 1e5) / 1e5,
      lon: Math.round((at?.lon ?? p.lon) * 1e5) / 1e5,
      barrierType,
      closeBeforeSec: CLOSE_BEFORE[barrierType],
      openAfterSec: 30,
      ...(station ? { station } : {}),
      directions,
      times,
      ...(Object.keys(bypass).length ? { bypass } : {}),
      ...(parallel ? { parallel } : {}),
      notes,
    },
  };
}

/** Group the per-track nodes of one crossing (a few metres apart) into one. */
export function clusterCrossings(nodes, withinM = 40) {
  const out = [];
  for (const n of nodes) {
    const g = out.find((c) => c.members.some((m) => distM(m, n) < withinM));
    if (g) g.members.push(n);
    else out.push({ members: [n] });
  }
  return out.map((g) => {
    const tagged = [...g.members].sort((a, b) => Object.keys(b.tags ?? {}).length - Object.keys(a.tags ?? {}).length);
    return {
      primary: tagged[0],
      members: g.members,
      at: {
        lat: g.members.reduce((s, m) => s + m.lat, 0) / g.members.length,
        lon: g.members.reduce((s, m) => s + m.lon, 0) / g.members.length,
      },
    };
  });
}

export function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'crossing';
}

/**
 * Merge generated entries into an existing registry: hand-written entries are
 * untouched (and suppress generated ones at the same spot), previously
 * generated entries keep their ids, everything else gets a fresh unique slug.
 */
export function mergeRegistry(existing, generated, { nearM = 60, dropOthers = false } = {}) {
  const hand = existing.filter((c) => !c.generated);
  const prior = new Map(existing.filter((c) => c.generated).map((c) => [c.osm, c]));
  const ids = new Set(hand.map((c) => c.id));
  const out = [...hand];
  const stats = { kept: hand.length, updated: 0, added: 0, suppressed: 0, dropped: 0 };
  for (const g of generated) {
    if (hand.some((h) => distM(h, g) < nearM)) { stats.suppressed++; continue; }
    const before = prior.get(g.osm);
    let id = before?.id;
    if (!id || ids.has(id)) {
      const base = slug(g.name);
      id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    }
    ids.add(id);
    out.push({ ...g, id });
    before ? stats.updated++ : stats.added++;
  }
  // Untouched generated entries from earlier runs (outside this run's box) stay.
  for (const [osm, c] of prior) {
    if (generated.some((g) => g.osm === osm) || ids.has(c.id)) continue;
    if (dropOthers) { stats.dropped++; continue; }
    out.push(c); ids.add(c.id); stats.kept++;
  }
  return { registry: out, stats };
}
