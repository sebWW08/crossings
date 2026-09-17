#!/usr/bin/env node
// Generate registry entries for every road level crossing in a bounding box.
//
//   node tools/build-registry.mjs --bbox S,W,N,E [--margin 25] [--dry-run] [--only id]
//
// Crossings come from OpenStreetMap; the surrounding track (bbox + margin) is
// walked to find the stations either side. Results are merged into
// data/crossings.json: hand-written entries always win. Overpass responses are
// cached in data/cache/ because Overpass is slow and flaky.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, stationIndex, buildEntry, clusterCrossings, isRoadCrossing, mergeRegistry } from './network.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(here, '..', 'data', 'crossings.json');
const CACHE = path.join(here, '..', 'data', 'cache');

const UA = 'crossings-registry-builder/0.1 (https://github.com/seb/crossings; level-crossing wait times)';
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

function args() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const bbox = get('--bbox');
  if (!bbox) { console.error('usage: build-registry --bbox S,W,N,E [--margin km] [--dry-run] [--only id]'); process.exit(2); }
  const [s, w, n, e] = bbox.split(',').map(Number);
  return { bbox: { s, w, n, e }, margin: Number(get('--margin', 25)), dryRun: a.includes('--dry-run'), only: get('--only') };
}

const fmt = (b) => `${b.s},${b.w},${b.n},${b.e}`;
function grow(b, km) {
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos((((b.s + b.n) / 2) * Math.PI) / 180));
  return { s: b.s - dLat, w: b.w - dLon, n: b.n + dLat, e: b.e + dLon };
}

async function overpass(query, label) {
  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, `${label}-${createHash('sha1').update(query).digest('hex').slice(0, 10)}.json`);
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* not cached */ }
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      process.stderr.write(`overpass ${label}: ${new URL(url).host} …`);
      const res = await fetch(url, { method: 'POST', body: `data=${encodeURIComponent(query)}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, signal: AbortSignal.timeout(300_000) });
      const text = await res.text();
      if (!res.ok || !text.trimStart().startsWith('{')) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
      const data = JSON.parse(text);
      process.stderr.write(` ${data.elements.length} elements\n`);
      await writeFile(file, text);
      return data;
    } catch (e) {
      lastErr = e;
      process.stderr.write(` failed (${e.message.slice(0, 80)})\n`);
      await new Promise((r) => setTimeout(r, 15_000 + attempt * 5_000));
    }
  }
  throw lastErr;
}

async function main() {
  const { bbox, margin, dryRun, only } = args();
  const wide = grow(bbox, margin);

  // One query at a time: the public mirrors rate-limit parallel requests.
  const network = await overpass(`[out:json][timeout:300][maxsize:1073741824];
      way["railway"="rail"]["service"!~"^(yard|siding|spur)$"](${fmt(wide)});
      out body; >; out skel qt;`, 'network');
  const stationsRaw = await overpass(`[out:json][timeout:120];
      nwr["railway"~"^(station|halt)$"]["ref:crs"]["ref:crs"!~"^Z"](${fmt(wide)});
      out center tags;`, 'stations');
  const crossingsRaw = await overpass(`[out:json][timeout:120];
      node["railway"="level_crossing"](${fmt(bbox)})->.x;
      .x out body;
      way(bn.x)["highway"];
      out body;`, 'crossings');

  const graph = buildGraph(network.elements);
  const stations = stationsRaw.elements.map((el) => ({
    crs: el.tags['ref:crs'].toUpperCase(),
    name: el.tags.name ?? el.tags['ref:crs'],
    lat: el.lat ?? el.center.lat,
    lon: el.lon ?? el.center.lon,
  }));
  const index = stationIndex(stations);
  console.error(`graph: ${graph.nodes.size} nodes, ${graph.adj.size} linked; ${stations.length} stations`);

  const nodes = crossingsRaw.elements.filter((el) => el.type === 'node');
  const highways = crossingsRaw.elements.filter((el) => el.type === 'way');
  const highwaysAt = (ids) => highways.filter((w) => w.nodes.some((n) => ids.includes(n)));

  const generated = [];
  const skipped = {};
  const directCache = new Map();
  for (const cluster of clusterCrossings(nodes)) {
    const ids = cluster.members.map((m) => m.id);
    const hw = highwaysAt(ids);
    if (!hw.some(isRoadCrossing)) { skipped['not a public road'] = (skipped['not a public road'] ?? 0) + 1; continue; }
    // Any member node on a running line will do for the walk.
    const nodeId = ids.find((id) => graph.adj.has(id));
    if (!nodeId) { skipped['not on a running line'] = (skipped['not on a running line'] ?? 0) + 1; continue; }
    const r = buildEntry({ graph, index, nodeId, tags: cluster.primary.tags, highways: hw.filter(isRoadCrossing), at: cluster.at, directCache });
    if (r.skip) { skipped[r.skip] = (skipped[r.skip] ?? 0) + 1; continue; }
    generated.push(r.entry);
  }
  console.error(`generated ${generated.length} crossings; skipped:`, skipped);

  const existing = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const { registry, stats } = mergeRegistry(existing, generated);
  console.error('merge:', stats);

  if (only) {
    const hit = generated.find((c) => String(c.osm) === only || c.name === only) ?? registry.find((c) => c.id === only);
    console.log(JSON.stringify(hit, null, 2));
    return;
  }
  if (dryRun) {
    for (const c of registry.filter((c) => c.generated)) {
      console.log(`${c.id.padEnd(32)} ${c.barrierType.padEnd(8)} ${c.directions.map((d) => `${d.key}→${d.boards.map((b) => b.crs).join('/')}`).join(' ')}  ${c.line}`);
    }
    return;
  }
  await writeFile(REGISTRY, JSON.stringify(registry, null, 1) + '\n');
  console.error(`wrote ${registry.length} crossings to ${path.relative(process.cwd(), REGISTRY)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
