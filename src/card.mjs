// The picture a shared link shows: "Is the barrier down at LISS?" over the
// crossing's road and line, in the site's own type and colours, 1200×630
// as Facebook and WhatsApp want. No live state on it — chat apps cache
// previews for hours, and a stale "OPEN" under our name would be worse
// than no picture. One SVG, rasterised on demand and kept in memory.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONTS = [path.join(here, '..', 'assets', 'barlow-condensed-800.ttf'), path.join(here, '..', 'assets', 'barlow-condensed-500.ttf')];

export const W = 1200, H = 630;
const BG = '#0b1220', INK = '#f1f5f9', MUTED = '#94a3b8', SIGNAL = '#d32f2f', PALE = '#e2e8f0';
const BARRIER = { full: 'full barriers', half: 'half barriers', gates: 'gates', open: 'lights only' };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Barlow Condensed ExtraBold is about 0.46 em per character; the name has
// to fit one line at whatever size that allows, down to a floor.
const fit = (text, maxWidth, maxSize, minSize = 64) => Math.max(minSize, Math.min(maxSize, Math.floor(maxWidth / (0.46 * text.length))));

// The medium weight is a little narrower: ~0.42 em per character. A long
// road + line name shrinks to fit rather than running off the edge.
const subSize = (text) => Math.max(26, Math.min(40, Math.floor((W - 128) / (0.42 * text.length))));

/** Split at the word boundary nearest the middle, for a name too long for one line. */
function halve(text) {
  const words = text.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const longest = Math.max(a.length, b.length);
    if (!best || longest < best.longest) best = { a, b, longest };
  }
  return best ? [best.a, best.b] : [text];
}

/** The hazard stripe from the top of every page, as a pattern. */
const stripe = (id, thick) => `<pattern id="${id}" width="${thick * 2}" height="${thick * 2}" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
  <rect width="${thick}" height="${thick * 2}" fill="${SIGNAL}"/><rect x="${thick}" width="${thick}" height="${thick * 2}" fill="${PALE}"/></pattern>`;

const brand = (y) => `<g transform="translate(64 ${y})">
  <path d="M4 8l24 16M28 8L4 24" stroke="${SIGNAL}" stroke-width="6" stroke-linecap="round" fill="none"/>
  <text x="44" y="26" font-family="Barlow Condensed" font-weight="800" font-size="30" fill="${INK}" letter-spacing="1">CROSSINGS</text>
</g>`;

export function cardSvg(crossing) {
  const name = crossing ? crossing.name.toUpperCase() : null;
  const lines = crossing
    ? [`${crossing.road} · ${crossing.line}`, [BARRIER[crossing.barrierType], crossing.station ? `at ${crossing.station.name} station` : null].filter(Boolean).join(' · ')]
    : ['Live estimates for every level crossing in Great Britain,', 'from the trains heading towards it.'];
  let title, subY = name ? 400 : 460;
  if (name) {
    const size = fit(`IS THE BARRIER DOWN AT ${name}?`, W - 128, 120);
    // One line if it fits large enough; else the name on its own line; else
    // the name over two lines, all at one size.
    if (size >= 88) {
      title = `<text x="64" y="300" font-family="Barlow Condensed" font-weight="800" font-size="${size}" fill="${INK}">IS THE BARRIER DOWN AT <tspan fill="${SIGNAL}">${esc(name)}</tspan>?</text>`;
    } else {
      const one = fit(name + '?', W - 128, 150, 0);
      const rows = one >= 72 ? [name + '?'] : halve(name + '?');
      const rowSize = Math.min(150, ...rows.map((r) => fit(r, W - 128, 150, 0)));
      const lead = rows.length > 1 ? 80 : 96;
      const y0 = rows.length > 1 ? 200 : 240;
      title = `<text x="64" y="${y0}" font-family="Barlow Condensed" font-weight="800" font-size="${lead}" fill="${INK}">IS THE BARRIER DOWN AT</text>`
        + rows.map((r, i) => `<text x="64" y="${y0 + rowSize * 0.95 * (i + 1)}" font-family="Barlow Condensed" font-weight="800" font-size="${rowSize}" fill="${SIGNAL}">${esc(r)}</text>`).join('');
      subY = Math.max(subY, y0 + rowSize * 0.95 * rows.length + 60);
    }
  } else {
    title = `<text x="64" y="240" font-family="Barlow Condensed" font-weight="800" font-size="150" fill="${INK}">IS THE <tspan fill="${SIGNAL}">BARRIER</tspan></text>
             <text x="64" y="380" font-family="Barlow Condensed" font-weight="800" font-size="150" fill="${INK}">DOWN?</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${stripe('hz', 14)}</defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="18" fill="url(#hz)"/>
  <rect y="${H - 18}" width="${W}" height="18" fill="url(#hz)"/>
  ${brand(56)}
  ${title}
  ${lines.map((l, i) => `<text x="64" y="${subY + 50 * i}" font-family="Barlow Condensed" font-weight="500" font-size="${subSize(l)}" fill="${MUTED}">${esc(l)}</text>`).join('\n  ')}
  <text x="64" y="${H - 56}" font-family="Barlow Condensed" font-weight="500" font-size="30" fill="${MUTED}">${name ? 'Live estimate from the trains heading towards it · ' : ''}crossings.onrender.com</text>
</svg>`;
}

const cache = new Map();
const MAX_CACHED = 400;

/** PNG bytes for a crossing's card (or the site's, for null). */
export function cardPng(crossing) {
  const key = crossing?.id ?? '';
  const hit = cache.get(key);
  if (hit) return hit;
  const png = new Resvg(cardSvg(crossing), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Barlow Condensed' }, fitTo: { mode: 'width', value: W } }).render().asPng();
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(key, png);
  return png;
}

