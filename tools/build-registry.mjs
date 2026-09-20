#!/usr/bin/env node
// Generate registry entries for every road level crossing in a bounding box.
//
//   node tools/build-registry.mjs --extract data/cache/osm-uk.json [--bbox S,W,N,E] [--dry-run] [--only id]
//   node tools/build-registry.mjs --bbox S,W,N,E [--margin 25] [--tile 0.5,1] [--dry-run] [--only id]
//
// Crossings come from OpenStreetMap; the surrounding track is walked to find
// the stations either side. The whole-country way is --extract: a JSON file
// made by tools/extract-osm.mjs from a Geofabrik PBF, read locally in one
// go. The older way asks Overpass for a bbox (+ margin) — it won't serve a
// whole region's track at once, so --tile splits the box into lat×lon degree
// tiles fetched and walked one at a time. Results are merged into
// data/crossings.json: hand-written entries always win. Overpass responses
// are cached in data/cache/ because Overpass is slow and flaky.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegistry, writeRegistry, GENERATED } from '../src/registry-files.mjs';
import { buildGraph, stationIndex, platformIndex, buildEntry, clusterCrossings, isRoadCrossing, mergeRegistry, matchNR, applyNR, NR_ROAD_TYPES } from './network.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, '..', 'data', 'cache');
const NR = path.join(here, '..', 'data', 'source', 'nr-crossings.json');

const UA = 'crossings-registry-builder/0.1 (https://github.com/sebWW08/crossings; level-crossing wait times)';
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

