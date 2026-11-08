/* TMedia — logica aplicației (player, liste, navigare TV, sincronizare) */
// ============= SERVICE WORKER (PWA offline) =============
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW register:', e));
  });
}

// ============= STATE =============
const TV_COUNTRIES = [
  {code:'ro',name:'🇷🇴 Romania'}, {code:'md',name:'🇲🇩 Moldova'},
  {code:'us',name:'🇺🇸 USA'}, {code:'gb',name:'🇬🇧 UK'},
  {code:'de',name:'🇩🇪 Germany'}, {code:'fr',name:'🇫🇷 France'},
  {code:'it',name:'🇮🇹 Italy'}, {code:'es',name:'🇪🇸 Spain'},
  {code:'tr',name:'🇹🇷 Turkey'}, {code:'nl',name:'🇳🇱 Netherlands'},
  {code:'hu',name:'🇭🇺 Hungary'}, {code:'bg',name:'🇧🇬 Bulgaria'},
  {code:'rs',name:'🇷🇸 Serbia'}, {code:'pl',name:'🇵🇱 Poland'},
  {code:'in',name:'🇮🇳 India'}, {code:'br',name:'🇧🇷 Brazil'},
  {code:'ar',name:'🇦🇷 Argentina'}, {code:'mx',name:'🇲🇽 Mexico'},
  {code:'jp',name:'🇯🇵 Japan'}, {code:'kr',name:'🇰🇷 Korea'},
];

// Helper mic pentru citirea sigură din localStorage
function _lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
  catch (_) { return fallback; }
}

// JSON din localStorage fără să blocheze aplicația dacă datele sunt corupte
function _lsJson(key, fallback) {
  try {
    const v = JSON.parse(_lsGet(key, 'null'));
    return (v && typeof v === 'object') ? v : fallback;
  } catch (_) { return fallback; }
}

function _lsSet(key, value) {
  try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (_) {}
}

// Copie minimă a unui canal, suficientă pentru redare fără lista țării încărcată
function _snapshot(item, type) {
  return {
    id: item.id, name: item.name, url: item.url,
    logo: item.logo || '', country: item.country || '',
    tags: item.tags || '', bitrate: item.bitrate || 0, _type: type
  };
}

const _favIds = _lsJson('broadcast-favs', {});

const state = {
  mode: 'tv',           // 'tv' | 'radio' | 'playlist' | 'fav'
  tvList: [],
  tvCache: {},
  currentTvCountry: _lsGet('tr-tv-country', 'ro'),
  tvHealth: {},         // url -> 'ok' | 'dead' pentru țara curentă
  tvOnlyWorking: _lsGet('tr-only-working', '1') === '1', // ascunde canale moarte
  radioList: [],
  radioCache: {},
  currentRadioCountry: _lsGet('tr-radio-country', 'RO'),
  radioGenre: '',       // filtru gen radio (tag), '' = toate
  playlistList: [],
  playlistName: 'Playlist',
  filtered: [],
  currentIndex: -1,
  current: null,
  favorites: {
    tv: Array.isArray(_favIds.tv) ? _favIds.tv : [],
    radio: Array.isArray(_favIds.radio) ? _favIds.radio : [],
  },
  // Datele complete ale favoritelor (id -> canal), ca să apară indiferent de țara încărcată
  favItems: Object.assign({ tv: {}, radio: {} }, _lsJson('broadcast-fav-items', {})),
  recent: (() => { const r = _lsJson('broadcast-recent', []); return Array.isArray(r) ? r : []; })(),
  muted: _lsGet('tr-muted', '0') === '1',  // preferință mute persistată
  hls: null,
  sleepTimer: null,    // ID setTimeout pentru oprirea redării
  sleepTick: null,     // ID setInterval pentru indicator
  sleepEndsAt: 0,      // timestamp ms
};

const MAX_RECENT = 30;

// Reține ultimul canal redat, pentru resume la deschidere
function saveLastPlayed(item, type) {
  _lsSet('tr-last', _snapshot(item, type));
}

function pushRecent(item, type) {
  const entry = { ..._snapshot(item, type), at: Date.now() };
  // Dedup după id
  state.recent = [entry, ...state.recent.filter(r => r.id !== entry.id)].slice(0, MAX_RECENT);
  _lsSet('broadcast-recent', state.recent);
}

function toggleFavorite(item, type) {
  const arr = state.favorites[type] = state.favorites[type] || [];
  const map = state.favItems[type] = state.favItems[type] || {};
  const pos = arr.indexOf(item.id);
  if (pos >= 0) { arr.splice(pos, 1); delete map[item.id]; }
  else { arr.push(item.id); map[item.id] = _snapshot(item, type); }
  _lsSet('broadcast-favs', state.favorites);
  _lsSet('broadcast-fav-items', state.favItems);
  return pos < 0;
}

// Lista favoritelor: din datele salvate, cu fallback la listele încărcate
// (favoritele vechi, salvate doar ca id, sunt completate când țara e încărcată).
function getFavoriteList() {
  const out = [];
  for (const type of ['tv', 'radio']) {
    const pools = type === 'tv'
      ? [state.tvList, ...Object.values(state.tvCache)]
      : [state.radioList, ...Object.values(state.radioCache)];
    for (const id of state.favorites[type] || []) {
      let it = state.favItems[type]?.[id];
      if (!it) {
        for (const pool of pools) { const f = pool.find(c => c.id === id); if (f) { it = _snapshot(f, type); break; } }
        if (!it) it = state.recent.find(r => r.id === id && r._type === type);
        if (it) { state.favItems[type][id] = it; _lsSet('broadcast-fav-items', state.favItems); }
      }
      if (it) out.push({ ...it, _type: type });
    }
  }
  return out;
}

const $ = id => document.getElementById(id);
const video = $('video-player');
const audio = $('audio-player');

// playsinline needed for iOS Safari — set via JS to avoid linter warnings
video.setAttribute('playsinline', '');
video.style.display = 'none'; // apare doar când rulează un canal TV în pagină

// ============= AUDIO VISUALIZER (Web Audio API) =============
const Viz = (() => {
  const canvas = $('viz-canvas');
  const ctx = canvas.getContext('2d');
  let audioCtx = null;
  let analyser = null;
  let source = null;
  let rafId = null;
  let fakePhase = 0;
  let mode = 'fake'; // 'real' | 'fake'

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 640;
    const h = canvas.clientHeight || 120;
    canvas.width  = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);

  function attach(mediaEl) {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { mode = 'fake'; return; }
        audioCtx = new AC();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();

      // O singură MediaElementSource per element — refolosim
      if (!mediaEl._vizSource) {
        try {
          mediaEl._vizSource = audioCtx.createMediaElementSource(mediaEl);
        } catch (e) {
          // CORS sau alt blocaj — fallback la fake bars
          mode = 'fake';
          return;
        }
      }
      if (source && source !== mediaEl._vizSource) {
        try { source.disconnect(); } catch (_) {}
      }
      source = mediaEl._vizSource;

      if (!analyser) {
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.78;
      }
      source.disconnect();
      source.connect(analyser);
      source.connect(audioCtx.destination);
      mode = 'real';
    } catch (_) {
      mode = 'fake';
    }
  }

  function drawBars(values, paused) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const n = values.length;
    const gap = 3;
    const barW = (w - (n - 1) * gap) / n;
    for (let i = 0; i < n; i++) {
      const v = paused ? 0.04 : values[i];
      const barH = Math.max(2, v * h);
      const x = i * (barW + gap);
      const y = h - barH;
      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, '#ff2e88');
      grad.addColorStop(0.5, '#b14eff');
      grad.addColorStop(1, '#00f0ff');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barW, barH);
      // Vârf strălucitor
      ctx.fillStyle = '#ffb627';
      ctx.fillRect(x, y, barW, Math.max(1, barH * 0.04));
    }
  }

  function loop() {
    const paused = $('visualizer').classList.contains('paused');
    let values;
    if (mode === 'real' && analyser) {
      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(buf);
      // Reducem la 32 bare
      const target = 32;
      values = new Array(target);
      const step = Math.floor(buf.length / target);
      for (let i = 0; i < target; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += buf[i * step + j];
        values[i] = (sum / step) / 255;
      }
    } else {
      // Fallback: animație sinus dacă CORS blochează capturarea
      fakePhase += 0.08;
      values = new Array(32);
      for (let i = 0; i < 32; i++) {
        const base = paused ? 0.05 : 0.4;
        const amp  = paused ? 0   : 0.5;
        values[i] = base + amp * Math.abs(Math.sin(fakePhase + i * 0.35));
      }
    }
    drawBars(values, paused);
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    resize();
    if (rafId == null) loop();
  }

  function stop() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return { attach, start, stop, resize };
})();

// ============= ANDROID BRIDGE =============
const Bridge = {
  notifyPlaying(item, isTv) {
    try {
      const subtitle = (item.country || '') + (item.bitrate ? ` · ${item.bitrate}kbps` : '');
      window.AndroidBridge?.notifyPlaying(item.name || '', subtitle, !!isTv);
    } catch (_) {}
    MediaSess.set(item, isTv);
    MediaSess.state('playing');
  },
  notifyPaused() {
    try { window.AndroidBridge?.notifyPaused(); } catch (_) {}
    MediaSess.state('paused');
  },
  notifyStopped() {
    try { window.AndroidBridge?.notifyStopped(); } catch (_) {}
    MediaSess.state('none');
  }
};

// ============= MEDIA SESSION (lockscreen / notificare browser) =============
// Afișează titlu + logo pe ecranul de blocare și rutează butoanele hardware/OS.
const MediaSess = (() => {
  const supported = 'mediaSession' in navigator;
  let wired = false;

  function wire() {
    if (!supported || wired) return;
    wired = true;
    const ms = navigator.mediaSession;
    const safe = (fn) => { try { fn(); } catch (_) {} };
    safe(() => ms.setActionHandler('play',  () => $('play-btn').click()));
    safe(() => ms.setActionHandler('pause', () => $('play-btn').click()));
    safe(() => ms.setActionHandler('previoustrack', () => window.__broadcastPrev?.()));
    safe(() => ms.setActionHandler('nexttrack',     () => window.__broadcastNext?.()));
    safe(() => ms.setActionHandler('stop', () => window.__broadcastStop?.()));
  }

  function set(item, isTv) {
    if (!supported) return;
    wire();
    const art = [];
    if (item.logo && item.logo !== 'null' && item.logo !== 'N/A') {
      art.push({ src: item.logo, sizes: '512x512' }); // tipul real variază (png/jpg/svg)
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.name || 'TMedia',
        artist: (item.country || '') + (item.bitrate ? ` · ${item.bitrate}kbps` : (isTv ? ' · TV' : ' · Radio')),
        album: 'TMedia',
        artwork: art,
      });
    } catch (_) {}
  }

  function state(s) {
    if (!supported) return;
    try { navigator.mediaSession.playbackState = s; } catch (_) {}
  }

  return { set, state };
})();

