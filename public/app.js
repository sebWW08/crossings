const app = document.getElementById('app');
const liveBadge = document.getElementById('live-badge');
const REFRESH_MS = 30_000;
const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet';

let refreshTimer = null;
let tickTimer = null;

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const hhmm = (ms) => clock.format(new Date(ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Per-device preferences: favourite crossings and the last place we saw the
// user, so the list opens sorted by distance before geolocation answers.
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const favourites = () => new Set(store.get('favourites', []));
function toggleFavourite(id) {
  const f = favourites();
  f.has(id) ? f.delete(id) : f.add(id);
  store.set('favourites', [...f]);
  return f.has(id);
}
const starButton = (id) => `<button class="star" data-fav="${esc(id)}" aria-pressed="${favourites().has(id)}" title="Favourite">★</button>`;
function bindStars(root, onChange) {
  for (const b of root.querySelectorAll('button[data-fav]')) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      b.setAttribute('aria-pressed', String(toggleFavourite(b.dataset.fav)));
      onChange?.();
    });
  }
}

function kmBetween(a, b) {
  const r = Math.PI / 180, R = 6371;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const kmLabel = (km) => (km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);

function human(ms, { about = false } = {}) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 10 || about) return `${about ? '~' : ''}${m} min`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function barrierLabel(t) {
  return { full: 'full barriers', half: 'half barriers', gates: 'gates', open: 'open crossing (lights)', unknown: 'barriers (type unconfirmed)' }[t] ?? esc(t ?? '');
}

function setLive(live) {
  liveBadge.hidden = false;
  liveBadge.textContent = live ? 'live' : 'demo data';
  liveBadge.classList.toggle('live', live);
}

function stopTimers() {
  clearTimeout(refreshTimer);
  clearInterval(tickTimer);
}

// ---------- map ----------
let leafletLoad = null; // Leaflet is only fetched the first time the map is opened
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletLoad ??= new Promise((resolve, reject) => {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${LEAFLET}.css` }));
    const s = Object.assign(document.createElement('script'), { src: `${LEAFLET}.js` });
    s.onload = () => resolve(window.L);
    s.onerror = () => { leafletLoad = null; reject(new Error('map library failed to load')); };
    document.head.append(s);
  });
  return leafletLoad;
}

let map = null;    // { L, map, markers: Map<id, marker>, layer }
function markerColour(c) {
  return { full: '#2563eb', half: '#b45309', gates: '#7c3aed', open: '#dc2626' }[c.barrierType] ?? '#6b7280';
}

async function showMap(container, crossings) {
  const L = await loadLeaflet();
  const m = L.map(container, { zoomSnap: 0.5, zoomControl: false }).setView([54.5, -3], 5); // a view before any layer: Leaflet's renderer needs one
  L.control.zoom({ position: 'topright' }).addTo(m);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(m);
  const layer = L.layerGroup().addTo(m);
  const markers = new Map();
  for (const c of crossings) {
    const mk = L.circleMarker([c.lat, c.lon], { radius: 7, color: '#fff', weight: 2, fillColor: markerColour(c), fillOpacity: 1 })
      .bindTooltip(`<b>${esc(c.name)}</b><br>${esc(c.road)}`)
      .on('click', () => { location.hash = `#/${c.id}`; });
    markers.set(c.id, mk);
  }
  // Dots the size of towns at the national zoom; full size once zoomed in.
  const size = () => { const r = m.getZoom() < 8 ? 3 : m.getZoom() < 11 ? 5 : 7; layer.eachLayer((mk) => mk.setRadius(r)); };
  m.on('zoomend', size);
  map = { L, map: m, markers, layer, here: null, size };
  return map;
}

