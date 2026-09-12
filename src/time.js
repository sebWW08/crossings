// Darwin gives clock times ("HH:MM") in UK local time with no date. Pin them
// to the nearest plausible instant around `now`, in Europe/London.

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function londonMinutesOfDay(date) {
  const parts = fmt.formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

export const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * "HH:MM" -> Date. Times up to 6h in the past are read as earlier today;
 * anything further back is assumed to be tomorrow (late-evening boards that
 * run past midnight).
 */
export function parseClock(hhmm, now = new Date()) {
  const m = HHMM.exec(hhmm);
  if (!m) return null;
  const target = Number(m[1]) * 60 + Number(m[2]);
  let diff = target - londonMinutesOfDay(now);
  if (diff < -360) diff += 1440;
  else if (diff > 1080) diff -= 1440;
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + diff);
  return d;
}

/**
 * Resolve a Darwin (scheduled, estimated/actual) pair to an instant.
 * `et`/`at` are "HH:MM", "On time", "Delayed", "Cancelled", "No report" or absent.
 * Returns { time, uncertain, actual } or null if the call is cancelled/unknown.
 */
export function resolveCall({ st, et, at }, now = new Date()) {
  if (at && HHMM.test(at)) return { time: parseClock(at, now), uncertain: false, actual: true };
  if (et === 'Cancelled' || at === 'Cancelled') return null;
  if (et && HHMM.test(et)) return { time: parseClock(et, now), uncertain: false, actual: false };
  if (!st || !HHMM.test(st)) return null;
  const time = parseClock(st, now);
  return { time, uncertain: et === 'Delayed' || et === 'No report', actual: false };
}

export function fmtClock(date) {
  return fmt.format(date);
}
