import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legsOnBoard, addLegs, resetLegs, missingBoards, legsSnapshot } from '../src/legs.mjs';
import { getCrossing } from '../src/registry.js';
import { predict } from '../src/predict.js';
import { fmtClock } from '../src/time.js';

const now = new Date('2026-09-25T11:10:00Z'); // 12:10 BST
const at = (mins) => fmtClock(new Date(now.getTime() + mins * 60_000));
const day = now.toISOString().slice(0, 10);

// The 11:58 Portsmouth & Southsea to Brighton: Fratton, Havant, then
// nothing until Chichester — past Warblington, Emsworth, Southbourne and
// Nutbourne without stopping. It is on Chichester's board and no other
// that Warblington used to read.
const fast = {
  serviceID: 'fast', sta: at(9), eta: 'On time', std: at(10), etd: 'On time',
  origin: [{ locationName: 'Portsmouth & Southsea', crs: 'PMS' }],
  destination: [{ locationName: 'Brighton', crs: 'BTN' }],
  previousCallingPoints: [{ callingPoint: [
    { crs: 'PMS', st: at(-12), at: at(-12) },
    { crs: 'FTN', st: at(-9), at: at(-9) },
    { crs: 'HAV', st: at(0), et: 'On time' },
  ] }],
  subsequentCallingPoints: [{ callingPoint: [{ crs: 'BAA', st: at(18) }, { crs: 'BTN', st: at(60) }] }],
};

test('legsOnBoard: consecutive calls through the board station, portions kept apart', () => {
  const legs = legsOnBoard({ crs: 'CCH', trainServices: [fast] });
  assert.deepEqual(legs, [['PMS', 'FTN', 3], ['FTN', 'HAV', 9], ['HAV', 'CCH', 10], ['CCH', 'BAA', 8], ['BAA', 'BTN', 42]]);
  // A train that joins: each portion runs into the board on its own.
  const joined = {
    sta: '10:00', previousCallingPoints: [
      { callingPoint: [{ crs: 'AAA', st: '09:40' }] },
      { callingPoint: [{ crs: 'BBB', st: '09:45' }] },
    ],
  };
  assert.deepEqual(legsOnBoard({ crs: 'ZZZ', trainServices: [joined] }), [['AAA', 'ZZZ', 20], ['BBB', 'ZZZ', 15]]);
  // Cancelled calls and trains leave no legs; past midnight wraps.
  const late = { sta: '00:05', previousCallingPoints: [{ callingPoint: [{ crs: 'AAA', st: '23:55' }, { crs: 'XXX', st: '23:58', isCancelled: true }] }] };
  assert.deepEqual(legsOnBoard({ crs: 'ZZZ', trainServices: [late, { ...fast, isCancelled: true }] }), [['AAA', 'ZZZ', 10]]);
  // Darwin's "???" is not a station.
  const unnamed = { sta: '10:00', previousCallingPoints: [{ callingPoint: [{ crs: '???', st: '09:50' }] }] };
  assert.deepEqual(legsOnBoard({ crs: 'ZZZ', trainServices: [unnamed] }), []);
});

test('a train skipping every board a direction reads adds its first stop after the road', () => {
  const wbl = getCrossing('warblington'); // loads the registry (and data/legs.json) first…
  resetLegs({});                          // …then starts from nothing
  const east = wbl.directions.find((d) => d.key === 'east');
  const raw = { ...wbl, directions: [{ ...east, boards: [{ crs: 'EMS' }, { crs: 'SOB' }, { crs: 'NUT' }] }] };
  assert.deepEqual(missingBoards(raw, raw.directions[0], now.getTime()), []);
  addLegs([['HAV', 'EMS', 3], ['HAV', 'CCH', 10]], now.getTime());
  assert.deepEqual(missingBoards(raw, raw.directions[0], now.getTime()), ['CCH']);
  // A leg far quicker than the run via the road went some other way.
  resetLegs({ 'HAV>CCH': [3, day] });
  assert.deepEqual(missingBoards(raw, raw.directions[0], now.getTime()), []);
  // One not seen for two months has gone from the timetable.
  resetLegs({ 'HAV>CCH': [10, '2026-07-01'] });
  assert.deepEqual(missingBoards(raw, raw.directions[0], now.getTime()), []);
});

test('Warblington: the fast is predicted once Chichester is a board', () => {
  getCrossing('warblington');
  resetLegs({});
  const before = getCrossing('warblington');
  assert.ok(!before.directions.some((d) => d.board.crs === 'CCH'));
  const boards = (c) => Object.fromEntries(c.directions.map((d) => [d.board.crs, { trainServices: d.board.crs === 'CCH' ? [fast] : [] }]));
  assert.equal(predict(before, boards(before), now).movements.length, 0);

  addLegs(legsOnBoard({ crs: 'CCH', trainServices: [fast] }), now.getTime());
  const after = getCrossing('warblington');
  const cch = after.directions.find((d) => d.board.crs === 'CCH');
  assert.equal(cch.key, 'east');
  const p = predict(after, boards(after), now);
  assert.equal(p.movements.length, 1);
  const m = p.movements[0];
  assert.equal(m.basis, 'HAV→CCH');
  // Leaves Havant 12:10, due Chichester 12:19: Warblington is under a minute out.
  assert.ok(m.closeAt > now.getTime() - 150_000 && m.closeAt < now.getTime() + 60_000, `closeAt ${new Date(m.closeAt).toISOString()}`);
  assert.ok(Object.keys(legsSnapshot()).includes('HAV>CCH'));
  resetLegs({});
});
