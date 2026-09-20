import { statSync } from 'node:fs';
import { readRegistry, HAND, GENERATED } from './registry-files.mjs';

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
  const stamp = `${mtime(HAND)}/${mtime(GENERATED)}`;
  if (stamp === loadedAt) return;
  list = readRegistry().map(expandBoards);
  byId = new Map(list.map((c) => [c.id, c]));
  loadedAt = stamp;
}

export function allCrossings() {
  load();
  return list;
}

export function getCrossing(id) {
  load();
  return byId.get(id) ?? null;
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
    station: c.station ? { crs: c.station.crs, name: c.station.name } : null,
    parallel: c.parallel ?? false,
    nr: c.nr ? { name: c.nr.name, type: c.nr.type, elr: c.nr.elr, miles: c.nr.miles, chains: c.nr.chains } : null,
  };
}
