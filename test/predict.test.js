import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict, mergeClosures, crossingLeg, legFraction, fromStop, stationWindow, trainCoaches } from '../src/predict.js';
import { parseClock, resolveCall, fmtClock } from '../src/time.js';
import { mockBoard } from '../src/mock.js';
import { getCrossing, expandBoards } from '../src/registry.js';

const liss = getCrossing('liss');
const now = new Date('2026-09-12T11:00:00Z'); // 12:00 BST
const at = (mins) => fmtClock(new Date(now.getTime() + mins * 60_000));

test('parseClock pins HH:MM to today in Europe/London', () => {
  assert.equal(parseClock('12:05', now).getTime(), now.getTime() + 5 * 60_000);
  assert.equal(parseClock('11:00', now).getTime(), now.getTime() - 60 * 60_000);
  // 23:50 seen at 00:10 is ten minutes ago, not tomorrow
  const late = new Date('2026-09-12T23:10:00Z'); // 00:10 BST next day
  assert.equal(parseClock('23:50', late).getTime(), late.getTime() - 20 * 60_000);
});

test('resolveCall prefers actual, then estimate, then schedule', () => {
  assert.equal(resolveCall({ st: '12:00', et: 'On time' }, now).time.getTime(), now.getTime());
  assert.equal(resolveCall({ st: '12:00', et: '12:04' }, now).time.getTime(), now.getTime() + 4 * 60_000);
  assert.equal(resolveCall({ st: '12:00', et: '12:04', at: '12:03' }, now).actual, true);
  assert.equal(resolveCall({ st: '12:00', et: 'Delayed' }, now).uncertain, true);
  assert.equal(resolveCall({ st: '12:00', et: 'Cancelled' }, now), null);
});

test('non-stop northbound train: Petersfield departure + run time', () => {
  const boards = {
    HSL: { trainServices: [{
      serviceID: 'a', sta: at(13), eta: 'On time', operator: 'SWR',
      origin: [{ locationName: 'Portsmouth Harbour', crs: 'PMH' }],
      destination: [{ locationName: 'London Waterloo', crs: 'WAT' }],
      previousCallingPoints: [{ callingPoint: [
        { locationName: 'Havant', crs: 'HAV', st: at(-10), at: at(-10) },
        { locationName: 'Petersfield', crs: 'PTR', st: at(1), et: 'On time' },
      ] }],
    }] },
    PTR: { trainServices: [] },
  };
  const p = predict(liss, boards, now);
  assert.equal(p.movements.length, 1);
  const m = p.movements[0];
  assert.equal(m.stops, false);
  assert.equal(m.basis, 'PTR +3.5 min');
  // crosses at 12:04:30; a CCTV crossing closes 150 s before, opens 30 s after
  assert.equal(m.closeAt, now.getTime() + 4.5 * 60_000 - 150_000);
  assert.equal(m.openAt, now.getTime() + 4.5 * 60_000 + 30_000);
  assert.equal(p.state, 'open');
  assert.equal(p.next.closeAt, m.closeAt);
});

test('train that has already left Petersfield uses the actual time and can be "closed" now', () => {
  const boards = {
    HSL: { trainServices: [{
      serviceID: 'b', sta: at(6), eta: at(6),
      origin: [{ locationName: 'Portsmouth Harbour', crs: 'PMH' }],
      destination: [{ locationName: 'London Waterloo', crs: 'WAT' }],
      previousCallingPoints: [{ callingPoint: [
        { locationName: 'Petersfield', crs: 'PTR', st: at(-4), at: at(-3) },
      ] }],
    }] },
    PTR: { trainServices: [] },
  };
  const p = predict(liss, boards, now);
  assert.equal(p.state, 'closed'); // crosses at 12:00:30, window 11:59:00–12:01:00
  assert.equal(p.movements[0].actual, true);
});

