// Cookieless counting, so we can tell whether anyone is using this and
// where they came from. Per day (Europe/London): how many people looked
// at each crossing, how they arrived (direct link to a crossing, the home
// page, the map), which sites sent them, whether the device had been here
// before, and how many "was this right?" taps. A person is a hash of
// address + browser + the day + a salt, so the same phone polling every
// 30 s counts once and nothing links one day to the next. Kept in memory,
// written to data/stats.json now and then, and summarised to the log each
// day, since the host's disk does not survive a deploy.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, '..', 'data', 'stats.json');
const KEEP_DAYS = 90;
const MAX_KEYS = 20_000; // per map per day: a bot storm shouldn't eat the heap

const dayOf = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/London' }); // YYYY-MM-DD

let salt = randomBytes(16).toString('hex');
let days = {};      // day -> { landings, referrers, polls, feedback, visitors: { total, new, byCrossing }, crossings }
let seen = new Map(); // day -> Set of visitor hashes (site-wide), plus per-crossing sets
let dirty = false;

function bucket(day) {
  if (!days[day]) {
    days[day] = { landings: {}, referrers: {}, crossings: {}, feedback: {}, visitors: 0, newDevices: 0, polls: 0 };
    seen.set(day, { site: new Set(), byCrossing: new Map() });
    const old = Object.keys(days).sort();
    while (old.length > KEEP_DAYS) { const d = old.shift(); delete days[d]; seen.delete(d); }
  }
  return days[day];
}

const bump = (map, key) => {
  if (map[key] != null) map[key]++;
  else if (Object.keys(map).length < MAX_KEYS) map[key] = 1;
};

/** Who this is for today only — never stored, never the same tomorrow. */
export function visitorHash(req, day = dayOf()) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || '';
  const ua = req.headers['user-agent'] ?? '';
  return createHash('sha256').update(`${salt}|${day}|${ip}|${ua}`).digest('hex').slice(0, 16);
}

const BOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|curl|wget|uptime|render/i;
export const isBot = (req) => BOT.test(req.headers['user-agent'] ?? '');

/** An HTML page load: where they landed and where from. */
export function landing(req, kind, day = dayOf()) {
  if (isBot(req)) return;
  const b = bucket(day);
  bump(b.landings, kind);
  const ref = req.headers.referer;
  if (ref) {
    try {
      const host = new URL(ref).hostname.replace(/^www\./, '');
      if (host && host !== (req.headers.host ?? '').replace(/^www\./, '').split(':')[0]) bump(b.referrers, host);
    } catch { /* not a URL */ }
  }
  dirty = true;
}

/** A crossing being watched (its API polled). `device` is "new" or "ret" from the page. */
export function watched(req, crossingId, device, day = dayOf()) {
  if (isBot(req)) return;
  const b = bucket(day);
  const s = seen.get(day);
  const h = visitorHash(req, day);
  b.polls++;
  if (!s.site.has(h)) {
    if (s.site.size < MAX_KEYS) s.site.add(h);
    b.visitors++;
    if (device === 'new') b.newDevices++;
  }
  const per = s.byCrossing.get(crossingId) ?? s.byCrossing.set(crossingId, new Set()).get(crossingId);
  if (!per.has(h)) {
    if (per.size < MAX_KEYS) per.add(h);
    bump(b.crossings, crossingId);
  }
  dirty = true;
}

export function feedbackTap(crossingId, day = dayOf()) {
  bump(bucket(day).feedback, crossingId);
  dirty = true;
}

/** Everything, most recent day first. Aggregates only: nothing in here is about a person. */
export function snapshot() {
  const out = {};
  for (const d of Object.keys(days).sort().reverse()) {
    const b = days[d];
    const top = (m, n = 20) => Object.fromEntries(Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, n));
    out[d] = { visitors: b.visitors, newDevices: b.newDevices, polls: b.polls, landings: b.landings, referrers: top(b.referrers), crossings: top(b.crossings, 50), feedback: b.feedback };
  }
  return out;
}

export async function load() {
  try {
    const saved = JSON.parse(await readFile(FILE, 'utf8'));
    if (saved.salt) salt = saved.salt;
    days = saved.days ?? {};
    for (const d of Object.keys(days)) seen.set(d, { site: new Set(), byCrossing: new Map() });
    // Today's hashes come back too, so a restart mid-day doesn't count everyone twice.
    const t = saved.seen;
    if (t?.day && days[t.day]) seen.set(t.day, { site: new Set(t.site), byCrossing: new Map(Object.entries(t.byCrossing).map(([k, v]) => [k, new Set(v)])) });
  } catch { /* first run, or no disk */ }
}

export async function save() {
  if (!dirty) return;
  dirty = false;
  try {
    await mkdir(path.dirname(FILE), { recursive: true });
    const day = dayOf();
    const t = seen.get(day);
    const today = t ? { day, site: [...t.site], byCrossing: Object.fromEntries([...t.byCrossing].map(([k, v]) => [k, [...v]])) } : null;
    await writeFile(FILE, JSON.stringify({ salt, days, seen: today }));
  } catch (e) {
    console.warn('stats: could not write', e.message);
  }
}

/** One log line per day so the numbers outlive the disk. */
export function logDay(day) {
  const b = days[day];
  if (b) console.log('stats', JSON.stringify({ day, ...snapshot()[day] }));
}

let lastDay = dayOf();
/** Periodic save, and a summary line when the day turns over or the process is told to stop. */
export function start({ everyMs = 5 * 60_000 } = {}) {
  const tick = async () => {
    const today = dayOf();
    if (today !== lastDay) { logDay(lastDay); lastDay = today; }
    await save();
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  const bye = async () => { logDay(lastDay); await save(); process.exit(0); };
  process.once('SIGTERM', bye);
  process.once('SIGINT', bye);
  return timer;
}
