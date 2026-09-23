// Pure prediction: Darwin arrivals boards in, barrier closure windows out.
// Nothing here talks to the network, so it is unit-testable against canned boards.

import { resolveCall, parseClock } from './time.js';

/** Two closures closer together than this are shown as one — the barriers
 *  would not realistically come up in between. */
const MERGE_GAP_SEC = 45;

/** Darwin nests calling points in groups (one per portion of a train that
 *  joined/split). Flatten to one list in travel order. */
export function flattenCalls(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g) => (Array.isArray(g?.callingPoint) ? g.callingPoint : []));
}

/**
 * Every train on `board` (an arrivals board at dir.board.crs) that will pass,
 * or has recently passed, the crossing travelling in `dir`, each with an
 * estimated barrier window.
 */
export function movementsForDirection(crossing, dir, board, now = new Date()) {
  const out = [];
  for (const svc of board?.trainServices ?? []) {
    if (svc.isCancelled) continue;
    const prev = flattenCalls(svc.previousCallingPoints);
    const m = dir.beyond
      ? timeByLeg(crossing, dir, svc, prev, now)
      : cameThrough(dir, prev) ? timeMovement(crossing, dir, svc, prev, now) : null;
    if (m) out.push(m);
  }
  return out;
}

/**
 * Where on its journey this train passed the crossing: the latest pair of
 * consecutive calls (X on the near side, Y beyond — the board itself counts)
 * whose leg crosses the road. Null if it never came this way, or came round
 * a loop: a leg that is scheduled far quicker than the run via the crossing
 * (`crossing.times`) did not go via the crossing.
 * Only for entries carrying `beyond` + `times`; hand-written ones use `via` alone.
 */
export function crossingLeg(crossing, dir, svc, prev) {
  const via = new Set(dir.via);
  const beyond = new Set([...(dir.beyond ?? []), dir.board.crs]);
  const board = { crs: dir.board.crs, st: svc.sta, et: svc.eta, at: svc.ata, isBoard: true };
  const seq = [...prev, board].filter((c) => !c.isCancelled && (via.has(c.crs) || beyond.has(c.crs)));
  for (let i = seq.length - 2; i >= 0; i--) {
    const [x, y] = [seq[i], seq[i + 1]];
    if (!via.has(x.crs) || !beyond.has(y.crs)) continue;
    if (crossing.bypass?.[x.crs]?.includes(y.crs)) return null; // round a loop, not over the road
    const tx = crossing.times?.[x.crs], ty = crossing.times?.[y.crs];
    if (tx == null || ty == null) return { x, y, frac: 0.5 };
    const sx = parseClock(x.st), sy = parseClock(y.st);
    if (sx && sy) {
      const legMin = (sy - sx) / 60_000;
      const run = tx + ty;
      if (legMin < 0.5 * run || legMin > 2 * run + 5) return null;
    }
    return { x, y, frac: legFraction(tx, ty) };
  }
  return null;
}

// X and Y are consecutive calls, so the train pulls away from X and brakes
// into Y. At ~0.4 m/s² to ~30 m/s each takes ~75 s and covers only what
// ~37 s at speed would, so a crossing just outside a station is reached
// later than a straight split of the leg says, and one just before the
// next station sooner.
const ACCEL_MIN = 0.625;
/** Minutes to cover `u` minutes' worth of track (at cruising speed) from, or to, a stop. */
export function fromStop(u) {
  return u >= ACCEL_MIN ? u + ACCEL_MIN : 2 * Math.sqrt(u * ACCEL_MIN);
}
/** Where along the scheduled leg X→Y the crossing falls, tx / ty being track minutes at speed. */
export function legFraction(tx, ty) {
  if (!(tx + ty > 0)) return 0.5;
  const a = fromStop(tx), b = fromStop(ty);
  return a / (a + b);
}

/** Old rule for hand-written entries: it called somewhere on the near side. */
function cameThrough(dir, prev) {
  const via = new Set(dir.via);
  return prev.some((c) => via.has(c.crs) && !c.isCancelled);
}

/** LDBWS service IDs differ per board; origin + its departure + destination
 *  identifies the same train wherever it is seen. */
export function trainKey(svc, prev) {
  const first = prev[0];
  const origin = svc.origin?.[0]?.crs, dest = svc.destination?.[0]?.crs;
  if (first?.st && origin && dest) return `${origin}@${first.st}>${dest}`;
  return svc.rsid ?? svc.serviceID ?? svc.serviceId ?? null;
}

