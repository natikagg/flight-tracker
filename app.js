'use strict';

// ── CONFIG ────────────────────────────────────────────────
// Deployed on Render? Set this to your Render URL, e.g.:
// const RENDER_PROXY = 'https://flight-tracker-proxy.onrender.com';
const RENDER_PROXY   = 'https://flight-tracker-litb.onrender.com';

const ADSBDB         = 'https://api.adsbdb.com/v0';  // CORS: * ✓
const FETCH_INTERVAL = 10;   // seconds between refreshes
const EARTH_R        = 6371; // km
const LOC_KEY        = 'ft_loc';

// ── STATE ─────────────────────────────────────────────────
let map, markerGroup;
let userLat, userLon;
let radiusKm     = 50;
let aircraft     = [];
let countdown    = FETCH_INTERVAL;
let isFetching   = false;
let lastFetch    = null;

const routeCache  = new Map();  // callsign → route data
const detailCache = new Map();  // icao24  → aircraft data

// ── API URL ───────────────────────────────────────────────
function flightsUrl(lat, lon, km) {
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (isLocal) return `/api/flights?lat=${lat}&lon=${lon}&radius_km=${km}`;
  if (RENDER_PROXY) return `${RENDER_PROXY}/api/flights?lat=${lat}&lon=${lon}&radius_km=${km}`;
  // No proxy configured — show helpful message
  return null;
}

// ── INIT ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Instant load from cache
  const cached = readLocCache();
  if (cached) boot(cached.lat, cached.lon, 'cache');

  // Always try fresh GPS
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p => {
        writeLocCache(p.coords.latitude, p.coords.longitude);
        if (!userLat) boot(p.coords.latitude, p.coords.longitude, 'gps');
        else { userLat = p.coords.latitude; userLon = p.coords.longitude; }
      },
      () => { if (!userLat) ipFallback(); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
    );
  } else if (!cached) {
    ipFallback();
  }
});

// ── LOCATION CACHE ────────────────────────────────────────
function writeLocCache(lat, lon) {
  try { localStorage.setItem(LOC_KEY, JSON.stringify({ lat, lon, t: Date.now() })); } catch (_) {}
}
function readLocCache() {
  try {
    const d = JSON.parse(localStorage.getItem(LOC_KEY) || 'null');
    if (!d || Date.now() - d.t > 30 * 60000) return null;
    return d;
  } catch (_) { return null; }
}

function ipFallback() {
  setOverlay('Finding your location via IP…');
  fetch('https://ipapi.co/json/')
    .then(r => r.json())
    .then(d => { if (d.latitude) boot(d.latitude, d.longitude, 'ip'); else throw 0; })
    .catch(() =>
      fetch('https://ip-api.com/json/?fields=lat,lon,status')
        .then(r => r.json())
        .then(d => { if (d.status === 'success') boot(d.lat, d.lon, 'ip'); else throw 0; })
        .catch(() => setOverlay('Could not detect your location.\nPlease reload and allow location access.'))
    );
}

// ── BOOT ──────────────────────────────────────────────────
function boot(lat, lon, source) {
  userLat = lat; userLon = lon;
  if (!map) initMap();
  hideOverlay();
  if (source === 'ip')    showStatus('Using approximate IP-based location.', 'info');
  if (source === 'cache') showStatus('Using cached location — refreshing…', 'info');
  refresh();
  startCountdown();
}

// ── MAP ───────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [userLat, userLon],
    zoom: 10,
    minZoom: 5,
    maxZoom: 16,
    zoomControl: false,
  });

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 16,
  }).addTo(map);

  markerGroup = L.layerGroup().addTo(map);

  // User marker
  L.marker([userLat, userLon], {
    icon: L.divIcon({
      html: '<div class="user-dot"></div>',
      className: 'user-location-marker',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    }),
    zIndexOffset: 9999,
  }).addTo(map).bindPopup('<span style="font-size:13px;color:#f1f5f9;font-family:Inter,sans-serif">📍 Your location</span>');

  // Zoom → radius
  map.on('zoomend', () => {
    const z = Math.round(map.getZoom());
    const map2km = { 5:800, 6:500, 7:350, 8:200, 9:100, 10:50, 11:35, 12:20 };
    const r = map2km[Math.min(Math.max(z, 5), 12)] || 50;
    if (r !== radiusKm) {
      radiusKm = r;
      document.getElementById('radius-value').textContent = r;
      refresh();
    }
  });
}

