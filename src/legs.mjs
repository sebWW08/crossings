// Which boards to read for a crossing, learnt from the trains themselves.
//
// A generated direction reads the arrivals boards of the next few stations
// beyond the road, but a fast train whose first stop after the road is
// further out than that is on none of them and brings the barriers down
// unseen. At Warblington every Portsmouth & Southsea–Brighton runs from
// Havant to Chichester, nine minutes on, past Emsworth, Southbourne and
// Nutbourne — the three boards eastbound read — and was down on a
// "was this right?" tap while the page said open (25 Sep, 12:13).
//
// Darwin can't say which trains pass a place, only where they call. So
// every board read — the pages' own and a slow background sweep — is mined
// for legs: consecutive calls X then Y, with their scheduled minutes. A leg
// from X on the near side of a crossing to Y beyond it is a train that went
// over the road in between, and Y's arrivals board is where it shows up, so
// Y joins that direction's boards. Legs are kept in data/legs.json (seeded
// by tools/survey-legs.mjs) plus whatever the running server learns, which
// the hourly Action keeps on the `stats` branch like the feedback.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const LEGS_FILE = path.join(here, '..', 'data', 'legs.json');
const SEED_URL = process.env.LEGS_SEED_URL ?? 'https://raw.githubusercontent.com/sebWW08/crossings/stats/legs.json';

/** "X>Y" -> [scheduled minutes, last seen YYYY-MM-DD] */
const legs = new Map();
/** X -> Set of Y, for looking legs up from the near side. */
const from = new Map();
function put(x, y, min, day) {
  const k = `${x}>${y}`;
  const cur = legs.get(k);
  if (cur) { if (min < cur[0]) cur[0] = min; if (day > cur[1]) cur[1] = day; return 0; }
  legs.set(k, [min, day]);
  let ys = from.get(x);
  if (!ys) from.set(x, (ys = new Set()));
  ys.add(y);
  return 1;
}
let version = 0;
export const legsVersion = () => version;
export const legCount = () => legs.size;

const CRS = /^[A-Z]{3}$/; // Darwin writes "???" for a call it can't name
const clock = (s) => { const m = /^(\d\d):(\d\d)$/.exec(s ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const calls = (groups) => (Array.isArray(groups) ? groups : []).map((g) => (Array.isArray(g?.callingPoint) ? g.callingPoint : []));

/**
 * Every pair of consecutive calls on a board, as [X, Y, minutes]. Portions
 * that join or split are separate groups, and each is its own run into or
 * out of the board's station, so pairs never straddle two of them.
 */
export function legsOnBoard(board) {
  const out = [];
  const here = board?.crs;
  for (const svc of board?.trainServices ?? []) {
    if (svc.isCancelled) continue;
    const me = here && { crs: here, st: svc.std ?? svc.sta };
    const runs = [
      ...calls(svc.previousCallingPoints).map((g) => (me ? [...g, me] : g)),
      ...calls(svc.subsequentCallingPoints).map((g) => (me ? [me, ...g] : g)),
    ];
    for (const run of runs) {
      const live = run.filter((c) => CRS.test(c?.crs ?? '') && !c.isCancelled);
      for (let i = 0; i + 1 < live.length; i++) {
        const [x, y] = [live[i], live[i + 1]];
        if (x.crs === y.crs) continue;
        const a = clock(x.st), b = clock(y.st);
        if (a == null || b == null) continue;
        out.push([x.crs, y.crs, (b - a + 1440) % 1440]);
      }
    }
  }
  return out;
}

const today = (now) => new Date(now).toISOString().slice(0, 10);

/** Fold legs into the store; returns how many were new. */
export function addLegs(list, now = Date.now()) {
  let fresh = 0;
  const day = today(now);
  for (const [x, y, min] of list) fresh += put(x, y, min, day);
  if (fresh) version++;
  return fresh;
}

export const learn = (board, now = Date.now()) => addLegs(legsOnBoard(board), now);

/** Legs in the file format: { "X>Y": [minutes, lastSeen] }. */
export function legsSnapshot() {
  return Object.fromEntries([...legs].sort(([a], [b]) => a.localeCompare(b)));
}

function merge(obj) {
  let fresh = 0;
  for (const [k, v] of Object.entries(obj ?? {})) {
    const [x, y] = k.split('>');
    if (!CRS.test(x ?? '') || !CRS.test(y ?? '') || !Array.isArray(v) || !Number.isFinite(v[0])) continue;
    fresh += put(x, y, v[0], String(v[1] ?? ''));
  }
  if (fresh) version++;
  return fresh;
}

export function loadLegsFile(file = LEGS_FILE) {
  try { const { _, ...o } = JSON.parse(readFileSync(file, 'utf8')); return merge(o); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
}

export function saveLegsFile(file = LEGS_FILE) {
  const body = Object.entries(legsSnapshot()).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n');
  writeFileSync(file, `{"_":"Consecutive calls (X>Y) seen on Darwin boards: [scheduled minutes, last seen]. A leg from the near side of a crossing to beyond it adds Y to that direction's boards. Written by tools/survey-legs.mjs; the server learns more as it runs.",\n${body}\n}\n`);
}

/** What the running server has learnt since the last deploy, from the stats branch. */
export async function seedLegs() {
  try {
    const res = await fetch(SEED_URL, { signal: AbortSignal.timeout(8000), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return 0;
    const n = merge(await res.json());
    if (n) console.log(`legs: seeded ${n} leg(s) from ${SEED_URL}`);
    return n;
  } catch (e) {
    console.warn('legs: could not seed', e.message);
    return 0;
  }
}

/** Test hook. */
export function resetLegs(obj = {}) { legs.clear(); from.clear(); merge(obj); version++; }

// Legs this far off schedule for the run via the road went some other way
// (the same test the predictor applies to a train, see crossingLeg).
const viaRoad = (crossing, x, y, min) => {
  if (crossing.bypass?.[x]?.includes(y)) return false;
  const tx = crossing.times?.[x], ty = crossing.times?.[y];
  if (tx == null || ty == null) return true;
  const run = tx + ty;
  return min >= 0.5 * run && min <= 2 * run + 5;
};

// A leg not seen for this long has gone from the timetable (a diversion, a
// withdrawn pattern), and its board with it.
const MAX_AGE_DAYS = 60;

/**
 * Stations beyond the road that some train reaches straight from the near
 * side and that `dir` doesn't read yet — each one a board to add. Needs the
 * direction's `via` and `beyond` and the crossing's `times`.
 */
export function missingBoards(crossing, dir, now = Date.now()) {
  if (!dir.beyond || !dir.via) return [];
  const since = today(now - MAX_AGE_DAYS * 86_400_000);
  const have = new Set((dir.boards ?? [dir.board]).map((b) => b.crs));
  const beyond = new Set(dir.beyond);
  const out = new Set();
  for (const x of dir.via) {
    for (const y of from.get(x) ?? []) {
      if (have.has(y) || out.has(y) || !beyond.has(y)) continue;
      const [min, seen] = legs.get(`${x}>${y}`);
      if (seen >= since && viaRoad(crossing, x, y, min)) out.add(y);
    }
  }
  // Nearest first, as the generator orders them.
  return [...out].sort((a, b) => (crossing.times?.[a] ?? 99) - (crossing.times?.[b] ?? 99));
}
