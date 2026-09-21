import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadError, leadFromReports } from '../src/calibrate.mjs';

// Monday 21 Sep 2026 at Fen Road and East Boldon, as tapped (BST shown as UTC+1).
const T = (hhmm) => Date.parse(`2026-09-21T${hhmm}:00+01:00`);
const rep = (at, crossing, observed, predicted, close, open, lead = 150) => ({ at: new Date(T(at)).toISOString(), crossing, observed, predicted, closeAt: T(close), openAt: T(open), lead });

test('leadError reads a tap as seconds the lead was short (+) or long (−), or nothing', () => {
  assert.equal(leadError(rep('07:42', 'cmb', 'down', 'open', '07:45', '07:54')), 180);       // down 3 min early
  assert.equal(leadError(rep('08:07', 'ebl', 'up', 'closed', '08:05', '08:11')), -120);      // not closed yet, 2 min in
  assert.equal(leadError(rep('07:49', 'cmb', 'down', 'closed', '07:46', '07:51')), 0);       // agreed
  assert.equal(leadError(rep('08:42', 'fxn', 'up', 'open', '08:51', '08:55')), 0);           // agreed
  assert.equal(leadError(rep('09:13', 'fxn', 'up', 'closed', '09:09', '09:13')), null);      // second half: reopened early, not a lead thing
  assert.equal(leadError(rep('00:05', 'cmb', 'down', 'open', '00:30', '00:32')), null);      // 25 min early: a train we can't see
  assert.equal(leadError({ at: '2026-09-21T00:00:00Z', crossing: 'x', observed: 'down', predicted: 'open', closeAt: null, openAt: null }), null);
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
  assert.equal(fit.n, 8);
  assert.ok(fit.leadSec >= 190 && fit.leadSec <= 240, `got ${fit.leadSec}`);
});

test('East Boldon: up inside merged closures pulls the lead down, bounded for the kind of crossing', () => {
  const now = T('12:00');
  const reports = [
    rep('07:47', 'ebl', 'down', 'closed', '07:42', '07:47'), rep('07:50', 'ebl', 'down', 'soon', '07:52', '08:02'),
    rep('08:07', 'ebl', 'up', 'closed', '08:05', '08:11'), rep('08:21', 'ebl', 'up', 'closed', '08:17', '08:28'),
    rep('08:22', 'ebl', 'up', 'closed', '08:17', '08:28'), rep('08:36', 'ebl', 'down', 'closed', '08:29', '08:38'),
    rep('10:42', 'ebl', 'up', 'closed', '10:41', '10:49'), rep('11:01', 'ebl', 'down', 'closed', '10:52', '11:03'),
  ];
  const fit = leadFromReports(reports, 150, 'signaller', now);
  assert.ok(fit.leadSec >= 80 && fit.leadSec <= 120, `got ${fit.leadSec}`);
  // An automatic crossing can't be talked below 20 s or above 120 s.
  const noLead = reports.map(({ lead, ...r }) => r);
  assert.equal(leadFromReports(noLead, 40, 'automatic', now).leadSec, 20);
  assert.equal(leadFromReports(noLead.map((r) => ({ ...r, observed: 'down', predicted: 'open', closeAt: r.closeAt + 300_000 })), 40, 'automatic', now).leadSec, 120);
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
  assert.equal(openError(rep('16:29', 'bdh', 'up', 'closed', '16:21', '16:30')), -60);         // reopened a minute early
  assert.equal(openError(rep('17:13', 'cmb', 'down', 'closed', '17:05', '17:17')), 0);          // still down late in the window: fine
  assert.equal(openError(rep('08:07', 'ebl', 'up', 'closed', '08:05', '08:11')), null);        // first half: the lead's business
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
  const early = [1, 1, 2].map((m) => ({ ...rep(`18:${60 - m}`, 'x', 'up', 'closed', '18:50', '19:00'), openAfter: 30 }));
  // …and one three minutes early, which is a merged closure, not a reopen-delay error: ignored.
  early.push({ ...rep('18:57', 'x', 'up', 'closed', '18:50', '19:00'), openAfter: 30 });
  assert.equal(openAfterFromReports(early, 30, now).openAfterSec, 10);
  assert.equal(openAfterFromReports(early.slice(0, 2), 30, now), null);
});