// ── FETCH ─────────────────────────────────────────────────
function refresh() {
  if (isFetching) return;

  const url = flightsUrl(userLat.toFixed(6), userLon.toFixed(6), radiusKm);
  if (!url) {
    showStatus('No proxy configured. Set RENDER_PROXY in app.js to use on GitHub Pages.', 'error');
    return;
  }

  isFetching = true;
  fetch(url)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(data => {
      if (data.error) throw new Error(data.error);
      hideStatus();
      aircraft = parse(data.states || []);
      lastFetch = Date.now();
      renderMarkers();
      renderList();
      document.getElementById('count-number').textContent = aircraft.length;
    })
    .catch(err => {
      console.warn(err);
      showStatus(navigator.onLine ? 'Could not load flight data. Retrying…' : 'No internet connection.', 'error');
      if (!aircraft.length) setListEmpty('No data available', 'Check your connection');
    })
    .finally(() => { isFetching = false; });
}

// ── PARSE ─────────────────────────────────────────────────
// OpenSky states[] indices:
//  0=icao24 1=callsign 2=country 5=lon 6=lat
//  7=baro_alt(m) 8=on_ground 9=vel(m/s) 10=track(°) 11=vert_rate(m/s) 13=geo_alt(m)
function parse(states) {
  return states
    .map(s => ({
      icao24:    (s[0] || '').toUpperCase(),
      callsign:  (s[1] || '').trim() || (s[0] || '?').toUpperCase(),
      country:    s[2] || 'Unknown',
      lon:        s[5],
      lat:        s[6],
      altBaro:    s[7],
      onGround:   s[8],
      vel:        s[9],
      track:      s[10],
      vRate:      s[11],
      altGeo:     s[13],
    }))
    .filter(a => a.lat != null && a.lon != null)
    .map(a => ({ ...a, dist: haversine(userLat, userLon, a.lat, a.lon) }))
    .filter(a => a.dist <= radiusKm)
    .sort((a, b) => a.dist - b.dist);
}

// ── EXTRAPOLATE POSITION ──────────────────────────────────
function extrapolate(ac, secElapsed) {
  if (!ac.vel || !ac.track || ac.onGround || secElapsed <= 0) return { lat: ac.lat, lon: ac.lon };
  const d    = (ac.vel * secElapsed / 1000) / EARTH_R;
  const lat1 = rad(ac.lat), lon1 = rad(ac.lon), brng = rad(ac.track);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lon: ((deg(lon2) + 540) % 360) - 180 };
}

// ── MARKERS ───────────────────────────────────────────────
function renderMarkers() {
  markerGroup.clearLayers();
  const sec = lastFetch ? (Date.now() - lastFetch) / 1000 : 0;

  aircraft.forEach(ac => {
    const pos = extrapolate(ac, sec);
    const rot = ((ac.track || 0) - 90 + 360) % 360;

    const marker = L.marker([pos.lat, pos.lon], {
      icon: L.divIcon({
        html: `<div class="ac-marker-wrap"><span class="ac-icon${ac.onGround ? ' grounded' : ''}" style="transform:rotate(${rot}deg)">✈</span></div>`,
        className: '',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        popupAnchor: [0, -14],
      }),
      title: ac.callsign,
    });

    marker.bindPopup(() => {
      const el = document.createElement('div');
      el.innerHTML = buildPopup(ac);
      loadPopupDetails(ac, el);
      return el;
    }, { maxWidth: 300, className: 'ft-popup' });

    markerGroup.addLayer(marker);
    ac._marker = marker;
  });

  // Smooth position updates every 2s
  clearInterval(window._moveTimer);
  window._moveTimer = setInterval(() => {
    if (!lastFetch) return;
    const s = (Date.now() - lastFetch) / 1000;
    aircraft.forEach(ac => ac._marker?.setLatLng(extrapolate(ac, s)));
  }, 2000);
}

