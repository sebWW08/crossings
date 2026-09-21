import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allCrossings, getCrossing, summarise } from './src/registry.js';
import { boardsFor, live } from './src/darwin.js';
import { predict } from './src/predict.js';
import { cleanReport, tooSoon, record, recent as recentFeedback, load as loadFeedback } from './src/feedback.mjs';
import * as stats from './src/stats.mjs';
import { cardPng, W as CARD_W, H as CARD_H } from './src/card.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT) || 3000;
const SITE = (process.env.SITE_URL || 'https://crossings.onrender.com').replace(/\/$/, '');

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

/** Small JSON bodies only; anything else is a 413 or a 400. */
function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function api(url, req, res) {
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, live, crossings: allCrossings().length });
  if (url.pathname === '/api/stats') return json(res, 200, stats.snapshot());
  if (url.pathname === '/api/feedback' && req.method === 'GET') return json(res, 200, recentFeedback());
  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (e) { return json(res, e.status ?? 400, { error: e.message }); }
    const report = cleanReport(body, getCrossing(String(body.crossing ?? '')));
    if (!report) return json(res, 400, { error: 'bad report' });
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (tooSoon(`${ip}/${report.crossing}`)) return json(res, 429, { error: 'already noted — thanks' });
    await record(report);
    stats.feedbackTap(report.crossing);
    return json(res, 200, { ok: true });
  }
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
    stats.watched(req, crossing.id, url.searchParams.get('v'));
    const now = new Date();
    try {
      const { boards, errors, staleSec } = await boardsFor(crossing, now);
      const p = predict(crossing, boards, now);
      if (errors.length) console.warn(`${crossing.id}: partial boards —`, errors.join('; '));
      return json(res, 200, {
        crossing: summarise(crossing),
        live,
        now: now.getTime(),
        ...p,
        partial: errors.length ? errors : undefined,
        staleSec: staleSec || undefined,
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

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BARRIER = { full: 'full barriers', half: 'half barriers', gates: 'gates', open: 'lights only' };

/**
 * The app is one page, but each crossing gets its own URL (/milford) with
 * a real <title> and description, so a link pasted into a group chat gets
 * a preview and a search for the crossing's name can find it. The HTML is
 * the same file with the head filled in; the page then routes itself.
 */
let indexHtml = null;
async function page(url, req, res) {
  indexHtml ??= await readFile(path.join(PUBLIC, 'index.html'), 'utf8');
  const id = url.pathname.slice(1);
  let title, description, kind = 'home', status = 200;
  if (!id) {
    title = 'Crossings — is the barrier down?';
    description = 'Live estimates for every level crossing in Great Britain: whether the barriers are down now, and when they will next close, from the trains heading towards it.';
  } else if (id === 'map') {
    title = 'Every level crossing in Great Britain — Crossings';
    description = 'A map of every road level crossing on the National Rail network, each with a live estimate of when its barriers will next close.';
    kind = 'map';
  } else {
    const c = getCrossing(id);
    if (!c) { res.writeHead(404, { 'content-type': 'text/plain' }).end('no such crossing'); return; }
    title = `Is the barrier down at ${c.name}? — Crossings`;
    description = `Live estimate of when the level crossing on ${c.road}${c.station ? ` at ${c.station.name} station` : ''} (${c.line}, ${BARRIER[c.barrierType] ?? 'barriers'}) will close and reopen, from the trains heading towards it.`;
    kind = 'crossing';
  }
  stats.landing(req, kind);
  const canonical = `${SITE}${url.pathname}`;
  const image = `${SITE}/og/${kind === 'crossing' ? id : 'crossings'}.png`;
  const head = [
    `<title>${escHtml(title)}</title>`,
    `<meta name="description" content="${escHtml(description)}">`,
    `<link rel="canonical" href="${escHtml(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Crossings">`,
    `<meta property="og:title" content="${escHtml(title)}">`,
    `<meta property="og:description" content="${escHtml(description)}">`,
    `<meta property="og:url" content="${escHtml(canonical)}">`,
    `<meta property="og:image" content="${escHtml(image)}">`,
    `<meta property="og:image:width" content="${CARD_W}">`,
    `<meta property="og:image:height" content="${CARD_H}">`,
    `<meta property="og:image:alt" content="${escHtml(title)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${escHtml(image)}">`,
  ].join('\n  ');
  const html = indexHtml.replace(/<title>[^<]*<\/title>/, head);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html);
}

function sitemap(res) {
  const urls = ['/', '/map', ...allCrossings().map((c) => `/${c.id}`)];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${escHtml(SITE + u)}</loc></url>`).join('\n')}\n</urlset>\n`;
  res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=86400' });
  res.end(body);
}

async function serveStatic(url, req, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/sitemap.xml') return sitemap(res);
  if (rel === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /stats\nSitemap: ${SITE}/sitemap.xml\n`); }
  if (rel === '/stats') rel = '/stats.html'; // the usage dashboard, a page of its own
  else if (rel === '/' || /^\/[a-z0-9-]+$/.test(rel)) return page(url, req, res);
  const og = /^\/og\/([a-z0-9-]+)\.png$/.exec(rel);
  if (og) {
    // The link-preview picture. Nothing live on it, so it can be cached hard.
    const crossing = og[1] === 'crossings' ? null : getCrossing(og[1]);
    if (og[1] !== 'crossings' && !crossing) { res.writeHead(404).end('not found'); return; }
    const png = cardPng(crossing);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'public, max-age=604800' });
    return res.end(png);
  }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    // Always revalidate, cheaply: a deploy must not leave phones on last
    // week's app.js, and a 304 costs nothing.
    const st = await stat(file);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return api(url, req, res).catch((e) => json(res, 500, { error: String(e) }));
    return serveStatic(url, req, res).catch((e) => { console.error(e); res.writeHead(500).end(); });
  })
  .listen(PORT, async () => {
    await Promise.all([stats.load(), loadFeedback()]);
    stats.start();
    console.log(`crossings: http://localhost:${PORT}  (${live ? 'live Darwin data' : 'DEMO data — set DARWIN_API_KEY for live'})`);
  });