test('stopping southbound train: platforms before the barriers; CCTV holds it down from before arrival', () => {
  const boards = {
    HSL: { trainServices: [] },
    PTR: { trainServices: [{
      serviceID: 'c', sta: at(15), eta: 'On time',
      origin: [{ locationName: 'London Waterloo', crs: 'WAT' }],
      destination: [{ locationName: 'Portsmouth Harbour', crs: 'PMH' }],
      previousCallingPoints: [{ callingPoint: [
        { locationName: 'Liphook', crs: 'LIP', st: at(4), et: 'On time' },
        { locationName: 'Liss', crs: 'LIS', st: at(10), et: 'On time' },
      ] }],
    }] },
  };
  const m = predict(liss, boards, now).movements[0];
  assert.equal(m.stops, true);
  assert.equal(m.basis, 'LIS departure');
  // CCTV: the signaller has the barriers down before the train reaches the
  // platform (seen at Liss), so the closure runs from 150 s before arrival.
  assert.equal(m.held, true);
  const dep = now.getTime() + 10 * 60_000;
  assert.equal(m.closeAt, dep - 40_000 - 150_000);
  // 11 m + 12 coaches (240 m) to clear at 0.5 m/s² ≈ 32 s, then 30 s.
  assert.ok(Math.abs(m.openAt - (dep + 32_000 + 30_000)) < 1500, `got +${(m.openAt - dep) / 1000}s`);
});

test('stopping northbound train: crosses before reaching the platform; a 12-car then stands on the road', () => {
  const boards = {
    PTR: { trainServices: [] },
    HSL: { trainServices: [{
      serviceID: 'd', sta: at(20), eta: 'On time',
      origin: [{ locationName: 'Portsmouth Harbour', crs: 'PMH' }],
      destination: [{ locationName: 'London Waterloo', crs: 'WAT' }],
      previousCallingPoints: [{ callingPoint: [
        { locationName: 'Petersfield', crs: 'PTR', st: at(5), et: 'On time' },
        { locationName: 'Liss', crs: 'LIS', st: at(10), et: 'On time' },
      ] }],
    }] },
  };
  const m = predict(liss, boards, now).movements[0];
  const dep = now.getTime() + 10 * 60_000;
  const arr = dep - liss.station.dwellSec * 1000;
  // Front reaches the road ~27 s before stopping 180 m beyond it; CCTV lead 150 s.
  assert.ok(Math.abs(m.closeAt - (arr - 27_000 - 150_000)) < 1500);
  // 12 coaches assumed (Darwin gives SWR no length) in 170 m of room: the
  // rear stands on the road, so the barriers hold until it leaves.
  assert.equal(m.held, true);
  assert.equal(m.coachesAssumed, true);
  assert.equal(m.basis, 'LIS departure');
  assert.ok(m.openAt > dep + 30_000);
});

// Milford: platforms 19–212 m north of the road, so a northbound train
// crosses first and stops beyond. Whether the barriers lift while it stands
// depends on whether its rear is clear of the road.
const milford = {
  id: 'm', closeBeforeSec: 40, openAfterSec: 15,
  station: { crs: 'MLF', platformsSide: 'north', platformStartM: 19, platformEndM: 212, assumeCoaches: 12, holdDuringDwell: false, dwellSec: 40 },
};
const north = { key: 'north', enters: 'south' };
const south = { key: 'south', enters: 'north' };
const dep = now.getTime() + 8 * 60_000;
const arr = dep - 40_000;
const call = (length) => ({ crs: 'MLF', st: at(8), et: 'On time', length });

test('trainCoaches: Darwin first, then the registry assumption, and 0 means unknown', () => {
  assert.deepEqual(trainCoaches({ length: 0 }, { length: 8 }, milford.station), { coaches: 8, assumed: false });
  assert.deepEqual(trainCoaches({ length: 10 }, { length: 0 }, milford.station), { coaches: 10, assumed: false });
  assert.deepEqual(trainCoaches({ length: 0 }, { length: 0 }, milford.station), { coaches: 12, assumed: true });
  assert.deepEqual(trainCoaches({}, {}, { crs: 'X' }), { coaches: null, assumed: true });
});

test('a train longer than the platform room beyond the road holds the barriers until it leaves', () => {
  const w = stationWindow(milford, north, call(12), now, { length: 12 });
  assert.equal(w.held, true);
  assert.equal(w.basis, 'MLF departure');
  // Front reaches the road ~29 s before it stops (212 m at 0.5 m/s²), barriers 40 s before that.
  assert.ok(Math.abs(w.closeAt - (arr - 29_000 - 40_000)) < 1500, 'closes as the front approaches');
  // 240 m train, 202 m of room: 38 m still on the road; ~12 s to pull clear, then 15 s.
  assert.ok(w.openAt > dep + 25_000 && w.openAt < dep + 30_000, `opens after departure, got +${(w.openAt - dep) / 1000}s`);
});

