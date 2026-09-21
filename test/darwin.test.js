import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DARWIN_API_KEY = 'test';
const { arrivalsBoard } = await import('../src/darwin.js');

const crossing = { id: 'x' };
const dir = (crs) => ({ board: { crs } });
const ok = (crs) => new Response(JSON.stringify({ crs, trainServices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const limited = () => new Response('429 Too Many Requests', { status: 429, headers: { 'retry-after': '0' } });

test('never more than 8 Darwin requests in flight, whatever the demand', async () => {
  let inFlight = 0, peak = 0;
  globalThis.fetch = async (url) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; return ok(url.slice(-30)); };
  const t0 = new Date('2030-01-01T10:00:00Z');
  await Promise.all(Array.from({ length: 40 }, (_, i) => arrivalsBoard(crossing, dir(`S${i}`), t0)));
  assert.equal(peak, 8);
});

test('a 429 is retried, and if it persists the last good board is served as stale', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return ok('AAA'); };
  const t0 = new Date('2030-01-01T11:00:00Z');
  const first = await arrivalsBoard(crossing, dir('AAA'), t0);
  assert.equal(first.staleSec, undefined);
  globalThis.fetch = async () => { calls++; return limited(); };
  const t1 = new Date(t0.getTime() + 5 * 60_000); // past the 30 s cache
  const stale = await arrivalsBoard(crossing, dir('AAA'), t1);
  assert.equal(stale.staleSec, 300);
  assert.equal(calls, 3, 'one good call, then a 429 and one retry');
  // Too old to be worth serving: the error comes through.
  const t2 = new Date(t0.getTime() + 20 * 60_000);
  await assert.rejects(arrivalsBoard(crossing, dir('AAA'), t2), /429/);
});