// ============= TOAST =============
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ============= DATA LOADING =============
function parseM3U(text) {
  const lines = text.split('\n');
  const list = [];
  let meta = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      meta = line;
    } else if (meta && line && !line.startsWith('#')) {
      // Eliminăm atributele key="val" înainte de a căuta virgula numelui —
      // altfel group-title="News,Sports" taie numele greșit.
      const name  = (meta.replace(/[\w-]+="[^"]*"/g, '').match(/,(.+)$/) || [])[1]?.trim() || 'Unknown';
      const logoRaw = (meta.match(/tvg-logo="([^"]*)"/) || [])[1] || '';
      const logo  = (logoRaw === 'null' || logoRaw === 'N/A') ? '' : logoRaw;
      const ctry  = (meta.match(/tvg-country="([^"]*)"/) || [])[1] || state.currentTvCountry.toUpperCase();
      const id    = (meta.match(/tvg-id="([^"]*)"/)   || [])[1] || (name + '_' + list.length);
      const group = (meta.match(/group-title="([^"]*)"/) || [])[1] || '';
      list.push({ id, name, url: line, logo, country: ctry, categories: group ? [group] : [] });
      meta = null;
    }
  }
  return list;
}

async function loadTV(country) {
  country = country || state.currentTvCountry;
  if (state.tvCache[country]) {
    state.tvList = state.tvCache[country];
    return state.tvList;
  }
  try {
    const res = await fetch(`https://iptv-org.github.io/iptv/countries/${country}.m3u`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = parseM3U(await res.text());
    state.tvCache[country] = list;
    state.tvList = list;
    return list;
  } catch (e) {
    console.error(e);
    toast(`Eroare la încărcarea TV pentru ${country.toUpperCase()}`);
    return [];
  }
}

// ============= VERIFICARE FUNCȚIONALITATE CANALE TV =============
// Testăm dacă stream-ul răspunde (manifest HLS accesibil). Rezultatele sunt
// cache-uite 12h în localStorage per țară, ca verificarea să fie instant apoi.
const HEALTH_TTL = 12 * 3600 * 1000;
const HEALTH_TIMEOUT = 7000;
const HEALTH_CONCURRENCY = 6;
let _healthRun = 0;           // token pentru anularea rulărilor vechi
let _healthOkCount = 0;       // câte canale confirmate ok în rularea curentă
const _tvRows = new Map();    // url -> { row, dot } pentru update in-place

function _healthKey(country) { return `tr-tvhealth-${(country || '').toLowerCase()}`; }

function loadHealthCache(country) {
  try {
    const raw = localStorage.getItem(_healthKey(country));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.map) return null;
    return obj;
  } catch (_) { return null; }
}

function saveHealthCache(country) {
  try {
    localStorage.setItem(_healthKey(country), JSON.stringify({ ts: Date.now(), map: state.tvHealth }));
  } catch (_) {}
}

// Fetch cu timeout via AbortController
function _fetchTimeout(url, ms, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...(opts || {}), signal: ac.signal }).finally(() => clearTimeout(t));
}

