import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadError, leadFromReports } from '../src/calibrate.mjs';

// Monday 21 Sep 2026 at Fen Road and East Boldon, as tapped (BST shown as UTC+1).
const T = (hhmm) => Date.parse(`2026-09-21T${hhmm}:00+01:00`);
const rep = (at, crossing, observed, predicted, close, open, lead = 150) => ({ at: new Date(T(at)).toISOString(), crossing, observed, predicted, closeAt: T(close), openAt: T(open), lead });

test('leadError reads a tap as seconds the lead was short (+) or long (−), or nothing', () => {
  assert.equal(leadError(rep('07:42', 'cmb', 'down', 'open', '07:45', '07:54'), 'signaller'), 180); // down 3 min early
  assert.equal(leadError(rep('08:07', 'ebl', 'up', 'closed', '08:05', '08:09'), 'signaller'), -105); // not closed yet, 2 min in — held to the 45 s floor
  assert.equal(leadError(rep('07:49', 'cmb', 'down', 'closed', '07:46', '07:51'), 'signaller'), 0); // agreed
  assert.equal(leadError(rep('08:42', 'fxn', 'up', 'open', '08:51', '08:55')), 0);           // agreed
  assert.equal(leadError(rep('09:13', 'fxn', 'up', 'closed', '09:09', '09:13')), null);      // second half: reopened early, not a lead thing
  assert.equal(leadError(rep('00:05', 'cmb', 'down', 'open', '00:30', '00:32')), null);      // 25 min early: a train we can't see
  assert.equal(leadError({ at: '2026-09-21T00:00:00Z', crossing: 'x', observed: 'down', predicted: 'open', closeAt: null, openAt: null }), null);
});

test('a tap implying a lead outside what the crossing could do says nothing about the lead', () => {
  // An AHB closes at most ~120 s ahead: from a 40 s lead, five minutes early
  // would mean 340 s, so it is another train, not the AHB.
  assert.equal(leadError(rep('13:06', 'mlf', 'down', 'open', '13:11', '13:12', 40), 'automatic'), null);
  assert.equal(leadError(rep('13:10', 'mlf', 'down', 'open', '13:11', '13:12', 40), 'automatic'), 60);
  // A signaller-controlled one has more room, but not unlimited.
  assert.equal(leadError(rep('10:57', 'cmb', 'down', 'open', '10:59', '11:02', 180), 'signaller'), 120);
  assert.equal(leadError(rep('10:55', 'cmb', 'down', 'open', '10:59', '11:02', 200), 'signaller'), null);
  assert.equal(leadError(rep('10:53', 'cmb', 'down', 'open', '10:59', '11:10', 190), 'signaller'), null);
});

test('up inside a merged multi-train window narrows the lead, but says nothing about the reopening', async () => {
  const { openError } = await import('../src/calibrate.mjs');
  const long = { ...rep('12:57', 'bdh', 'up', 'closed', '12:55', '13:11'), lead: 240 }; // 16 minutes = several trains
  assert.equal(leadError(long, 'signaller'), -120);  // the window is too wide: shorten the lead
  assert.equal(leadError({ ...long, lead: 100 }, 'signaller'), -55); // never below the floor for its kind
  assert.equal(openError(long), null);               // …but its tail is not one train's reopening
  const short = { ...rep('12:57', 'bdh', 'up', 'closed', '12:55', '12:59'), lead: 240 };
  assert.equal(leadError(short, 'signaller'), -120);
});

test('Fen Road: three early sightings and five agreements push the lead up', () => {
  const now = T('12:00');
  const reports = [
    rep('07:42', 'cmb', 'down', 'open', '07:45', '07:54'), rep('07:43', 'cmb', 'up', 'open', '07:45', '07:50'),
    rep('07:49', 'cmb', 'down', 'closed', '07:46', '07:51'), rep('08:50', 'cmb', 'down', 'closed', '08:50', '08:54'),
    rep('08:50', 'cmb', 'up', 'soon', '08:51', '08:55'), rep('09:16', 'cmb', 'down', 'closed', '09:12', '09:19'),
    rep('10:12', 'cmb', 'down', 'open', '10:17', '10:21'), rep('10:13', 'cmb', 'down', 'open', '10:17', '10:21'),
  ];
  const fit = leadFromReports(reports, 150, 'signaller', now);
  assert.equal(fit.n, 7);
  assert.ok(fit.leadSec >= 190 && fit.leadSec <= 240, `got ${fit.leadSec}`);
});

