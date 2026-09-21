// Fetches Darwin arrivals boards (Rail Data Marketplace LDBWS) with a short
// per-station cache, falling back to synthetic data when no key is configured.

import { mockBoard } from './mock.js';

const TTL_MS = 30_000;
const KEY = process.env.DARWIN_API_KEY || '';
const BASE = (process.env.DARWIN_ARRIVALS_URL ||
  'https://api1.raildata.org.uk/1010-live-arrival-and-departure-boards-arr-and-dep1_1/LDBWS/api/20220120/GetArrDepBoardWithDetails'
).replace(/\/$/, '');

export const live = Boolean(KEY);

/** @type {Map<string, {at:number, board:Promise<object>}>} */
const cache = new Map();
/** The last board that did come back, per station, for when Darwin won't answer. */
const last = new Map();
const STALE_MAX_MS = 15 * 60_000;

// The Rail Data Marketplace allows 100 requests a second with a burst cap
// and answers 429 for a while once tripped (a whole-registry sweep did it).
// A few in flight at once is plenty: boards are cached per station, and a
// queue here costs a busy moment milliseconds, not everyone a blank page.
const MAX_IN_FLIGHT = 8;
let inFlight = 0;
const waiting = [];
const slot = () => new Promise((r) => (inFlight < MAX_IN_FLIGHT ? (inFlight++, r()) : waiting.push(r)));
const release = () => { const next = waiting.shift(); if (next) next(); else inFlight--; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(crs) {
  const url = `${BASE}/${crs}?numRows=20&timeWindow=120`;
  await slot();
  try {
    const res = await fetch(url, { headers: { 'x-apikey': KEY, accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error(`Darwin ${crs}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 80)}`.trim()), { status: res.status, retryAfter: Number(res.headers.get('retry-after')) || 0 });
    return res.json();
  } finally {
    release();
  }
}

/** One retry on a limit or server error; then the last good board if it is
 *  recent enough, marked stale so the page can say so. */
async function fetchLive(crs, now) {
  try {
    return await fetchOnce(crs);
  } catch (e) {
    if (e.status === 429 || e.status >= 500) {
      await sleep(Math.min(5000, e.retryAfter * 1000 || 1500));
      try { return await fetchOnce(crs); } catch (e2) { e = e2; }
    }
    const old = last.get(crs);
    if (old && now - old.at < STALE_MAX_MS) return { ...old.board, staleSec: Math.round((now - old.at) / 1000) };
    throw e;
  }
}

/** Arrivals board for one direction of a crossing. */
export function arrivalsBoard(crossing, dir, now = new Date()) {
  const crs = dir.board.crs;
  const hit = cache.get(crs);
  if (hit && now.getTime() - hit.at < TTL_MS) return hit.board;
  const board = live ? fetchLive(crs, now.getTime()) : Promise.resolve(mockBoard(crossing, dir, now));
  board.then((b) => { if (!b.staleSec) last.set(crs, { at: now.getTime(), board: b }); }, () => cache.delete(crs));
  cache.set(crs, { at: now.getTime(), board });
  return board;
}

/**
 * Every board a crossing reads, keyed by CRS. A board that fails is left out
 * and its error reported, so one bad station (a typo in the registry, a
 * Darwin hiccup) degrades that direction rather than the whole crossing.
 * Throws only if nothing could be read at all.
 */
export async function boardsFor(crossing, now = new Date()) {
  const wanted = [...new Map(crossing.directions.map((d) => [d.board.crs, d])).values()];
  const results = await Promise.allSettled(wanted.map((dir) => arrivalsBoard(crossing, dir, now)));
  const boards = {};
  const errors = [];
  let staleSec = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { boards[wanted[i].board.crs] = r.value; staleSec = Math.max(staleSec, r.value.staleSec ?? 0); }
    else errors.push(`${wanted[i].board.crs}: ${r.reason?.message ?? r.reason}`);
  });
  if (!Object.keys(boards).length) throw new Error(errors.join('; '));
  return { boards, errors, staleSec };
}