function drawHere(pos) {
  if (!map || !pos) return;
  map.here?.remove();
  map.here = map.L.circleMarker([pos.lat, pos.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#111', fillOpacity: 1 })
    .bindTooltip('You are here').addTo(map.map);
}

// Show only the given crossings on the map; frame them, or the user's
// surroundings when we know where they are.
function drawMap(items, focus = null) {
  if (!map) return;
  map.layer.clearLayers();
  const pts = [];
  for (const c of items) {
    const mk = map.markers.get(c.id);
    if (!mk) continue;
    mk.addTo(map.layer);
    pts.push(mk.getLatLng());
  }
  // The hero copy sits over the map's top-left: keep the dots clear of it.
  const el = map.map.getContainer();
  const hero = el.closest('.hero');
  const overlaid = hero && el.clientWidth > 640; // on phones the copy sits above the map instead
  const pad = overlaid ? (el.clientWidth > 900 ? [Math.round(el.clientWidth * 0.5), 24] : [24, 250]) : [24, 24];
  if (focus) {
    map.map.setView([focus.lat, focus.lon], 10, { animate: false });
    if (overlaid) map.map.panBy([-pad[0] / 2, -pad[1] / 2 + 12], { animate: false });
  } else if (pts.length) map.map.fitBounds(map.L.latLngBounds(pts), { paddingTopLeft: pad, paddingBottomRight: [24, hero ? 80 : 24], maxZoom: 14, animate: false });
  map.size();
}

function destroyMap() {
  map?.map.remove();
  map = null;
}

// ---------- home ----------
const SHOW_FIRST = 40; // cards before "show all": 1,300 crossings is a lot of DOM on a phone
const TILES_MAX = 6;   // live tiles: each one is a round trip to Darwin

const LEGEND = `<div class="legend">${['full', 'half', 'gates', 'open'].map((t) => `<span><i style="background:${markerColour({ barrierType: t })}"></i>${t === 'full' ? 'full barriers' : t}</span>`).join('')}</div>`;
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';

/** One crossing's live state, shared by the tiles and the crossing page. */
function statusOf(data, now) {
  const cur = data.current && data.current.openAt > now ? data.current : null;
  const live = cur ?? data.upcoming.find((c) => c.closeAt <= now && now < c.openAt) ?? null;
  if (live) return { kind: 'closed', state: 'Closed', count: `reopens in ${human(live.openAt - now)}`, sub: live.uncertain ? 'a train is running late — timing is uncertain' : `expected up at ${hhmm(live.openAt)}`, at: live.openAt };
  const next = data.upcoming.find((c) => c.closeAt > now) ?? null;
  if (next) {
    const until = next.closeAt - now;
    return { kind: until < 120_000 ? 'soon' : 'open', state: 'Open', count: `closes in ${human(until)}`, sub: `${hhmm(next.closeAt)} for ${human(next.openAt - next.closeAt, { about: true })}${next.uncertain ? ' · uncertain' : ''}`, at: next.closeAt };
  }
  return { kind: 'open', state: 'Open', count: '', sub: 'no trains due in the next two hours', at: null };
}

async function renderList() {
  stopTimers();
  destroyMap();
  const res = await fetch('/api/crossings');
  const data = await res.json();
  setLive(data.live);
  const all = data.crossings;
  const byId = new Map(all.map((c) => [c.id, c]));
  let here = store.get('here', null); // { lat, lon }
  let showAll = false;

  const byName = (a, b) => a.name.localeCompare(b.name, 'en-GB');
  const sorted = () => {
    if (!here) return [...all].sort(byName);
    return all.map((c) => ({ ...c, km: kmBetween(here, c) })).sort((a, b) => a.km - b.km);
  };
  const query = () => (document.getElementById('q')?.value ?? '').trim();
  const filtered = (list) => {
    const q = query().toLowerCase();
    return list.filter((c) => !q || `${c.name} ${c.road} ${c.line}`.toLowerCase().includes(q));
  };

  const card = (c) => `
    <div class="card"><a href="#/${esc(c.id)}" class="main">
      <span class="dot" style="background:${markerColour(c)}"></span>
      <span style="min-width:0">
        <div class="name">${esc(c.name)}</div>
        <div class="muted small">${esc(c.road)} · ${esc(c.line)} · ${barrierLabel(c.barrierType)}</div>
      </span>
    </a><div class="side">${c.km != null ? `<span class="muted small num">${kmLabel(c.km)}</span>` : ''}${starButton(c.id)}</div></div>`;

  // Live tiles: favourites, else the nearest few once we know where we are.
  const tileStates = new Map(); // id → payload from /api/crossings/:id
  const tileIds = () => {
    const favs = [...favourites()].filter((id) => byId.has(id));
    if (favs.length) return favs.slice(0, TILES_MAX);
    return here ? sorted().slice(0, 3).map((c) => c.id) : [];
  };
  const tile = (id) => {
    const c = byId.get(id);
    const d = tileStates.get(id);
    const st = d ? statusOf(d, Date.now() + skew) : null;
    const km = here ? kmLabel(kmBetween(here, c)) : '';
    return `<a class="tile ${st ? st.kind : 'loading'}" href="#/${esc(id)}">
      <div class="tname">${esc(c.name)}</div>
      <div class="troad">${esc(c.road)}${km ? ` · ${km}` : ''}</div>
      <div class="tstate">${st ? st.state : '…'}</div>
      <div class="tsub">${st ? (st.count ? `<b>${esc(st.count)}</b> · ${esc(st.sub)}` : esc(st.sub)) : 'checking the boards'}</div>
    </a>`;
  };
  const drawTiles = () => {
    const el = document.getElementById('tiles');
    if (!el) return;
    const ids = tileIds();
    el.hidden = !ids.length;
    el.innerHTML = ids.length ? `<h2>${favourites().size ? 'Your crossings' : 'Nearest right now'}</h2><div class="tiles">${ids.map(tile).join('')}</div>` : '';
  };
  const loadTiles = async () => {
    await Promise.all(tileIds().filter((id) => !tileStates.has(id)).map(async (id) => {
      try {
        const r = await fetch(`/api/crossings/${encodeURIComponent(id)}`);
        const d = await r.json();
        if (r.ok) { tileStates.set(id, d); skew = d.now - Date.now(); }
      } catch { /* leave it loading */ }
    }));
    drawTiles();
  };

  const draw = () => {
    const list = sorted();
    const items = filtered(list);
    const q = query();
    drawMap(items, q ? null : here);
    const favs = favourites();
    const rest = q ? items : items.filter((c) => !favs.has(c.id));
    const shown = showAll || q ? rest : rest.slice(0, SHOW_FIRST);
    const el = document.getElementById('list');
    el.innerHTML = [
      `<h2>${q ? `${items.length} match${items.length === 1 ? '' : 'es'}` : here ? 'Nearest first' : 'All crossings, A–Z'}</h2>`,
      shown.map(card).join(''),
      !shown.length ? '<p class="muted">No crossings match.</p>' : '',
      shown.length < rest.length ? `<button id="more" class="wide">Show all ${rest.length}</button>` : '',
    ].join('');
    bindStars(el, () => { draw(); loadTiles(); });
    document.getElementById('more')?.addEventListener('click', () => { showAll = true; draw(); });
    document.getElementById('near').setAttribute('aria-pressed', String(!!here));
    drawTiles();
  };

  const nrShare = Math.round(100 * all.filter((c) => c.nr).length / all.length);
  app.innerHTML = `
    <section class="hero">
      <div id="map" class="map"></div>
      <div class="hero-copy"><div class="hero-inner">
        <h1 class="display">Is the <em>barrier</em> down?</h1>
        <p class="lede">Live estimates for every level crossing in Great Britain, from the trains heading towards it.</p>
        <form class="searchbar" role="search" onsubmit="return false">
          ${SEARCH_ICON}
          <input id="q" placeholder="Search ${all.length.toLocaleString('en-GB')} crossings by name, road or line" autocomplete="off" aria-label="Search crossings">
          <button id="near" type="button" title="Sort by distance from me" aria-pressed="false">Near me</button>
        </form>
        <p class="stats"><span><b>${all.length.toLocaleString('en-GB')}</b> crossings</span><span><b>${nrShare}%</b> matched to Network Rail's register</span><span>${data.live ? '<b>live</b> Darwin data' : '<b>demo</b> timetable'}</span></p>
      </div></div>
      ${LEGEND}
      <a class="explore-link" href="#/map" title="Just the map, full screen">Explore the map ↗</a>
    </section>
    <div class="wrap home">
      <div id="tiles" hidden></div>
      <div id="list" class="list"></div>
    </div>`;
  draw();
  document.getElementById('q').addEventListener('input', draw);

  // The map is the hero; it draws as soon as Leaflet is in.
  const mapEl = document.getElementById('map');
  try {
    await showMap(mapEl, all);
    drawHere(here);
    drawMap(filtered(sorted()), query() ? null : here);
  } catch (e) {
    mapEl.innerHTML = `<p class="err small wrap">${esc(e.message)}</p>`;
  }

  // Location: asked for with the button; once granted, used quietly on every visit.
  const locate = () => new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { maximumAge: 60_000, timeout: 8_000 },
    );
  });
  const useLocation = async () => {
    const pos = await locate();
    if (!pos) return;
    here = pos;
    store.set('here', here);
    drawHere(here);
    draw();
    loadTiles();
  };
  document.getElementById('near').addEventListener('click', () => {
    if (here) { here = null; store.set('here', null); map?.here?.remove(); draw(); loadTiles(); return; }
    useLocation();
  });
  navigator.permissions?.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') useLocation(); }).catch(() => {});

  loadTiles();
  tickTimer = setInterval(drawTiles, 1000);
  const schedule = () => {
    refreshTimer = setTimeout(async () => {
      if (location.hash && location.hash !== '#/') return;
      tileStates.clear();
      await loadTiles();
      schedule();
    }, REFRESH_MS);
  };
  schedule();
}

