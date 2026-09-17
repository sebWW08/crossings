#!/usr/bin/env node
// Generate registry entries for every road level crossing in a bounding box.
//
//   node tools/build-registry.mjs --bbox S,W,N,E [--margin 25] [--tile 0.5,1] [--dry-run] [--only id]
//
// Crossings come from OpenStreetMap; the surrounding track (bbox + margin) is
// walked to find the stations either side. Overpass won't serve a whole
// region's track at once, so --tile splits the box into lat×lon degree tiles
// fetched and walked one at a time (each with its own margin). Results are merged into
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
  const tile = get('--tile');
  return {
    bbox: { s, w, n, e },
    margin: Number(get('--margin', 25)),
    tile: tile ? tile.split(',').map(Number) : null,
    dryRun: a.includes('--dry-run'),
    only: get('--only'),
  };
}

const fmt = (b) => `${b.s},${b.w},${b.n},${b.e}`;
const r3 = (x) => Math.round(x * 1000) / 1000;
function tiles(b, [dLat, dLon]) {
  const out = [];
  for (let s = b.s; s < b.n; s = r3(s + dLat)) {
    for (let w = b.w; w < b.e; w = r3(w + dLon)) out.push({ s, w, n: r3(Math.min(s + dLat, b.n)), e: r3(Math.min(w + dLon, b.e)) });
  }
  return out;
}
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

async function fetchStations(box) {
  const raw = await overpass(`[out:json][timeout:180];
      nwr["railway"~"^(station|halt)$"]["ref:crs"]["ref:crs"!~"^Z"](${fmt(box)});
      out center tags;`, 'stations');
  return raw.elements.map((el) => ({
    crs: el.tags['ref:crs'].toUpperCase(),
    name: el.tags.name ?? el.tags['ref:crs'],
    lat: el.lat ?? el.center.lat,
    lon: el.lon ?? el.center.lon,
  }));
}

async function fetchCrossings(box) {
  const raw = await overpass(`[out:json][timeout:180];
      node["railway"="level_crossing"](${fmt(box)})->.x;
      .x out body;
      way(bn.x)["highway"];
      out body;`, 'crossings');
  return {
    nodes: raw.elements.filter((el) => el.type === 'node'),
    highways: raw.elements.filter((el) => el.type === 'way'),
  };
}

async function fetchNetwork(box) {
  const raw = await overpass(`[out:json][timeout:300][maxsize:1073741824];
      way["railway"="rail"]["service"!~"^(yard|siding|spur)$"](${fmt(box)});
      out body; >; out skel qt;`, 'network');
  return buildGraph(raw.elements);
}

const inBox = (p, b) => p.lat >= b.s && p.lat <= b.n && p.lon >= b.w && p.lon <= b.e;

/** Generate entries for the crossings inside one tile, walking that tile's track. */
function buildTile(graph, index, crossings, box) {
  const highwaysAt = (ids) => crossings.highways.filter((w) => w.nodes.some((n) => ids.includes(n)));
  const generated = [];
  const skipped = {};
  const directCache = new Map();
  for (const cluster of clusterCrossings(crossings.nodes.filter((n) => inBox(n, box)))) {
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
  return generated;
}

async function main() {
  const { bbox, margin, tile, dryRun, only } = args();
  // Stations and crossings are small lists: one query for the whole region.
  // Track is the bulk, so it goes tile by tile (each with its own margin).
  const stations = await fetchStations(grow(bbox, margin));
  const index = stationIndex(stations);
  const crossings = await fetchCrossings(bbox);
  console.error(`${stations.length} stations, ${crossings.nodes.length} crossing nodes in the region`);

  const boxes = tile ? tiles(bbox, tile) : [bbox];
  const generated = [];
  const failed = [];
  for (const [i, box] of boxes.entries()) {
    if (!crossings.nodes.some((n) => inBox(n, box))) continue; // sea, mostly
    if (boxes.length > 1) console.error(`\n== tile ${i + 1}/${boxes.length}: ${fmt(box)}`);
    try {
      const graph = await fetchNetwork(grow(box, margin));
      console.error(`graph: ${graph.nodes.size} nodes`);
      generated.push(...buildTile(graph, index, crossings, box));
    } catch (e) {
      console.error(`tile ${fmt(box)} failed: ${e.message}`);
      failed.push(fmt(box));
    }
  }
  if (failed.length) console.error(`\n${failed.length} tile(s) failed — re-run for: ${failed.join(' ; ')}`);
  // A crossing exactly on a tile edge can come back from both tiles.
  const seen = new Set();
  const unique = generated.filter((g) => !seen.has(g.osm) && seen.add(g.osm));

  const existing = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const { registry, stats } = mergeRegistry(existing, unique);
  console.error('merge:', stats);

  if (only) {
    const hit = unique.find((c) => String(c.osm) === only || c.name === only) ?? registry.find((c) => c.id === only);
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