// Testează un singur stream. true = pare funcțional.
async function probeStream(url) {
  if (!/^https?:\/\//i.test(url)) return false; // rtmp:// etc. — browserul nu le poate reda
  const isHls = url.includes('.m3u8');
  // Testăm exact cum va reda browserul: direct, pe https, cu CORS. Fără proxy-uri publice —
  // un stream accesibil doar prin proxy oricum nu poate fi redat de hls.js în pagină.
  try {
    const res = await _fetchTimeout(upgradeUrl(url), HEALTH_TIMEOUT);
    if (!res.ok) return false;
    if (isHls) { const t = await res.text(); return /#EXTM3U/i.test(t); }
    return true;
  } catch (_) {
    // Eroare CORS/rețea. Excepție: browsere fără hls.js dar cu HLS nativ (iOS vechi)
    // nu au nevoie de CORS → nu putem ști, nu ascundem canalul.
    if (isHls && !hlsAvailable() && video.canPlayType('application/vnd.apple.mpegurl')) return true;
    return false;
  }
}

// Pool de concurență simplu
async function _pool(items, worker, concurrency) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function _setDot(url, status) {
  const entry = _tvRows.get(url);
  if (!entry) return;
  if (entry.dot) entry.dot.className = 'ch-dot ' + status;
  // Ascundem live doar dacă avem deja măcar un canal ok (proxy funcțional)
  if (state.tvOnlyWorking && status === 'dead' && entry.row && _healthOkCount > 0) {
    entry.row.style.display = 'none';
  }
}

function updateHealthProgress(done, total, phase) {
  const el = $('tv-health-progress');
  if (!el) return;
  if (phase === 'done' || (total > 0 && done >= total)) {
    const dead = Object.values(state.tvHealth).filter(v => v === 'dead').length;
    el.textContent = `✓ verificat · ${dead} indisponibile ascunse`;
    el.classList.add('tv-health-done');
    setTimeout(() => { el.textContent = ''; el.classList.remove('tv-health-done'); }, 4000);
  } else {
    el.classList.remove('tv-health-done');
    el.textContent = `⧗ verific canale... ${done}/${total}`;
  }
}

// Rulează verificarea pentru țara curentă (folosește cache dacă e proaspăt).
async function runTvHealthCheck(country, force) {
  country = country || state.currentTvCountry;
  const list = state.tvCache[country] || state.tvList;
  if (!list || !list.length) return;

  const cache = loadHealthCache(country);
  state.tvHealth = (cache && cache.map) ? { ...cache.map } : {};
  const fresh = cache && (Date.now() - cache.ts < HEALTH_TTL);

  // Aplicăm imediat rezultatele din cache (ascunde morții știuți)
  if (state.mode === 'tv') applyFilter();
  if (fresh && !force) { updateHealthProgress(1, 1, 'done'); return; }

  const runId = ++_healthRun;
  _healthOkCount = Object.values(state.tvHealth).filter(v => v === 'ok').length;
  const toCheck = list.filter(c => force || !state.tvHealth[c.url]);
  if (!toCheck.length) { updateHealthProgress(1, 1, 'done'); return; }

  let done = 0;
  updateHealthProgress(0, toCheck.length);
  await _pool(toCheck, async (c) => {
    if (runId !== _healthRun) return; // rulare anulată de una nouă (schimbare țară/mod)
    const ok = await probeStream(c.url);
    if (runId !== _healthRun) return;
    state.tvHealth[c.url] = ok ? 'ok' : 'dead';
    if (ok) _healthOkCount++;
    if (state.mode === 'tv') _setDot(c.url, ok ? 'ok' : 'dead');
    done++;
    if (done % 6 === 0) { saveHealthCache(country); updateHealthProgress(done, toCheck.length); }
  }, HEALTH_CONCURRENCY);

  if (runId !== _healthRun) return;
  saveHealthCache(country);
  updateHealthProgress(toCheck.length, toCheck.length, 'done');
  if (state.mode === 'tv') applyFilter();
}

// Pornește verificarea dacă suntem pe TV și filtrul e activ
function kickTvHealthCheck(force) {
  if (state.mode !== 'tv') return;
  if (NativePlayer.available()) return; // APK: ExoPlayer nu are limite CORS → verificarea nu ajută
  runTvHealthCheck(state.currentTvCountry, force);
}

// Mapare cod ISO 2-litere → nume complet țară pentru endpoint-ul bycountry (fallback)
const COUNTRY_FULL = {
  RO: 'Romania', MD: 'Moldova', US: 'United States of America', GB: 'United Kingdom',
  DE: 'Germany', FR: 'France', IT: 'Italy', ES: 'Spain', TR: 'Turkey',
  NL: 'The Netherlands', HU: 'Hungary', BG: 'Bulgaria', RS: 'Serbia', PL: 'Poland',
  IN: 'India', BR: 'Brazil', AR: 'Argentina', MX: 'Mexico', JP: 'Japan', KR: 'South Korea',
};

function mapStations(data, country) {
  return data
    .filter(s => s.url_resolved && s.name)
    .map(s => ({
      id: s.stationuuid,
      name: s.name.trim(),
      url: s.url_resolved,
      country: s.countrycode || country,
      logo: (s.favicon && s.favicon !== 'null') ? s.favicon : '',
      tags: s.tags,
      bitrate: s.bitrate || 0,
      clickcount: s.clickcount || 0,
    }));
}

// Normalizează numele pentru dedup: elimină markeri de calitate/format
function _normName(name) {
  return name
    .toLowerCase()
    .replace(/\s*[\(\[]\s*(hd|sd|fhd|4k|\d+\s*k?bps?|backup|live\s*\d*|stream\s*\d*|mirror|copy|online|v\d+)\s*[\)\]]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupStations(list) {
  // Pasul 1: dedup după URL exact (prinde aceeași stație din cele 2 query-uri API)
  // Păstrăm intrarea cu cele mai multe ascultări (ex. „ProB Radio” vs dublura „Radio Pro-B”),
  // nu prima întâlnită — API-ul le dă în ordine crescătoare de popularitate.
  const urlMap = new Map();
  for (const s of list) {
    const k = s.url.toLowerCase();
    const ex = urlMap.get(k);
    if (!ex || s.clickcount > ex.clickcount) urlMap.set(k, s);
  }
  const byUrl = [...urlMap.values()];

  // Pasul 2: dedup după nume normalizat — păstrăm stream-ul cu cele mai multe clickuri
  // (ex: "Pro FM (128kbps)" și "Pro FM (320kbps)" → păstrăm pe cel mai popular)
  const byName = new Map();
  for (const s of byUrl) {
    const key = _normName(s.name);
    if (!key) continue;
    const ex = byName.get(key);
    if (!ex || s.clickcount > ex.clickcount || (s.clickcount === ex.clickcount && s.bitrate > ex.bitrate)) {
      byName.set(key, s);
    }
  }

  return [...byName.values()];
}

async function loadRadio(country) {
  country = (country || state.currentRadioCountry).toUpperCase();
  const cacheKey = country;
  if (state.radioCache[cacheKey]) {
    state.radioList = state.radioCache[cacheKey];
    return state.radioList;
  }
  const servers = [
    'all.api.radio-browser.info',
    'de1.api.radio-browser.info',
    'fi1.api.radio-browser.info',
    'nl1.api.radio-browser.info',
    'at1.api.radio-browser.info',
  ];
  const fullName = COUNTRY_FULL[country] || country;
  // Două query-uri în paralel: by code exact + by country name complet.
  // hidebroken=false ca să nu pierdem stații marcate fals-pozitiv ca broken.
  // Nu mai filtrăm după clickcount (pierde stații mai mici, dar valide).
  for (const server of servers) {
    try {
      const base = `https://${server}/json/stations`;
      const params = `limit=2000&hidebroken=false&order=clickcount`;
      // 3 query-uri paralele:
      // r1 = după country code exact (RO)
      // r2 = după country name complet (Romania)
      // r3 = după limbă (română) — prinde stații fără country code setat corect
      const langCode = country === 'RO' ? 'ro' : country.toLowerCase();
      const [r1, r2, r3] = await Promise.all([
        fetch(`${base}/bycountrycodeexact/${country}?${params}`).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${base}/bycountry/${encodeURIComponent(fullName)}?${params}`).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${base}/bylanguage/${encodeURIComponent(langCode)}?${params}`).then(r => r.ok ? r.json() : []).catch(() => [])
      ]);
      // Căutarea după limbă aduce și posturi din alte țări (ex. Maroc „MA”) → le scoatem;
      // păstrăm stațiile fără țară setată (pot fi locale).
      const combined = [...r1, ...r2, ...r3]
        .filter(st => !st.countrycode || st.countrycode.toUpperCase() === country);
      if (!combined.length) continue;
      const list = dedupStations(mapStations(combined, country));
      // Sortare: întâi după popularitate (clickcount desc), la egalitate alfabetic
      list.sort((a, b) =>
        b.clickcount !== a.clickcount
          ? b.clickcount - a.clickcount
          : a.name.localeCompare(b.name, 'ro', { sensitivity: 'base' })
      );
      state.radioCache[cacheKey] = list;
      state.radioList = list;
      return list;
    } catch (_) { continue; }
  }
  toast(`Eroare la încărcarea radio pentru ${country}`);
  return [];
}

// ============= GHID TV (EPG) =============
// epg/ro.json e generat la fiecare 6 ore de GitHub Actions (scripts/build_epg.py).
// Format: { channels: { "<tvg-id>": [[start, stop, "titlu"], ...] } }, timpi în secunde UTC.
const EPG = { data: null, loading: null };
function loadEpg() {
  if (EPG.data || EPG.loading) return EPG.loading;
  EPG.loading = fetch('/epg/ro.json', { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null)
    .then(j => { EPG.data = (j && j.channels) || {}; if (state.mode === 'tv' || state.mode === 'fav' || state.mode === 'recent') renderList(); updateNpEpg(); })
    .catch(() => { EPG.data = {}; });
  return EPG.loading;
}
function epgNowNext(id) {
  const list = EPG.data && id && EPG.data[id];
  if (!list) return null;
  const now = Date.now() / 1000;
  const i = list.findIndex(p => p[0] <= now && now < p[1]);
  if (i < 0) return null;
  return { now: list[i], next: list[i + 1] || null };
}
const _hm = (t) => new Date(t * 1000).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
function updateNpEpg() {
  const c = state.current;
  if (!c || (c._type || state.mode) !== 'tv') return;
  const e = epgNowNext(c.id);
  if (!e) return;
  $('np-subtitle').textContent = `▶ ${e.now[2]}` + (e.next ? ` · ${_hm(e.next[0])} ${e.next[2]}` : '');
}
// Reîmprospătăm „acum rulează" la fiecare minut
setInterval(() => { if (EPG.data) updateNpEpg(); }, 60000);

// ============= RENDER =============
function getCurrentSource() {
  if (state.mode === 'tv') return state.tvList;
  if (state.mode === 'radio') return state.radioList;
  if (state.mode === 'playlist') return state.playlistList;
  if (state.mode === 'fav') return getFavoriteList();
  if (state.mode === 'recent') return state.recent;
  return [];
}

// Populează dropdown-ul de gen din tag-urile stațiilor radio încărcate.
// Sortăm genurile după frecvență și păstrăm cele mai comune ~28.
function populateGenreOptions() {
  const sel = $('genre-select');
  if (!sel) return;
  const counts = new Map();
  for (const s of state.radioList) {
    if (!s.tags) continue;
    for (let tag of String(s.tags).split(',')) {
      tag = tag.trim().toLowerCase();
      if (tag.length < 2 || tag.length > 24) continue;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 28)
    .map(([tag]) => tag)
    .sort();
  sel.innerHTML = '<option value="">// toate genurile</option>' +
    top.map(g => `<option value="${escapeHtml(g)}"${g === state.radioGenre ? ' selected' : ''}>${escapeHtml(g)}</option>`).join('');
}

// Normalizare pentru căutare: litere mici, fără diacritice, fără spații/semne
function _fold(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}
const RENDER_STEP = 250;
let _lastFilterKey = '';
state.renderLimit = RENDER_STEP;

function applyFilter() {
  const search = $('search-input').value.toLowerCase().trim();
  let list = getCurrentSource();
  // TV and radio load per-country; playlist filters by group; fav filters by country
  const dropVal = $('filter-select').value;
  if (state.mode === 'playlist' && dropVal) {
    list = list.filter(c => c.categories.includes(dropVal));
  } else if (state.mode === 'fav' && dropVal) {
    list = list.filter(c => c.country === dropVal);
  } else if (state.mode === 'recent' && dropVal) {
    list = list.filter(c => c._type === dropVal);
  }
  // Filtru gen — doar în modul radio
  if (state.mode === 'radio' && state.radioGenre) {
    const g = state.radioGenre;
    list = list.filter(c => (c.tags || '').toLowerCase().includes(g));
  }
  // Doar canale funcționale — ascunde stream-urile confirmate moarte (TV).
  // Siguranță: dacă filtrul ar goli complet lista (verificare eșuată/proxy picat),
  // afișăm totuși tot, ca să nu rămână ecranul gol.
  if (state.mode === 'tv' && state.tvOnlyWorking && !NativePlayer.available()) {
    const alive = list.filter(c => state.tvHealth[c.url] !== 'dead');
    if (alive.length) list = alive;
  }
  if (search) {
    const q = _fold(search);
    list = list.filter(c => q ? _fold(c.name).includes(q) : c.name.toLowerCase().includes(search));
  }
  // Lista nouă (alt mod / altă căutare / alt filtru) → afișăm din nou doar primele rânduri
  const key = [state.mode, search, dropVal, state.radioGenre].join('|');
  if (key !== _lastFilterKey) { _lastFilterKey = key; state.renderLimit = RENDER_STEP; }
  state.filtered = list;
  renderList();
}

// Skeleton de loading — înlocuiește textul „Se încarcă” cu rânduri fantomă
function renderSkeleton(n = 9) {
  const row = `
    <div class="skel-row">
      <div class="skel-box skel-logo"></div>
      <div class="skel-lines">
        <div class="skel-box skel-line-1"></div>
        <div class="skel-box skel-line-2"></div>
      </div>
    </div>`;
  $('channel-list').innerHTML = row.repeat(n);
}

function renderList() {
  const list = $('channel-list');
  $('stat-count').textContent = state.filtered.length;

  if (!state.filtered.length) {
    list.innerHTML = '<div class="empty-state">// nimic găsit</div>';
    return;
  }

  // Only fav mode uses the dropdown as a post-load filter
  if (state.mode === 'fav') {
    const select = $('filter-select');
    if (select.options.length <= 1) {
      const countries = [...new Set(getCurrentSource().map(c => c.country))].filter(Boolean).sort();
      select.innerHTML = '<option value="">// toate</option>' +
        countries.map(c => `<option value="${c}">${c}</option>`).join('');
    }
  }

  const searchTerm = $('search-input').value.trim();
  // Păstrăm poziția scroll-ului listei când user-ul continuă să tasteze
  const savedScroll = searchTerm ? list.scrollTop : 0;

  // Limităm DOM-ul pentru scroll fluid pe telefoane și TV box-uri cu memorie redusă.
  const items = state.filtered.slice(0, state.renderLimit);
  const remaining = state.filtered.length - items.length;
  const showDot = state.mode === 'tv';
  list.innerHTML = items.map((c, i) => {
    const isActive = state.current && state.current.id === c.id;
    const type = c._type || state.mode;
    const isFav = state.favorites[type]?.includes(c.id);
    const fb = escapeHtml((c.name[0]||'?').toUpperCase());
    const validLogo = c.logo && c.logo !== 'null' && c.logo !== 'N/A' ? c.logo : '';
    const logoHtml = validLogo
      ? `<img src="${escapeHtml(validLogo)}" alt="" loading="lazy" decoding="async" data-logo="1">`
      : `<span>${fb}</span>`;
    const ep = type === 'tv' ? epgNowNext(c.id) : null;
    const meta = type === 'radio'
      ? `${c.country} · ${c.bitrate || 0}kbps`
      : (ep ? `▶ ${ep.now[2]}` : c.country);
    const dotHtml = showDot
      ? `<span class="ch-dot ${state.tvHealth[c.url] || ''}" title="stare stream"></span>`
      : '';
    return `
      <div class="channel ${isActive?'active':''}" data-idx="${i}" tabindex="0" role="option" aria-selected="${isActive}" aria-label="${escapeHtml(c.name)}, ${escapeHtml(meta)}">
        ${dotHtml}
        <div class="channel-logo ${c.logo?'':'fallback'}" data-fb="${fb}">${logoHtml}</div>
        <div class="channel-info">
          <div class="channel-name">${escapeHtml(c.name)}</div>
          <div class="channel-meta">${escapeHtml(meta)}</div>
        </div>
        <span class="fav-star ${isFav?'is-fav':''}" data-fav="${i}" data-type="${type}" role="button" tabindex="0" aria-label="${isFav ? 'Elimină din favorite' : 'Adaugă la favorite'}">★</span>
      </div>
    `;
  }).join('') + (remaining > 0
    ? `<div class="channel load-more" data-more="1" tabindex="0" role="button">
         <div class="channel-info"><div class="channel-name">⬇ Afișează mai multe (${remaining} rămase)</div></div>
       </div>`
    : '');

  // Rândul „mai multe” se încarcă singur când ajunge pe ecran (scroll pe orice container)
  const moreEl = list.querySelector('[data-more]');
  if (moreEl && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some(en => en.isIntersecting)) { io.disconnect(); showMoreChannels(); }
    }, { rootMargin: '300px' });
    io.observe(moreEl);
  }

  // Reconstruim map-ul url -> rând, pentru update in-place al punctelor de status
  _tvRows.clear();
  if (showDot) {
    const rows = list.querySelectorAll('.channel');
    items.forEach((c, i) => {
      const row = rows[i];
      if (row) _tvRows.set(c.url, { row, dot: row.querySelector('.ch-dot') });
    });
  }

  requestAnimationFrame(() => {
    if (searchTerm || _keepScroll) {
      list.scrollTop = _keepScroll ? _keepScroll.top : savedScroll;
      _keepScroll = null;
    } else {
      const activeEl = list.querySelector('.channel.active');
      if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    // tabindex e pus direct în HTML (mai sus) ca focusul să meargă imediat după randare
  });
}

let _keepScroll = null;
function showMoreChannels() {
  state.renderLimit += RENDER_STEP;
  _keepScroll = { top: $('channel-list').scrollTop };
  renderList();
}

function escapeHtml(s) {
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Logo care nu se încarcă → inițiala canalului (un singur handler pt. toată lista)
$('channel-list').addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.logo) return;
  const p = img.parentNode;
  if (!p) return;
  p.classList.add('fallback');
  p.textContent = p.dataset.fb || '?';
}, true);

// ============= HELPERE VIZUALE =============
// Fundal blur din logo-ul stației; ascuns dacă nu există logo valid.
function setBackdrop(logo) {
  const bd = $('logo-backdrop');
  if (!bd) return;
  const valid = logo && logo !== 'null' && logo !== 'N/A';
  if (valid) {
    bd.style.backgroundImage = `url("${logo.replace(/"/g, '%22')}")`;
    bd.classList.add('active');
  } else {
    bd.classList.remove('active');
    bd.style.backgroundImage = '';
  }
}

// Titlu în now-playing cu marquee automat când textul depășește lățimea.
function setNpTitle(text) {
  const box = $('np-title');
  const txt = $('np-title-txt');
  if (!txt) { box.textContent = text; return; }
  txt.textContent = text;
  box.classList.remove('marquee');
  txt.style.removeProperty('--mq');
  // Măsurăm după ce s-a randat
  requestAnimationFrame(() => {
    const overflow = txt.scrollWidth - box.clientWidth;
    if (overflow > 8) {
      txt.style.setProperty('--mq', `-${overflow + 12}px`);
      box.classList.add('marquee');
    }
  });
}

// Spinner de conectare TV — arată feedback între click și pornirea stream-ului.
function showSpinner() { $('tv-spinner')?.classList.add('active'); }
function hideSpinner() { $('tv-spinner')?.classList.remove('active'); }

// Umple slider-ul de volum până la nivelul curent (gradient pe track).
function setVolumeFill(pct) {
  const v = $('volume');
  const p = Math.max(0, Math.min(100, pct));
  v.style.background =
    `linear-gradient(90deg, var(--neon-pink) 0%, var(--neon-cyan) ${p}%, var(--bg-elevated) ${p}%)`;
}

// ============= PLAYBACK =============
// ============= PLAYER NATIV (doar în APK) =============
// ExoPlayer din aplicația Android redă și ce WebView nu poate: stream-uri fără CORS,
// http simplu și MPEG-TS brut (ex. PRO TV / Pro Cinema din feed-ul HbbTV oficial).
const NativePlayer = {
  available() {
    try { return !!(window.AndroidBridge && typeof window.AndroidBridge.playNative === 'function'); }
    catch (_) { return false; }
  },
  play(item) {
    state.nativeActive = true;
    const sub = (item.country || '') + (item.bitrate ? ` · ${item.bitrate}kbps` : '');
    window.AndroidBridge.playNative(item.url, item.name || '', sub);
  },
  stop() {
    if (!state.nativeActive) return;
    state.nativeActive = false;
    try { window.AndroidBridge.stopNative(); } catch (_) {}
  },
  toggle() { try { window.AndroidBridge.toggleNative(); } catch (_) {} },
};

// Callback-uri apelate din Kotlin
window.__nativePlaying = function () { _tvSkipCount = 0; clearTimeout(_tvWatchdog); hideSpinner(); };
window.__nativeError = function () {
  if (state.current && state.nativeActive) handleTvFailure(state.current);
};
window.__nativeClosed = function () {
  // Back pe player-ul nativ → revenim în listă, canalul rămâne selectat (▶ îl reia)
  state.nativeActive = false;
  clearTimeout(_tvWatchdog);
  hideSpinner();
  state.pendingResume = true;
  $('play-btn').textContent = '▶';
  $('play-btn').setAttribute('aria-label', 'Redă');
  Bridge.notifyPaused();
  if (_isTv()) _tvFocusList(_tvListIdx);
};

function stopAll(keepNative) {
  if (!keepNative) NativePlayer.stop();
  clearInterval(_npTimer);
  hideSpinner();
  clearTimeout(_radioReconnectTimer);
  clearTimeout(_tvWatchdog);
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  video.pause(); video.removeAttribute('src'); video.load();
  // load() după scoaterea src oprește efectiv descărcarea stream-ului vechi
  audio.pause(); audio.removeAttribute('src'); audio.load();
}

// Pagina e servită pe HTTPS (Vercel) → cererile XHR/fetch către http:// sunt blocate
// (mixed content). Încercăm varianta https a aceluiași server.
const IS_HTTPS = location.protocol === 'https:';
function upgradeUrl(url) {
  return (IS_HTTPS && /^http:\/\//i.test(url)) ? 'https://' + url.slice(7) : url;
}
const isHlsUrl = (url) => /\.m3u8(\?|#|$)/i.test(url) || url.includes('.m3u8');
const hlsAvailable = () => typeof window.Hls !== 'undefined' && window.Hls.isSupported();

// Instanță hls.js cu rescriere http→https pentru manifest + segmente
function createHls() {
  return new Hls({
    enableWorker: true,
    xhrSetup: (xhr, url) => {
      const up = upgradeUrl(url);
      if (up !== url) xhr.open('GET', up, true);
      xhr.timeout = 10000;
    },
  });
}

// Watchdog: dacă un canal TV nu pornește în 20s (fără eroare explicită), trecem mai departe
let _tvWatchdog = null;
const TV_START_TIMEOUT = 20000;

// Expus pentru notificarea media (apelat din Kotlin)
window.__broadcastStop = function () {
  stopAll();
  Viz.stop();
  state.current = null;
  $('idle-state').classList.remove('hidden');
  setNpTitle('NIMIC ÎN REDARE');
  video.style.display = 'none';
  $('np-subtitle').textContent = 'aștept semnal...';
  $('np-logo').textContent = '—';
  $('play-btn').textContent = '▶';
  $('play-btn').setAttribute('aria-label', 'Redă');
  $('visualizer')?.classList.add('paused');
  $('radio-display')?.classList.remove('active');
  setBackdrop('');
  Bridge.notifyStopped();
  renderList();
};

window.__broadcastNext = function () {
  if (!state.filtered.length) return;
  const idx = state.current ? state.filtered.findIndex(i => i.id === state.current.id) : -1;
  const next = state.filtered[Math.min(idx + 1, state.filtered.length - 1)];
  if (next) play(next);
};

window.__broadcastPrev = function () {
  if (!state.filtered.length) return;
  const idx = state.current ? state.filtered.findIndex(i => i.id === state.current.id) : 0;
  const prev = state.filtered[Math.max(idx - 1, 0)];
  if (prev) play(prev);
};

function play(item) {
  const nextType = item._type || state.mode;
  stopAll(nextType === 'tv' && NativePlayer.available());
  state.current = item;
  state.pendingResume = false;
  $('idle-state').classList.add('hidden');
  setNpTitle(item.name);
  $('np-subtitle').textContent = item.country + (item.bitrate ? ` · ${item.bitrate}kbps` : '');
  const npLogo = $('np-logo');
  const npFb = (item.name[0]||'?').toUpperCase();
  npLogo.innerHTML = '';
  if (item.logo && item.logo !== 'null' && item.logo !== 'N/A') {
    const img = document.createElement('img');
    img.src = item.logo;
    img.alt = '';
    img.onerror = () => { npLogo.textContent = npFb; };
    npLogo.appendChild(img);
  } else {
    npLogo.textContent = npFb;
  }
  setBackdrop(item.logo);

  const itemType = item._type || state.mode;

  if (itemType === 'tv') {
    video.style.display = 'block';
    $('radio-display').classList.remove('active');
    playTV(item);
  } else {
    video.style.display = 'none';
    $('radio-display').classList.add('active');
    $('radio-name').textContent = item.name;
    $('radio-tags').textContent = item.tags || '';
    playRadio(item);
  }

  $('play-btn').textContent = '⏸';
  $('play-btn').setAttribute('aria-label', 'Pauză');
  if (itemType === 'tv') updateNpEpg();
  Bridge.notifyPlaying(item, itemType === 'tv');
  pushRecent(item, itemType);
  saveLastPlayed(item, itemType);
  renderList();
}

// ---- Auto-skip canale TV moarte ----
// Sare la următorul stream când unul pică; contorul se resetează la primul
// canal care chiar pornește (evenimentul 'playing'), sau la selecție manuală.
const TV_SKIP_LIMIT = 8;
let _tvSkipCount = 0;

function handleTvFailure(item) {
  // Doar dacă mai suntem pe același canal TV (nu a schimbat user-ul între timp)
  if (!state.current || state.current.id !== item.id) return;
  if ((state.current._type || state.mode) !== 'tv') return;

  clearTimeout(_tvWatchdog);
  hideSpinner();
  if (_tvSkipCount >= TV_SKIP_LIMIT) {
    _tvSkipCount = 0;
    toast(`Prea multe canale indisponibile la rând — oprit`);
    return;
  }
  // Ultimul canal din listă: nu are unde sări (altfel ar relua același canal în buclă)
  const idx = state.filtered.findIndex(c => c.id === item.id);
  if (idx < 0 || idx >= state.filtered.length - 1) {
    toast(`${item.name} indisponibil`);
    return;
  }
  _tvSkipCount++;
  toast(`⏭ ${item.name} indisponibil — sar la următorul (${_tvSkipCount})`);
  setTimeout(() => {
    if (state.current && state.current.id === item.id) window.__broadcastNext?.();
  }, 900);
}

function playTV(item) {
  const url = item.url;
  showSpinner();
  // Redarea e inițiată de user (click) → politica autoplay permite sunet.
  // Aplicăm preferința de mute, implicit NEmutat (fix „fără sunet pe PC").
  video.muted = state.muted;
  clearTimeout(_tvWatchdog);
  // Anulat de evenimentul 'playing'; dacă expiră, canalul n-a pornit niciodată
  if (NativePlayer.available()) {
    video.pause();
    video.style.display = 'none'; // în APK canalul rulează în player-ul nativ
    _tvWatchdog = setTimeout(() => {
      if (state.current && state.current.id === item.id && state.nativeActive) handleTvFailure(item);
    }, 45000); // ExoPlayer raportează singur erorile reale; aici prindem doar blocajele
    NativePlayer.play(item);
    return;
  }
  _tvWatchdog = setTimeout(() => {
    if (state.current && state.current.id === item.id) handleTvFailure(item);
  }, TV_START_TIMEOUT);

  if (isHlsUrl(url) && hlsAvailable()) {
    const hls = state.hls = createHls();
    hls.loadSource(url);
    hls.attachMedia(video);
    let netRetries = 0, mediaRecovered = false;
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal || state.hls !== hls) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries < 2) {
        netRetries++;
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
        mediaRecovered = true;          // o singură încercare de recuperare decoder
        hls.recoverMediaError();
      } else {
        toast(data.type === Hls.ErrorTypes.MEDIA_ERROR
          ? 'Flux video incompatibil sau corupt. Se încearcă următorul canal.'
          : 'Conexiunea cu postul TV a eșuat. Se încearcă următorul canal.');
        handleTvFailure(item);
      }
    });
    // Redare reușită → resetăm contoarele, ca o cădere ulterioară să poată fi reîncercată
    hls.on(Hls.Events.FRAG_LOADED, () => { netRetries = 0; });
    video.play().catch(() => {});
  } else {
    // Safari/iOS: HLS nativ; restul: mp4/ts direct
    video.src = upgradeUrl(url);
    video.play().catch((e) => {
      // NotAllowedError = autoplay blocat, nu stream mort
      if (e && e.name === 'NotAllowedError') { clearTimeout(_tvWatchdog); hideSpinner(); return; }
      handleTvFailure(item);
    });
  }
}

