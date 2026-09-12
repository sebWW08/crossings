const app = document.getElementById('app');
const liveBadge = document.getElementById('live-badge');
const REFRESH_MS = 30_000;

let refreshTimer = null;
let tickTimer = null;

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const hhmm = (ms) => clock.format(new Date(ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function human(ms, { about = false } = {}) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 10 || about) return `${about ? '~' : ''}${m} min`;
  return `${m}:${String(r).padStart(2, '0')}`;
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

// ---------- list ----------
async function renderList() {
  stopTimers();
  const res = await fetch('/api/crossings');
  const data = await res.json();
  setLive(data.live);
  let list = data.crossings;

  const draw = () => {
    const q = (document.getElementById('q')?.value ?? '').trim().toLowerCase();
    const items = list.filter((c) => !q || `${c.name} ${c.road} ${c.line}`.toLowerCase().includes(q));
    document.getElementById('list').innerHTML = items.length
      ? items.map((c) => `
        <a href="#/${esc(c.id)}"><div class="card">
          <div><div class="name">${esc(c.name)}</div><div class="muted small">${esc(c.road)} · ${esc(c.line)}</div></div>
          <div class="muted small">${c.distanceKm != null ? `${c.distanceKm} km` : ''}</div>
        </div></a>`).join('')
      : '<p class="muted">No crossings match.</p>';
  };

  app.innerHTML = `
    <h1>Level crossings</h1>
    <p class="muted">Pick a crossing to see when the barriers are expected down.</p>
    <div class="row">
      <input id="q" class="search" placeholder="Search by name, road or line" autocomplete="off">
      <button id="near" title="Sort by distance from me">Near me</button>
    </div>
    <div id="list" class="list"></div>`;
  draw();
  document.getElementById('q').addEventListener('input', draw);
  document.getElementById('near').addEventListener('click', () => {
    navigator.geolocation?.getCurrentPosition(async (pos) => {
      const r = await fetch(`/api/crossings?near=${pos.coords.latitude},${pos.coords.longitude}`);
      list = (await r.json()).crossings;
      draw();
    });
  });
}

// ---------- crossing ----------
let state = null; // last payload for the current crossing
let skew = 0;     // server now − client now

function trainLine(t) {
  const arrow = t.direction === 'north' ? '↑' : t.direction === 'south' ? '↓' : t.direction === 'east' ? '→' : '←';
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
  const now = Date.now() + skew;
  const el = document.getElementById('status');
  if (!el) return;
  const cur = state.current && state.current.openAt > now ? state.current : null;
  const next = state.upcoming.find((c) => c.closeAt > now) ?? null;
  // Re-evaluate against the moving clock rather than the server's snapshot.
  const live = cur ?? state.upcoming.find((c) => c.closeAt <= now && now < c.openAt) ?? null;

  if (live) {
    el.className = 'card status closed';
    el.innerHTML = `<div class="state">CLOSED</div>
      <div class="count">reopens in ${human(live.openAt - now)}</div>
      <div class="sub">${live.uncertain ? 'a train is running late — timing is uncertain' : `expected up at ${hhmm(live.openAt)}`}</div>`;
  } else if (next) {
    const until = next.closeAt - now;
    el.className = `card status ${until < 120_000 ? 'soon' : 'open'}`;
    el.innerHTML = `<div class="state">OPEN</div>
      <div class="count">closes in ${human(until)}</div>
      <div class="sub">${hhmm(next.closeAt)} for ${human(next.openAt - next.closeAt, { about: true })}${next.uncertain ? ' · uncertain' : ''}</div>`;
  } else {
    el.className = 'card status open';
    el.innerHTML = `<div class="state">OPEN</div><div class="sub">no trains due in the next two hours</div>`;
  }
}

async function loadCrossing(id) {
  const res = await fetch(`/api/crossings/${encodeURIComponent(id)}`);
  const data = await res.json();
  if (!res.ok) {
    app.innerHTML = `<p class="err">${esc(data.error ?? 'error')}</p><p class="muted small">${esc(data.detail ?? '')}</p><p><a href="#/">All crossings</a></p>`;
    return;
  }
  setLive(data.live);
  state = data;
  skew = data.now - Date.now();
  const c = data.crossing;
  const mins = Math.round(data.closedSecNextHour / 60);
  app.innerHTML = `
    <p class="small"><a href="#/">‹ All crossings</a></p>
    <h1>${esc(c.name)}</h1>
    <div class="muted">${esc(c.road)} · ${esc(c.line)}${c.station ? ` · at ${esc(c.station.name)} station` : ''}</div>
    <div id="status" class="card status"></div>
    <p class="muted small">Barriers expected down for about ${mins} min of the next hour. Updated ${hhmm(data.now)}.</p>
    <h2>Coming up</h2>
    <div class="card">${data.upcoming.length ? data.upcoming.map(closureBlock).join('') : '<p class="muted">Nothing in the next two hours.</p>'}</div>
    ${data.recent.length ? `<h2>Recent</h2><div class="card">${data.recent.map(closureBlock).join('')}</div>` : ''}
    <p class="muted small">Directions: ${data.directions.map((d) => `${d.key === 'north' ? '↑' : d.key === 'south' ? '↓' : '·'} ${esc(d.label)} towards ${esc(d.towards)}`).join(' · ')}</p>`;
  drawStatus();
}

async function renderCrossing(id) {
  stopTimers();
  app.innerHTML = '<p class="muted">Loading…</p>';
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
  if (m) renderCrossing(m[1]).catch(showError);
  else renderList().catch(showError);
}
function showError(e) {
  app.innerHTML = `<p class="err">Something went wrong: ${esc(e.message ?? e)}</p>`;
}
window.addEventListener('hashchange', route);
route();
