// Pure prediction: Darwin arrivals boards in, barrier closure windows out.
// Nothing here talks to the network, so it is unit-testable against canned boards.

import { resolveCall } from './time.js';

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
    const seen = new Set(prev.map((c) => c.crs));
    // Must have come from the far side of the crossing, else it joined the
    // line beyond it (or arrives from another route entirely).
    if (!dir.via.some((crs) => seen.has(crs))) continue;
    const m = timeMovement(crossing, dir, svc, prev, now);
    if (m) out.push(m);
  }
  return out;
}

function timeMovement(crossing, dir, svc, prev, now) {
  const closeBefore = crossing.closeBeforeSec * 1000;
  const openAfter = crossing.openAfterSec * 1000;
  const st = crossing.station;
  const stopCall = st ? prev.find((c) => c.crs === st.crs && !c.isCancelled) : null;

  const base = {
    serviceId: svc.serviceID ?? svc.serviceId ?? svc.rsid ?? null,
    direction: dir.key,
    towards: dir.towards,
    operator: svc.operator ?? null,
    origin: svc.origin?.[0]?.locationName ?? null,
    destination: svc.destination?.[0]?.locationName ?? null,
    stops: Boolean(stopCall),
  };

  if (stopCall) {
    const r = resolveCall(stopCall, now);
    if (!r) return null;
    // A calling point's time is its departure; arrival ≈ departure − dwell.
    const dep = r.time.getTime();
    const arr = dep - st.dwellSec * 1000;
    const stationBefore = st.platformsSide === dir.enters;
    let closeAt, openAt;
    if (stationBefore) {
      // Train sits in the platform, then crosses on departure.
      closeAt = (st.holdDuringDwell ? arr : dep) - closeBefore;
      openAt = dep + openAfter;
    } else {
      // Train crosses, then stops: barriers lift once it is in the platform.
      closeAt = arr - closeBefore;
      openAt = arr + openAfter;
    }
    return {
      ...base,
      closeAt,
      openAt,
      basis: `${st.crs} ${stationBefore ? 'departure' : 'arrival'}`,
      uncertain: r.uncertain,
      actual: r.actual,
    };
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

export function predict(crossing, boards, now = new Date()) {
  const movements = crossing.directions.flatMap((dir) =>
    movementsForDirection(crossing, dir, boards[dir.board.crs], now),
  );
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