function describe(dir, svc, prev, stops) {
  return {
    serviceId: trainKey(svc, prev),
    direction: dir.key,
    towards: dir.towards,
    operator: svc.operator ?? null,
    origin: svc.origin?.[0]?.locationName ?? null,
    destination: svc.destination?.[0]?.locationName ?? null,
    stops,
  };
}

// A stopping train at a station crossing: where it stops relative to the
// road decides what the barriers do. Distances are along the track from the
// road; a train pulls away from, or brakes to, a stand at about 0.5 m/s².
const COACH_M = 20;      // a 20 m coach is the common case (450, 377, 150…); 23 m stock runs a bit long
const CLEAR_M = 10;      // rear wheels this close beyond the road still hold the barriers down
const ACCEL = 0.5;       // m/s², from and to a stand
const secsToCover = (m) => Math.sqrt((2 * Math.max(0, m)) / ACCEL);

/** Coaches in a train: Darwin's word for this calling point, then the
 *  service, then what the registry assumes here. Darwin says 0 when it
 *  doesn't know (all of SWR, at the time of writing). */
export function trainCoaches(svc, call, station) {
  for (const n of [call?.length, svc?.length]) if (Number(n) > 0) return { coaches: Number(n), assumed: false };
  if (station?.assumeCoaches > 0) return { coaches: station.assumeCoaches, assumed: true };
  return { coaches: null, assumed: true };
}

/** Barrier window for a train that calls at the station on the crossing. */
export function stationWindow(crossing, dir, stopCall, now, svc = null) {
  const st = crossing.station;
  const r = resolveCall(stopCall, now);
  if (!r) return null;
  // A calling point's time is its departure; arrival ≈ departure − dwell.
  const dep = r.time.getTime();
  const arr = dep - st.dwellSec * 1000;
  const stationBefore = st.platformsSide === dir.enters;
  const closeBefore = crossing.closeBeforeSec * 1000;
  const openAfter = crossing.openAfterSec * 1000;
  const { coaches, assumed } = trainCoaches(svc, stopCall, st);
  // Without platform measurements the old fixed offsets apply.
  const S = st.platformStartM ?? 0;                  // road → nearest platform end
  const E = st.platformEndM ?? null;                 // road → far end, where the front stops
  // Train length: known, assumed, or "fills the platform".
  const L = coaches ? coaches * COACH_M : E != null ? E - S : null;
  const extra = { coaches, coachesAssumed: assumed, held: false };
  let closeAt, openAt, basis;
  if (stationBefore) {
    // Stands in the platform, then pulls away over the road: the front
    // reaches it after covering the gap, the rear clears after the gap plus
    // the train's own length.
    const roadAt = dep + secsToCover(S) * 1000;
    closeAt = (st.holdDuringDwell ? arr : roadAt) - closeBefore;
    openAt = dep + (L != null ? secsToCover(S + L) * 1000 : 0) + openAfter;
    basis = `${st.crs} departure`;
    extra.held = Boolean(st.holdDuringDwell);
  } else {
    // Crosses the road while braking, then stops with its front E beyond it.
    const roadAt = E != null ? arr - secsToCover(E) * 1000 : arr;
    closeAt = roadAt - closeBefore;
    // `stopsClear`: a train too long for the platform draws forward past it
    // and opens only the doors that fit (selective door opening), so its
    // rear still stops clear of the road (Cressing, seen by a user).
    const overhang = E != null && L != null ? (st.stopsClear ? Math.min(0, L - (E - CLEAR_M)) : L - (E - CLEAR_M)) : null;
    // `holdDuringDwell` doesn't apply here: once the train is past the road
    // nothing needs the barriers, signaller or not (Fen Road: northbound
    // stoppers at Cambridge North were reported up the moment they'd passed).
    if (overhang > 0) {
      // Longer than the room beyond the road: its rear stands on the crossing
      // for the whole stop, and the barriers stay down until it has pulled clear.
      openAt = dep + (overhang > 0 ? secsToCover(overhang) * 1000 : 0) + openAfter;
      basis = `${st.crs} departure`;
      extra.held = true;
    } else {
      // The rear passes the road while the train is still braking in.
      const tailAt = overhang != null ? arr - secsToCover(E - L) * 1000 : arr;
      openAt = tailAt + openAfter;
      basis = `${st.crs} arrival`;
    }
  }
  return { closeAt, openAt, basis, uncertain: r.uncertain, actual: r.actual, ...extra };
}

/**
 * Generated entries: the crossing moment is interpolated along the train's
 * own leg X→Y in proportion to track distance, so it tracks the real
 * schedule (and live delay at X) rather than an assumed run time.
 */