function playRadio(item) {
  // IMPORTANT: NU folosim crossOrigin + Web Audio pentru captură.
  // Majoritatea stream-urilor radio nu trimit headere CORS, iar
  // createMediaElementSource ar reda SILENȚIOS pe desktop Chrome/Edge.
  // Folosim vizualizatorul „fake" (animat), care nu depinde de CORS → sunet garantat.
  audio.removeAttribute('crossorigin');
  audio.volume = $('volume').value / 100;
  audio.muted = state.muted;
  _radioReconnect = 0; // stație nouă → resetăm contorul de reconectare
  loadRadioSource(item);
  audio.play()
    .then(() => {
      $('visualizer').classList.remove('paused');
      Viz.start();
      startNowPlaying(item);
    })
    .catch(() => {
      toast(`Nu se poate porni ${item.name}. Verifică internetul sau încearcă altă stație.`);
      $('visualizer').classList.add('paused');
    });
}

// Unele stații radio sunt HLS (.m3u8) — <audio> le redă nativ doar în Safari,
// deci în Chrome/Firefox/Android le trecem prin hls.js.
function loadRadioSource(item) {
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  if (isHlsUrl(item.url) && hlsAvailable()) {
    const hls = state.hls = createHls();
    hls.loadSource(item.url);
    hls.attachMedia(audio);
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal && state.hls === hls) reconnectRadio();
    });
  } else {
    audio.src = item.url; // browserele upgradează singure audio http→https
  }
}

