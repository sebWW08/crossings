import { readFileSync } from 'node:fs';
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

/** @type {Array<import('./types').Crossing>} */
export const crossings = JSON.parse(readFileSync(file, 'utf8')).map(expandBoards);

const byId = new Map(crossings.map((c) => [c.id, c]));

export function getCrossing(id) {
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
  };
}
