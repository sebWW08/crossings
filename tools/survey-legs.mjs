#!/usr/bin/env node
// Read the Darwin board of every station near a crossing and keep the legs
// (consecutive calls) the trains on them make, so each generated direction
// also reads the board where a fast train first stops after the road.
//
//   node --env-file=.env tools/survey-legs.mjs [--offset MIN] [--rate PER_SEC] [--only id]
//
// A board shows the next two hours, so one run sees what runs at this time
// of day; run it at a few different times (weekday peak, midday, weekend) to
// catch the patterns that only run then. The server keeps learning as it
// runs (src/legs.mjs), so this is the head start, not the whole story.
// Merges into data/legs.json.

import { readRegistry } from '../src/registry-files.mjs';
import { learn, loadLegsFile, saveLegsFile, legCount, missingBoards } from '../src/legs.mjs';

const KEY = process.env.DARWIN_API_KEY;
if (!KEY) { console.error('DARWIN_API_KEY not set (run with --env-file=.env)'); process.exit(2); }
const BASE = (process.env.DARWIN_ARRIVALS_URL ||
  'https://api1.raildata.org.uk/1010-live-arrival-and-departure-boards-arr-and-dep1_1/LDBWS/api/20220120/GetArrDepBoardWithDetails'
).replace(/\/$/, '');

const a = process.argv.slice(2);
const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const offset = Number(get('--offset', 0));
const rate = Number(get('--rate', 15)); // RDM trips its spike arrest well below its 100/s headline
const only = get('--only');
// How far out each side to read: far enough that a train skipping every
// small station near the road still calls somewhere we look.
const DEPTH = Number(get('--depth', 10));

const registry = readRegistry().filter((c) => !only || c.id === only);
const stations = new Set();
for (const c of registry) {
  for (const d of c.directions) {
    for (const b of d.boards ?? [d.board]) stations.add(b.crs);
    for (const s of (d.via ?? []).slice(0, DEPTH)) stations.add(s);
    for (const s of (d.beyond ?? []).slice(0, DEPTH)) stations.add(s);
    for (const r of d.references ?? []) stations.add(r.crs);
  }
}
const before = loadLegsFile();
console.log(`${registry.length} crossings, ${stations.size} stations to read; ${legCount()} legs known (${before} from data/legs.json)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function board(crs, tries = 3) {
  const url = `${BASE}/${crs}?numRows=150&timeWindow=120${offset ? `&timeOffset=${offset}` : ''}`;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { 'x-apikey': KEY, accept: 'application/json' } }).catch((e) => ({ ok: false, status: 0, e }));
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500 || res.status === 0) { await sleep(2000 * (i + 1)); continue; }
    return null; // 400/404: not a station Darwin knows
  }
  return null;
}

const list = [...stations];
let done = 0, fresh = 0, failed = 0;
const started = Date.now();
await Promise.all(Array.from({ length: 6 }, async (_, w) => {
  for (let i = w; i < list.length; i += 6) {
    // Pace the whole pool to `rate` requests a second.
    const due = started + (i / rate) * 1000;
    if (due > Date.now()) await sleep(due - Date.now());
    const b = await board(list[i]);
    if (b) fresh += learn(b); else failed++;
    if (++done % 250 === 0) console.log(`  ${done}/${list.length} read, ${fresh} new legs`);
  }
}));
saveLegsFile();
console.log(`read ${done - failed}/${list.length} boards (${failed} failed) in ${Math.round((Date.now() - started) / 1000)} s; ${fresh} new legs, ${legCount()} in all`);

// What it changes: directions that gain a board.
let dirs = 0, crossings = 0;
const examples = [];
for (const c of registry) {
  let hit = false;
  for (const d of c.directions) {
    const add = missingBoards(c, d);
    if (!add.length) continue;
    dirs++; hit = true;
    if (examples.length < 25) examples.push(`${c.id} ${d.key}: +${add.join(',')} (reads ${(d.boards ?? [d.board]).map((b) => b.crs).join(',')})`);
  }
  if (hit) crossings++;
}
console.log(`${crossings} crossings (${dirs} directions) have trains whose first stop after the road is on no board they read`);
for (const e of examples) console.log('  ' + e);