test('a train that fits beyond the road lifts the barriers while it stands', () => {
  const w = stationWindow(milford, north, call(8), now, { length: 8 });
  assert.equal(w.held, false);
  assert.equal(w.basis, 'MLF arrival');
  // 160 m train, 212 m to the stop: the rear is past the road ~14 s before it stops.
  assert.ok(Math.abs(w.openAt - (arr - 14_000 + 15_000)) < 1500, `got ${(w.openAt - arr) / 1000}s after arrival`);
  assert.ok(w.openAt > w.closeAt + 40_000);
});

test('unknown length falls back to the registry assumption, and is marked as assumed', () => {
  const w = stationWindow(milford, north, call(0), now, { length: 0 });
  assert.equal(w.coaches, 12);
  assert.equal(w.coachesAssumed, true);
  assert.equal(w.held, true);
});

test('with no assumption the train is taken to fill the platform', () => {
  const st = { ...milford.station, assumeCoaches: undefined };
  const w = stationWindow({ ...milford, station: st }, north, call(0), now, { length: 0 });
  assert.equal(w.coaches, null);
  assert.equal(w.held, false); // 193 m train, 19 m gap: clear of the road
  const tight = stationWindow({ ...milford, station: { ...st, platformStartM: 4 } }, north, call(0), now, { length: 0 });
  assert.equal(tight.held, true); // platform starts at the road: the rear sits on it
});

test('a signaller hold does not keep the barriers down for a train already past the road', () => {
  // Fen Road / Cambridge North: platforms 266–525 m beyond, CCTV, holdDuringDwell.
  const fen = { ...milford, closeBeforeSec: 200, station: { ...milford.station, platformStartM: 266, platformEndM: 525, assumeCoaches: undefined, holdDuringDwell: true } };
  const through = stationWindow(fen, north, call(8), now, { length: 8 });
  assert.equal(through.held, false);
  assert.equal(through.basis, 'MLF arrival');
  assert.ok(through.openAt < arr, 'lifts before the train has even stopped');
  // Stopping first, then crossing: the hold still applies.
  const before = stationWindow(fen, south, call(8), now, { length: 8 });
  assert.equal(before.held, true);
  assert.equal(before.closeAt, arr - 200_000);
});

test('stopsClear: a train too long for the platform draws forward rather than stand on the road', () => {
  const clear = { ...milford, station: { ...milford.station, stopsClear: true } };
  const w = stationWindow(clear, north, call(12), now, { length: 12 });
  assert.equal(w.held, false);
  assert.equal(w.openAt, arr + 15_000); // rear clears the road as it stops
});

test('stopping then crossing: the rear clears after the gap plus its own length', () => {
  const w = stationWindow(milford, south, call(8), now, { length: 8 });
  assert.equal(w.held, false);
  assert.equal(w.basis, 'MLF departure');
  // 19 m gap: front on the road ~9 s after moving off, barriers 40 s before that.
  assert.ok(Math.abs(w.closeAt - (dep + 9_000 - 40_000)) < 1500);
  // 179 m to clear at 0.5 m/s² ≈ 27 s, then 15 s.
  assert.ok(w.openAt > dep + 40_000 && w.openAt < dep + 44_000, `got +${(w.openAt - dep) / 1000}s`);
});

test('a station with no platform measurements keeps the fixed offsets', () => {
  const bare = { ...milford, station: { crs: 'MLF', platformsSide: 'north', holdDuringDwell: false, dwellSec: 40 } };
  const w = stationWindow(bare, north, call(0), now, { length: 0 });
  assert.equal(w.closeAt, arr - 40_000);
  assert.equal(w.openAt, arr + 15_000);
  const w2 = stationWindow(bare, south, call(0), now, { length: 0 });
  assert.equal(w2.closeAt, dep - 40_000);
  assert.equal(w2.openAt, dep + 15_000);
});

