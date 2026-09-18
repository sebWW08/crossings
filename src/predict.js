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

/** Barrier window for a train that calls at the station on the crossing. */
function stationWindow(crossing, dir, stopCall, now) {
  const st = crossing.station;
  const r = resolveCall(stopCall, now);
  if (!r) return null;
  // A calling point's time is its departure; arrival ≈ departure − dwell.
  const dep = r.time.getTime();
  const arr = dep - st.dwellSec * 1000;
  const stationBefore = st.platformsSide === dir.enters;
  let closeAt, openAt;
  if (stationBefore) {
    // Train sits in the platform, then crosses on departure.
    closeAt = (st.holdDuringDwell ? arr : dep) - crossing.closeBeforeSec * 1000;
    openAt = dep + crossing.openAfterSec * 1000;
  } else {
    // Train crosses, then stops: barriers lift once it is in the platform.
    closeAt = arr - crossing.closeBeforeSec * 1000;
    openAt = arr + crossing.openAfterSec * 1000;
  }
  return { closeAt, openAt, basis: `${st.crs} ${stationBefore ? 'departure' : 'arrival'}`, uncertain: r.uncertain, actual: r.actual };
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
    const w = stationWindow(crossing, dir, leg.x, now);
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
    const w = stationWindow(crossing, dir, stopCall, now);
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
