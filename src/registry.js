import { statSync } from 'node:fs';
import { readRegistry, HAND, GENERATED, OVERRIDES } from './registry-files.mjs';
import { reportsFor, reportsVersion } from './feedback.mjs';
import { leadFromReports, openAfterFromReports } from './calibrate.mjs';
import { missingBoards, legsVersion, loadLegsFile } from './legs.mjs';

/**
 * A generated direction lists several `boards` (the next few stations, so
 * that fast trains skipping the nearest one are still seen somewhere). The
 * predictor works one board at a time, so expand those into one direction
 * per board, each with its board as the negative-offset fallback reference.
 */
export function expandBoards(crossing) {
  const directions = crossing.directions.flatMap((dir) => {
    if (!dir.boards) return [dir];
    const { boards, ...rest } = dir;
    return boards.map((b) => ({
      ...rest,
      board: { crs: b.crs, name: b.name },
      references: [...dir.references, { crs: b.crs, name: b.name, minutesToCrossing: -b.min }],
    }));
  });
  return { ...crossing, directions };
}

/**
 * The boards the trains themselves say this crossing needs (src/legs.mjs):
 * the first stop after the road of every train seen going over it, where
 * that isn't a board the entry already reads. Not on a line paralleled by a
 * faster one — trains on the other line would look as if they came this way.
 */
export function withLearntBoards(crossing) {
  if (crossing.parallel || !crossing.times) return crossing;
  let changed = false;
  const directions = crossing.directions.map((dir) => {
    const add = missingBoards(crossing, dir);
    if (!add.length) return dir;
    changed = true;
    const min = (crs) => Math.round((crossing.times[crs] + 0.5) * 2) / 2;
    return { ...dir, boards: [...dir.boards, ...add.map((crs) => ({ crs, name: crs, min: min(crs), learnt: true }))] };
  });
  return changed ? { ...crossing, directions } : crossing;
}

// The registry is re-read whenever either file changes, so a generator run
// (or a hand edit) shows up without restarting the server.
let loadedAt = '';
/** @type {Array<import('./types').Crossing>} */
let list = [];
let byId = new Map();
let legsLoaded = false;
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
function load() {
  if (!legsLoaded) { loadLegsFile(); legsLoaded = true; }
  const stamp = `${mtime(HAND)}/${mtime(GENERATED)}/${mtime(OVERRIDES)}`;
  if (stamp === loadedAt) return;
  list = readRegistry();
  byId = new Map(list.map((c) => [c.id, c]));
  loadedAt = stamp;
}

// Each entry as the predictor sees it: learnt boards added, one direction
// per board, then calibrated from the taps. Recomputed when the registry,
// the legs or the reports change.
const cooked = new Map(); // id -> { v, entry }
function cook(c) {
  if (!c) return null;
  const v = `${loadedAt}/${legsVersion()}/${reportsVersion()}`;
  const hit = cooked.get(c.id);
  if (hit?.v === v) return hit.entry;
  const entry = withTaps(expandBoards(withLearntBoards(c)));
  cooked.set(c.id, { v, entry });
  return entry;
}

// What people saw at the barrier, applied on top of the entry: once a
// crossing has a few usable reports, its lead is theirs, not the rule's.
function withTaps(c) {
  const reports = reportsFor(c.id);
  const lead = leadFromReports(reports, c.closeBeforeSec, c.control);
  const open = openAfterFromReports(reports, c.openAfterSec);
  const entry = lead || open
    ? {
      ...c,
      ...(lead ? { closeBeforeSec: lead.leadSec } : {}),
      ...(open ? { openAfterSec: open.openAfterSec } : {}),
      calibrated: {
        leadSec: lead ? lead.leadSec : c.closeBeforeSec, was: c.closeBeforeSec,
        openAfterSec: open ? open.openAfterSec : c.openAfterSec, wasOpenAfter: c.openAfterSec,
        reports: Math.max(lead?.n ?? 0, open?.n ?? 0),
      },
    }
    : c;
  return entry;
}

export function allCrossings() {
  load();
  return list.map(cook);
}

export function getCrossing(id) {
  load();
  return cook(byId.get(id) ?? null);
}

/** Every station within `depth` calls of a crossing, either side: what the
 *  background sweep reads to learn legs (src/darwin.js). */
export function surveyStations(depth = 10) {
  load();
  const out = new Set();
  for (const c of list) {
    for (const d of c.directions) {
      for (const b of d.boards ?? [d.board]) out.add(b.crs);
      for (const s of (d.via ?? []).slice(0, depth)) out.add(s);
      for (const s of (d.beyond ?? []).slice(0, depth)) out.add(s);
    }
  }
  return [...out];
}

/** Public summary — what the list/map page needs, nothing operational. */
export function summarise(c) {
  return {
    id: c.id,
    name: c.name,
    road: c.road,
    line: c.line,
    lat: c.lat,
    lon: c.lon,
    barrierType: c.barrierType,
    control: c.control ?? 'unknown',
    calibrated: c.calibrated ?? null,
    station: c.station ? { crs: c.station.crs, name: c.station.name } : null,
    parallel: c.parallel ?? false,
    nr: c.nr ? { name: c.nr.name, type: c.nr.type, elr: c.nr.elr, miles: c.nr.miles, chains: c.nr.chains } : null,
  };
}
