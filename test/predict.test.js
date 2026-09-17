import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict, mergeClosures, crossingLeg } from '../src/predict.js';
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
  // crosses at 12:04:30; closes 90s before, opens 30s after
  assert.equal(m.closeAt, now.getTime() + 4.5 * 60_000 - 90_000);
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

test('stopping southbound train: platforms before the barriers, so keyed off departure', () => {
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
  assert.equal(m.closeAt, now.getTime() + 10 * 60_000 - 90_000);
  assert.equal(m.openAt, now.getTime() + 10 * 60_000 + 30_000);
});

test('stopping northbound train: crosses before reaching the platform, so keyed off arrival', () => {
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
  assert.equal(m.basis, 'LIS arrival');
  const arr = now.getTime() + 10 * 60_000 - liss.station.dwellSec * 1000;
  assert.equal(m.closeAt, arr - 90_000);
  assert.equal(m.openAt, arr + 30_000);
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
  const { crossings } = await import('../src/registry.js');
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
    assert.ok(p.upcoming.length >= 4, `${c.id}: mock gives ${p.upcoming.length} closures`);
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
  assert.ok(Math.abs(leg.frac - 0.4) < 1e-9);
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
  assert.ok(Math.abs(fast.frac - 8 / 11) < 1e-9);
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
  // Departed X at −2, due Y at +3 → crossing at −2 + 5 × 0.4 = 0 → close at −60 s.
  assert.equal(m.closeAt, now.getTime() - 60_000);
  assert.equal(m.openAt, now.getTime() + 30_000);
});
