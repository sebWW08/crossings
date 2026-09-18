#!/usr/bin/env node
// Pull the railway out of an OpenStreetMap PBF extract (e.g. Geofabrik's
// united-kingdom-latest.osm.pbf) into one JSON file the registry generator
// can read instead of asking Overpass tile by tile:
//
//   node tools/extract-osm.mjs data/source/united-kingdom-latest.osm.pbf [data/cache/osm-uk.json]
//
// Two passes over the file. The first keeps every tagged object we care
// about (running-line ways, stations, level crossing nodes, the roads over
// them) and notes which blocks hold which node ids; the second decodes only
// the blocks that contain the ~2M coordinates those ways reference.

import { writeFile } from 'node:fs/promises';
import { blocks } from './pbf.mjs';

const [src, dst = 'data/cache/osm-uk.json'] = process.argv.slice(2);
if (!src) { console.error('usage: extract-osm <file.osm.pbf> [out.json]'); process.exit(2); }

const progress = (label) => {
  let last = -1;
  return (p) => { const pct = Math.floor(p * 20) * 5; if (pct !== last) { last = pct; process.stderr.write(`\r${label}: ${pct}%   `); } };
};

const STATION = /^(station|halt)$/;
const isStation = (t) => t && STATION.test(t.railway) && t['ref:crs'] && !/^Z/.test(t['ref:crs']);

// ---------- pass 1: tagged objects ----------
const crossingNodes = [];           // { id, lat, lon, tags }
const crossingIds = new Set();
const stationNodes = [];            // { id, lat, lon, tags }
const stationWays = [];             // { id, nodes, tags }
const railWays = [];                // { id, nodes, tags }
const highways = [];                // roads through a crossing node
const nodeBlocks = [];              // { offset, min, max } — dense node id ranges per block
const needed = new Set();

for await (const { offset, block } of blocks(src, { onProgress: progress('pass 1 (tagged objects)') })) {
  let min = Infinity, max = -Infinity, any = false;
  block.nodes((id, lat, lon, tags) => {
    any = true;
    if (id < min) min = id;
    if (id > max) max = id;
    if (!tags) return;
    if (tags.railway === 'level_crossing') { crossingNodes.push({ type: 'node', id, lat, lon, tags }); crossingIds.add(id); }
    else if (isStation(tags)) stationNodes.push({ type: 'node', id, lat, lon, tags });
  });
  if (any) nodeBlocks.push({ offset, min, max });
  block.ways((id, refs, tags) => {
    if (!tags) return;
    if (tags.railway === 'rail') {
      railWays.push({ type: 'way', id, nodes: refs, tags });
      for (const r of refs) needed.add(r);
    } else if (isStation(tags)) {
      stationWays.push({ id, nodes: refs, tags });
      for (const r of refs) needed.add(r);
    } else if (tags.highway && refs.some((r) => crossingIds.has(r))) {
      highways.push({ type: 'way', id, nodes: refs, tags });
    }
  });
}
console.error(`\n${railWays.length} rail ways, ${stationNodes.length}+${stationWays.length} stations, ${crossingNodes.length} crossing nodes, ${highways.length} roads over them; ${needed.size} coordinates to fetch`);

// ---------- pass 2: coordinates ----------
const sorted = Float64Array.from(needed).sort();
const firstAtOrAbove = (x) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; } return lo; };
const wanted = new Set(nodeBlocks.filter(({ min, max }) => { const i = firstAtOrAbove(min); return i < sorted.length && sorted[i] <= max; }).map((b) => b.offset));
console.error(`${wanted.size} of ${nodeBlocks.length} node blocks hold them`);

const coords = new Map();
for await (const { block } of blocks(src, { only: wanted, onProgress: progress('pass 2 (coordinates)') })) {
  block.nodes((id, lat, lon) => { if (needed.has(id)) coords.set(id, [lat, lon]); });
}
console.error(`\n${coords.size} coordinates found (${needed.size - coords.size} missing — nodes outside the extract)`);

// Station ways → a centre point, like Overpass's `out center`.
const stations = [...stationNodes];
for (const w of stationWays) {
  const pts = w.nodes.map((n) => coords.get(n)).filter(Boolean);
  if (!pts.length) continue;
  stations.push({ type: 'way', id: w.id, center: { lat: pts.reduce((s, p) => s + p[0], 0) / pts.length, lon: pts.reduce((s, p) => s + p[1], 0) / pts.length }, tags: w.tags });
}

const out = {
  source: src.split('/').pop(),
  extracted: new Date().toISOString(),
  ways: railWays,
  nodes: [...coords].map(([id, [lat, lon]]) => [id, Math.round(lat * 1e7) / 1e7, Math.round(lon * 1e7) / 1e7]),
  stations,
  crossings: { nodes: crossingNodes, highways },
};
await writeFile(dst, JSON.stringify(out));
console.error(`wrote ${dst}`);
