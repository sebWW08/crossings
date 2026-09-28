// Turning "was this right?" taps into a lead time per crossing.
//
// Each report says what the barriers were doing and what the page was
// showing, with the closure the page was counting to. That makes it a
// measurement of the lead — how far ahead of the train the barriers went
// down — relative to the lead in force when the tap was made:
//
//   saw DOWN, page said open, next closure at T   -> it closed (T - now)
//                                                   earlier: lead too short
//   saw UP,   page said closed since T            -> it hadn't closed yet:
//                                                   lead too long by (now - T)
//   saw what the page said                        -> the lead was fine
//
// The estimate is the mean of (lead then + error) over the crossing's recent
// reports, with the rule's value weighed in as a few reports of its own, so
// agreeing taps hold it where it is and a run of early or late sightings
// moves it — and one odd tap doesn't. It needs a few reports before it says
// anything, and never strays outside what a crossing of that kind can do.
// A tap more than six minutes from any predicted closure is a train the
// boards don't know about (freight, empties) and says nothing about either.
// The reopen delay (openAfterSec) is estimated the same way from the other
// end of the window.

const DAYS = 21;
const MIN_REPORTS = 3;
// How far out a tap can be and still be about the lead. Beyond the range a
// crossing of that kind can plausibly close over, it is a train the boards
// can't see (freight, empties, an extra working), not a lead we got wrong:
// a five-minute-early closure at an AHB that closes 40 s ahead is not the
// AHB. Taking those as lead errors is what made Foxton climb 210→240 s
// while people were also reporting the barriers up.
const MAX_ERR_SEC = 360;
// A closure this long is several trains merged into one window. Its tail
// says nothing about how long after one train the barriers lift, so the
// reopen delay ignores it; the lead still counts it, since a window too
// wide to be true is what the lead is there to fix.
const MERGED_WINDOW_SEC = 300;
const merged = (r) => r.closeAt != null && r.openAt != null && (r.openAt - r.closeAt) / 1000 > MERGED_WINDOW_SEC;
// The rule's own value counts as this many extra "it was fine" reports, so
// three taps nudge a crossing and a fortnight of them move it.
const PRIOR_WEIGHT = 3;
const BOUNDS = { signaller: [45, 420], automatic: [20, 120], unknown: [30, 300] };
const OPEN_BOUNDS = [10, 120];
// A reopening more than two minutes off isn't the reopen delay — it's a
// closure that was really two trains, or one we couldn't see.
const OPEN_MAX_ERR_SEC = 120;

/**
 * The window a tap is about. Reports carry each train's own window (since
 * 28 Sep 2026), so a tap inside a closure of several trains is judged
 * against the train it fell on, not the whole block — the barriers lifting
 * between two trains the page had merged is no longer mistaken for either
 * edge being wrong. Older reports only have the whole closure, flagged
 * when it is too long to be one train.
 */
export function windowOf(r, at) {
  const own = (r.trains ?? []).filter((t) => t?.closeAt != null && t?.openAt != null);
  if (!own.length) return r.closeAt == null || r.openAt == null ? null : { closeAt: r.closeAt, openAt: r.openAt, single: !merged(r) };
  const off = (t) => (at < t.closeAt ? t.closeAt - at : at >= t.openAt ? at - t.openAt : 0);
  const t = own.reduce((a, b) => (off(b) < off(a) ? b : a));
  return { closeAt: t.closeAt, openAt: t.openAt, single: true };
}

/**
 * Which end of a closure a tap bears on — the start (the lead) or the end
 * (the reopen delay) — and never both. During a closure it is whichever
 * half the tap fell in; between closures, whichever edge is nearer. (Taken
 * both ways, the down taps at Milford on 22 Sep that were the next train
 * closing early also counted as the last one reopening late, and walked
 * its reopen delay from 15 s to 35.)
 */
function edge(r, at) {
  if (r.predicted === 'closed') {
    const w = windowOf(r, at);
    return w && { kind: at <= (w.closeAt + w.openAt) / 2 ? 'lead' : 'open', w };
  }
  const toNext = r.closeAt != null && r.closeAt > at ? (r.closeAt - at) / 1000 : Infinity;
  const sincePrev = r.prevOpenAt != null && r.prevOpenAt <= at ? (at - r.prevOpenAt) / 1000 : Infinity;
  if (toNext === Infinity && sincePrev === Infinity) return null;
  return sincePrev < toNext ? { kind: 'open', since: sincePrev } : { kind: 'lead', until: toNext };
}

