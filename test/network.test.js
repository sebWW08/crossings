import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, stationIndex, buildEntry, clusterCrossings, mergeRegistry, lineSpeedMps, compass, isRoadCrossing } from '../tools/network.mjs';

// A west–east line with a junction east of the crossing:
//
//   A ──── X ──── B ──┬── C
//   (west)  (cross)   └── D (north-east branch)
//
// Nodes every ~1 km at 60 mph.
const km = 1 / 111; // degrees latitude per km
function toy() {
  const nodes = [];
  const way = (id, ids, tags = { railway: 'rail', maxspeed: '60 mph' }) => ({ type: 'way', id, nodes: ids, tags });
  const n = (id, lat, lon, tags) => { nodes.push({ type: 'node', id, lat, lon, tags }); return id; };
  // main line, lon increases eastwards; 1 km ≈ km/cos(51°) degrees of longitude
  const dl = km / Math.cos((51 * Math.PI) / 180);
  const main = [];
  for (let i = 0; i <= 10; i++) main.push(n(100 + i, 51, -1 + i * dl, i === 5 ? { railway: 'level_crossing', 'crossing:barrier': 'double_half' } : undefined));
  const branch = [main[8]];
  for (let i = 1; i <= 3; i++) branch.push(n(200 + i, 51 + i * km * 0.7, -1 + (8 + i * 0.7) * dl));
  const elements = [...nodes, way(1, main), way(2, branch)];
  const stations = [
    { crs: 'AAA', name: 'A', lat: 51, lon: -1 + 1 * dl },
    { crs: 'BBB', name: 'B', lat: 51, lon: -1 + 7 * dl },
    { crs: 'CCC', name: 'C', lat: 51, lon: -1 + 10 * dl },
    { crs: 'DDD', name: 'D', lat: 51 + 3 * km * 0.7, lon: -1 + (8 + 3 * 0.7) * dl },
  ];
  return { elements, stations, crossingNode: 105 };
}

test('lineSpeedMps parses mph and km/h, defaults by usage', () => {
  assert.ok(Math.abs(lineSpeedMps({ maxspeed: '60 mph' }) - 26.8) < 0.1);
  assert.ok(Math.abs(lineSpeedMps({ maxspeed: '100' }) - 27.8) < 0.2);
  assert.ok(lineSpeedMps({ usage: 'main' }) > lineSpeedMps({ usage: 'branch' }));
});

test('compass quantises bearings', () => {
  assert.equal(compass(10), 'north');
  assert.equal(compass(100), 'east');
  assert.equal(compass(350), 'north');
  assert.equal(compass(45, 8), 'northeast');
});

test('isRoadCrossing drops footpaths, tracks and unnamed private ways', () => {
  assert.equal(isRoadCrossing({ tags: { highway: 'footway' } }), false);
  assert.equal(isRoadCrossing({ tags: { highway: 'track' } }), false);
  assert.equal(isRoadCrossing({ tags: { highway: 'service', access: 'private' } }), false);
  assert.equal(isRoadCrossing({ tags: { highway: 'service', access: 'private', name: 'Mill Lane' } }), true);
  assert.equal(isRoadCrossing({ tags: { highway: 'service' } }), false);
  assert.equal(isRoadCrossing({ tags: { highway: 'service', name: 'Depot Approach' } }), true);
  assert.equal(isRoadCrossing({ tags: { highway: 'unclassified', name: 'Station Road' } }), true);
});