// ---------- map only ----------
// For people who just want to see where the crossings are: the whole
// country, full height, nothing over it. Tap a dot for its page.
async function renderMap() {
  stopTimers();
  destroyMap();
  const res = await fetch('/api/crossings');
  const data = await res.json();
  setLive(data.live);
  app.innerHTML = `
    <section class="explore">
      <div id="map" class="map"></div>
      <a class="explore-back" href="#/">‹ Back</a>
      ${LEGEND}
      <div class="explore-count">${data.crossings.length.toLocaleString('en-GB')} level crossings · tap one</div>
    </section>`;
  const mapEl = document.getElementById('map');
  try {
    await showMap(mapEl, data.crossings);
    const here = store.get('here', null);
    drawHere(here);
    drawMap(data.crossings);
  } catch (e) {
    mapEl.innerHTML = `<p class="err small wrap">${esc(e.message)}</p>`;
  }
}

// ---------- crossing ----------
let state = null; // last payload for the current crossing
let skew = 0;     // server now − client now

const ARROWS = { north: '↑', northeast: '↗', east: '→', southeast: '↘', south: '↓', southwest: '↙', west: '←', northwest: '↖' };

function trainLine(t) {
  const arrow = ARROWS[t.direction] ?? '·';
  return `<div class="train"><span class="dir">${arrow}</span>${esc(t.destination ?? t.towards)} <span class="kind">· ${t.stops ? 'stopping' : 'non-stop'}${t.operator ? ` · ${esc(t.operator)}` : ''}</span>${t.uncertain ? '<span class="unc">delayed, time uncertain</span>' : ''}</div>`;
}

