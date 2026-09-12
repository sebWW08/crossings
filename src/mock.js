// Synthetic arrivals boards so the app runs without a Darwin key. Trains run
// to a fixed clock-face pattern so refreshes are consistent; one service per
// hour carries a few minutes' delay.

import { fmtClock } from './time.js';

const PATTERN = {
  north: [
    { minute: 7, stops: true },
    { minute: 22, stops: false, lateMin: 3 },
    { minute: 37, stops: true },
    { minute: 52, stops: false },
  ],
  south: [
    { minute: 12, stops: true },
    { minute: 27, stops: false },
    { minute: 42, stops: true, lateMin: 2 },
    { minute: 57, stops: false },
  ],
};

function call(crs, name, time, now, lateMs) {
  const st = fmtClock(time);
  const est = new Date(time.getTime() + lateMs);
  const out = { locationName: name, crs, st };
  if (est <= now) out.at = fmtClock(est);
  else out.et = lateMs ? fmtClock(est) : 'On time';
  return out;
}

export function mockBoard(crossing, dir, now = new Date()) {
  const pattern = PATTERN[dir.key] ?? PATTERN.north;
  const boardRef = dir.references.find((r) => r.crs === dir.board.crs);
  const refs = dir.references.filter((r) => r.crs !== dir.board.crs);
  const st = crossing.station;
  const services = [];

  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  for (let h = -1; h <= 2; h++) {
    for (const p of pattern) {
      // Scheduled instant the train reaches the barriers.
      const cross = new Date(start.getTime() + (h * 60 + p.minute) * 60_000);
      const lateMs = (p.lateMin ?? 0) * 60_000;
      const prev = refs
        .map((r) => call(r.crs, r.name, new Date(cross.getTime() - r.minutesToCrossing * 60_000), now, lateMs))
        .reverse(); // travel order: furthest first
      if (p.stops && st) {
        const before = st.platformsSide === dir.enters;
        const dep = new Date(cross.getTime() + (before ? 0 : st.dwellSec * 1000));
        prev.push(call(st.crs, st.name, dep, now, lateMs));
      }
      const arrive = new Date(cross.getTime() - (boardRef?.minutesToCrossing ?? -8) * 60_000);
      if (arrive.getTime() + lateMs <= now.getTime()) continue; // already arrived — off the board
      const sta = fmtClock(arrive);
      services.push({
        serviceID: `mock-${dir.key}-${sta}`,
        sta,
        eta: lateMs ? fmtClock(new Date(arrive.getTime() + lateMs)) : 'On time',
        operator: 'South Western Railway',
        isCancelled: false,
        origin: [{ locationName: prev[0].locationName, crs: prev[0].crs }],
        destination: [{ locationName: dir.towards, crs: '' }],
        previousCallingPoints: [{ callingPoint: prev }],
      });
    }
  }
  return {
    generatedAt: now.toISOString(),
    locationName: dir.board.name,
    crs: dir.board.crs,
    trainServices: services,
    mock: true,
  };
}
