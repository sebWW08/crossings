// Fetches Darwin arrivals boards (Rail Data Marketplace LDBWS) with a short
// per-station cache, falling back to synthetic data when no key is configured.

import { mockBoard } from './mock.js';

const TTL_MS = 30_000;
const KEY = process.env.DARWIN_API_KEY || '';
const BASE = (process.env.DARWIN_ARRIVALS_URL ||
  'https://api1.raildata.org.uk/1010-live-arrival-board-arr1_2/LDBWS/api/20220120/GetArrBoardWithDetails'
).replace(/\/$/, '');

export const live = Boolean(KEY);

/** @type {Map<string, {at:number, board:Promise<object>}>} */
const cache = new Map();

async function fetchLive(crs) {
  const url = `${BASE}/${crs}?numRows=20&timeWindow=120`;
  const res = await fetch(url, { headers: { 'x-apikey': KEY, accept: 'application/json' } });
  if (!res.ok) throw new Error(`Darwin ${crs}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  return res.json();
}

/** Arrivals board for one direction of a crossing. */
export function arrivalsBoard(crossing, dir, now = new Date()) {
  const crs = dir.board.crs;
  const hit = cache.get(crs);
  if (hit && now.getTime() - hit.at < TTL_MS) return hit.board;
  const board = live ? fetchLive(crs) : Promise.resolve(mockBoard(crossing, dir, now));
  board.catch(() => cache.delete(crs));
  cache.set(crs, { at: now.getTime(), board });
  return board;
}

export async function boardsFor(crossing, now = new Date()) {
  const entries = await Promise.all(
    crossing.directions.map(async (dir) => [dir.board.crs, await arrivalsBoard(crossing, dir, now)]),
  );
  return Object.fromEntries(entries);
}
