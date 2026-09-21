import { statSync } from 'node:fs';
import { readRegistry, HAND, GENERATED, OVERRIDES } from './registry-files.mjs';
import { reportsFor, reportsVersion } from './feedback.mjs';
import { leadFromReports, openAfterFromReports } from './calibrate.mjs';

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

// The registry is re-read whenever either file changes, so a generator run
// (or a hand edit) shows up without restarting the server.
let loadedAt = '';
/** @type {Array<import('./types').Crossing>} */
let list = [];
let byId = new Map();
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
function load() {
  const stamp = `${mtime(HAND)}/${mtime(GENERATED)}/${mtime(OVERRIDES)}`;
  if (stamp === loadedAt) return;
  list = readRegistry().map(expandBoards);
  byId = new Map(list.map((c) => [c.id, c]));
  loadedAt = stamp;
}

// What people saw at the barrier, applied on top of the entry: once a
// crossing has a few usable reports, its lead is theirs, not the rule's.
// Recomputed when the registry or the reports change.
const calibrated = new Map(); // id -> { version, entry }
function withTaps(c) {
  if (!c) return c;
  const v = `${loadedAt}/${reportsVersion()}`;
  const hit = calibrated.get(c.id);
  if (hit && hit.version === v) return hit.entry;
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
  calibrated.set(c.id, { version: v, entry });
  return entry;
}

export function allCrossings() {
  load();
  return list.map(withTaps);
}

export function getCrossing(id) {
  load();
  return withTaps(byId.get(id) ?? null);
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
