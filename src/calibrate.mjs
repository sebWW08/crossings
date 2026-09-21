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
const MAX_ERR_SEC = 360;
// The rule's own value counts as this many extra "it was fine" reports, so
// three taps nudge a crossing and a fortnight of them move it.
const PRIOR_WEIGHT = 3;
const BOUNDS = { signaller: [45, 420], automatic: [20, 120], unknown: [30, 300] };
const OPEN_BOUNDS = [10, 120];
// A reopening more than two minutes off isn't the reopen delay — it's a
// closure that was really two trains, or one we couldn't see.
const OPEN_MAX_ERR_SEC = 120;

/** Seconds by which the lead should have been longer (+) or shorter (−), or null if the tap says nothing about it. */
export function leadError(r) {
  const at = Date.parse(r.at);
  if (!Number.isFinite(at) || r.closeAt == null || r.openAt == null) return null;
  const agreed = (r.observed === 'down') === (r.predicted === 'closed');
  if (agreed) return 0;
  if (r.observed === 'down') {
    // Down before the page expected the next closure to start.
    const early = (r.closeAt - at) / 1000;
    return early > 0 && early <= MAX_ERR_SEC ? early : null;
  }
  // Up during a predicted closure: only the first half says "not closed yet"
  // (the second half would mean it reopened early — a different knob).
  if (at > (r.closeAt + r.openAt) / 2) return null;
  const late = (at - r.closeAt) / 1000;
  return late >= 0 && late <= MAX_ERR_SEC ? -late : null;
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
  if (r.predicted === 'closed' && r.closeAt != null && r.openAt != null) {
    if (at <= (r.closeAt + r.openAt) / 2) return null; // the lead's business
    const early = (r.openAt - at) / 1000;
    if (r.observed === 'up') return early <= OPEN_MAX_ERR_SEC ? -early || 0 : null;
    return 0; // still down, as predicted
  }
  if (r.prevOpenAt != null) {
    const since = (at - r.prevOpenAt) / 1000;
    if (since < 0 || since > OPEN_MAX_ERR_SEC) return null;
    if (r.observed === 'down') return since;           // predicted open, still down
    return since <= 180 ? 0 : null;                     // up soon after: it did reopen
  }
  return null;
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
    const e = leadError(r);
    if (e == null) continue;
    samples.push((r.lead ?? baseLead) + e);
  }
  if (samples.length < MIN_REPORTS) return null;
  const mean = (samples.reduce((a, b) => a + b, 0) + PRIOR_WEIGHT * baseLead) / (samples.length + PRIOR_WEIGHT);
  const [lo, hi] = BOUNDS[control] ?? BOUNDS.unknown;
  return { leadSec: Math.round(Math.min(hi, Math.max(lo, mean)) / 10) * 10, n: samples.length };
}