function timeByLeg(crossing, dir, svc, prev, now) {
  const leg = crossingLeg(crossing, dir, svc, prev);
  if (!leg) return null;
  const st = crossing.station;
  if (st && leg.x.crs === st.crs) {
    const w = stationWindow(crossing, dir, leg.x, now, svc);
    return w && { ...describe(dir, svc, prev, true), ...w };
  }
  const rx = resolveCall(leg.x, now), ry = resolveCall(leg.y, now);
  if (!rx || !ry) return null;
  // X's time is a departure; Y's is an arrival at the board, else a departure
  // from an intermediate call (arrival ≈ 40 s earlier).
  const from = rx.time.getTime();
  const to = ry.time.getTime() - (leg.y.isBoard ? 0 : 40_000);
  const at = from + Math.max(0, to - from) * leg.frac;
  return {
    ...describe(dir, svc, prev, false),
    closeAt: at - crossing.closeBeforeSec * 1000,
    openAt: at + crossing.openAfterSec * 1000,
    basis: `${leg.x.crs}→${leg.y.crs}`,
    uncertain: rx.uncertain || ry.uncertain,
    actual: rx.actual,
  };
}

function timeMovement(crossing, dir, svc, prev, now) {
  const closeBefore = crossing.closeBeforeSec * 1000;
  const openAfter = crossing.openAfterSec * 1000;
  const st = crossing.station;
  const stopCall = st ? prev.find((c) => c.crs === st.crs && !c.isCancelled) : null;
  const base = describe(dir, svc, prev, Boolean(stopCall));

  if (stopCall) {
    const w = stationWindow(crossing, dir, stopCall, now, svc);
    return w && { ...base, ...w };
  }

  // Non-stopping: nearest reference station we have a time for, plus a fixed
  // run time to the barriers. The board's own station is the last resort
  // (negative offset — the train reaches the crossing before it).
  for (const ref of dir.references) {
    const call = ref.crs === dir.board.crs
      ? { st: svc.sta, et: svc.eta }
      : prev.find((c) => c.crs === ref.crs && !c.isCancelled);
    if (!call) continue;
    const r = resolveCall(call, now);
    if (!r) continue;
    const at = r.time.getTime() + ref.minutesToCrossing * 60_000;
    return {
      ...base,
      closeAt: at - closeBefore,
      openAt: at + openAfter,
      basis: `${ref.crs} ${ref.minutesToCrossing >= 0 ? '+' : ''}${ref.minutesToCrossing} min`,
      uncertain: r.uncertain,
      actual: r.actual,
    };
  }
  return null;
}

/** Overlapping / near-touching windows become one closure with several trains. */
export function mergeClosures(movements) {
  const sorted = [...movements].sort((a, b) => a.closeAt - b.closeAt);
  const out = [];
  for (const m of sorted) {
    const last = out.at(-1);
    if (last && m.closeAt <= last.openAt + MERGE_GAP_SEC * 1000) {
      last.openAt = Math.max(last.openAt, m.openAt);
      last.trains.push(m);
      last.uncertain ||= m.uncertain;
    } else {
      out.push({ closeAt: m.closeAt, openAt: m.openAt, trains: [m], uncertain: m.uncertain });
    }
  }
  return out;
}

/** A direction may read several boards (the line forks beyond the crossing),
 *  so the same train can turn up twice. Keep the sighting with the best
 *  evidence: an actual time beats an estimate. */
export function dedupe(movements) {
  const best = new Map();
  for (const m of movements) {
    const key = m.serviceId ?? `${m.direction}:${m.closeAt}`;
    const cur = best.get(key);
    if (!cur || (m.actual && !cur.actual) || (m.actual === cur.actual && !m.uncertain && cur.uncertain)) best.set(key, m);
  }
  return [...best.values()];
}

export function predict(crossing, boards, now = new Date()) {
  const movements = dedupe(crossing.directions.flatMap((dir) =>
    movementsForDirection(crossing, dir, boards[dir.board.crs], now),
  ));
  const closures = mergeClosures(movements);
  const t = now.getTime();
  const current = closures.find((c) => c.closeAt <= t && t < c.openAt) ?? null;
  const upcoming = closures.filter((c) => c.closeAt > t);
  const recent = closures.filter((c) => c.openAt <= t).slice(-3);
  const hourAhead = t + 3_600_000;
  const closedSecNextHour = closures.reduce((acc, c) => {
    const s = Math.max(c.closeAt, t);
    const e = Math.min(c.openAt, hourAhead);
    return e > s ? acc + (e - s) / 1000 : acc;
  }, 0);
  return {
    state: current ? 'closed' : 'open',
    current,
    next: upcoming[0] ?? null,
    upcoming,
    recent,
    closedSecNextHour: Math.round(closedSecNextHour),
    movements,
  };
}