function closureBlock(c) {
  return `<div class="closure">
    <div><div class="when">${hhmm(c.closeAt)}–${hhmm(c.openAt)}</div><div class="dur">${human(c.openAt - c.closeAt, { about: true })} down</div></div>
    <div>${c.trains.map(trainLine).join('')}</div>
  </div>`;
}

function drawStatus() {
  if (!state) return;
  const el = document.getElementById('status');
  if (!el) return;
  const st = statusOf(state, Date.now() + skew);
  el.className = `card status ${st.kind}`;
  el.innerHTML = `<div class="state">${st.state}</div>${st.count ? `<div class="count">${st.count}</div>` : ''}<div class="sub">${st.sub}</div>`;
}

async function loadCrossing(id) {
  const res = await fetch(`/api/crossings/${encodeURIComponent(id)}`);
  const data = await res.json();
  if (!res.ok) {
    app.innerHTML = `<div class="wrap"><p class="err">${esc(data.error ?? 'error')}</p><p class="muted small">${esc(data.detail ?? '')}</p><p><a href="#/">All crossings</a></p></div>`;
    return;
  }
  setLive(data.live);
  state = data;
  skew = data.now - Date.now();
  const c = data.crossing;
  const mins = Math.round(data.closedSecNextHour / 60);
  app.innerHTML = `<div class="wrap page">
    <p class="small"><a href="#/">‹ All crossings</a></p>
    <div class="title"><h1>${esc(c.name)}</h1>${starButton(c.id)}</div>
    <div class="muted">${esc(c.road)} · ${esc(c.line)}${c.station ? ` · at ${esc(c.station.name)} station` : ''}</div>
    <div class="muted small">${barrierLabel(c.barrierType)}${c.nr ? ` · Network Rail: ${esc(c.nr.name)} (${esc(c.nr.type)}), ${esc(c.nr.elr)} ${c.nr.miles}m ${c.nr.chains}ch` : ''}</div>
    <div id="status" class="card status"></div>
    <div id="verify" class="verify">
      <span>At the crossing? Was this right — barriers are actually</span>
      <button type="button" data-observed="down">Down</button>
      <button type="button" data-observed="up">Up</button>
    </div>
    <p class="muted small">Barriers expected down for about ${mins} min of the next hour. Updated ${hhmm(data.now)}.</p>
    ${c.parallel ? '<p class="unc small">This road is on a line that runs beside a faster one between the same stations. Trains on the other line never close these barriers, and the live boards cannot tell the two apart, so only trains known to have come this way are shown.</p>' : ''}
    ${data.partial ? `<p class="unc small">Some trains may be missing: could not read ${data.partial.length} of the boards this crossing depends on.</p>` : ''}
    <h2>Coming up</h2>
    <div class="card">${data.upcoming.length ? data.upcoming.map(closureBlock).join('') : '<p class="muted">Nothing in the next two hours.</p>'}</div>
    ${data.recent.length ? `<h2>Recent</h2><div class="card">${data.recent.map(closureBlock).join('')}</div>` : ''}
    <p class="muted small">Directions: ${data.directions.map((d) => `${ARROWS[d.key] ?? '·'} ${esc(d.label)} towards ${esc(d.towards)}`).join(' · ')}</p>
  </div>`;
  bindStars(app);
  bindVerify(c.id);
  drawStatus();
}

