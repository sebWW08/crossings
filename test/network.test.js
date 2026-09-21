import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, stationIndex, buildEntry, clusterCrossings, mergeRegistry, lineSpeedMps, compass, isRoadCrossing, platformExtent, sides, applyNR } from '../tools/network.mjs';

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

// Platforms drawn beside the line: 20–200 m east of the crossing, offset
// 5 m north of the track, plus a stray one 300 m away sideways.
function platformsEastOf(p) {
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180), ky = 111_320;
  const at = (dxM, dyM) => [p.lat + dyM / ky, p.lon + dxM / kx];
  return [
    { id: 1, pts: [at(20, 5), at(200, 5)] },
    { id: 2, pts: [at(20, -5), at(110, -5), at(110, -8), at(20, -8)] }, // shorter one as an area
    { id: 3, pts: [at(50, 300), at(150, 300)] },                        // not this line
    { id: 4, pts: [at(-400, 5), at(-700, 5)] },                         // the next station west, longer
  ];
}

test('platformExtent measures platform ends along the track, per side', () => {
  const { elements, crossingNode } = toy();
  const graph = buildGraph(elements);
  const p = graph.nodes.get(crossingNode);
  const split = sides(graph, crossingNode);
  const ext = platformExtent(graph, crossingNode, split, platformsEastOf(p));
  const east = split[0].bearing < 180 ? 0 : 1; // whichever side of the split points east
  assert.ok(ext[east], 'platforms found east');
  assert.ok(Math.abs(ext[east].startM - 20) <= 2 && Math.abs(ext[east].endM - 200) <= 2, JSON.stringify(ext[east]));
  assert.ok(ext[1 - east] && ext[1 - east].startM >= 398, 'the next station is measured too…');
});

test('a station with platforms gets platformsSide and distances from them, not the node bearing', () => {
  const { elements, stations, crossingNode } = toy();
  const graph = buildGraph(elements);
  const p = graph.nodes.get(crossingNode);
  // Station node placed WEST of the road, platforms EAST: geometry wins.
  const index = stationIndex([...stations, { crs: 'XXX', name: 'X', lat: p.lat, lon: p.lon - 0.0008 }]);
  const args = { graph, index, nodeId: crossingNode, tags: {}, highways: [{ tags: { highway: 'residential', name: 'Station Road' } }] };
  assert.equal(buildEntry(args).entry.station.platformsSide, 'west');
  const { entry } = buildEntry({ ...args, platforms: platformsEastOf(p) });
  assert.equal(entry.station.platformsSide, 'east'); // …but the nearest platforms are this station's
  assert.ok(Math.abs(entry.station.platformStartM - 20) <= 2);
  assert.ok(Math.abs(entry.station.platformEndM - 200) <= 2);
  assert.equal(entry.station.holdDuringDwell, false);
  assert.match(entry.notes, /Platforms 2\d–\d{3} m east/);
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

test('applyNR: a signaller-controlled crossing holds through a stop and closes early; an automatic one does not', () => {
  const base = { name: 'X', notes: '', station: { crs: 'XXX', platformsSide: 'east', holdDuringDwell: false, dwellSec: 40 } };
  const cctv = applyNR(base, { uid: 1, name: 'X CCTV', type: 'CCTV', d: 5 });
  assert.equal(cctv.control, 'signaller');
  assert.equal(cctv.closeBeforeSec, 150);
  assert.equal(cctv.station.holdDuringDwell, true);
  const ahb = applyNR(base, { uid: 2, name: 'X AHB', type: 'AHB', d: 5 });
  assert.equal(ahb.control, 'automatic');
  assert.equal(ahb.closeBeforeSec, 40);
  assert.equal(ahb.station.holdDuringDwell, false);
  const gates = applyNR({ name: 'Y', notes: '' }, { uid: 3, name: 'Y MGH', type: 'MGH', d: 5 });
  assert.equal(gates.control, 'signaller');
  assert.equal(gates.closeBeforeSec, 120);
});

test('overrides sit on top of an entry and merge into station{}', async () => {
  const { applyOverride } = await import('../src/registry-files.mjs');
  const entry = { id: 'x', closeBeforeSec: 150, station: { crs: 'XXX', holdDuringDwell: true, dwellSec: 40 } };
  const out = applyOverride(entry, { closeBeforeSec: 240, station: { dwellSec: 60 }, calibration: 'seen' });
  assert.deepEqual(out, { id: 'x', closeBeforeSec: 240, station: { crs: 'XXX', holdDuringDwell: true, dwellSec: 60 }, calibration: 'seen' });
  assert.equal(applyOverride(entry, undefined), entry);
});
