import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allCrossings, getCrossing, summarise } from './src/registry.js';
import { boardsFor, live } from './src/darwin.js';
import { predict } from './src/predict.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function api(url, res) {
  if (url.pathname === '/api/crossings') {
    let list = allCrossings().map(summarise);
    const near = url.searchParams.get('near');
    if (near) {
      const [lat, lon] = near.split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        list = list
          .map((c) => ({ ...c, distanceKm: Math.round(haversineKm({ lat, lon }, c) * 10) / 10 }))
          .sort((a, b) => a.distanceKm - b.distanceKm);
      }
    }
    return json(res, 200, { live, crossings: list });
  }

  const m = /^\/api\/crossings\/([a-z0-9-]+)$/.exec(url.pathname);
  if (m) {
    const crossing = getCrossing(m[1]);
    if (!crossing) return json(res, 404, { error: 'unknown crossing' });
    const now = new Date();
    try {
      const { boards, errors } = await boardsFor(crossing, now);
      const p = predict(crossing, boards, now);
      if (errors.length) console.warn(`${crossing.id}: partial boards —`, errors.join('; '));
      return json(res, 200, {
        crossing: summarise(crossing),
        live,
        now: now.getTime(),
        ...p,
        partial: errors.length ? errors : undefined,
        movements: undefined,
        directions: [...new Map(crossing.directions.map((d) => [d.key, { key: d.key, label: d.label, towards: d.towards }])).values()],
      });
    } catch (err) {
      console.error(err);
      return json(res, 502, { error: 'could not reach the live departure service', detail: String(err.message ?? err) });
    }
  }
  return json(res, 404, { error: 'not found' });
}

async function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // hash-routed SPA
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return api(url, res).catch((e) => json(res, 500, { error: String(e) }));
    return serveStatic(url, res);
  })
  .listen(PORT, () => {
    console.log(`crossings: http://localhost:${PORT}  (${live ? 'live Darwin data' : 'DEMO data — set DARWIN_API_KEY for live'})`);
  });