// ---- Melodia curentă (metadate ICY prin /api/nowplaying) ----
let _npTimer = null;
function startNowPlaying(item) {
  clearInterval(_npTimer);
  if (!item || isHlsUrl(item.url)) return; // HLS nu are ICY
  const poll = async () => {
    if (!state.current || state.current.id !== item.id || (state.current._type || state.mode) !== 'radio') {
      clearInterval(_npTimer); return;
    }
    try {
      const r = await fetch('/api/nowplaying?url=' + encodeURIComponent(item.url));
      const j = r.ok ? await r.json() : null;
      let t = (j && j.title || '').trim();
      // Unele posturi trimit site-ul sau propriul nume în loc de piesă
      if (/^(https?:\/\/|www\.)|\.(ro|com|net|fm)$/i.test(t) || _fold(t) === _fold(item.name)) t = '';
      if (!state.current || state.current.id !== item.id) return;
      const base = item.country + (item.bitrate ? ` · ${item.bitrate}kbps` : '');
      $('np-subtitle').textContent = t ? `♪ ${t}` : base;
      $('radio-tags').textContent = t ? `♪ ${t}` : (item.tags || '');
      if (t) MediaSess.set({ ...item, name: t, country: item.name, bitrate: 0 }, false);
    } catch (_) {}
  };
  poll();
  _npTimer = setInterval(poll, 20000);
}

// ---- Reconectare automată radio ----
// Stream-urile radio pică des; reîncercăm de câteva ori înainte să renunțăm.
const RADIO_RECONNECT_LIMIT = 3;
let _radioReconnect = 0;
let _radioReconnectTimer = null;

function reconnectRadio() {
  const item = state.current;
  if (!item || (item._type || state.mode) !== 'radio') return;
  $('visualizer').classList.add('paused');
  if (_radioReconnect >= RADIO_RECONNECT_LIMIT) {
    toast(`Stație indisponibilă: ${item.name}`);
    return;
  }
  _radioReconnect++;
  toast(`↻ Reconectare radio (${_radioReconnect}/${RADIO_RECONNECT_LIMIT})...`);
  clearTimeout(_radioReconnectTimer);
  _radioReconnectTimer = setTimeout(() => {
    if (!state.current || state.current.id !== item.id) return; // user-ul a schimbat
    loadRadioSource(item);
    audio.muted = state.muted;
    audio.volume = $('volume').value / 100;
    audio.play()
      .then(() => $('visualizer').classList.remove('paused'))
      .catch(() => {}); // dacă pică iar, evenimentul 'error' reîncearcă
  }, 1500);
}

// ============= PLAYLIST IMPORT =============
// Mai multe proxy-uri CORS încercate pe rând — dacă unul pică (sau își schimbă
// API-ul, cum a făcut corsproxy.io), trecem la următorul. Fiecare împachetează
// altfel URL-ul țintă.
const CORS_PROXIES = [
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://thingproxy.freeboard.io/fetch/${u}`,
  u => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
];

// Descărcare prin aplicația Android (AndroidBridge.fetchTextAsync). null = indisponibil/eșec.
const _nativeFetchWaiters = new Map();
window.__nativeFetchDone = function (id, ok) {
  const w = _nativeFetchWaiters.get(id);
  if (!w) return;
  _nativeFetchWaiters.delete(id);
  let txt = null;
  try { txt = ok ? window.AndroidBridge.takeFetchResult(id) : null; } catch (_) {}
  w(txt || null);
};
function nativeFetchText(url) {
  try {
    if (!window.AndroidBridge || typeof window.AndroidBridge.fetchTextAsync !== 'function') return Promise.resolve(null);
  } catch (_) { return Promise.resolve(null); }
  const id = 'f' + Date.now() + Math.random().toString(36).slice(2, 8);
  return new Promise((resolve) => {
    const t = setTimeout(() => { _nativeFetchWaiters.delete(id); resolve(null); }, 90000);
    _nativeFetchWaiters.set(id, (txt) => { clearTimeout(t); resolve(txt); });
    try { window.AndroidBridge.fetchTextAsync(url, id); }
    catch (_) { clearTimeout(t); _nativeFetchWaiters.delete(id); resolve(null); }
  });
}

// Întoarce textul M3U, încercând întâi direct și apoi fiecare proxy pe rând.
async function fetchTextWithProxy(url) {
  // 1) Direct (merge dacă serverul trimite CORS headers)
  try {
    const res = await fetch(url);
    if (res.ok) {
      const txt = await res.text();
      if (txt && txt.length) return txt;
    }
  } catch (_) {}

  // 2) În aplicația Android: descărcare nativă (fără CORS) — linkul cu user/parolă
  //    nu mai trece prin servere terțe.
  const nat = await nativeFetchText(url);
  if (nat) return nat;

  // 3) Proxy-uri de rezervă, în ordine (doar dacă metodele de mai sus au eșuat)
  for (const build of CORS_PROXIES) {
    try {
      const res = await fetch(build(url));
      if (!res.ok) continue;
      const txt = await res.text();
      if (txt && txt.length) return txt;
    } catch (_) { /* încearcă următorul */ }
  }
  throw new Error('Toate proxy-urile CORS au eșuat');
}

async function loadPlaylistFromUrl(m3uUrl) {
  const text = await fetchTextWithProxy(m3uUrl);
  const list = parseM3U(text);
  if (!list.length) throw new Error('Lista goală sau format M3U invalid');
  return list;
}

// Playlist dialog tab switching
document.querySelectorAll('.pl-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pl-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.pl-panel').forEach(p => p.classList.add('pl-panel--hidden'));
    btn.classList.add('active');
    $('pl-tab-' + btn.dataset.tab).classList.remove('pl-panel--hidden');
  });
});

function openPlaylistDialog() {
  const saved = _lsGet('tr-playlist-url', '');
  if (saved && !$('pl-m3u-url').value) $('pl-m3u-url').value = saved;
  $('playlist-dialog').classList.add('open');
  $('pl-m3u-url').focus();
}

$('mode-playlist').addEventListener('click', async () => {
  // Click din nou pe tab-ul activ → încarcă alt playlist
  if (state.mode === 'playlist') { openPlaylistDialog(); return; }
  if (state.playlistList.length) { switchMode('playlist'); return; }
  // Playlist salvat din sesiunea trecută → îl reîncărcăm automat
  const saved = _lsGet('tr-playlist-url', '');
  if (saved) {
    try {
      renderSkeleton();
      state.playlistList = await loadPlaylistFromUrl(saved);
      state.playlistName = _lsGet('tr-playlist-name', 'Playlist');
      $('mode-playlist').textContent = state.playlistName.toUpperCase().slice(0, 12);
      switchMode('playlist');
      return;
    } catch (e) {
      toast(`Playlist-ul salvat nu s-a putut încărca: ${e.message}`);
      applyFilter();
    }
  }
  openPlaylistDialog();
});

$('pl-cancel').addEventListener('click', () => $('playlist-dialog').classList.remove('open'));
$('playlist-dialog').addEventListener('click', e => {
  if (e.target === $('playlist-dialog')) $('playlist-dialog').classList.remove('open');
});

$('pl-load').addEventListener('click', async () => {
  const activeTab = document.querySelector('.pl-tab.active')?.dataset.tab;
  let m3uUrl = '';

  if (activeTab === 'xtream') {
    const server = $('pl-xt-server').value.trim().replace(/\/$/, '');
    const user   = $('pl-xt-user').value.trim();
    const pass   = $('pl-xt-pass').value.trim();
    if (!server || !user || !pass) { toast('Completează toate câmpurile Xtream'); return; }
    // Fără protocol, new URL() aruncă eroare — adăugăm http:// implicit
    const base = /^https?:\/\//i.test(server) ? server : 'http://' + server;
    try { state.playlistName = new URL(base).hostname; }
    catch (_) { toast('Adresa serverului Xtream nu este validă'); return; }
    m3uUrl = `${base}/get.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&type=m3u_plus&output=ts`;
  } else {
    m3uUrl = $('pl-m3u-url').value.trim();
    if (!m3uUrl) { toast('Introdu URL-ul M3U'); return; }
    try { state.playlistName = new URL(m3uUrl).hostname; }
    catch (_) { toast('URL-ul M3U nu este valid'); return; }
  }

  $('pl-load').textContent = '⏳ Se încarcă...';
  $('pl-load').disabled = true;

  try {
    const list = await loadPlaylistFromUrl(m3uUrl);
    if (!list.length) throw new Error('Lista goală sau format invalid');
    state.playlistList = list;
    // Reținem playlist-ul (doar pe acest dispozitiv) ca să nu fie reintrodus la fiecare pornire
    _lsSet('tr-playlist-url', m3uUrl);
    _lsSet('tr-playlist-name', state.playlistName);
    $('playlist-dialog').classList.remove('open');
    $('mode-playlist').textContent = `${state.playlistName.toUpperCase().slice(0,12)}`;
    switchMode('playlist');
  } catch(e) {
    toast(`Eroare: ${e.message}`);
  } finally {
    $('pl-load').textContent = '⬇ Încarcă';
    $('pl-load').disabled = false;
  }
});

// ============= EVENTS =============
$('mode-tv').addEventListener('click', () => switchMode('tv'));
$('mode-radio').addEventListener('click', () => switchMode('radio'));
$('mode-fav').addEventListener('click', () => switchMode('fav'));
$('mode-recent').addEventListener('click', () => switchMode('recent'));

async function switchMode(mode) {
  state.mode = mode;
  try { localStorage.setItem('tr-mode', mode); } catch (_) {}
  document.querySelectorAll('.mode-toggle button').forEach(b => {
    const selected = b.id === 'mode-' + mode;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-selected', String(selected));
  });
  $('stat-mode').textContent = mode.toUpperCase();
  $('search-input').value = '';
  renderSkeleton();

  // Dropdown-ul de gen apare doar în modul radio
  $('genre-select').classList.toggle('genre-hidden', mode !== 'radio');
  // Rândul „doar funcționale" apare doar în modul TV
  $('tv-health-row').classList.toggle('hidden', mode !== 'tv' || NativePlayer.available());
  $('only-working-chk').checked = state.tvOnlyWorking;
  updateSyncButton();

  if (mode === 'tv') {
    $('filter-select').innerHTML = TV_COUNTRIES
      .map(c => `<option value="${c.code}" ${c.code === state.currentTvCountry ? 'selected' : ''}>${c.name}</option>`)
      .join('');
    await loadTV(state.currentTvCountry);
    applyFilter();
    kickTvHealthCheck();
    return;
  } else if (mode === 'radio') {
    $('filter-select').innerHTML = TV_COUNTRIES
      .map(c => `<option value="${c.code.toUpperCase()}" ${c.code.toUpperCase() === state.currentRadioCountry ? 'selected' : ''}>${c.name}</option>`)
      .join('');
    await loadRadio(state.currentRadioCountry);
    populateGenreOptions();
  } else if (mode === 'playlist') {
    const groups = [...new Set(state.playlistList.flatMap(c => c.categories))].filter(Boolean).sort();
    $('filter-select').innerHTML = '<option value="">// toate grupurile</option>' +
      groups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  } else if (mode === 'recent') {
    $('filter-select').innerHTML = '<option value="">// tv + radio</option>' +
      '<option value="tv">// doar TV</option>' +
      '<option value="radio">// doar radio</option>';
  } else {
    $('filter-select').innerHTML = '<option value="">// toate</option>';
  }
  applyFilter();
}

