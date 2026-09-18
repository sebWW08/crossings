import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'data', 'crossings.json');

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

// The registry is re-read whenever the file changes, so a long generator
// run (or a hand edit) shows up without restarting the server.
let loadedAt = 0;
/** @type {Array<import('./types').Crossing>} */
let list = [];
let byId = new Map();
function load() {
  const mtime = statSync(file).mtimeMs;
  if (mtime === loadedAt) return;
  list = JSON.parse(readFileSync(file, 'utf8')).map(expandBoards);
  byId = new Map(list.map((c) => [c.id, c]));
  loadedAt = mtime;
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
    station: c.station ? { crs: c.station.crs, name: c.station.name } : null,
    parallel: c.parallel ?? false,
    nr: c.nr ? { name: c.nr.name, type: c.nr.type, elr: c.nr.elr, miles: c.nr.miles, chains: c.nr.chains } : null,
  };
}