/** Seconds by which the lead should have been longer (+) or shorter (−), or null if the tap says nothing about it. */
export function leadError(r, control = 'unknown', lead = r.lead) {
  const at = Date.parse(r.at);
  if (!Number.isFinite(at) || r.closeAt == null || r.openAt == null) return null;
  const e = edge(r, at);
  if (e?.kind !== 'lead') return null;
  // An error that would put the lead outside what this kind of crossing can
  // do isn't the lead: it's a train the boards can't see.
  const [lo, hi] = BOUNDS[control] ?? BOUNDS.unknown;
  const base = lead ?? (lo + hi) / 2;
  const early = (s) => (s <= Math.min(MAX_ERR_SEC, hi - base) ? s : null);
  if (!e.w) {
    // The page said open, the next closure `until` s off. A tap far from
    // any closure says nothing about when the barriers drop, even if right.
    if (e.until > MAX_ERR_SEC) return null;
    return r.observed === 'up' ? 0 : early(e.until); // down before the page expected: lead too short
  }
  const late = (at - e.w.closeAt) / 1000;
  if (late < 0) return r.observed === 'up' ? 0 : early(-late); // before this train's window, between merged trains
  if (late > MAX_ERR_SEC) return null;
  if (r.observed === 'down') return 0;
  // Up in the first half of a predicted closure: it hadn't closed yet. Still
  // up well into one means the window is far too wide; unlike the other
  // direction there is nothing else it could be, so it is kept and merely
  // held to the shortest lead this kind of crossing can have.
  return -Math.min(late, base - lo);
}

/**
 * The other end of the closure: seconds by which the barriers stayed down
 * longer (+) or lifted sooner (−) than the page said. Up in the second half
 * of a predicted closure means it reopened early; down shortly after a
 * predicted reopening (the page sends when the last closure ended) means it
 * hadn't. Agreement counts as fine.
 */
export function openError(r) {
  const at = Date.parse(r.at);
  if (!Number.isFinite(at)) return null;
  const e = edge(r, at);
  if (e?.kind !== 'open') return null;
  if (e.w) {
    if (!e.w.single) return null;                  // several trains and no per-train times: the merge's business
    if (at >= e.w.openAt) return r.observed === 'up' ? 0 : null; // between merged trains: up as expected, or the next one
    const early = (e.w.openAt - at) / 1000;
    if (r.observed === 'up') return early <= OPEN_MAX_ERR_SEC ? -early : null;
    return 0; // still down, as predicted
  }
  if (e.since > OPEN_MAX_ERR_SEC) return null;
  return r.observed === 'down' ? e.since : 0;     // still down after the page's reopening, or up as it said
}

/** The reopen delay the reports point to, or null if there aren't enough usable ones. */
export function openAfterFromReports(reports, baseOpenAfter, now = Date.now()) {
  const since = now - DAYS * 86_400_000;
  const samples = [];
  for (const r of reports) {
    if (Date.parse(r.at) < since) continue;
    const e = openError(r);
    if (e == null) continue;
    samples.push((r.openAfter ?? baseOpenAfter) + e);
  }
  if (samples.length < MIN_REPORTS) return null;
  const mean = (samples.reduce((a, b) => a + b, 0) + PRIOR_WEIGHT * baseOpenAfter) / (samples.length + PRIOR_WEIGHT);
  const [lo, hi] = OPEN_BOUNDS;
  return { openAfterSec: Math.round(Math.min(hi, Math.max(lo, mean)) / 5) * 5, n: samples.length };
}

/**
 * The lead the reports point to, or null if there aren't enough usable ones.
 * `baseLead` is what the entry says; reports made before leads were recorded
 * are taken to have been made under it.
 */
export function leadFromReports(reports, baseLead, control = 'unknown', now = Date.now()) {
  const since = now - DAYS * 86_400_000;
  const samples = [];
  for (const r of reports) {
    if (Date.parse(r.at) < since) continue;
    const e = leadError(r, control, r.lead ?? baseLead);
    if (e == null) continue;
    samples.push((r.lead ?? baseLead) + e);
  }
  if (samples.length < MIN_REPORTS) return null;
  const mean = (samples.reduce((a, b) => a + b, 0) + PRIOR_WEIGHT * baseLead) / (samples.length + PRIOR_WEIGHT);
  const [lo, hi] = BOUNDS[control] ?? BOUNDS.unknown;
  return { leadSec: Math.round(Math.min(hi, Math.max(lo, mean)) / 10) * 10, n: samples.length };
}