// ============= FIX SAMSUNG IME REVERSED TEXT =============
// Pe Samsung WebView, GBoard plasează cursorul ÎNAINTE de textul composing
// (newCursorPosition=0) → fiecare literă se inserează înainte → "radio" devine "oidar".
// Fix JS: la compositionend știm textul CORECT din e.data; dacă inputul are versiunea
// inversată, o înlocuim direct.
(function() {
  const inp = $('search-input');
  let _compData = '';

  inp.addEventListener('compositionstart', () => { _compData = ''; });
  inp.addEventListener('compositionupdate', (e) => { _compData = e.data || ''; });
  inp.addEventListener('compositionend', (e) => {
    const correct = e.data || _compData;
    _compData = '';
    if (!correct) return;
    const reversed = correct.split('').reverse().join('');
    // Dacă inputul se termină cu versiunea inversată, o corectăm
    if (reversed !== correct && inp.value.endsWith(reversed)) {
      inp.value = inp.value.slice(0, -reversed.length) + correct;
    }
  });
})();

// Polling — citim valoarea reală din DOM (după fix-ul de mai sus)
// Reacționăm la tastare; verificarea periodică (necesară pentru tastatura Samsung,
// care uneori nu trimite 'input') rulează DOAR cât câmpul de căutare e activ.
let _lastSearchVal = '';
let _searchPoll = null;
function _checkSearch() {
  const val = $('search-input').value;
  if (val !== _lastSearchVal) {
    _lastSearchVal = val;
    applyFilter();
  }
}
// La 'input' filtrăm mereu (valoarea poate fi fost golită din cod între timp)
$('search-input').addEventListener('input', () => { _lastSearchVal = $('search-input').value; applyFilter(); });
$('search-input').addEventListener('focus', () => {
  clearInterval(_searchPoll);
  _searchPoll = setInterval(_checkSearch, 150);
});
$('search-input').addEventListener('blur', () => {
  clearInterval(_searchPoll);
  _searchPoll = null;
  _checkSearch();
});

$('filter-select').addEventListener('change', async () => {
  const val = $('filter-select').value;
  if (state.mode === 'tv') {
    state.currentTvCountry = val;
    try { localStorage.setItem('tr-tv-country', val); } catch (_) {}
    $('search-input').value = '';
    renderSkeleton();
    await loadTV(val);
  } else if (state.mode === 'radio') {
    state.currentRadioCountry = val.toUpperCase();
    try { localStorage.setItem('tr-radio-country', val.toUpperCase()); } catch (_) {}
    state.radioGenre = '';
    $('search-input').value = '';
    renderSkeleton();
    await loadRadio(val);
    populateGenreOptions();
  }
  // playlist and fav: just re-filter without fetching
  applyFilter();
  if (state.mode === 'tv') kickTvHealthCheck();
});

$('genre-select').addEventListener('change', () => {
  state.radioGenre = $('genre-select').value;
  applyFilter();
});

// „Doar funcționale" — ascunde/arată canalele moarte
$('only-working-chk').addEventListener('change', (e) => {
  state.tvOnlyWorking = e.target.checked;
  try { localStorage.setItem('tr-only-working', state.tvOnlyWorking ? '1' : '0'); } catch (_) {}
  applyFilter();
  if (state.tvOnlyWorking) kickTvHealthCheck(); // pornește verificarea dacă nu s-a făcut
});

// Reverificare forțată (ignoră cache-ul)
$('tv-recheck').addEventListener('click', async () => {
  if (state.mode !== 'tv') return;
  const btn = $('tv-recheck');
  btn.classList.add('spinning');
  try { await runTvHealthCheck(state.currentTvCountry, true); }
  finally { btn.classList.remove('spinning'); }
});

$('channel-list').addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    e.stopPropagation();
    const idx = parseInt(fav.dataset.fav);
    const type = fav.dataset.type;
    const item = state.filtered[idx];
    if (!item) return;
    const added = toggleFavorite(item, type);
    fav.classList.toggle('is-fav', added);
    fav.setAttribute('aria-label', added ? 'Elimină din favorite' : 'Adaugă la favorite');
    if (state.mode === 'fav') applyFilter();
    return;
  }

  if (e.target.closest('[data-more]')) { showMoreChannels(); return; }
  const ch = e.target.closest('.channel');
  if (ch) {
    const idx = parseInt(ch.dataset.idx);
    const item = state.filtered[idx];
    if (item) { _tvSkipCount = 0; play(item); } // selecție manuală → contor auto-skip resetat
  }
});

$('channel-list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-fav]')) {
    e.preventDefault();
    e.target.click();
  }
  // Enter pe un canal focusat (tastatură desktop) — pe TV îl tratează handler-ul global
  else if (e.key === 'Enter' && !_isTv() && e.target.matches('.channel')) {
    e.target.click();
  }
});

$('play-btn').addEventListener('click', () => {
  if (!state.current) { toast('Selectează ceva mai întâi'); return; }
  // Resume după restore: nimic nu e încărcat încă → încarcă și redă stream-ul
  if (state.pendingResume) {
    state.pendingResume = false;
    play(state.current);
    return;
  }
  const isTv = (state.current._type || state.mode) === 'tv';
  if (isTv && state.nativeActive) { NativePlayer.toggle(); return; }
  const el = isTv ? video : audio;
  if (el.paused) {
    el.play().catch(() => {
      // Stream-ul live a expirat cât a stat pe pauză → îl reîncărcăm de la zero
      if (state.current) play(state.current);
    });
    $('play-btn').textContent = '⏸';
    $('play-btn').setAttribute('aria-label', 'Pauză');
    $('visualizer')?.classList.remove('paused');
    Bridge.notifyPlaying(state.current, isTv);
  } else {
    el.pause();
    clearTimeout(_tvWatchdog); // pauză voluntară ≠ canal mort
    hideSpinner();
    $('play-btn').textContent = '▶';
    $('play-btn').setAttribute('aria-label', 'Redă');
    $('visualizer')?.classList.add('paused');
    Bridge.notifyPaused();
  }
});

$('prev-btn').addEventListener('click', () => window.__broadcastPrev?.());
$('next-btn').addEventListener('click', () => window.__broadcastNext?.());

// ============= SLEEP TIMER =============
function pad(n) { return n < 10 ? '0' + n : '' + n; }

function updateSleepIndicator() {
  if (!state.sleepEndsAt) return;
  const remainingMs = Math.max(0, state.sleepEndsAt - Date.now());
  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  $('sleep-remaining').textContent = `${pad(m)}:${pad(s)}`;
}

function cancelSleepTimer(silent) {
  if (state.sleepTimer) { clearTimeout(state.sleepTimer); state.sleepTimer = null; }
  if (state.sleepTick)  { clearInterval(state.sleepTick); state.sleepTick = null; }
  state.sleepEndsAt = 0;
  $('sleep-indicator').classList.remove('active');
  document.querySelectorAll('.sleep-opt').forEach(b => b.classList.remove('active'));
  $('sleep-status').textContent = 'Niciun timer activ.';
  if (!silent) toast('Sleep timer anulat');
}

function setSleepTimer(minutes) {
  cancelSleepTimer(true);
  const ms = minutes * 60 * 1000;
  state.sleepEndsAt = Date.now() + ms;
  state.sleepTimer = setTimeout(() => {
    cancelSleepTimer(true);
    toast('💤 Sleep timer: oprire redare');
    window.__broadcastStop?.();
  }, ms);
  state.sleepTick = setInterval(updateSleepIndicator, 1000);
  $('sleep-indicator').classList.add('active');
  updateSleepIndicator();
  document.querySelectorAll('.sleep-opt').forEach(b => {
    b.classList.toggle('active', +b.dataset.min === minutes);
  });
  $('sleep-status').textContent = `Activ: oprire în ${minutes} min`;
  toast(`⏰ Sleep timer setat: ${minutes} min`);
}

$('sleep-btn').addEventListener('click', () => {
  $('sleep-dialog').classList.add('open');
});
$('sleep-close').addEventListener('click', () => $('sleep-dialog').classList.remove('open'));
$('sleep-dialog').addEventListener('click', e => {
  if (e.target === $('sleep-dialog')) $('sleep-dialog').classList.remove('open');
});
$('sleep-cancel-timer').addEventListener('click', () => cancelSleepTimer());
document.querySelectorAll('.sleep-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    setSleepTimer(parseInt(btn.dataset.min, 10));
    setTimeout(() => $('sleep-dialog').classList.remove('open'), 300);
  });
});

$('volume').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  video.volume = v;
  audio.volume = v;
  setVolumeFill(+e.target.value);
  try { localStorage.setItem('tr-volume', e.target.value); } catch (_) {}
});

$('custom-btn').addEventListener('click', () => {
  $('custom-dialog').classList.add('open');
  $('custom-url').focus();
});

function closeCustomDialog() {
  $('custom-dialog').classList.remove('open');
}

$('custom-cancel').addEventListener('click', closeCustomDialog);

$('custom-dialog').addEventListener('click', (e) => {
  if (e.target === $('custom-dialog')) closeCustomDialog();
});

$('custom-play').addEventListener('click', () => {
  const url  = $('custom-url').value.trim();
  const name = $('custom-name').value.trim() || 'Custom Stream';
  if (!url) { toast('Introdu un URL valid'); return; }
  const isRadio = !url.includes('.m3u8') && !url.includes('.mp4') && !url.includes('.ts');
  const item = { id: 'custom_' + Date.now(), name, url, country: '', logo: '', _type: isRadio ? 'radio' : 'tv' };
  closeCustomDialog();
  play(item);
});

$('custom-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('custom-play').click();
  if (e.key === 'Escape') closeCustomDialog();
});

$('share-btn').addEventListener('click', async () => {
  if (!state.current) { toast('Selectează ceva mai întâi'); return; }
  const name = state.current.name || 'TMedia';
  const shareData = {
    title: 'TMedia',
    text: `Ascult „${name}" pe TMedia 📺`,
    url: location.href,
  };
  // Web Share API (mobil) — deschide meniul nativ (WhatsApp, etc.)
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (_) { return; } // user a anulat — nu tratăm ca eroare
  }
  // Fallback desktop: copiem în clipboard
  const txt = `${shareData.text} — ${shareData.url}`;
  try {
    await navigator.clipboard.writeText(txt);
    toast('🔗 Link copiat în clipboard');
  } catch (_) {
    toast('Partajare neacceptată pe acest dispozitiv');
  }
});

$('mute-btn').addEventListener('click', () => {
  state.muted = !state.muted;
  video.muted = audio.muted = state.muted;
  $('mute-btn').textContent = state.muted ? '🔇' : '🔊';
  $('mute-btn').setAttribute('aria-label', state.muted ? 'Activează sunetul' : 'Dezactivează sunetul');
  try { localStorage.setItem('tr-muted', state.muted ? '1' : '0'); } catch (_) {}
});

window.addEventListener('offline', () => toast('Ești offline. Interfața rămâne disponibilă, dar streamurile necesită internet.'));
window.addEventListener('online', () => {
  toast('Conexiunea la internet a revenit.');
  // Lista goală (ex. TV box pornit înainte de Wi-Fi) → o reîncărcăm automat
  if ((state.mode === 'tv' && !state.tvList.length) || (state.mode === 'radio' && !state.radioList.length)) {
    switchMode(state.mode);
  }
});

