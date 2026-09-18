#!/usr/bin/env node
// Re-match every generated registry entry against Network Rail's crossing
// list (data/source/nr-crossings.json) without touching Overpass. The
// generator does this as it goes; this is for entries built before the list
// existed, or after the list is refreshed.
//
//   node tools/enrich-nr.mjs [--dry-run]

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchNR, applyNR, NR_ROAD_TYPES } from './network.mjs';
import { readRegistry, writeRegistry } from '../src/registry-files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NR = path.join(here, '..', 'data', 'source', 'nr-crossings.json');

const dryRun = process.argv.includes('--dry-run');
const nr = JSON.parse(await readFile(NR, 'utf8'));
const registry = readRegistry();

const stats = { matched: 0, unmatched: 0, dropped: 0, hand: 0, typeChanged: 0 };
const out = registry.flatMap((c) => {
  if (!c.generated) {
    // Hand-written entries keep their own name and barrier type; the NR
    // record is attached for reference (and for spotting disagreements).
    stats.hand++;
    const m = matchNR(nr, c);
    if (m && NR_ROAD_TYPES[m.type] !== c.barrierType) console.error(`${c.id}: hand says ${c.barrierType}, Network Rail says ${m.type} (${m.name})`);
    return [m ? { ...c, nr: { uid: m.uid, name: m.name, type: m.type, status: m.status, elr: m.elr, miles: m.miles, chains: m.chains, distM: m.d } } : c];
  }
  const m = matchNR(nr, c);
  if (!m) { stats.unmatched++; console.error(`no NR match: ${c.id} (${c.name})`); return [applyNR(c, null)]; }
  const e = applyNR({ ...c, nameFromRoad: c.nameFromRoad ?? (!c.station && c.name.includes(c.road)) }, m);
  if (!e) { stats.dropped++; console.error(`dropped ${c.id}: Network Rail lists it as ${m.type} (${m.name})`); return []; }
  stats.matched++;
  if (e.barrierType !== c.barrierType) { stats.typeChanged++; console.error(`${c.id}: ${c.barrierType} → ${e.barrierType} (${m.name})`); }
  return [e];
});
console.error(stats);
if (!dryRun) writeRegistry(out);