test('buildEntry walks both sides, one board per branch, references on the other side', () => {
  const { elements, stations, crossingNode } = toy();
  const graph = buildGraph(elements);
  const index = stationIndex(stations);
  const { entry, skip } = buildEntry({ graph, index, nodeId: crossingNode, tags: graph.nodes.get(crossingNode).tags, highways: [{ tags: { highway: 'unclassified', name: 'Station Road' } }] });
  assert.equal(skip, undefined);
  assert.equal(entry.barrierType, 'full');
  assert.equal(entry.closeBeforeSec, 90);
  assert.equal(entry.road, 'Station Road');
  assert.equal(entry.name, 'Station Road (B)'); // qualified by the nearest station
  assert.equal(entry.station, undefined);

  // Eastbound: boards are B and, beyond it, C and D (both branches).
  const east = entry.directions.filter((d) => d.key === 'east');
  assert.equal(east.length, 1);
  assert.deepEqual(east[0].boards.map((b) => b.crs), ['BBB', 'CCC', 'DDD']);
  assert.equal(east[0].towards, 'B');
  assert.equal(east[0].enters, 'west');
  assert.deepEqual(east[0].via, ['AAA']);
  assert.deepEqual(east[0].beyond, ['BBB', 'CCC', 'DDD']);
  assert.deepEqual(east[0].references.map((r) => r.crs), ['AAA']);
  // 4 km at 48 mph (60 × 0.8) ≈ 3.1 min + 0.5 pad → 3.5
  assert.equal(east[0].references[0].minutesToCrossing, 3.5);
  assert.equal(east[0].boards[0].min, 2);

  // Westbound: board is A; trains must have come via B (or C / D beyond it).
  const west = entry.directions.filter((d) => d.key === 'west');
  assert.equal(west.length, 1);
  assert.deepEqual(west[0].boards.map((b) => b.crs), ['AAA']);
  assert.deepEqual(west[0].via, ['BBB', 'CCC', 'DDD']);
  // References: B (root) and its children C and D — nearest first.
  assert.deepEqual(west[0].references.map((r) => r.crs), ['BBB', 'CCC', 'DDD']);

  // Run times for every station on the line, for schedule interpolation.
  assert.deepEqual(Object.keys(entry.times).sort(), ['AAA', 'BBB', 'CCC', 'DDD']);
  assert.ok(Math.abs(entry.times.AAA - 3.1) < 0.1);
});

test('a station at the crossing goes into station{} and both via lists', () => {
  const { elements, stations, crossingNode } = toy();
  const graph = buildGraph(elements);
  const p = graph.nodes.get(crossingNode);
  const index = stationIndex([...stations, { crs: 'XXX', name: 'X', lat: p.lat + 0.0005, lon: p.lon + 0.0003 }]);
  const { entry } = buildEntry({ graph, index, nodeId: crossingNode, tags: {}, highways: [{ tags: { highway: 'residential', name: 'Station Road' } }] });
  assert.equal(entry.station.crs, 'XXX');
  assert.equal(entry.name, 'X');
  assert.ok(['east', 'west'].includes(entry.station.platformsSide));
  for (const d of entry.directions) assert.equal(d.via[0], 'XXX');
});

test('clusterCrossings merges the per-track node pair', () => {
  const a = { id: 1, lat: 51, lon: -1, tags: { railway: 'level_crossing', name: 'Mill Lane' } };
  const b = { id: 2, lat: 51.00003, lon: -1, tags: { railway: 'level_crossing' } };
  const c = { id: 3, lat: 51.01, lon: -1, tags: { railway: 'level_crossing' } };
  const groups = clusterCrossings([b, a, c]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].primary.id, 1); // the better-tagged node leads
  assert.equal(groups[0].members.length, 2);
});

test('mergeRegistry keeps hand entries, reuses ids, suppresses duplicates of hand entries', () => {
  const hand = { id: 'liss', name: 'Liss', lat: 51.04332, lon: -0.89336 };
  const oldGen = { id: 'mill-lane', osm: 7, generated: true, name: 'Mill Lane', lat: 51.2, lon: -0.5 };
  const farAway = { id: 'elsewhere', osm: 99, generated: true, name: 'Elsewhere', lat: 52, lon: 0 };
  const gen = [
    { osm: 7, generated: true, name: 'Mill Lane (renamed)', lat: 51.2, lon: -0.5 },
    { osm: 8, generated: true, name: 'Liss', lat: 51.04335, lon: -0.89330 }, // same spot as the hand entry
    { osm: 9, generated: true, name: 'Liss', lat: 51.3, lon: -0.4 },        // name clash only
  ];
  const { registry, stats } = mergeRegistry([hand, oldGen, farAway], gen);
  assert.deepEqual(stats, { kept: 2, updated: 1, added: 1, suppressed: 1, dropped: 0 });
  assert.deepEqual(registry.map((c) => c.id).sort(), ['elsewhere', 'liss', 'liss-2', 'mill-lane']);
  assert.equal(registry.find((c) => c.id === 'mill-lane').name, 'Mill Lane (renamed)');
});