$('fullscreen-btn').addEventListener('click', () => {
  const wrap = document.querySelector('.player-wrap');
  const inFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (!inFs) {
    if (wrap.requestFullscreen) {
      wrap.requestFullscreen().catch(() => {});
    } else if (wrap.webkitRequestFullscreen) {
      wrap.webkitRequestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      // iOS Safari: fullscreen doar pe elementul <video>
      video.webkitEnterFullscreen();
    } else {
      toast('Fullscreen neacceptat pe acest dispozitiv');
    }
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
});

document.addEventListener('fullscreenchange', () => {
  $('fullscreen-btn').textContent = document.fullscreenElement ? '✕' : '⛶';
});
document.addEventListener('webkitfullscreenchange', () => {
  $('fullscreen-btn').textContent = document.webkitFullscreenElement ? '✕' : '⛶';
});

audio.addEventListener('error', () => {
  if (state.current && (state.current._type || state.mode) === 'radio') reconnectRadio();
});
// Un stream „live" nu ar trebui să se termine — dacă o face, reconectăm.
audio.addEventListener('ended', () => {
  if (state.current && (state.current._type || state.mode) === 'radio') reconnectRadio();
});
// Redare reușită → resetăm contorul de reconectare.
audio.addEventListener('playing', () => { _radioReconnect = 0; });

video.addEventListener('error', () => {
  if (state.current && (state.current._type || state.mode) === 'tv' && !state.hls) {
    handleTvFailure(state.current);
  }
});

// Canal pornit cu succes → resetăm contorul de auto-skip și ascundem spinner-ul
video.addEventListener('playing', () => { _tvSkipCount = 0; clearTimeout(_tvWatchdog); hideSpinner(); });
video.addEventListener('canplay', hideSpinner);

// (Fostul handler „unmute la primul click" a fost eliminat — acum dezactivăm
//  mute-ul direct în playTV/playRadio, în cadrul gestului user-ului.)

// Tracking manual focus — document.activeElement nu e fiabil pe Android WebView
let _anyInputFocused = false;
document.querySelectorAll('input').forEach(inp => {
  inp.addEventListener('focus', () => { _anyInputFocused = true; });
  inp.addEventListener('blur',  () => { _anyInputFocused = false; });
});

// ============= NAVIGARE TELECOMANDA TV =============
let _tvListIdx = 0;
let _tvCtrlIdx = 1;

// TV real: APK-ul adaugă „TannyRadioTV" în user-agent pe Android TV. Lățimea singură
// nu e de încredere — multe TV box-uri raportează < 950px în WebView, iar atunci
// telecomanda nu putea comuta pe RADIO.
const _IS_TV_DEVICE = /TannyRadioTV|Android TV|GoogleTV|AFT[A-Z]|BRAVIA|SMART-TV|SmartTV/i.test(navigator.userAgent);
if (_IS_TV_DEVICE) document.documentElement.classList.add('tv-device');
function _isTv() { return _IS_TV_DEVICE || window.innerWidth >= 950; }
function _tvGetFilters() {
  return Array.from(document.querySelectorAll('.search-box input, .search-box select, .search-box button'))
    .filter(el => el.offsetParent !== null && !el.disabled);
}
function _tvFocusFilters(idx) {
  const f = _tvGetFilters();
  if (!f.length) return false;
  f[Math.max(0, Math.min(idx, f.length - 1))].focus();
  return true;
}
function _focusables(root) {
  return Array.from(root.querySelectorAll('input, select, button'))
    .filter(el => el.offsetParent !== null && !el.disabled);
}
// Mută focusul în listă de elemente (dialog / filtre), cu încadrare la capete
function _moveIn(list, active, delta) {
  const i = list.indexOf(active);
  const n = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta));
  list[n]?.focus();
  return i < 0 ? 0 : i + delta;  // poate ieși din interval → apelantul decide zona următoare
}
// Selectul nu se poate deschide cu evenimente injectate → schimbăm opțiunea cu ← →
function _stepSelect(sel, delta) {
  const n = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + delta));
  if (n !== sel.selectedIndex) {
    sel.selectedIndex = n;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Apelat din Kotlin la butonul Back: true = am consumat (dialog închis etc.)
window.__broadcastBack = function () {
  const dlg = document.querySelector('.custom-dialog.open');
  if (dlg) { dlg.classList.remove('open'); _tvFocusList(_tvListIdx); return true; }
  const a = document.activeElement;
  if (a && (a.closest('.search-box') || a.closest('.np-controls') || a.closest('.mode-toggle'))) {
    if (_tvFocusList(_tvListIdx)) return true;
  }
  return false;
};
function _tvGetChannels() { return Array.from(document.querySelectorAll('#channel-list .channel')); }
function _tvGetTabs()     { return Array.from(document.querySelectorAll('.mode-toggle button')); }
function _tvGetCtrls()    {
  return Array.from(document.querySelectorAll('.np-controls .ctrl-btn'))
    .filter(b => getComputedStyle(b).display !== 'none');
}

function _tvFocusList(idx) {
  const items = _tvGetChannels();
  if (!items.length) return false;
  _tvListIdx = Math.max(0, Math.min(idx, items.length - 1));
  items[_tvListIdx].focus({ preventScroll: false });
  items[_tvListIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return true;
}

function _tvFocusTabs(idx) {
  const tabs = _tvGetTabs();
  if (!tabs.length) return;
  const active = tabs.findIndex(t => t.classList.contains('active'));
  const i = Math.max(0, Math.min(idx ?? active, tabs.length - 1));
  tabs[i].focus();
}

function _tvFocusCtrls(idx) {
  const ctrls = _tvGetCtrls();
  if (!ctrls.length) return;
  _tvCtrlIdx = Math.max(0, Math.min(idx, ctrls.length - 1));
  ctrls[_tvCtrlIdx].focus();
}

// Mapă directă tab id → mod (evită problema cu click() + focus pierdut)
const _tvModeMap = {
  'mode-tv': 'tv', 'mode-radio': 'radio',
  'mode-fav': 'fav', 'mode-recent': 'recent'
};

// Schimbă modul și după încărcare focusează primul canal
async function _tvSwitchMode(mode) {
  try { await switchMode(mode); } catch (e) { console.error(e); }
  // Așteptăm efectiv încărcarea (radio poate dura) în loc de un delay fix
  if (!_tvFocusList(0)) setTimeout(() => { if (!_tvFocusList(0)) _tvFocusTabs(); }, 1000);
}

// Recuperare focus când se pierde (video/body preia focusul)
document.addEventListener('focusout', () => {
  if (!_IS_TV_DEVICE) return;
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a.tagName === 'VIDEO' || a.tagName === 'AUDIO') {
      // focus pierdut — îl recuperăm pe listă sau controale
      if (!_tvFocusList(_tvListIdx)) _tvFocusCtrls(_tvCtrlIdx);
    }
  });
});

// Taste consumate de navigarea „telecomandă" — restul (Tab, F5, Ctrl+…) rămân la browser
const _TV_KEYS = new Set([
  'Enter', 'NumpadEnter', 'Space', 'MediaPlayPause', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'ChannelUp', 'ChannelDown',
  'MediaTrackNext', 'MediaTrackPrevious', 'KeyM',
]);