test('East Boldon: barriers up early in closure after closure pulls the lead down', () => {
  const now = T('12:00');
  // Metro every few minutes: people keep finding the barriers up just after
  // a predicted closure began, which is the window being too wide.
  const reports = [
    rep('08:07', 'ebl', 'up', 'closed', '08:06', '08:10'), rep('08:21', 'ebl', 'up', 'closed', '08:20', '08:24'),
    rep('08:22', 'ebl', 'up', 'closed', '08:21', '08:25'), rep('10:42', 'ebl', 'up', 'closed', '10:41', '10:45'),
    rep('08:36', 'ebl', 'down', 'closed', '08:29', '08:38'), rep('11:01', 'ebl', 'down', 'closed', '10:52', '11:03'),
  ];
  const fit = leadFromReports(reports, 150, 'signaller', now);
  assert.equal(fit.n, 6);
  assert.ok(fit.leadSec >= 80 && fit.leadSec <= 130, `got ${fit.leadSec}`);
  // Agreement holds a crossing where it is.
  const happy = Array.from({ length: 6 }, (_, i) => rep(`09:0${i}`, 'ebl', 'down', 'closed', '09:00', '09:05'));
  assert.equal(leadFromReports(happy, 150, 'signaller', now).leadSec, 150);
});

test('too few usable reports, or stale ones, mean no calibration', () => {
  const now = T('12:00');
  assert.equal(leadFromReports([rep('07:42', 'x', 'down', 'open', '07:45', '07:54')], 150, 'signaller', now), null);
  const old = Array.from({ length: 5 }, () => ({ ...rep('07:42', 'x', 'down', 'open', '07:45', '07:54'), at: '2026-08-01T07:42:00Z' }));
  assert.equal(leadFromReports(old, 150, 'signaller', now), null);
});

test('reports made under a later lead are measured against it', () => {
  const now = T('12:00');
  const reports = [rep('07:42', 'x', 'down', 'closed', '07:40', '07:45', 240), rep('08:42', 'x', 'down', 'closed', '08:40', '08:45', 240), rep('09:42', 'x', 'down', 'closed', '09:40', '09:45', 240)];
  assert.equal(leadFromReports(reports, 240, 'signaller', now).leadSec, 240);
  // …and against a different rule value, the prior pulls back a little.
  assert.ok(leadFromReports(reports, 150, 'signaller', now).leadSec < 240);
});

test('openError reads the other end of the window', async () => {
  const { openError } = await import('../src/calibrate.mjs');
  assert.equal(openError(rep('09:13', 'fxn', 'up', 'closed', '09:09', '09:13')), 0);            // right at the predicted end: −0
  assert.equal(openError(rep('16:29', 'bdh', 'up', 'closed', '16:26', '16:30')), -60);         // reopened a minute early
  assert.equal(openError(rep('17:13', 'cmb', 'down', 'closed', '17:09', '17:14')), 0);          // still down late in the window: fine
  assert.equal(openError(rep('17:13', 'cmb', 'down', 'closed', '17:05', '17:20')), null);       // …but a 15 min window is several trains
  assert.equal(openError(rep('08:07', 'ebl', 'up', 'closed', '08:05', '08:09')), null);        // first half: the lead's business
  const stillDown = { ...rep('18:52', 'mlf', 'down', 'open', '19:00', '19:01', 40), prevOpenAt: T('18:52') - 30_000 };
  assert.equal(openError(stillDown), 30);                                                       // 30 s past the predicted reopening, still down
  const didOpen = { ...rep('18:53', 'mlf', 'up', 'open', '18:59', '19:00', 40), prevOpenAt: T('18:52') };
  assert.equal(openError(didOpen), 0);
  assert.equal(openError(rep('13:44', 'hun', 'down', 'open', '13:52', '13:56')), null);         // nothing recent to compare with
});

test('openAfterFromReports shrinks toward the entry value and is bounded', async () => {
  const { openAfterFromReports } = await import('../src/calibrate.mjs');
  const now = T('20:00');
  const late = [30, 40, 50, 60].map((s, i) => ({ ...rep(`18:${10 + i}`, 'x', 'down', 'open', '19:00', '19:01'), prevOpenAt: T(`18:${10 + i}`) - s * 1000, openAfter: 30 }));
  const fit = openAfterFromReports(late, 30, now);
  assert.equal(fit.n, 4);
  assert.ok(fit.openAfterSec > 30 && fit.openAfterSec <= 60, `got ${fit.openAfterSec}`);
  const early = [0, 0, 0].map(() => ({ ...rep('18:59', 'x', 'up', 'closed', '18:56', '19:00'), openAfter: 30 }));
  // …and one inside a sixteen-minute window, which is several trains merged: ignored.
  early.push({ ...rep('18:57', 'x', 'up', 'closed', '18:44', '19:00'), openAfter: 30 });
  assert.equal(openAfterFromReports(early, 30, now).openAfterSec, 10);
  assert.equal(openAfterFromReports(early.slice(0, 2), 30, now), null);
});