// "Was this right?": send what the page is showing alongside what they saw.
function bindVerify(id) {
  const box = document.getElementById('verify');
  if (!box) return;
  for (const b of box.querySelectorAll('button[data-observed]')) {
    b.addEventListener('click', async () => {
      const now = Date.now() + skew;
      const st = statusOf(state, now);
      const cur = state.current && state.current.openAt > now ? state.current : state.upcoming.find((c) => c.closeAt <= now && now < c.openAt);
      const next = cur ?? state.upcoming.find((c) => c.closeAt > now) ?? null;
      const report = {
        crossing: id, observed: b.dataset.observed, predicted: st.kind, predictedAt: st.at,
        closeAt: next?.closeAt ?? null, openAt: next?.openAt ?? null,
        dataAge: Date.now() + skew - state.now, live: state.live, ua: navigator.userAgent,
      };
      box.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try {
        const r = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
        const agree = (b.dataset.observed === 'down') === (st.kind === 'closed');
        box.innerHTML = r.ok || r.status === 429
          ? `<span class="thanks">${agree ? 'Thanks — that matches the estimate.' : 'Thanks — noted that the estimate was wrong here. This is how it gets better.'}</span>`
          : '<span class="err">Could not send that just now.</span>';
      } catch {
        box.innerHTML = '<span class="err">Could not send that just now.</span>';
      }
    });
  }
}

async function renderCrossing(id) {
  stopTimers();
  app.innerHTML = '<p class="wrap muted">Loading…</p>';
  await loadCrossing(id);
  tickTimer = setInterval(drawStatus, 1000);
  const schedule = () => {
    refreshTimer = setTimeout(async () => {
      if (location.hash !== `#/${id}`) return;
      try { await loadCrossing(id); } catch (e) { console.warn('refresh failed', e); }
      schedule();
    }, REFRESH_MS);
  };
  schedule();
}

function route() {
  const m = /^#\/([a-z0-9-]+)/.exec(location.hash);
  if (m?.[1] === 'map') renderMap().catch(showError);
  else if (m) renderCrossing(m[1]).catch(showError);
  else renderList().catch(showError);
}
function showError(e) {
  app.innerHTML = `<p class="wrap err">Something went wrong: ${esc(e.message ?? e)}</p>`;
}
window.addEventListener('hashchange', route);
route();
