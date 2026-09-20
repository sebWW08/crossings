import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landing, watched, feedbackTap, snapshot, isBot } from '../src/stats.mjs';

const req = (ua, extra = {}) => ({ headers: { 'user-agent': ua, host: 'crossings.onrender.com', ...extra }, socket: { remoteAddress: '10.0.0.1' } });
const day = '2030-01-01'; // a day nothing else in the process touches

test('one phone polling all day is one person; two phones are two', () => {
  const a = req('Mozilla/5.0 (iPhone)'), b = req('Mozilla/5.0 (Android)');
  for (let i = 0; i < 5; i++) watched(a, 'milford', 'ret', day);
  watched(b, 'milford', 'new', day);
  watched(b, 'liss', 'ret', day);
  const d = snapshot()[day];
  assert.equal(d.visitors, 2);
  assert.equal(d.newDevices, 1);
  assert.equal(d.polls, 7);
  assert.deepEqual(d.crossings, { milford: 2, liss: 1 });
});

test('landings record where people came from, not our own pages', () => {
  landing(req('Mozilla/5.0', { referer: 'https://www.facebook.com/groups/liss/posts/1' }), 'crossing', day);
  landing(req('Mozilla/5.0', { referer: 'https://crossings.onrender.com/' }), 'home', day);
  landing(req('Mozilla/5.0'), 'map', day);
  feedbackTap('milford', day);
  const d = snapshot()[day];
  assert.deepEqual(d.landings, { crossing: 1, home: 1, map: 1 });
  assert.deepEqual(d.referrers, { 'facebook.com': 1 });
  assert.deepEqual(d.feedback, { milford: 1 });
});

test('crawlers, link previewers and the keep-alive ping are not people', () => {
  assert.ok(isBot(req('facebookexternalhit/1.1')));
  assert.ok(isBot(req('curl/8.0')));
  assert.ok(isBot(req('Googlebot/2.1')));
  assert.ok(!isBot(req('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)')));
  const before = snapshot()[day].polls;
  watched(req('WhatsApp/2.0'), 'milford', 'new', day);
  assert.equal(snapshot()[day].polls, before);
});