document.addEventListener('keydown', (e) => {
  // Dialog deschis: Escape / Back îl închide, altfel tastele merg în dialog
  const openDlg = document.querySelector('.custom-dialog.open');
  const keyCode = e.code || e.key;
  if (openDlg) {
    if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
      e.preventDefault();
      openDlg.classList.remove('open');
      return;
    }
    // Pe TV, D-pad-ul e injectat din APK → navigăm manual prin elementele dialogului
    if (_IS_TV_DEVICE) {
      const items = _focusables(openDlg);
      const a = document.activeElement;
      if (!openDlg.contains(a)) { e.preventDefault(); items[0]?.focus(); return; }
      if (keyCode === 'ArrowDown' || keyCode === 'ArrowRight') { e.preventDefault(); _moveIn(items, a, 1); }
      else if (keyCode === 'ArrowUp' || keyCode === 'ArrowLeft') { e.preventDefault(); _moveIn(items, a, -1); }
      else if (keyCode === 'Enter' || keyCode === 'NumpadEnter') {
        e.preventDefault();
        if (a.tagName === 'INPUT') { a.blur(); a.focus(); a.click(); } else a.click();
      }
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  const inFilters = !!document.activeElement?.closest?.('.search-box');

  // ---- TV: zona de filtre (căutare / țară / gen / doar funcționale) ----
  if (_IS_TV_DEVICE && inFilters) {
    const a = document.activeElement;
    const f = _tvGetFilters();
    const i = f.indexOf(a);
    if (keyCode === 'ArrowDown') {
      e.preventDefault();
      if (i >= f.length - 1) _tvFocusList(0); else f[i + 1].focus();
    } else if (keyCode === 'ArrowUp') {
      e.preventDefault();
      if (i <= 0) _tvFocusTabs(); else f[i - 1].focus();
    } else if ((keyCode === 'ArrowLeft' || keyCode === 'ArrowRight') && tag === 'SELECT') {
      e.preventDefault();
      _stepSelect(a, keyCode === 'ArrowLeft' ? -1 : 1);
    } else if (keyCode === 'Enter' || keyCode === 'NumpadEnter') {
      e.preventDefault();
      if (tag === 'SELECT') _stepSelect(a, 1);
      else if (tag === 'INPUT' && a.type === 'text') { a.blur(); a.focus(); a.click(); }
      else a.click();
    }
    return;
  }

  // SELECT inclus: săgețile trebuie să schimbe opțiunea, nu canalul
  if (_anyInputFocused || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  const active = document.activeElement || document.body;
  const inTab  = !!active.closest?.('.mode-toggle');
  const inList = !!active.closest?.('#channel-list');
  const inCtrl = !!active.closest?.('.np-controls');

  // ---- Telefon / tabletă ----
  if (!_isTv()) {
    if (e.code === 'Space') { e.preventDefault(); $('play-btn').click(); }
    if (e.code === 'ArrowDown' && state.filtered.length) {
      e.preventDefault();
      const idx = state.current ? state.filtered.findIndex(i => i.id === state.current.id) : -1;
      const next = state.filtered[Math.min(idx + 1, state.filtered.length - 1)];
      if (next) play(next);
    }
    if (e.code === 'ArrowUp' && state.filtered.length) {
      e.preventDefault();
      const idx = state.current ? state.filtered.findIndex(i => i.id === state.current.id) : 0;
      const prev = state.filtered[Math.max(idx - 1, 0)];
      if (prev) play(prev);
    }
    return;
  }

  // ---- TV: consumăm doar tastele de navigare ----
  const code = e.code || e.key;
  if (!_TV_KEYS.has(code)) return;
  e.preventDefault();

  switch (code) {

    // OK / Enter
    case 'Enter':
    case 'NumpadEnter':
      if (inList) {
        const items = _tvGetChannels();
        if (items[_tvListIdx]) items[_tvListIdx].click();
      } else if (inTab) {
        // Comutare mod — direct, fără click() care pierde focusul
        const mode = _tvModeMap[active.id];
        if (mode) {
          _tvSwitchMode(mode);
        } else if (active.id === 'mode-playlist') {
          active.click(); // playlist deschide dialog
        }
      } else if (inCtrl || active.tagName === 'BUTTON') {
        active.click();
      } else {
        // Focus pierdut — redă canalul curent sau focusează lista
        if (state.current) $('play-btn').click();
        else _tvFocusList(_tvListIdx);
      }
      break;

    // Space = play/pause mereu
    case 'Space':
    case 'MediaPlayPause':
      $('play-btn').click();
      break;

    // Sus
    case 'ArrowUp':
      if (inList) {
        if (_tvListIdx > 0) _tvFocusList(_tvListIdx - 1);
        else if (!_tvFocusFilters(99)) _tvFocusTabs(); // sus din top → filtre (țară/căutare)
      } else if (inCtrl) {
        _tvFocusTabs();               // sus din controale → tab-uri
      } else if (inTab) {
        // deja sus de tot — rămânem pe tab-uri
      } else {
        _tvFocusList(_tvListIdx);
      }
      break;

    // Jos
    case 'ArrowDown':
      if (inTab) {
        if (!_tvFocusFilters(0)) _tvFocusList(0); // jos din tab-uri → filtre
      } else if (inList) {
        const items = _tvGetChannels();
        if (_tvListIdx < items.length - 1) _tvFocusList(_tvListIdx + 1);
        // la capăt → controale
        else _tvFocusCtrls(1);
      } else if (inCtrl) {
        _tvFocusList(_tvListIdx);     // jos din controale → înapoi la listă
      } else {
        _tvFocusList(0);
      }
      break;

    // Stânga
    case 'ArrowLeft':
      if (inTab) {
        const tabs = _tvGetTabs();
        const ti = tabs.indexOf(active);
        if (ti > 0) tabs[ti - 1].focus();
      } else if (inCtrl) {
        const ctrls = _tvGetCtrls();
        const ci = ctrls.indexOf(active);
        if (ci > 0) { _tvCtrlIdx = ci - 1; ctrls[_tvCtrlIdx].focus(); }
        else _tvFocusList(_tvListIdx);  // capăt stânga → listă
      } else {
        _tvFocusTabs();
      }
      break;

    // Dreapta
    case 'ArrowRight':
      if (inTab) {
        const tabs = _tvGetTabs();
        const ti = tabs.indexOf(active);
        if (ti < tabs.length - 1) tabs[ti + 1].focus();
      } else if (inList) {
        _tvFocusCtrls(1);             // din listă → Play button
      } else if (inCtrl) {
        const ctrls = _tvGetCtrls();
        const ci = ctrls.indexOf(active);
        if (ci < ctrls.length - 1) { _tvCtrlIdx = ci + 1; ctrls[_tvCtrlIdx].focus(); }
      } else {
        _tvFocusCtrls(1);
      }
      break;

    // Volum
    case 'PageUp':   case 'ChannelUp':
    case 'MediaTrackNext':
      { const v = $('volume'); v.value = Math.min(100, +v.value + 10); v.dispatchEvent(new Event('input')); }
      break;
    case 'PageDown': case 'ChannelDown':
    case 'MediaTrackPrevious':
      { const v = $('volume'); v.value = Math.max(0, +v.value - 10); v.dispatchEvent(new Event('input')); }
      break;

    // Mute rapid
    case 'KeyM':
      $('mute-btn').click();
      break;
  }
});

// Focus inițial pe primul canal la load
window.addEventListener('load', () => {
  if (_isTv()) setTimeout(() => _tvFocusList(0), 900);
});

// ============= SIDEBAR TOGGLE (mobil) =============
// Pe mobil layout-ul e stivuit (header / main / aside), nu drawer.
// Butonul ☰ doar derulează rapid la lista de canale.
const sidebarToggleBtn = $('sidebar-toggle');
const sidebarEl = document.querySelector('aside');

sidebarToggleBtn.addEventListener('click', () => {
  sidebarEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('search-input').focus({ preventScroll: true });
});

// ============= RESTORE PERSISTAT =============
// Volum + mute salvate din sesiunea anterioară
(function restorePrefs() {
  const savedVol = _lsGet('tr-volume', null);
  const vv = savedVol !== null ? Math.max(0, Math.min(100, parseInt(savedVol, 10) || 0)) : +$('volume').value;
  $('volume').value = vv;
  video.volume = audio.volume = vv / 100;
  setVolumeFill(vv);
  video.muted = audio.muted = state.muted;
  $('mute-btn').textContent = state.muted ? '🔇' : '🔊';
})();

// Pre-încarcă ultimul canal în bara "now playing" (fără autoplay — blocat de browser).
// User-ul apasă ▶ ca să reia.
function restoreLastPlayed() {
  let last;
  try { last = JSON.parse(_lsGet('tr-last', 'null')); } catch (_) { last = null; }
  if (!last || !last.url) return;
  state.current = last;
  state.pendingResume = true; // nimic nu e încă încărcat în media element
  $('idle-state').classList.add('hidden');
  setNpTitle(last.name);
  setBackdrop(last.logo);
  $('np-subtitle').textContent = (last.country || '') + (last.bitrate ? ` · ${last.bitrate}kbps` : '') + ' · apasă ▶ pentru a relua';
  const npLogo = $('np-logo');
  npLogo.innerHTML = '';
  const npFb = (last.name[0] || '?').toUpperCase();
  if (last.logo && last.logo !== 'null' && last.logo !== 'N/A') {
    const img = document.createElement('img');
    img.src = last.logo; img.alt = '';
    img.onerror = () => { npLogo.textContent = npFb; };
    npLogo.appendChild(img);
  } else {
    npLogo.textContent = npFb;
  }
  $('play-btn').textContent = '▶';
}

// ============= SINCRONIZARE FAVORITE =============
let _syncEnabled = false;
async function initSync() {
  try {
    const r = await fetch('/api/sync?status=1', { cache: 'no-store' });
    _syncEnabled = r.ok && !!(await r.json()).enabled;
  } catch (_) { _syncEnabled = false; }
  updateSyncButton();
}
function updateSyncButton() {
  $('sync-open').classList.toggle('hidden', !(_syncEnabled && state.mode === 'fav'));
  // Digi Online: doar în aplicația Android, în modul TV
  let canDigi = false;
  try { canDigi = !!(window.AndroidBridge && typeof window.AndroidBridge.openPartnerApp === 'function'); } catch (_) {}
  $('digi-open').classList.toggle('hidden', !(canDigi && state.mode === 'tv'));
}
$('digi-open').addEventListener('click', () => {
  try { window.AndroidBridge.openPartnerApp('ro.rcsrds.digionline'); } catch (_) {}
});
$('sync-open').addEventListener('click', () => {
  $('sync-code').textContent = '';
  $('sync-input').value = '';
  $('sync-dialog').classList.add('open');
  if (_IS_TV_DEVICE) setTimeout(() => $('sync-input').focus(), 100);
});
$('sync-close').addEventListener('click', () => $('sync-dialog').classList.remove('open'));
$('sync-export').addEventListener('click', async () => {
  const n = state.favorites.tv.length + state.favorites.radio.length;
  if (!n) { toast('Nu ai favorite de sincronizat'); return; }
  getFavoriteList(); // completează datele favoritelor vechi
  $('sync-code').textContent = '…';
  try {
    const r = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorites: state.favorites, favItems: state.favItems }) });
    const j = await r.json();
    if (!r.ok || !j.code) throw new Error(j.error || 'eroare');
    $('sync-code').textContent = j.code;
    toast(`Cod generat: ${j.code} — introdu-l pe celălalt dispozitiv`);
  } catch (e) { $('sync-code').textContent = ''; toast('Nu s-a putut genera codul: ' + e.message); }
});
$('sync-import').addEventListener('click', async () => {
  const code = $('sync-input').value.trim().toUpperCase();
  if (code.length !== 6) { toast('Codul are 6 caractere'); return; }
  try {
    const r = await fetch('/api/sync?code=' + encodeURIComponent(code), { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'eroare');
    let added = 0;
    for (const t of ['tv', 'radio']) {
      for (const id of j.favorites[t] || []) {
        if (!state.favorites[t].includes(id)) { state.favorites[t].push(id); added++; }
        if (j.favItems[t] && j.favItems[t][id]) state.favItems[t][id] = j.favItems[t][id];
      }
    }
    _lsSet('broadcast-favs', state.favorites);
    _lsSet('broadcast-fav-items', state.favItems);
    $('sync-dialog').classList.remove('open');
    toast(`✓ ${added} favorite noi importate`);
    if (state.mode === 'fav') switchMode('fav');
  } catch (e) { toast('Import eșuat: ' + e.message); }
});

// ============= ACTUALIZARE APK =============
// Doar în aplicația Android: compară versiunea instalată cu /version.json la fiecare pornire.
async function checkAppUpdate(force) {
  let cur;
  try {
    if (!window.AndroidBridge || typeof window.AndroidBridge.appVersionCode !== 'function') return;
    cur = window.AndroidBridge.appVersionCode();
  } catch (_) { return; }
  // Verificăm la fiecare pornire (version.json are ~250 de octeți); „Mai târziu"
  // ascunde doar versiunea respectivă.
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const v = await res.json();
    _lsSet('tr-update-check', String(Date.now()));
    if (!v || !(v.versionCode > cur) || !v.apkUrl) return;
    if (!force && _lsGet('tr-update-skip', '') === String(v.versionCode)) return; // „Mai târziu" pt. versiunea asta
    $('update-text').textContent =
      `TMedia ${v.versionName} este disponibilă (ai ${window.AndroidBridge.appVersionName()}).` +
      (v.notes ? ` ${v.notes}` : '') + ' Favoritele și setările se păstrează.';
    $('update-now').onclick = () => {
      $('update-dialog').classList.remove('open');
      try { window.AndroidBridge.downloadUpdate(v.apkUrl); } catch (_) {}
    };
    $('update-later').onclick = () => {
      _lsSet('tr-update-skip', String(v.versionCode));
      $('update-dialog').classList.remove('open');
    };
    $('update-dialog').classList.add('open');
    if (_IS_TV_DEVICE) setTimeout(() => $('update-now').focus(), 100);
  } catch (_) { /* fără internet / fișier lipsă — încercăm mâine */ }
}

// ============= INIT =============
(async () => {
  try {
    $('filter-select').innerHTML = TV_COUNTRIES
      .map(c => `<option value="${c.code}" ${c.code === state.currentTvCountry ? 'selected' : ''}>${c.name}</option>`)
      .join('');

    renderSkeleton();
    restoreLastPlayed();

    // Starea inițială a controalelor TV
    $('only-working-chk').checked = state.tvOnlyWorking;
    $('tv-health-row').classList.toggle('hidden', NativePlayer.available()); // modul implicit e TV

    // Pe TV nu focusăm căutarea: telecomanda ar rămâne „blocată" în input
    if (!_isTv()) $('search-input').focus();

    await loadTV(state.currentTvCountry);
    applyFilter();
    kickTvHealthCheck();

    // Reținem ultimul mod folosit (TV rămâne default; playlist necesită date, îl sărim)
    const savedMode = _lsGet('tr-mode', 'tv');
    if (savedMode && savedMode !== 'tv' && savedMode !== 'playlist') {
      switchMode(savedMode);
    }

    // Încercăm focus pe primul element din listă
    setTimeout(() => {
      const first = document.querySelector('.channel');
      if (first) first.focus();
    }, 1000);

    loadRadio(state.currentRadioCountry);
    setTimeout(() => checkAppUpdate(false), 4000);
    loadEpg();
    initSync();
    updateSyncButton();
  } catch (e) {
    console.error("Init error:", e);
    applyFilter();
  }
})();