function buildPopup(ac) {
  const alt  = ac.altBaro ?? ac.altGeo;
  const altM = alt != null ? Math.round(alt).toLocaleString() : '—';
  const altFt = alt != null ? Math.round(alt * 3.28084).toLocaleString() : '—';
  const spd  = ac.vel != null ? Math.round(ac.vel * 1.94384) : '—';
  const spdMs = ac.vel != null ? ac.vel.toFixed(0) : '—';
  const hdg  = ac.track != null ? Math.round(ac.track) : '—';
  const vr   = ac.vRate != null
    ? (ac.vRate > 0.3 ? '↑' : ac.vRate < -0.3 ? '↓' : '→') + ' ' + Math.abs(Math.round(ac.vRate * 196.85)) + ' fpm'
    : '—';
  const gnd  = ac.onGround ? ' <span style="color:#f59e0b;font-size:11px">ON GROUND</span>' : '';

  return `<div class="popup-wrap">
    <div class="popup-top">
      <div class="popup-callsign"><span class="icon">✈</span>${esc(ac.callsign)}${gnd}</div>
      <div class="popup-route-line" id="pr-${esc(ac.icao24)}">
        <span style="color:var(--text-3);font-size:11px">Loading route…</span>
      </div>
    </div>
    <div id="pp-${esc(ac.icao24)}"></div>
    <div class="popup-body">
      <div class="popup-grid">
        <div class="popup-field">
          <div class="popup-label">Altitude</div>
          <div class="popup-value">${altM} m</div>
          <div class="popup-sub">${altFt} ft</div>
        </div>
        <div class="popup-field">
          <div class="popup-label">Speed</div>
          <div class="popup-value">${spd} kt</div>
          <div class="popup-sub">${spdMs} m/s</div>
        </div>
        <div class="popup-field">
          <div class="popup-label">Heading</div>
          <div class="popup-value">${hdg}°</div>
          <div class="popup-sub">${compassDir(ac.track)}</div>
        </div>
        <div class="popup-field">
          <div class="popup-label">Vert Rate</div>
          <div class="popup-value">${vr}</div>
        </div>
        <div class="popup-field">
          <div class="popup-label">Distance</div>
          <div class="popup-value">${ac.dist.toFixed(1)} km</div>
        </div>
        <div class="popup-field">
          <div class="popup-label">Country</div>
          <div class="popup-value" style="font-size:11px;font-family:Inter,sans-serif">${esc(ac.country)}</div>
        </div>
      </div>
    </div>
    <div class="popup-footer">ICAO24 · ${esc(ac.icao24)}</div>
  </div>`;
}

async function loadPopupDetails(ac, container) {
  const [route, detail] = await Promise.all([fetchRoute(ac.callsign), fetchDetail(ac.icao24)]);

  const routeEl = container.querySelector(`#pr-${ac.icao24}`);
  if (routeEl) {
    if (route?.origin && route?.destination) {
      const airline = route.airline?.name ? `<span class="airline">${esc(route.airline.name)}</span>` : '';
      routeEl.innerHTML = `
        <span class="orig">${esc(route.origin.iata_code || route.origin.icao_code)}</span>
        <span class="arrow"> → </span>
        <span class="dest">${esc(route.destination.iata_code || route.destination.icao_code)}</span>
        ${airline}
        <span class="arrow"> · ${esc(route.origin.municipality || '')} → ${esc(route.destination.municipality || '')}</span>`;
    } else {
      routeEl.innerHTML = '';
    }
  }

  const photoEl = container.querySelector(`#pp-${ac.icao24}`);
  if (photoEl && detail?.url_photo_thumbnail) {
    photoEl.innerHTML = `<img class="popup-photo" src="${esc(detail.url_photo_thumbnail)}"
      alt="${esc(detail.registration || '')}"
      onerror="this.closest('#pp-${ac.icao24}').remove()">`;
  }
}

// ── ADSBDB ───────────────────────────────────────────────
async function fetchRoute(callsign) {
  if (routeCache.has(callsign)) return routeCache.get(callsign);
  routeCache.set(callsign, null);
  try {
    const r = await fetch(`${ADSBDB}/callsign/${encodeURIComponent(callsign)}`);
    if (!r.ok) return null;
    const d = (await r.json())?.response?.flightroute || null;
    routeCache.set(callsign, d);
    return d;
  } catch { return null; }
}