function args() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const bbox = get('--bbox');
  const extract = get('--extract');
  if (!bbox && !extract) { console.error('usage: build-registry (--extract osm.json | --bbox S,W,N,E [--margin km] [--tile lat,lon]) [--dry-run] [--only id]'); process.exit(2); }
  const [s, w, n, e] = bbox ? bbox.split(',').map(Number) : [-90, -180, 90, 180];
  const tile = get('--tile');
  return {
    extract,
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

async function fetchPlatforms(box) {
  const raw = await overpass(`[out:json][timeout:180];
      way["railway"="platform"](${fmt(box)});
      out geom;`, 'platforms');
  return raw.elements.filter((el) => el.geometry?.length >= 2).map((el) => ({ id: el.id, pts: el.geometry.map((g) => [g.lat, g.lon]) }));
}

async function fetchNetwork(box) {
  const raw = await overpass(`[out:json][timeout:300][maxsize:1073741824];
      way["railway"="rail"]["service"!~"^(yard|siding|spur)$"](${fmt(box)});
      out body; >; out skel qt;`, 'network');
  return buildGraph(raw.elements);
}

const inBox = (p, b) => p.lat >= b.s && p.lat <= b.n && p.lon >= b.w && p.lon <= b.e;

/** Generate entries for the crossings inside one tile, walking that tile's track. */
function buildTile(graph, index, crossings, box, nr, platforms = platformIndex([])) {
  const byNode = new Map();
  for (const w of crossings.highways) for (const n of w.nodes) (byNode.get(n) ?? byNode.set(n, []).get(n)).push(w);
  const highwaysAt = (ids) => [...new Set(ids.flatMap((id) => byNode.get(id) ?? []))];
  const generated = [];
  const skipped = {};
  const directCache = new Map();
  for (const cluster of clusterCrossings(crossings.nodes.filter((n) => inBox(n, box)))) {
    const ids = cluster.members.map((m) => m.id);
    const hw = highwaysAt(ids);
    // Network Rail's word beats OSM's road tagging: a CCTV or barrier crossing
    // on what OSM calls a track or an unnamed service road is still a crossing
    // people drive over (port and works accesses, farm lanes with gates).
    const m = matchNR(nr, cluster.at);
    const nrRoad = m && m.d <= 30 && m.type in NR_ROAD_TYPES;
    const roads = hw.filter(isRoadCrossing);
    if (!roads.length && !nrRoad) { skipped['not a public road'] = (skipped['not a public road'] ?? 0) + 1; continue; }
    // Walk from a member node on a running line — the plain-line one first;
    // a node on a spur or crossover beside it may lead nowhere.
    const onLine = ids.filter((id) => graph.adj.has(id));
    if (!onLine.length) { skipped['not on a running line'] = (skipped['not on a running line'] ?? 0) + 1; continue; }
    const plain = (id) => (graph.waysByNode.get(id) ?? []).some((w) => !w.tags.service);
    let r;
    for (const nodeId of onLine.sort((a, b) => plain(b) - plain(a))) {
      r = buildEntry({ graph, index, nodeId, tags: cluster.primary.tags, highways: roads.length ? roads : hw, at: cluster.at, directCache, platforms: platforms.near(cluster.at) });
      if (!r.skip) break;
    }
    if (r.skip) { skipped[r.skip] = (skipped[r.skip] ?? 0) + 1; continue; }
    const entry = applyNR(r.entry, m);
    if (!entry) { skipped[`Network Rail lists it as ${m.type}`] = (skipped[`Network Rail lists it as ${m.type}`] ?? 0) + 1; continue; }
    generated.push(entry);
  }
  console.error(`generated ${generated.length} crossings; skipped:`, skipped);
  return generated;
}

/** Whole-country run from a tools/extract-osm.mjs file: one graph, one pass. */
async function fromExtract({ extract, bbox, dryRun, only }) {
  const data = JSON.parse(await readFile(extract, 'utf8'));
  const nr = JSON.parse(await readFile(NR, 'utf8').catch(() => '[]'));
  console.error(`${data.source} extracted ${data.extracted.slice(0, 10)}: ${data.ways.length} rail ways, ${data.nodes.length} nodes, ${data.stations.length} stations, ${data.crossings.nodes.length} crossing nodes`);
  const graph = buildGraph([...data.ways, ...data.nodes.map(([id, lat, lon]) => ({ type: 'node', id, lat, lon }))]);
  const stations = data.stations.map((el) => ({
    crs: el.tags['ref:crs'].toUpperCase(),
    name: el.tags.name ?? el.tags['ref:crs'],
    lat: el.lat ?? el.center.lat,
    lon: el.lon ?? el.center.lon,
  }));
  const index = stationIndex(stations);
  console.error(`graph: ${graph.nodes.size} nodes`);
  const platforms = platformIndex(data.platforms ?? []);
  if (!data.platforms) console.error('extract has no platforms (re-run tools/extract-osm.mjs): platformsSide will be guessed from station nodes');
  const generated = buildTile(graph, index, data.crossings, bbox, nr, platforms);
  // A whole-country run is authoritative: anything generated earlier that it
  // did not produce again has gone (retagged in OSM, or NR now calls it a
  // footpath). A --bbox run only touches its box, like the Overpass path.
  const { registry, stats } = mergeRegistry(readRegistry(), generated, { dropOthers: bbox.s === -90 });
  console.error('merge:', stats);
  return { registry, stats, unique: generated };
}

async function main() {
  const { extract, bbox, margin, tile, dryRun, only } = args();
  if (extract) return finish(await fromExtract({ extract, bbox, dryRun, only }), { dryRun, only });
  // Stations and crossings are small lists: one query for the whole region.
  // Track is the bulk, so it goes tile by tile (each with its own margin).
  const stations = await fetchStations(grow(bbox, margin));
  const index = stationIndex(stations);
  const crossings = await fetchCrossings(bbox);
  const nr = JSON.parse(await readFile(NR, 'utf8').catch(() => '[]'));
  console.error(`${stations.length} stations, ${crossings.nodes.length} crossing nodes in the region`);

  const boxes = tile ? tiles(bbox, tile) : [bbox];
  const generated = [];
  const failed = [];
  // A crossing exactly on a tile edge can come back from both tiles.
  const seen = new Set();
  const unique = () => generated.filter((g) => !seen.has(g.osm) && seen.add(g.osm));
  // Merge into the registry as we go: a country-sized run takes hours and
  // Overpass can drop out at any point, so every finished tile is saved.
  const merge = async () => {
    const { registry, stats } = mergeRegistry(readRegistry(), unique());
    generated.length = 0;
    if (!dryRun && !only) writeRegistry(registry);
    return { registry, stats };
  };
  let registry, stats;
  // Only stations with a CRS code are any use to us, so tiles with none
  // nearby (sea, and the French coast) are skipped along with empty ones.
  const hasStation = (box) => stations.some((st) => inBox(st, grow(box, margin)));
  const queue = boxes.filter((box) => crossings.nodes.some((n) => inBox(n, box)) && hasStation(box));
  let done = 0;
  while (queue.length) {
    const box = queue.shift();
    if (boxes.length > 1) console.error(`\n== tile ${++done} (${queue.length} to go): ${fmt(box)}`);
    try {
      const graph = await fetchNetwork(grow(box, margin));
      console.error(`graph: ${graph.nodes.size} nodes`);
      generated.push(...buildTile(graph, index, crossings, box, nr, platformIndex(await fetchPlatforms(grow(box, margin)))));
      if (!only) ({ registry, stats } = await merge(), console.error('merge:', stats));
    } catch (e) {
      // Overpass gives up on big responses when it is busy: try the tile
      // again as four quarters (with the same margin), down to 1/8 degree.
      if (box.n - box.s > 0.126) {
        const quarters = tiles(box, [r3((box.n - box.s) / 2), r3((box.e - box.w) / 2)]);
        console.error(`tile ${fmt(box)} failed (${e.message.slice(0, 60)}); splitting into ${quarters.length}`);
        queue.unshift(...quarters.filter((q) => crossings.nodes.some((n) => inBox(n, q))));
      } else {
        console.error(`tile ${fmt(box)} failed: ${e.message}`);
        failed.push(fmt(box));
      }
    }
  }
  if (failed.length) console.error(`\n${failed.length} tile(s) failed — re-run for: ${failed.join(' ; ')}`);
  if (only) ({ registry } = await merge());
  await finish({ registry, written: !dryRun && !only }, { dryRun, only });
}

async function finish({ registry, written = false }, { dryRun, only }) {
  if (only) {
    const hit = registry.find((c) => String(c.osm) === only || c.name === only || c.id === only);
    console.log(JSON.stringify(hit, null, 2));
    return;
  }
  if (dryRun) {
    for (const c of registry.filter((c) => c.generated)) {
      console.log(`${c.id.padEnd(32)} ${c.barrierType.padEnd(8)} ${c.directions.map((d) => `${d.key}→${d.boards.map((b) => b.crs).join('/')}`).join(' ')}  ${c.line}`);
    }
    return;
  }
  if (!written) writeRegistry(registry);
  console.error(`wrote ${registry.length} crossings (${registry.filter((c) => c.generated).length} to ${path.relative(process.cwd(), GENERATED)})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