test('the same train on two boards for one direction is counted once', () => {
  const bdh = getCrossing('bedhampton');
  const svc = {
    serviceID: 'same', sta: at(8), eta: 'On time',
    origin: [{ locationName: 'Brighton', crs: 'BTN' }],
    destination: [{ locationName: 'Portsmouth Harbour', crs: 'PMH' }],
    previousCallingPoints: [{ callingPoint: [{ locationName: 'Havant', crs: 'HAV', st: at(1), et: 'On time' }] }],
  };
  const p = predict(bdh, { HAV: { trainServices: [] }, FTN: { trainServices: [svc] }, CSA: { trainServices: [svc] } }, now);
  assert.equal(p.movements.length, 1);
  assert.equal(p.movements[0].basis, 'HAV +1.5 min');
});

test('every registry entry is well-formed', async () => {
  const { allCrossings } = await import('../src/registry.js');
  const crossings = allCrossings();
  const ids = new Set();
  for (const c of crossings) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`); ids.add(c.id);
    assert.ok(c.directions.length >= 2, `${c.id} needs both directions`);
    for (const d of c.directions) {
      assert.ok(d.references.some((r) => r.crs === d.board.crs && r.minutesToCrossing < 0), `${c.id}/${d.key}: board station must be a negative-offset fallback reference`);
      assert.ok(d.via.length > 0);
      if (c.station) assert.ok(c.directions.some((d) => d.key === c.station.platformsSide), `${c.id}: platformsSide must be one of its direction keys`);
    }
    const boards = Object.fromEntries(c.directions.map((d) => [d.board.crs, mockBoard(c, d, now)]));
    const p = predict(c, boards, now);
    // On a line paralleled by a faster one, the mock's trains all look as if
    // they took the other line, so no closures is the right answer there.
    if (!c.parallel) assert.ok(p.upcoming.length >= 4, `${c.id}: mock gives ${p.upcoming.length} closures`);
  }
});

test('ignores cancelled trains and trains from the wrong side', () => {
  const boards = {
    PTR: { trainServices: [] },
    HSL: { trainServices: [
      { serviceID: 'x', sta: at(5), eta: 'On time', isCancelled: true,
        previousCallingPoints: [{ callingPoint: [{ crs: 'PTR', st: at(1), et: 'Cancelled' }] }] },
      { serviceID: 'y', sta: at(5), eta: 'On time', // came from Guildford: never crossed Liss
        previousCallingPoints: [{ callingPoint: [{ crs: 'GLD', st: at(-20), at: at(-20) }] }] },
    ] },
  };
  assert.equal(predict(liss, boards, now).movements.length, 0);
});

test('two close trains merge into one closure', () => {
  const closures = mergeClosures([
    { closeAt: 0, openAt: 120_000, uncertain: false },
    { closeAt: 130_000, openAt: 240_000, uncertain: true },
    { closeAt: 600_000, openAt: 700_000, uncertain: false },
  ]);
  assert.equal(closures.length, 2);
  assert.equal(closures[0].trains.length, 2);
  assert.equal(closures[0].openAt, 240_000);
  assert.equal(closures[0].uncertain, true);
});

test('mock boards run through the same predictor and give a sane picture', () => {
  const boards = Object.fromEntries(liss.directions.map((d) => [d.board.crs, mockBoard(liss, d, now)]));
  const p = predict(liss, boards, now);
  assert.ok(p.upcoming.length >= 6, `expected a couple of hours of closures, got ${p.upcoming.length}`);
  assert.ok(p.closedSecNextHour > 0 && p.closedSecNextHour < 1800);
  for (const c of p.upcoming) assert.ok(c.openAt > c.closeAt);
});

// A generated-style crossing between X (near, 2 min) and Y (beyond, 3 min),
// read from Y's board and Z's beyond it.
const gen = expandBoards({
  id: 'gen', name: 'Gen', closeBeforeSec: 60, openAfterSec: 30,
  times: { WWW: 8, XXX: 2, YYY: 3, ZZZ: 6 },
  directions: [{
    key: 'east', label: 'Eastbound', towards: 'Y', enters: 'west',
    boards: [{ crs: 'YYY', name: 'Y', min: 3.5 }, { crs: 'ZZZ', name: 'Z', min: 6.5 }],
    via: ['XXX', 'WWW'], beyond: ['YYY', 'ZZZ'], references: [{ crs: 'XXX', name: 'X', minutesToCrossing: 2.5 }],
  }],
});

test('expandBoards makes one direction per board with the board as fallback reference', () => {
  assert.equal(gen.directions.length, 2);
  assert.deepEqual(gen.directions.map((d) => d.board.crs), ['YYY', 'ZZZ']);
  assert.deepEqual(gen.directions[1].references.map((r) => [r.crs, r.minutesToCrossing]), [['XXX', 2.5], ['ZZZ', -6.5]]);
});

test('crossingLeg: latest near→beyond leg, loop legs rejected by schedule', () => {
  const dir = gen.directions[0];
  const svc = { sta: at(3), eta: 'On time' };
  const leg = crossingLeg(gen, dir, svc, [{ crs: 'WWW', st: at(-8) }, { crs: 'XXX', st: at(-2) }]);
  assert.equal(leg.x.crs, 'XXX');
  assert.equal(leg.y.crs, 'YYY');
  assert.ok(Math.abs(leg.frac - legFraction(2, 3)) < 1e-9);
  // Passed beyond then came back round a loop: X→Y in 1 min can't be via the crossing (5 min).
  assert.equal(crossingLeg(gen, dir, { sta: at(-1), eta: 'On time' }, [{ crs: 'XXX', st: at(-2) }]), null);
  // A pair the generator marked as a loop shortcut is never a crossing.
  const looped = { ...gen, bypass: { XXX: ['YYY'] } };
  assert.equal(crossingLeg(looped, dir, svc, [{ crs: 'WWW', st: at(-8) }, { crs: 'XXX', st: at(-2) }]), null);
  // Never on the near side at all.
  assert.equal(crossingLeg(gen, dir, svc, [{ crs: 'QQQ', st: at(-9) }]), null);
  // Non-stop from W straight to the board: W→Y is the leg.
  const fast = crossingLeg(gen, dir, { sta: at(3), eta: 'On time' }, [{ crs: 'WWW', st: at(-8) }]);
  assert.equal(fast.x.crs, 'WWW');
  assert.ok(Math.abs(fast.frac - legFraction(8, 3)) < 1e-9);
});

test('legFraction: pulling away and braking push the crossing moment towards the middle of the leg', () => {
  // Continuous through the accelerating zone, and 37.5 s extra beyond it.
  assert.ok(Math.abs(fromStop(0.625) - 1.25) < 1e-9);
  assert.ok(Math.abs(fromStop(10) - 10.625) < 1e-9);
  assert.ok(fromStop(0.1) > 0.1 && fromStop(0.1) < 0.6);
  // 1 min out of a 11-min leg: a straight split says 9 %, with the start from rest it is 13 %.
  assert.ok(Math.abs(legFraction(1, 10) - 1.625 / 12.25) < 1e-9);
  assert.equal(legFraction(5, 5), 0.5);
  assert.equal(legFraction(0, 0), 0.5);
});

test('generated entry: crossing time interpolated along the leg, deduped across boards', () => {
  const svc = (id, sta, prev) => ({ serviceID: id, sta, eta: 'On time', previousCallingPoints: [{ callingPoint: prev }] });
  const boards = {
    YYY: { trainServices: [svc('t1', at(3), [{ crs: 'XXX', st: at(-2), at: at(-2) }])] },
    ZZZ: { trainServices: [svc('t1', at(7), [{ crs: 'XXX', st: at(-2), at: at(-2) }, { crs: 'YYY', st: at(4), et: 'On time' }])] },
  };
  const p = predict(gen, boards, now);
  assert.equal(p.movements.length, 1); // same train seen on both boards
  const m = p.movements[0];
  assert.equal(m.basis, 'XXX→YYY');
  assert.equal(m.actual, true);
  // Departed X at −2, due Y at +3 → crossing at −2 + 5 × legFraction(2, 3) min.
  const cross = now.getTime() - 120_000 + 300_000 * legFraction(2, 3);
  assert.equal(m.closeAt, cross - 60_000);
  assert.equal(m.openAt, cross + 30_000);
});
