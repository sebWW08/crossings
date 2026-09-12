import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'data', 'crossings.json');

/** @type {Array<import('./types').Crossing>} */
export const crossings = JSON.parse(readFileSync(file, 'utf8'));

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
