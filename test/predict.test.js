import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict, mergeClosures } from '../src/predict.js';
import { parseClock, resolveCall, fmtClock } from '../src/time.js';
import { mockBoard } from '../src/mock.js';
import { getCrossing } from '../src/registry.js';

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
      if (c.station) assert.ok(['north', 'south', 'east', 'west'].includes(c.station.platformsSide));
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