async function fetchDetail(icao24) {
  if (detailCache.has(icao24)) return detailCache.get(icao24);
  detailCache.set(icao24, null);
  try {
    const r = await fetch(`${ADSBDB}/aircraft/${encodeURIComponent(icao24.toLowerCase())}`);
    if (!r.ok) return null;
    const d = (await r.json())?.response?.aircraft || null;
    detailCache.set(icao24, d);
    return d;
  } catch { return null; }
}

// ── SIDEBAR LIST ──────────────────────────────────────────
function renderList() {
  const el = document.getElementById('aircraft-list');
  if (!aircraft.length) { setListEmpty('No aircraft in range', `Try zooming out — current radius: ${radiusKm} km`); return; }

  el.innerHTML = aircraft.map((ac, i) => {
    const alt    = ac.altBaro ?? ac.altGeo;
    const altStr = alt != null ? Math.round(alt).toLocaleString() + ' m' : '—';
    const spdStr = ac.vel != null ? Math.round(ac.vel * 1.94384) + ' kt' : '—';
    const route  = routeCache.get(ac.callsign);
    const routeTxt = route?.origin && route?.destination
      ? `${route.origin.iata_code} → ${route.destination.iata_code}`
      : null;

    return `<div class="ac-card${ac.onGround ? ' grounded' : ''}" data-i="${i}" role="button" tabindex="0">
      <div class="card-row-1">
        <span class="card-callsign">${esc(ac.callsign)}</span>
        <span class="card-dist">${ac.dist.toFixed(1)} km</span>
      </div>
      <div class="card-route ${routeTxt ? '' : 'no-route'}">${esc(routeTxt || ac.country)}</div>
      <div class="card-row-2">
        <span class="card-chip">${altStr}</span>
        <span class="card-chip">${spdStr}</span>
        ${ac.onGround ? '<span class="card-chip amber">GND</span>' : `<span class="card-chip">${Math.round(ac.track || 0)}°</span>`}
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.ac-card').forEach(card => {
    const go = () => {
      const ac = aircraft[+card.dataset.i];
      if (!ac) return;
      map.setView([ac.lat, ac.lon], Math.max(map.getZoom(), 11), { animate: true });
      ac._marker?.openPopup();
    };
    card.addEventListener('click', go);
    card.addEventListener('keydown', e => (e.key === 'Enter' || e.key === ' ') && go());
  });

  // Background-prefetch routes for visible cards
  aircraft.slice(0, 20).forEach(ac => {
    if (!routeCache.has(ac.callsign)) fetchRoute(ac.callsign).then(() => {});
    if (!detailCache.has(ac.icao24))  fetchDetail(ac.icao24).then(() => {});
  });
}

function setListEmpty(title, sub) {
  document.getElementById('aircraft-list').innerHTML =
    `<div class="empty-state"><div class="empty-icon">🛸</div><div class="empty-title">${esc(title)}</div><div class="empty-sub">${esc(sub)}</div></div>`;
}

// ── COUNTDOWN ─────────────────────────────────────────────
function startCountdown() {
  countdown = FETCH_INTERVAL;
  tick();
  setInterval(tick, 1000);
}

function tick() {
  countdown = Math.max(0, countdown - 1);
  document.getElementById('refresh-fill').style.width = (countdown / FETCH_INTERVAL * 100) + '%';
  document.getElementById('refresh-label').textContent = countdown > 0 ? `${countdown}s` : 'now';
  if (countdown === 0) { countdown = FETCH_INTERVAL; refresh(); }
}

// ── STATUS ────────────────────────────────────────────────
function showStatus(msg, type = 'error') {
  const b = document.getElementById('status-banner');
  b.className = type;
  document.getElementById('status-message').textContent = msg;
  b.classList.remove('hidden');
  if (type === 'info') setTimeout(() => b.classList.add('hidden'), 5000);
}

function hideStatus() { document.getElementById('status-banner').classList.add('hidden'); }
function setOverlay(msg) { document.getElementById('overlay-message').textContent = msg; }
function hideOverlay()   { document.getElementById('map-overlay').classList.add('hidden'); }

// ── MATH ──────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = EARTH_R, dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function compassDir(track) {
  if (track == null) return '';
  return ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(((track%360)+360)%360/22.5)%16];
}

function rad(d) { return d * Math.PI / 180; }
function deg(r) { return r * 180 / Math.PI; }
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
