// "Was this right?" — what people at the crossing actually saw, kept next to
// what we predicted at that moment. This is the calibration data the run
// times and closeBeforeSec will be tuned from. Each report is one JSON line
// in data/feedback.jsonl, echoed to the log, and posted to FEEDBACK_WEBHOOK
// if set (for hosts whose disk does not survive a restart).
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, '..', 'data', 'feedback.jsonl');
const WEBHOOK = process.env.FEEDBACK_WEBHOOK || '';
// The hourly GitHub Action keeps a copy of recent reports on the `stats`
// branch (see .github/workflows/stats.yml); a fresh process starts from it,
// so a deploy doesn't forget what people saw at the barrier.
const SEED_URL = process.env.FEEDBACK_SEED_URL ?? 'https://raw.githubusercontent.com/sebWW08/crossings/stats/feedback.json';
const KEEP_DAYS = 60;

/** Every report we know of, newest last. Calibration reads this. */
const reports = [];
const seen = new Set();
let version = 0;
const key = (r) => `${r.at}|${r.crossing}`;
function remember(r) {
  if (seen.has(key(r))) return false;
  seen.add(key(r));
  reports.push(r);
  version++;
  return true;
}
export const reportsVersion = () => version;
export const reportsFor = (crossingId) => reports.filter((r) => r.crossing === crossingId);
/** Recent reports without anything about the person (no user agent). */
export function recent(days = KEEP_DAYS, now = Date.now()) {
  const since = now - days * 86_400_000;
  return reports.filter((r) => Date.parse(r.at) >= since).map(({ ua, ...r }) => r);
}

export async function load() {
  try {
    const res = await fetch(SEED_URL, { signal: AbortSignal.timeout(8000), headers: { 'cache-control': 'no-cache' } });
    if (res.ok) { let n = 0; for (const r of await res.json()) if (r?.at && r.crossing && remember(r)) n++; if (n) console.log(`feedback: seeded ${n} report(s) from ${SEED_URL}`); }
  } catch (e) {
    console.warn('feedback: could not seed', e.message);
  }
  try {
    const { readFile } = await import('node:fs/promises');
    for (const line of (await readFile(FILE, 'utf8')).split('\n')) { if (line.trim()) { try { remember(JSON.parse(line)); } catch { /* a bad line */ } } }
  } catch { /* first run, or no disk */ }
  reports.sort((a, b) => a.at.localeCompare(b.at));
}

const OBSERVED = new Set(['down', 'up']);
const PREDICTED = new Set(['open', 'soon', 'closed']);

/** Shape-check a report from the page; returns the clean record or null. */
export function cleanReport(body, crossing, now = Date.now()) {
  if (!body || typeof body !== 'object' || !crossing) return null;
  if (!OBSERVED.has(body.observed) || !PREDICTED.has(body.predicted)) return null;
  const num = (x) => (Number.isFinite(x) ? Math.round(x) : null);
  return {
    at: new Date(now).toISOString(),
    crossing: crossing.id,
    observed: body.observed,              // what they saw: barriers down / up
    predicted: body.predicted,            // what the page said: open / soon / closed
    lead: crossing.closeBeforeSec,        // the lead in force when they tapped, so the error is relative to it
    openAfter: crossing.openAfterSec,     // …and the reopen delay
    prevOpenAt: num(body.prevOpenAt),     // when the page thought the last closure ended (ms epoch), if recently
    predictedAt: num(body.predictedAt),   // the closure edge the page was counting to (ms epoch)
    closeAt: num(body.closeAt),           // the closure that was current or next…
    openAt: num(body.openAt),             // …so the error can be measured later
    trains: Array.isArray(body.trains)    // what the page thought was coming: length, held, basis
      ? body.trains.slice(0, 4).map((t) => ({
        id: String(t?.id ?? '').slice(0, 40), basis: String(t?.basis ?? '').slice(0, 40),
        coaches: num(t?.coaches), assumed: !!t?.assumed, held: !!t?.held,
      }))
      : [],
    dataAge: num(body.dataAge),           // ms since the page last refreshed
    live: !!body.live,
    ua: String(body.ua ?? '').slice(0, 120),
  };
}

// One report per crossing per client every 30 s is plenty; anything faster
// is a stuck finger or a script.
const lastTap = new Map();
export function tooSoon(key, now = Date.now()) {
  const last = lastTap.get(key) ?? 0;
  if (now - last < 30_000) return true;
  lastTap.set(key, now);
  if (lastTap.size > 5000) for (const [k, t] of lastTap) if (now - t > 60_000) lastTap.delete(k);
  return false;
}

export async function record(report) {
  remember(report);
  const line = JSON.stringify(report);
  console.log('feedback', line);
  try {
    await mkdir(path.dirname(FILE), { recursive: true });
    await appendFile(FILE, line + '\n');
  } catch (e) {
    console.warn('feedback: could not write file', e.message);
  }
  if (WEBHOOK) {
    fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: line, signal: AbortSignal.timeout(5000) })
      .catch((e) => console.warn('feedback: webhook failed', e.message));
  }
}
