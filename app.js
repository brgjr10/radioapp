/* OpenMHz Activity Monitor
 * A better way to browse a system: see the most active talkgroups, spot the
 * ones that have gone quiet, and mute the ones you don't want to hear.
 *
 * The browser does NOT talk to OpenMHz. A unified backend running on the host
 * (serve.js -> host-backend.js) makes every API call — talkgroups, history and
 * the live Socket.IO feed — and relays the results to every connected client
 * over the host's own Socket.IO server. Audio is streamed through the host's
 * same-origin /proxy so devices on slow links only pull from the (fast) host
 * and Web Audio (EQ) can still read the samples.
 */

'use strict';

// ---------- config / state ----------
// The host runs the unified backend and is the ONLY thing that talks to
// OpenMHz. The client connects to the host over Socket.IO and receives the
// talkgroup list, history, and live calls pushed from the host. apiBase and
// system are supplied by the host (see the `snapshot` event) — the client
// never calls OpenMHz directly. Audio is always streamed through the host's
// same-origin /proxy endpoint.
let apiBase = 'https://api.openmhz.com';
let system = 'marcs_sc';

const talkgroups = {};        // num(String) -> tg object
const feed = [];              // recent live calls (newest first)
const playedIds = new Set();  // _ids of calls already auto-played (avoid replays)
const liveNow = new Set();    // talkgroup nums with a call currently buffering/playing

let socket = null;
let connected = false;
let autoplay = true;
let currentCall = null;
let playing = false;
let renderTimer = null;
let historyCursor = null;
let historyPages = 0;
const MAX_FEED = 200;

let eqOn = true;              // auto-equalize playback
let audioCtx = null;          // Web Audio context for EQ
let eqGraph = null;           // { src, hp, lp, peak, comp, gain }
let eqAudio = null;           // dedicated element routed through Web Audio (EQ)
let activeAudio = null;       // element currently playing (set once `audio` exists)
let eqRouting = false;        // current call is playing via the EQ proxy
let eqFallBack = false;       // already fell back to direct playback this call
let firstGesture = false;     // set on first user interaction (autoplay policy)
let currentBlobUrl = null;    // blob: URL of the last proxied/decoded call
let currentAlt = null;         // alternate audio URL to try if primary fails

const MAX_TIMES = 10000;       // cap timestamps kept per talkgroup
const HISTORY_PAGES = 100;     // safety limit for history pagination
const WINDOWS = { h1: 3600e3, h6: 21600e3, h24: 86400e3 };
const IDLE_MS = WINDOWS.h24;
const DORMANT_MS = 7 * WINDOWS.h24;
const INITIAL_VOLUME = 1.0;

const CATEGORIES = [
  { id: 'police', label: 'Police', description: 'Police', color: '#2f81f7', blacklist: ['cvsr','cn','rngr','metroparks','park','fire','jail','South Summit Fire COM 1','ss com1'], keywords: ['xecomm14','post98','post98','medina1','tac 1','police','patrol','enforcement', 'mac', 'pdisp','road','trooper','highway','pd','so','turnpike','secc'] },
  { id: 'jail', label: 'Jail', description: 'Jail', color: '#a371f7', blacklist: [], keywords: ['jail','detention','prison','correction'] },
  { id: 'rta', label: 'Transportation', description: 'Transportation', color: '#3fb950', blacklist: [], keywords: ['rta','sarta'] },
  { id: 'fire', label: 'Fire', description: 'Fire', color: '#f85149', blacklist: [], keywords: ['fire','fd','f/e','f/e-1','fd1','fdpage','Fire Paging','ss com1','South Summit Fire COM 1'] },
  { id: 'medical', label: 'Medical', description: 'Medical', color: '#ec6cb9', blacklist: [], keywords: ['medical','hospital','ems','lf','medevac','LifeFlight','cc','Cleveland Metro LifeFlight Dispatch'] },
  { id: 'Parks', label: 'Parks', description: 'Parks', color: '#d2228f', blacklist: [], keywords: ['cn','rngr','metroparks','park'] },
];

const CATEGORY_OTHER = 'other';
const CATEGORY_OTHER_COLOR = '#8b97a7';

// ---------- map config (desktop only) ----------
// OpenMHz calls carry NO GPS — a call only knows its talkgroup. So each call is
// plotted at its TALKGROUP's location. Put exact agency coordinates here, keyed
// by talkgroup number, for accurate pins. Any talkgroup not listed is scattered
// deterministically around SYSTEM_CENTER (a stable spot per talkgroup) so the
// map is still useful before you fill this in.
const SYSTEM_CENTER = [41.0814, -81.519];  // Akron / Summit County, OH (marcs_sc)
const DEFAULT_ZOOM = 10;
const MAP_SPREAD = 0.16;        // ~degrees: jitter radius (retained for jitterLL)
const MAX_MAP_MARKERS = 60;     // recent call dots kept on the map
const MAP_FADE_MS = 120000;     // dots fade toward min opacity over this long
const DRIVING_RADIUS_MI = 25;   // mobile driving mode: only listen within this radius

const TG_LOCATIONS = {
  // Example — uncomment / add real agency coordinates as you learn them:
  // '2001': { lat: 41.0498, lng: -81.4443, label: 'Akron PD Dispatch' },
  // '5150': { lat: 41.1387, lng: -81.8632, label: 'Medina SO' },
};

// Manual aliases for abbreviations in talkgroup titles that automatic matching
// can't derive (e.g. "mun" is not a prefix of "Monroe"). Key = token as it
// appears in the title (lowercase, no punctuation); value = an Ohio place name
// from ohio-cities.js. Add more as you spot them.
const TG_ALIASES = {
  cuyfalls: 'Cuyahoga Falls',
  munfalls: 'Munroe Falls',
};

// Ohio reuses place names all over the state, so a matched name sometimes points
// at the wrong (usually larger/more famous) town. Override coordinates here to
// pin an ambiguous or missing name to the instance relevant to your region.
// Key = normalized place name (lowercase); value = { la, lo, label? }.
// NOTE: no "springfield" override — marcs_sc is statewide, so most "Springfield"
// talkgroups really are the Clark County (Dayton-area) one and are correctly
// filtered out by the NE Ohio geofence. Add overrides only for genuine NE places.
const PLACE_OVERRIDES = {
};

function categoryColor(id) {
  if (!id) return CATEGORY_OTHER_COLOR;
  if (id === CATEGORY_OTHER) return CATEGORY_OTHER_COLOR;
  const cat = CATEGORIES.find(c => c.id === id);
  return cat ? cat.color : CATEGORY_OTHER_COLOR;
}

// Convert a #rrggbb color to an rgba() string with the given alpha.
function rgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return 'rgba(139,151,167,' + alpha + ')';
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function categoryBadge(id) {
  if (!id) return null;
  const color = categoryColor(id);
  const b = el('span', 'tg-badge badge-category', categoryLabel(id));
  b.style.color = color;
  b.style.background = rgba(color, 0.15);
  b.title = 'Category: ' + categoryLabel(id);
  return b;
}

let activeCategory = 'police'; // default filter
let categoryFilters = {};

function guessCategory(tg) {
  const hay = (tg.alpha + ' ' + tg.description).toLowerCase();
  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    // Skip this category if any blacklisted keyword appears in the name/desc.
    if (cat.blacklist && cat.blacklist.length) {
      let blocked = false;
      for (let b = 0; b < cat.blacklist.length; b++) {
        if (hay.includes(cat.blacklist[b])) { blocked = true; break; }
      }
      if (blocked) continue;
    }
    for (let k = 0; k < cat.keywords.length; k++) {
      if (hay.includes(cat.keywords[k])) return cat.id;
    }
  }
  return CATEGORY_OTHER;
}

function categoryLabel(id) {
  if (!id) return '';
  if (id === CATEGORY_OTHER) return 'Other';
  const cat = CATEGORIES.find(c => c.id === id);
  return cat ? cat.label : id;
}

function categoryIdFromFilterValue(value) {
  if (!value || value === CATEGORY_OTHER) return value;
  const cat = CATEGORIES.find(c => c.description === value);
  return cat ? cat.id : value;
}

// Audio is streamed through the local same-origin /proxy so Web Audio (EQ)
// can read the samples even when OpenMHz blocks cross-origin requests.
let isLocalApi = true;
let focusMode = true;              // when true, show only active + playing calls

// ---------- map state (desktop only; null on the mobile page) ----------
let map = null;                    // Leaflet map instance
let mapFollow = true;              // pan to the newest call
const mapMarkers = [];             // recent call dots (oldest first)

let drivingMode = false;           // mobile-only: filter calls by proximity
let userLat = null;                 // cached user latitude
let userLng = null;                 // cached user longitude

const audio = document.getElementById('audio');
activeAudio = audio;

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

// Route audio through the local same-origin proxy so Web Audio (EQ) can read
// the samples even when the audio host blocks cross-origin requests. See the
// /proxy handler in serve.js.
function proxyUrl(u) {
  return '/proxy?url=' + encodeURIComponent(u);
}

function relTime(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 0) return 'just now';
  const s = Math.floor(d / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
  const days = Math.floor(h / 24);
  return days + 'd ' + (h % 24) + 'h ago';
}

function fmtClock(ms) {
  const t = new Date(ms);
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtFreq(f) {
  if (!f) return '—';
  return (f / 1e6).toFixed(4) + ' MHz';
}

// Build the playable audio URL. Newer uploads carry a full `url`; older ones
// only have `filename` / `path`+`name`. We also accept common aliases from
// alternate API versions (audio_url, audio, media_url, objectKey) and prefer
// `srcList` when present because it carries the exact source(s) recorded.
function maybeProxy(u) {
  if (!u) return u;
  return isLocalApi ? '/proxy?url=' + encodeURIComponent(u) : u;
}

function audioUrl(call) {
  if (!call) return null;

  const candidates = [];

  if (Array.isArray(call.srcList)) {
    for (let i = 0; i < call.srcList.length; i++) {
      const raw = typeof call.srcList[i] === 'string' ? call.srcList[i] : (call.srcList[i].src || call.srcList[i].url || call.srcList[i].audio || '');
      if (!raw) continue;
      if (/^https?:\/\//.test(raw) || /^\//.test(raw)) {
        candidates.push(raw);
      }
    }
  }

  if (!candidates.length) {
    const u = directUrl(call);
    if (u && (/^https?:\/\//.test(u) || /^\//.test(u))) candidates.push(u);
  }

  if (!candidates.length) {
    const fn = audioFile(call);
    if (fn) candidates.push(apiBase + '/call-audio/' + callSystem(call) + '/' + fn.replace(/^\/+/, ''));
  }

  if (!candidates.length && call._id) {
    candidates.push(apiBase + '/call-audio/' + callSystem(call) + '/' + call._id);
  }

  if (!candidates.length) {
    console.warn('[audioUrl] no audio source fields on call', call._id || call);
    return null;
  }

  return maybeProxy(candidates[0]);
}

function altAudioUrl(call) {
  if (!call) return null;
  // If srcList has multiple entries, return the next one as alternate.
  const srcs = (call.srcList || []);
  for (let i = 0; i < srcs.length; i++) {
    const s = typeof srcs[i] === 'string' ? srcs[i] : (srcs[i].src || srcs[i].url || srcs[i].audio || '');
    if (s && i + 1 < srcs.length) {
      const n = typeof srcs[i+1] === 'string' ? srcs[i+1] : (srcs[i+1].src || srcs[i+1].url || srcs[i+1].audio || '');
      if (n) return maybeProxy(n);
    }
  }

  const u = directUrl(call);
  if (u) return null;

  const fn = audioFile(call);
  if (fn) {
    const p = apiBase + '/call-audio/' + callSystem(call) + '/' + fn.replace(/^\/+/, '');
    return maybeProxy(p);
  }

  return null;
}

function directUrl(call) {
  return call.url || call.audio_url || call.audioUrl || call.audio || call.media_url || call.media || null;
}

function callSystem(call) {
  return call.shortName || call.system || system;
}

function audioFile(call) {
  return call.filename || call.name || (call.path && call.name ? call.path + call.name : '') || (call.objectKey ? call.objectKey.split('/').pop() : '') || '';
}

// The API returns `time` as an ISO *string*, not epoch ms. Normalize it once
// so comparisons, window counts and the history cursor are all correct.
function callTime(call) {
  const t = call.time;
  let n = (
    typeof t === 'number' ? t
    : new Date(
        (typeof t === 'string' && t.length && t[0] === '"')
          ? JSON.parse(t)
          : t
      ).getTime()
  );
  return isNaN(n) ? 0 : n;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function setBanner(msg, isErr) {
  const b = $('banner');
  if (!msg) { b.classList.add('hidden'); return; }
  b.textContent = msg;
  b.classList.remove('hidden');
  b.classList.toggle('err', !!isErr);
}

function saveEnabled() {
  const map = {};
  for (const num in talkgroups) map[num] = talkgroups[num].enabled;
  localStorage.setItem('om_enabled_' + system, JSON.stringify(map));
}

function loadEnabled() {
  try { return JSON.parse(localStorage.getItem('om_enabled_' + system) || '{}'); }
  catch { return {}; }
}

function saveCache() {
  // persist last-seen + total so staleness survives reloads
  const cache = {};
  for (const num in talkgroups) {
    const t = talkgroups[num];
    cache[num] = { lastSeen: t.lastSeen, total: t.total };
  }
  localStorage.setItem('om_cache_' + system, JSON.stringify(cache));
}

function loadCache() {
  try { return JSON.parse(localStorage.getItem('om_cache_' + system) || '{}'); }
  catch { return {}; }
}

function saveTgConfig() {
  const configs = [];
  for (const num in talkgroups) {
    const tg = talkgroups[num];
    configs.push({ num, alpha: tg.alpha, description: tg.description });
  }
  localStorage.setItem('om_tg_config_' + system, JSON.stringify(configs));
}

function loadTgConfig() {
  try { return JSON.parse(localStorage.getItem('om_tg_config_' + system) || '[]'); }
  catch { return []; }
}

// ---------- talkgroup model ----------
function newTG(num, data) {
  const cache = loadCache();
  const c = cache[num] || {};
  const tg = {
    num,
    alpha: data ? data.alpha : ('TG ' + num),
    description: data ? data.description : '',
    enabled: enabledState[num] !== undefined ? enabledState[num] : true,
    times: [],
    lastSeen: c.lastSeen || null,
    total: c.total || 0,
  };
  tg.category = guessCategory(tg);
  return tg;
}

function ensureTG(num, data) {
  if (!talkgroups[num]) talkgroups[num] = newTG(num, data);
  else if (data) {
    if (data.alpha) talkgroups[num].alpha = data.alpha;
    if (data.description) talkgroups[num].description = data.description;
    talkgroups[num].category = guessCategory(talkgroups[num]);
  }
  return talkgroups[num];
}

function countsFor(tg) {
  const now = Date.now();
  let h1 = 0, h6 = 0, h24 = 0;
  for (let i = tg.times.length - 1; i >= 0; i--) {
    const dt = now - tg.times[i];
    if (dt > WINDOWS.h24) break;
    h24++;
    if (dt <= WINDOWS.h6) h6++;
    if (dt <= WINDOWS.h1) h1++;
  }
  return { h1, h6, h24, total: tg.total };
}

// ---------- data: talkgroups + history ----------
// The browser fetches talkgroups and history directly from OpenMHz.

// ---------- live socket ----------
// Connect directly to OpenMHz. No host backend; the browser fetches everything
// directly with CORS enabled on the OpenMHz API.
function connectSocket() {
  if (socket) { try { socket.close(); } catch {} socket = null; }

  socket = io(apiBase, { transports: ['polling', 'websocket'], reconnection: true });

  socket.on('connect', () => {
    connected = true;
    setBanner('');
    socket.emit('start', {
      shortName: system,
      filterCode: '',
      filterName: 'all',
      filterStarred: false,
      filterType: 'all',
    });
    fetchDirectTalkgroups();
    fetchDirectHistory();
  });

  socket.on('disconnect', () => { connected = false; });
  socket.on('connect_error', (e) => {
    connected = false;
    setBanner('Could not reach OpenMHz — ' + (e && e.message ? e.message : e) + '.', true);
  });

  socket.on('new message', (raw) => {
    let call; try { call = JSON.parse(raw); } catch { return; }
    if (!call || call.talkgroupNum == null) return;
    recordCall(call, true);
  });
}

// Apply the host's talkgroup name/description map into our local model.
function applyTgNames(map) {
  for (const num in map) {
    const data = map[num];
    const tg = ensureTG(num, data);
    if (data && data.alpha) tg.alpha = data.alpha;
    if (data && data.description) tg.description = data.description;
    tg.category = guessCategory(tg);
  }
  scheduleRender();
}

async function fetchDirectTalkgroups() {
  try {
    const res = await fetch(`${apiBase}/${system}/talkgroups`, { mode: 'cors' });
    if (!res.ok) throw new Error('talkgroups ' + res.status);
    const data = await res.json();
    applyTgNames(data.talkgroups || {});
  } catch (e) {
    setBanner('Could not load talkgroups — ' + e.message, true);
  }
}

async function fetchDirectHistory() {
  try {
    let cursor = null, pages = 0;
    while (pages < 100) {
      const url = cursor == null
        ? `${apiBase}/${system}/calls?filter-type=all&filter-starred=false`
        : `${apiBase}/${system}/calls/older?time=${cursor}&filter-type=all&filter-starred=false`;
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error('calls ' + res.status);
      const data = await res.json();
      const calls = data.calls || [];
      if (!calls.length) break;
      for (const c of calls) recordCall(c, false);
      cursor = callTime(calls[calls.length - 1]);
      if (Date.now() - cursor > WINDOWS.h24) break;
      pages++;
    }
  } catch (e) {
    setBanner('Could not load history — ' + e.message, true);
  }
}

// ---------- call intake ----------
function recordCall(call, isLive) {
  const num = String(call.talkgroupNum);
  const tg = ensureTG(num);
  const t = callTime(call);
  tg.times.push(t);
  if (tg.times.length > MAX_TIMES) tg.times.shift();
  tg.lastSeen = Math.max(tg.lastSeen || 0, t);
  tg.total = (tg.total || 0) + 1;

  if (isLive) {
    call._live = true;
    liveNow.add(num);
    setTimeout(() => liveNow.delete(num), 4000);
    pushFeed(call);
    addCallToMap(call);
    // Autoplay new live calls (pump() picks the next one chronologically from
    // the feed), but skip muted talkgroups so silent/control channels don't
    // eat up listening time.
    if (autoplay && tg.enabled) enqueue(call);
    scheduleRender();
    saveCacheSoon();
  } else {
    // History calls seed the feed so the Live Feed list isn't empty before the
    // first live call arrives.
    if (feed.length < MAX_FEED) feed.push(call);
    scheduleRender();
  }
}

// ---------- playback ----------
// New live calls land in `feed` (recordCall -> pushFeed). Autoplay then picks
// the next call to play straight from the feed in strict chronological order
// (oldest unplayed call first), so playback always continues from where it
// left off at the bottom of the list and never jumps to the newest call.
function enqueue(call) { pump(); }

// The earliest not-yet-played, enabled, live call currently in the feed.
function nextAutoCall() {
  let best = null, bestT = Infinity;
  for (let i = 0; i < feed.length; i++) {
    const c = feed[i];
    if (!c._live || playedIds.has(c._id)) continue;
    const num = String(c.talkgroupNum);
    const tg = talkgroups[num];
    if (!tg || !tg.enabled) continue;
    if (drivingMode && userLat != null && tgHasRealPlace(num) && !callWithinRadius(c)) continue;
    const t = callTime(c);
    if (t < bestT) { bestT = t; best = c; }
  }
  return best;
}

function pump() {
  if (playing) return;
  if (!firstGesture) return;
  // Don't hijack audio that is still actually playing (guards against the
  // `playing` flag getting out of sync with the element under heavy load).
  const el = activeAudio;
  if (el && !el.paused && !el.ended && !el.error) return;
  prunePlayed();
  const next = nextAutoCall();
  if (next) playCall(next);
}

// Drop played ids that are no longer in the feed so the set stays bounded.
function prunePlayed() {
  if (playedIds.size < 500) return;
  const inFeed = new Set(feed.map((c) => c._id));
  for (const id of playedIds) if (!inFeed.has(id)) playedIds.delete(id);
}

function setNpStatus(msg) {
  // intentionally removed UI status text
}

// Live readout of the <audio> element so we can see exactly what state it's in.
const RS = ['nothing', 'metadata', 'current', 'future', 'enough'];
const NS = ['empty', 'idle', 'loading', 'no-source'];
function updateNpStatusLive() {
  if (!currentCall) return;
  const el = activeAudio;
  if (el.error) {
    setNpStatus('Audio load error: code ' + el.error.code + ' (' + el.error.message + ')');
    return;
  }
  const u = audioUrl(currentCall);
  const txt = 'URL: ' + (u && u.length > 64 ? u.slice(0, 61) + '…' : u) +
    '\nrs=' + (RS[el.readyState] || el.readyState) +
    ' ns=' + (NS[el.networkState] || el.networkState) +
    ' paused=' + el.paused +
    ' t=' + el.currentTime.toFixed(1) + 's' +
    ' vol=' + el.volume;
  setNpStatus(txt);
}

// Fetch a call through the same-origin /proxy, decode it, and measure its peak
// amplitude. removed silence analysis feature

async function playCall(call) {
  const u = audioUrl(call);
  if (!call || !u) { setNpStatus('No audio URL available for this call.'); return; }
  currentCall = call;
  playedIds.add(call._id);
  playing = true;
  currentAlt = altAudioUrl(call);
  eqRouting = false;

  const el = eqOn ? getEqAudio() : audio;
  activeAudio = el;
  eqRouting = eqOn;

  let src = u;

  if (eqOn) {
    el.crossOrigin = 'anonymous';
    buildGraph();
    // If analysis produced a decoded blob: URL, play that (same-origin, so
    // Web Audio can read it) instead of re-fetching through the proxy.
    if (!currentBlobUrl) src = proxyUrl(u);
  } else {
    el.removeAttribute('crossorigin');
  }

  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  el.src = src;
  document.body.classList.add('m-playing');
  renderNowPlaying(call);
  highlightFeed(call._id);
  addCallToMap(call, true);   // always show the playing call, even if muted/filtered
  fadeMap();                  // apply the "playing" highlight immediately

  const short = (eqRouting ? '(EQ) ' : '') + (src.length > 70 ? src.slice(0, 67) + '…' : src);
  setNpStatus('URL: ' + short);
  console.log('[play]', u, 'routingEQ=' + eqRouting);

  const p = el.play();
  if (p && p.catch) {
    p.catch((err) => {
      setNpStatus('play() blocked: ' + (err && err.message ? err.message : err) + ' — click again or enable Autoplay.');
      playing = false; document.body.classList.remove('m-playing'); pump();
    });
  }
  if (focusMode) renderFeed();
}

// The EQ path uses its own <audio> element so the main element is never
// captured by a MediaElementSource. Both elements share the same handlers.
function attachAudioHandlers(el) {
  el.addEventListener('ended', () => { playing = false; currentCall = null; document.body.classList.remove('m-playing'); if (focusMode) renderFeed(); pump(); });
  el.addEventListener('pause', () => { document.body.classList.remove('m-playing'); });
  el.addEventListener('play', () => { document.body.classList.add('m-playing'); });
  el.addEventListener('error', () => onAudioError(el));
}

function onAudioError(el) {
  // EQ-via-proxy failed (host unreachable, or a Cloudflare challenge on the
  // file). Fall back to the main element, which is never captured by Web
  // Audio, so direct playback works without EQ (no CORS needed to play).
  if (el === eqAudio && eqRouting && !eqFallBack) {
    eqFallBack = true;
    eqRouting = false;
    eqOn = false;
    $('eq').checked = false;
    setBanner('EQ unavailable for this call — playing directly without EQ.', true);
    activeAudio = audio;
    audio.removeAttribute('crossorigin');
    const direct = currentCall ? audioUrl(currentCall) : '';
    if (direct) { audio.src = direct; audio.play().catch(() => {}); }
    return;
  }

  // If the primary URL failed, automatically try the alternate form once.
  if (currentAlt) {
    const next = currentAlt;
    currentAlt = null;
    setNpStatus('Primary URL failed — trying alternate: ' + (next.length > 70 ? next.slice(0, 67) + '…' : next));
    el.src = next;
    el.play().catch(() => {});
    return;
  }
  const err = el.error;
  const code = err ? 'code ' + err.code + ' (' + err.message + ')' : 'unknown';
  console.warn('Audio failed to load:', el.currentSrc || el.src, code);
  setNpStatus('Audio load error: ' + code);
  setBanner('Audio failed to load for a call (' + code + '). See console.', true);
  playing = false; pump();
}

attachAudioHandlers(audio);

// ---------- audio equalization (Web Audio) ----------
// Shapes each call for intelligibility: a speech band-pass (~300Hz–3.4kHz),
// a gentle mid boost, and a compressor to even out the wildly inconsistent
// recording levels typical of scanner audio. The audio is routed through the
// local same-origin /proxy (see proxyUrl) so Web Audio can read the samples
// even when the host blocks cross-origin requests; if the proxy can't fetch a
// file the app falls back to direct playback (no EQ). A dedicated, separate
// <audio> element is used for EQ so the main element is never captured.
function getEqAudio() {
  if (eqAudio) return eqAudio;
  eqAudio = new Audio();
  eqAudio.preload = 'none';
  eqAudio.crossOrigin = 'anonymous'; // always fed the same-origin proxy stream
  attachAudioHandlers(eqAudio);
  return eqAudio;
}

function buildGraph() {
  if (eqGraph) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const el = getEqAudio();
  el.crossOrigin = 'anonymous';
  audioCtx = new AC();
  const src = audioCtx.createMediaElementSource(el);
  const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 280;
  const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;
  const peak = audioCtx.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 1500; peak.gain.value = 4; peak.Q.value = 0.8;
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -24; comp.knee.value = 14; comp.ratio.value = 3.5; comp.attack.value = 0.005; comp.release.value = 0.2;
  const gain = audioCtx.createGain(); gain.gain.value = 1.0;
  src.connect(hp); hp.connect(lp); lp.connect(peak); peak.connect(comp); comp.connect(gain); gain.connect(audioCtx.destination);
  eqGraph = { src, hp, lp, peak, comp, gain };
  applyEq();
}

function applyEq() {
  if (!eqGraph) return;
  const on = eqOn;
  eqGraph.hp.frequency.value = on ? 280 : 20;
  eqGraph.lp.frequency.value = on ? 3400 : 20000;
  eqGraph.peak.gain.value = on ? 4 : 0;
  eqGraph.comp.ratio.value = on ? 3.5 : 1;
  eqGraph.comp.threshold.value = on ? -24 : -100;
}

// ---------- feed ----------
function pushFeed(call) {
  feed.unshift(call);
  // Evict the oldest calls, but never the one currently playing nor calls that
  // are still pending playback. Otherwise a busy call can be pushed off the
  // bottom of the list and playback loses its place.
  while (feed.length > MAX_FEED) {
    const last = feed[feed.length - 1];
    const protectedCall = (currentCall && last._id === currentCall._id) ||
      (last._live && !playedIds.has(last._id));
    if (protectedCall) break;
    feed.pop();
  }
  renderFeed();
}

function highlightFeed(id) {
  document.querySelectorAll('.feed-row').forEach((r) => {
    r.classList.toggle('playing', r.dataset.id === id);
  });
}

// ---------- rendering (throttled) ----------
function scheduleRender() { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; renderList(); }, 400); }

function renderList() {
  const wrap = $('tgList');
  const prevScroll = wrap.scrollTop;
  wrap.innerHTML = '';

  const search = $('search').value.trim().toLowerCase();
  const sort = $('sort').value;
  const enabledOnly = $('enabledOnly').checked;
  const categoryFilterValue = categoryFilters.category ? categoryFilters.category.value : '';
  const categoryFilter = categoryIdFromFilterValue(categoryFilterValue);

  let rows = Object.values(talkgroups);
  const now = Date.now();

  rows = rows.filter((tg) => {
    if (search) {
      const hay = (tg.alpha + ' ' + tg.description + ' ' + tg.num).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (enabledOnly && !tg.enabled) return false;
    if (sort !== 'idle' && (now - (tg.lastSeen || 0)) > IDLE_MS) return false;
    if (categoryFilter && tg.category !== categoryFilter && !(categoryFilter === CATEGORY_OTHER && !tg.category)) return false;
    return true;
  });

  const maxH24 = rows.reduce((m, tg) => Math.max(m, countsFor(tg).h24), 1);

  rows.sort((a, b) => {
    if (sort === 'name') return a.alpha.localeCompare(b.alpha);
    if (sort === 'num') return Number(a.num) - Number(b.num);
    if (sort === 'idle') return (a.lastSeen || 0) - (b.lastSeen || 0);
    // activity
    const ca = countsFor(a), cb = countsFor(b);
    if (cb.h24 !== ca.h24) return cb.h24 - ca.h24;
    if (cb.h6 !== ca.h6) return cb.h6 - ca.h6;
    if (cb.h1 !== ca.h1) return cb.h1 - ca.h1;
    return cb.total - ca.total;
  });

  if (rows.length === 0) {
    wrap.appendChild(el('div', 'empty', 'No talkgroups match your filters.'));
    return;
  }

  for (const tg of rows) {
    wrap.appendChild(buildRow(tg, now, maxH24));
  }
  wrap.scrollTop = prevScroll;
}

function buildRow(tg, now, maxH24) {
  const c = countsFor(tg);
  const dt = now - (tg.lastSeen || 0);
  const row = el('div', 'tg-row' + (tg.enabled ? '' : ' disabled'));
  row.style.borderLeft = '3px solid ' + categoryColor(tg.category);

  // toggle
  const toggle = el('input', 'tg-toggle');
  toggle.type = 'checkbox';
  toggle.checked = tg.enabled;
  toggle.title = tg.enabled ? 'Listening — click to mute' : 'Muted — click to listen';
  toggle.addEventListener('change', () => {
    tg.enabled = toggle.checked;
    row.classList.toggle('disabled', !tg.enabled);
    saveEnabled();
    renderList();
    refreshMapVisibility();
  });
  row.appendChild(toggle);

  // main
  const main = el('div', 'tg-main');
  const name = el('div', 'tg-name');
  const displayName = tg.description || tg.alpha || ('TG ' + tg.num);
  name.appendChild(document.createTextNode(displayName));
  name.appendChild(el('span', 'tg-num', '#' + tg.num));
  let badge = null;
  if (dt > DORMANT_MS) badge = el('span', 'tg-badge badge-dormant', 'dormant');
  else if (dt > IDLE_MS) badge = el('span', 'tg-badge badge-idle', 'idle');
  else if (c.h24 >= Math.max(5, maxH24 * 0.4)) badge = el('span', 'tg-badge badge-hot', 'hot');
  else if (c.h24 > 0) badge = el('span', 'tg-badge badge-warm', 'active');
  if (badge) name.appendChild(badge);
  const catBadge = categoryBadge(tg.category);
  if (catBadge) name.appendChild(catBadge);
  main.appendChild(name);
  if (tg.alpha && tg.alpha !== displayName) main.appendChild(el('div', 'tg-desc', tg.alpha));

  // bar
  const bar = el('div', 'tg-bar');
  const fill = el('i');
  const pct = Math.round((c.h24 / maxH24) * 100);
  fill.style.width = Math.max(pct, c.h24 > 0 ? 4 : 0) + '%';
  fill.style.background = c.h24 >= maxH24 * 0.5 ? '#f85149'
    : c.h24 >= maxH24 * 0.2 ? '#d29922' : '#2f81f7';
  bar.appendChild(fill);
  main.appendChild(bar);
  row.appendChild(main);

  // meta + actions
  const meta = el('div', 'tg-meta');
  const count = el('div', 'tg-count');
  count.appendChild(document.createTextNode(String(c.h24) + ' '));
  count.appendChild(el('small', null, 'calls/24h'));
  meta.appendChild(count);
  meta.appendChild(el('div', 'tg-seen', (dt > IDLE_MS ? '' : 'seen ') + relTime(tg.lastSeen)));

  const actions = el('div', 'tg-actions');
  const preview = el('button', 'mini', '▶ latest');
  preview.title = 'Play the most recent call for this talkgroup';
  preview.addEventListener('click', (e) => { e.stopPropagation(); playLatest(tg.num); });
  actions.appendChild(preview);
  meta.appendChild(actions);
  row.appendChild(meta);

  return row;
}

function playLatest(num) {
  // find latest call for this talkgroup from feed, else ignore
  let latest = null;
  for (const c of feed) {
    if (String(c.talkgroupNum) === num) { latest = c; break; }
  }
  if (latest) playCall(latest);
}

// ---------- now playing ----------
function renderNowPlaying(call) {
  const box = $('nowPlaying');
  box.innerHTML = '';
  if (!call) { box.appendChild(el('div', 'np-empty', 'Nothing playing')); return; }
  const num = String(call.talkgroupNum);
  const tg = talkgroups[num];
  const displayName = tg && tg.description ? tg.description : (tg && tg.alpha ? tg.alpha : 'TG ' + num);
  const name = el('div', 'np-name', displayName + '  #' + num);
  const catB = tg ? categoryBadge(tg.category) : null;
  if (catB) name.appendChild(catB);
  box.appendChild(name);
  if (tg && tg.alpha && tg.alpha !== displayName) box.appendChild(el('div', 'np-sub', tg.alpha));
  const meta = el('div', 'np-meta');
  const mTime = el('span'); mTime.appendChild(document.createTextNode('time ')); mTime.appendChild(el('b', null, fmtClock(call.time)));
  const mFreq = el('span'); mFreq.appendChild(document.createTextNode('freq ')); mFreq.appendChild(el('b', null, fmtFreq(call.freq)));
  meta.appendChild(mTime);
  meta.appendChild(mFreq);
  const srcs = (call.srcList || []).map((s) => (s.src != null ? s.src : s)).join(', ');
  if (srcs) { const m = el('span'); m.appendChild(document.createTextNode('units ')); m.appendChild(el('b', null, srcs)); meta.appendChild(m); }
  if (call.len != null) { const m = el('span'); m.appendChild(document.createTextNode('len ')); m.appendChild(el('b', null, call.len + 's')); meta.appendChild(m); }
  box.appendChild(meta);

  const ctrls = el('div', 'np-controls');
  const stopBtn = el('button', 'btn primary', 'Stop');
  stopBtn.title = 'Stop playback';
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeAudio) { activeAudio.pause(); activeAudio.currentTime = 0; }
    playing = false;
    currentCall = null;
    document.body.classList.remove('m-playing');
    renderNowPlaying(null);
    renderFeed();
    pump();
  });
  ctrls.appendChild(stopBtn);
  box.appendChild(ctrls);
}

// ---------- feed render ----------
function renderFeed() {
  const wrap = $('feed');
  if (wrap._needsBuild) return;
  wrap._needsBuild = true;
  requestAnimationFrame(() => {
    wrap._needsBuild = false;
    buildFeed(wrap);
  });
}

function buildFeed(wrap) {
  let items = feed;
  if (focusMode) {
    items = feed.filter((c) => {
      const n = String(c.talkgroupNum);
      const tg = talkgroups[n];
      return tg && tg.enabled;
    });
  }
  if (drivingMode && userLat != null) {
    items = items.filter((c) => {
      const n = String(c.talkgroupNum);
      if (!tgHasRealPlace(n)) return true;
      return callWithinRadius(c);
    });
  }

  wrap.innerHTML = '';
  if (items.length === 0) { wrap.appendChild(el('div', 'empty', focusMode ? 'No active calls' : 'Waiting for calls…')); return; }
  const slice = items.slice(0, 80);
  for (const c of slice) {
    const num = String(c.talkgroupNum);
    const tg = talkgroups[num];
    const displayName = tg && tg.description ? tg.description : (tg && tg.alpha ? tg.alpha : 'TG ' + num);
    const row = el('div', 'feed-row');
    row.dataset.id = c._id;
    if (currentCall && currentCall._id === c._id) row.classList.add('playing');
    const left = el('div');
    const feedTg = el('div', 'feed-tg', displayName + '  #' + num);
    const catB = tg ? categoryBadge(tg.category) : null;
    if (catB) feedTg.appendChild(catB);
    if (drivingMode && userLat != null && tgHasRealPlace(num)) {
      const d = tgDistMi(num);
      if (d != null) {
        const dEl = el('span', 'feed-dist', Math.round(d) + ' mi');
        dEl.style.color = d < 10 ? '#3fb950' : d < 20 ? '#d29922' : '#f85149';
        feedTg.appendChild(dEl);
      }
    }
    left.appendChild(feedTg);
    left.appendChild(el('div', 'feed-sub', (tg && tg.alpha && tg.alpha !== displayName ? tg.alpha + ' · ' : '') + fmtFreq(c.freq)));
    const right = el('div');
    right.style.textAlign = 'right';
    right.appendChild(el('div', 'feed-time', fmtClock(c.time)));
    right.appendChild(el('div', 'feed-dur', (c.len != null ? c.len + 's' : '')));
    row.appendChild(left);
    row.appendChild(right);
    row.addEventListener('click', () => playCall(c));
    wrap.appendChild(row);
  }
}

// ---------- map (desktop only) ----------
// Leaflet is loaded from a CDN on index.html but NOT on the mobile page, so
// every map entry point is guarded by `map` / `window.L` and simply no-ops when
// the map isn't present. Calls have no coordinates, so each call is drawn at its
// talkgroup's location (see tgLatLng / TG_LOCATIONS).
function initMap() {
  const elMap = document.getElementById('map');
  if (!elMap || typeof L === 'undefined' || map) return;

  map = L.map(elMap, { zoomControl: true, attributionControl: true, preferCanvas: true })
    .setView(SYSTEM_CENTER, DEFAULT_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const follow = $('mapFollow');
  if (follow) {
    mapFollow = follow.checked;
    follow.addEventListener('change', () => { mapFollow = follow.checked; });
  }
  const clear = $('mapClear');
  if (clear) clear.addEventListener('click', clearMap);

  // Leaflet measures its container on creation; nudge it once layout settles.
  setTimeout(() => { try { map.invalidateSize(); } catch {} }, 200);
}

// FNV-1a hash → stable pseudo-random spot per talkgroup number.
function hashNum(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---- Ohio place matching ----
// ohio-cities.js (desktop only) provides window.OHIO_PLACES = [{n, la, lo}] for
// every Ohio city + county centroid. We scan each talkgroup's title (alpha +
// description) for a place name and use that city's coordinates — so calls that
// have no explicit TG_LOCATIONS pin still land on the right city when the title
// names one (e.g. "Akron PD Dispatch" → Akron).
const MIN_PLACE_LEN = 4;     // ignore very short names ("Ada", "Rio") to cut noise
const CITY_JITTER = 0.008;   // ~0.8km spread so multiple TGs in one city don't stack

let _placeIndex = null;
function placeIndex() {
  if (_placeIndex) return _placeIndex;
  const src = (typeof window !== 'undefined' && window.OHIO_PLACES) || [];
  _placeIndex = src
    .map((p) => ({ n: normText(p.n), la: p.la, lo: p.lo }))
    .filter((p) => p.n.length >= MIN_PLACE_LEN)
    // Longest names first so "cuyahoga falls" wins over "falls".
    .sort((a, b) => b.n.length - a.n.length);
  return _placeIndex;
}

// name (normalized) -> coords, for resolving aliases to a real place.
let _placeByName = null;
function placeByName(name) {
  if (!_placeByName) {
    _placeByName = new Map();
    for (const p of placeIndex()) if (!_placeByName.has(p.n)) _placeByName.set(p.n, p);
  }
  return _placeByName.get(normText(name)) || null;
}

// Abbreviation matchers for multi-word places: the first word may be shortened
// to a prefix and the words run together, so "Cuyahoga Falls" also matches
// "cuyfalls" / "cuyahogafalls". (Later words must appear in full — that keeps
// false positives down; truly irregular short forms go in TG_ALIASES instead.)
let _abbrevIndex = null;
function abbrevIndex() {
  if (_abbrevIndex) return _abbrevIndex;
  _abbrevIndex = [];
  for (const p of placeIndex()) {
    const parts = p.n.split(' ');
    if (parts.length < 2 || parts[0].length < 3) continue;
    if (parts[parts.length - 1] === 'county') continue;
    const src = '^' + parts[0].slice(0, 3) + '[a-z]*' + parts.slice(1).join('') + '$';
    try { _abbrevIndex.push({ re: new RegExp(src), la: p.la, lo: p.lo, n: p.n }); } catch {}
  }
  return _abbrevIndex;
}

// Lowercase, strip punctuation to single spaces (matches both titles and names).
function normText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Apply a regional coordinate override for an ambiguous/missing place name.
function applyOverride(p) {
  if (!p) return p;
  const o = PLACE_OVERRIDES[p.n];
  if (o) return { n: p.n, la: o.la, lo: o.lo };
  return p;
}

// Find an Ohio place for a title, in order of confidence:
//   1. a manual alias token (TG_ALIASES),
//   2. the longest full place name appearing as whole words,
//   3. an abbreviated multi-word place run together in one token.
function matchPlace(text) {
  const norm = normText(text);
  if (!norm) return null;
  const tokens = norm.split(' ');

  // 1. manual aliases (exact title token)
  for (let i = 0; i < tokens.length; i++) {
    const alias = TG_ALIASES[tokens[i]];
    if (alias) {
      const hit = placeByName(alias);
      if (hit) return applyOverride(hit);
    }
  }

  // 2. full place names as whole words
  const hay = ' ' + norm + ' ';
  const idx = placeIndex();
  for (let i = 0; i < idx.length; i++) {
    if (hay.indexOf(' ' + idx[i].n + ' ') !== -1) return applyOverride(idx[i]);
  }

  // 3. abbreviated multi-word places (single run-together token)
  const abbr = abbrevIndex();
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.length < MIN_PLACE_LEN) continue;
    for (let i = 0; i < abbr.length; i++) {
      if (abbr[i].re.test(tok)) return applyOverride({ n: abbr[i].n, la: abbr[i].la, lo: abbr[i].lo });
    }
  }

  // 4. MARCS county zone: the 2-digit prefix in the alpha (e.g. pd08ops, fd01disp)
  // is the system's county code, numbered alphabetically across Ohio's 88
  // counties (01 Adams … 88 Wyandot). Map it to that county's centroid.
  const zone = zoneOf(tgAlphaFor(text));
  if (zone) {
    const c = countyCentroid(zone);
    if (c) return { n: normText(c.n) + ' county', la: c.la, lo: c.lo };
  }

  return null;
}

// ---- MARCS county zone → Ohio county ----
// The 2-digit prefix in a talkgroup's alpha (pd08ops, fd01disp, 12wittpd) is the
// system's county code, numbered alphabetically over Ohio's 88 counties
// (01 Adams … 88 Wyandot). This lets generic sheriff/fire/tac channels resolve
// to their county even when the title names no city.
const ZONE_COUNTIES = ['Adams','Allen','Ashland','Ashtabula','Athens','Auglaize','Belmont','Brown','Butler','Carroll','Champaign','Clark','Clermont','Clinton','Columbiana','Coshocton','Crawford','Cuyahoga','Darke','Defiance','Delaware','Erie','Fairfield','Fayette','Franklin','Fulton','Gallia','Geauga','Greene','Guernsey','Hamilton','Hancock','Hardin','Harrison','Henry','Highland','Hocking','Holmes','Huron','Jackson','Jefferson','Knox','Lake','Lawrence','Licking','Logan','Lorain','Lucas','Madison','Mahoning','Marion','Medina','Meigs','Mercer','Miami','Monroe','Montgomery','Morgan','Morrow','Muskingum','Noble','Ottawa','Paulding','Perry','Pickaway','Pike','Portage','Preble','Putnam','Richland','Ross','Sandusky','Scioto','Seneca','Shelby','Stark','Summit','Trumbull','Tuscarawas','Union','Van Wert','Vinton','Warren','Washington','Wayne','Williams','Wood','Wyandot'];

// Lazily built "<county>" -> {la, lo} lookup from the Ohio places dataset.
let _countyCentroids = null;
function countyCentroid(zone) {
  if (zone < 1 || zone > 88) return null;
  if (!_countyCentroids) {
    _countyCentroids = new Map();
    for (const p of (placeIndex())) {
      const m = /^(.*) county$/.exec(p.n);
      if (m && !_countyCentroids.has(m[1])) _countyCentroids.set(m[1], p);
    }
  }
  return _countyCentroids.get(ZONE_COUNTIES[zone - 1]) || null;
}

// Pull the leading 2-digit zone from a talkgroup alpha, if present.
function zoneOf(alpha) {
  const m = /^[a-z]{0,3}(\d{2})/.exec(normText(alpha || ''));
  if (!m) return null;
  const z = parseInt(m[1], 10);
  return (z >= 1 && z <= 88) ? z : null;
}

// The alpha used for zone lookup — matchPlace passes the title; if a talkgroup
// object is in scope we prefer its own alpha for accuracy.
function tgAlphaFor(text) {
  return text;
}

// Cached per-talkgroup place match; recomputed only if the title changes.
function tgPlace(num) {
  const tg = talkgroups[String(num)];
  if (!tg) return null;
  const key = (tg.alpha || '') + '|' + (tg.description || '');
  if (tg._placeKey !== key) {
    tg._placeKey = key;
    tg._place = matchPlace(key);
  }
  return tg._place;
}

// Small deterministic offset so many talkgroups in the same city fan out.
function jitterLL(la, lo, num, amt) {
  const h = hashNum(String(num));
  const dLat = (((h & 0xff) / 255) - 0.5) * 2 * amt;
  const dLon = ((((h >> 8) & 0xff) / 255) - 0.5) * 2 * amt / (Math.cos(la * Math.PI / 180) || 1);
  return [la + dLat, lo + dLon];
}

// Resolve a talkgroup to a location, in order of confidence:
//   1. an explicit TG_LOCATIONS pin            (real)
//   2. an Ohio city/county named in the title   (real)
//   3. the MARCS county zone in the alpha        (real, county centroid)
//   4. nothing matched → UNLOCATED (we don't fake a spot for it).
// Map/feed/autoplay only use talkgroups that are `real`, so unlocated calls
// simply don't appear — no fake dots, no need for a region toggle.
function resolveTg(num) {
  const fixed = TG_LOCATIONS[num];
  if (fixed) return { la: fixed.lat, lo: fixed.lng, real: true, jit: false };

  const place = tgPlace(num);
  if (place) return { la: place.la, lo: place.lo, real: true, jit: true };

  // All talkgroups in this system belong to Summit County; scatter them around
  // SYSTEM_CENTER so every call gets a map dot and can be auto-played.
  return { la: SYSTEM_CENTER[0], lo: SYSTEM_CENTER[1], real: true, jit: true };
}

// Map coordinates for a talkgroup's calls (with tiny jitter for matched cities).
function tgLatLng(num) {
  const t = resolveTg(num);
  return t.jit ? jitterLL(t.la, t.lo, num, CITY_JITTER) : [t.la, t.lo];
}

// True if the talkgroup resolves to a REAL location (so it can be mapped /
// auto-played). Unlocated talkgroups return false.
function tgRealLocated(num) {
  return resolveTg(num).real;
}

// True only when the talkgroup matched an actual city/county (not the
// SYSTEM_CENTER fallback). Used for distance display so we don't show the
// same ~4mi distance for every unmatched talkgroup.
function tgHasRealPlace(num) {
  return tgPlace(num) != null;
}

// Human-readable source of a talkgroup's location, for the popup.
function tgLocLabel(num) {
  const fixed = TG_LOCATIONS[num];
  if (fixed) return fixed.label || 'pinned';
  const place = tgPlace(num);
  if (place) return titleCase(place.n);
  return 'not located';
}

function titleCase(s) {
  return (s || '').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- driving mode (mobile proximity filter) ----------
function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function tgDistMi(num) {
  if (userLat == null || userLng == null) return null;
  const t = resolveTg(num);
  return haversineMi(userLat, userLng, t.la, t.lo);
}

function callWithinRadius(call) {
  if (userLat == null || userLng == null) return true;
  const d = tgDistMi(String(call.talkgroupNum));
  return d != null && d <= DRIVING_RADIUS_MI;
}

function makePing(color) {
  return L.divIcon({
    className: '',
    html: '<div class="map-ping" style="width:26px;height:26px;border-color:' + color + '"></div>',
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}

function mapPopup(call, name, color) {
  const wrap = el('div');
  const n = el('div', 'map-pop-name', name + '  #' + call.talkgroupNum);
  n.style.color = color;
  wrap.appendChild(n);
  wrap.appendChild(el('div', 'map-pop-meta', fmtClock(call.time) + ' · ' + fmtFreq(call.freq)));
  wrap.appendChild(el('div', 'map-pop-meta', '📍 ' + tgLocLabel(String(call.talkgroupNum))));
  const btn = el('button', 'map-pop-play', '▶ Play');
  btn.addEventListener('click', (e) => { e.stopPropagation(); playCall(call); });
  wrap.appendChild(btn);
  return wrap;
}

// Plot a live call: an expanding "ping" ring plus a persistent, category-colored
// dot with a click-to-play popup. Oldest dots are evicted past MAX_MAP_MARKERS.
// `force` bypasses the focus filter (used for the call that is now playing, which
// should always be visible even if its talkgroup is muted).
function addCallToMap(call, force) {
  if (!map || call == null || call.talkgroupNum == null) return;
  const num = String(call.talkgroupNum);
  // Only plot talkgroups with a REAL location. Unlocated calls (no city/zone)
  // aren't faked onto the map.
  if (!tgRealLocated(num)) return;
  if (!force && !mapShouldShow(num)) return;
  const tg = talkgroups[num];
  const ll = tgLatLng(num);
  const color = categoryColor(tg ? tg.category : null);
  const displayName = tg && tg.description ? tg.description : (tg && tg.alpha ? tg.alpha : 'TG ' + num);

  // If this exact call already has a dot (e.g. it was live, now it's playing),
  // don't duplicate it — just re-center on it (only when it's the playing call).
  if (call._id) {
    const existing = mapMarkers.find((m) => m._callId === call._id);
    if (existing) {
      if (force && mapFollow) map.panTo(existing.getLatLng(), { animate: true, duration: 0.5 });
      return;
    }
  }

  const ping = L.marker(ll, { icon: makePing(color), interactive: false, keyboard: false }).addTo(map);
  setTimeout(() => { try { map.removeLayer(ping); } catch {} }, 1900);

  const dot = L.circleMarker(ll, {
    radius: 7, color: '#0b0f14', weight: 1.5, fillColor: color, fillOpacity: 0.9,
  }).addTo(map);
  dot._bornAt = Date.now();
  dot._tgNum = num;
  dot._callId = call._id;
  dot.bindPopup(mapPopup(call, displayName, color), { closeButton: false });
  mapMarkers.push(dot);

  // Evict oldest, but never the dot for the call that is currently playing.
  while (mapMarkers.length > MAX_MAP_MARKERS) {
    let idx = 0;
    if (currentCall && mapMarkers[0]._callId === currentCall._id && mapMarkers.length > 1) idx = 1;
    const oldest = mapMarkers.splice(idx, 1)[0];
    try { map.removeLayer(oldest); } catch {}
  }

  // Only recenter for the call that is actually playing, so incoming dots don't
  // yank the view around — the map follows playback and moves when the next call
  // starts playing.
  if (force && mapFollow) map.panTo(ll, { animate: true, duration: 0.5 });
}

// Age the dots so the map reads as "recent activity" — newest are brightest.
// The currently playing call is pinned bright and enlarged so it stands out.
function fadeMap() {
  if (!map) return;
  const now = Date.now();
  for (const m of mapMarkers) {
    const isPlaying = currentCall && m._callId === currentCall._id;
    if (isPlaying) {
      try { m.setStyle({ fillOpacity: 1, radius: 10, weight: 2.5, color: '#ffffff' }); } catch {}
      continue;
    }
    const age = now - (m._bornAt || now);
    const op = Math.max(0.25, 0.9 - (age / MAP_FADE_MS) * 0.65);
    try { m.setStyle({ fillOpacity: op, radius: 7, weight: 1.5, color: '#0b0f14' }); } catch {}
  }
}

function clearMap() {
  if (!map) return;
  for (const m of mapMarkers) { try { map.removeLayer(m); } catch {} }
  mapMarkers.length = 0;
}

// Map visibility gate: respect focus (muted categories) and only show talkgroups
// that resolve to a REAL location. The call currently playing is always kept.
function mapShouldShow(num) {
  if (focusMode) {
    const tg = talkgroups[String(num)];
    if (!(tg && tg.enabled)) return false;
  }
  return tgRealLocated(num);
}

// Drop any dots that no longer pass the focus/region filters (called when a
// filter toggles or the set of enabled talkgroups changes). The call that is
// currently playing is always kept, even if its talkgroup is muted/out-of-region.
function refreshMapVisibility() {
  if (!map) return;
  for (let i = mapMarkers.length - 1; i >= 0; i--) {
    const m = mapMarkers[i];
    const isPlaying = currentCall && m._callId === currentCall._id;
    if (!isPlaying && !mapShouldShow(m._tgNum)) {
      try { map.removeLayer(m); } catch {}
      mapMarkers.splice(i, 1);
    }
  }
}

// ---------- cache saving (debounced) ----------
let cacheTimer = null;
function saveCacheSoon() {
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => { cacheTimer = null; saveCache(); }, 5000);
}

// ---------- bulk actions ----------
function applyBulk(kind) {
  if (categoryFilters.category) {
    categoryFilters.category.value = '';
  }
  const catFilterValue = categoryFilters.category ? categoryFilters.category.value : '';
  const catTarget = categoryIdFromFilterValue(catFilterValue) || null;
  const now = Date.now();
  for (const num in talkgroups) {
    const tg = talkgroups[num];
    if (catTarget && tg.category !== catTarget && !(catTarget === CATEGORY_OTHER && !tg.category)) continue;
    if (kind === 'all') tg.enabled = true;
    else if (kind === 'none') tg.enabled = false;
  }
  saveEnabled();
  renderList();
  refreshMapVisibility();
}

function applyCategory(catId) {
  if (categoryFilters.category) {
    if (catId === CATEGORY_OTHER) {
      categoryFilters.category.value = CATEGORY_OTHER;
    } else {
      const cat = CATEGORIES.find(c => c.id === catId);
      if (cat) categoryFilters.category.value = cat.description;
    }
  }
  for (const num in talkgroups) {
    const tg = talkgroups[num];
    const isTarget = tg.category === catId || (catId === CATEGORY_OTHER && !tg.category);
    tg.enabled = isTarget;
  }
  saveEnabled();
  renderList();
  refreshMapVisibility();
}

// ---------- connect / boot ----------
let enabledState = loadEnabled();

function connect() {
  // Reset local state for a fresh connection.
  enabledState = loadEnabled();
  for (const k in talkgroups) delete talkgroups[k];
  feed.length = 0;
  playedIds.clear();
  historyCursor = null;
  historyPages = 0;
  activeAudio.pause();
  activeAudio.currentTime = 0;
  playing = false;
  currentCall = null;
  isLocalApi = false; // test direct audio URLs for EQ compatibility

  $('tgList').innerHTML = '<div class="empty">Loading talkgroups…</div>';
  $('feed').innerHTML = '<div class="empty">Waiting for calls…</div>';
  renderNowPlaying(null);

  const cachedConfigs = loadTgConfig();
  if (cachedConfigs.length) {
    for (const c of cachedConfigs) ensureTG(c.num, c);
    renderList();
  }

  setBanner('Connecting to OpenMHz…');
  console.info('[connect] client connecting directly to OpenMHz');

  // The browser connects straight to OpenMHz, fetches talkgroups and history,
  // and receives live calls over the Socket.IO live feed.
  connectSocket();

  // Apply the default category filter once we have data (best-effort).
  setTimeout(() => {
    if (activeCategory && Object.keys(enabledState).length === 0) applyCategory(activeCategory);
  }, 1500);
}

// Build the category UI (bulk buttons + filter dropdown) from CATEGORIES so
// any category added to the array appears automatically — no HTML edits needed.
function buildCategoryControls() {
  const bulk = $('bulkBar');
  // keep the static All/None buttons, append one per category + Other
  for (const cat of CATEGORIES) {
    const b = el('button', 'btn small', cat.label);
    b.dataset.cat = cat.id;
    b.style.color = cat.color;
    b.style.borderColor = rgba(cat.color, 0.5);
    bulk.appendChild(b);
  }
  const other = el('button', 'btn small', 'Other');
  other.dataset.cat = CATEGORY_OTHER;
  bulk.appendChild(other);

  const sel = $('categoryFilter');
  for (const cat of CATEGORIES) {
    const o = el('option');
    o.value = cat.description;
    o.textContent = cat.description;
    sel.appendChild(o);
  }
  const oo = el('option');
  oo.value = CATEGORY_OTHER;
  oo.textContent = 'Other';
  sel.appendChild(oo);
}

function requestLocation() {
  if (!navigator.geolocation) {
    fallbackIpLocation();
    return;
  }
  setBanner('Driving Mode: requesting GPS…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      localStorage.setItem('om_userLat', String(userLat));
      localStorage.setItem('om_userLng', String(userLng));
      renderFeed();
      scheduleRender();
      setBanner('');
      console.info('[location] GPS acquired:', userLat.toFixed(5), userLng.toFixed(5), '±' + Math.round(pos.coords.accuracy) + 'm');
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        console.warn('Geolocation denied by user.');
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        console.warn('Geolocation unavailable.');
      } else {
        console.warn('Geolocation error:', err.message);
      }
      fallbackIpLocation();
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

function fallbackIpLocation() {
  setBanner('Driving Mode: GPS unavailable, using IP…');
  fetch('https://ipwho.is/')
    .then((r) => r.json())
    .then((data) => {
      if (data.latitude != null && data.longitude != null) {
        userLat = data.latitude;
        userLng = data.longitude;
        localStorage.setItem('om_userLat', String(userLat));
        localStorage.setItem('om_userLng', String(userLng));
        renderFeed();
        scheduleRender();
        console.info('[location] IP fallback:', data.city || data.region || 'approximate', userLat.toFixed(5), userLng.toFixed(5));
        setBanner('Driving Mode: IP-based location (±' + (data.radius != null ? Math.round(data.radius) : '50') + ' km)');
      } else {
        disableDrivingMode('Could not determine location.');
      }
    })
    .catch(() => disableDrivingMode('Location lookup failed.'));
}

function disableDrivingMode(reason) {
  console.warn(reason || 'Location unavailable.');
  setBanner(reason || 'Driving Mode unavailable');
  const drivingEl = $('drivingMode');
  if (drivingEl) {
    drivingEl.checked = false;
    drivingMode = false;
    const label = document.getElementById('drivingLabel');
    if (label) label.classList.remove('driving-on');
  }
}

// ---------- wire up UI ----------
function init() {
  focusMode = localStorage.getItem('om_focusMode') !== '0';
  $('focusMode').checked = focusMode;

  $('enabledOnly').checked = true;
  $('eq').checked = eqOn;

  const drivingEl = $('drivingMode');
  if (drivingEl) {
    drivingMode = drivingEl.checked;
    drivingEl.addEventListener('change', (e) => {
      drivingMode = e.target.checked;
      if (drivingMode) requestLocation();
      renderFeed();
      scheduleRender();
      const label = document.getElementById('drivingLabel');
      if (label) label.classList.toggle('driving-on', drivingMode);
    });
  }

  const cachedLat = localStorage.getItem('om_userLat');
  const cachedLng = localStorage.getItem('om_userLng');
  if (cachedLat && cachedLng) {
    userLat = parseFloat(cachedLat);
    userLng = parseFloat(cachedLng);
  }

  buildCategoryControls();

  $('search').addEventListener('input', scheduleRender);
  $('sort').addEventListener('change', scheduleRender);
  $('enabledOnly').addEventListener('change', scheduleRender);
  categoryFilters.category = $('categoryFilter');
  categoryFilters.category.value = 'Police';
  $('categoryFilter').addEventListener('change', scheduleRender);
  $('autoplay').addEventListener('change', (e) => { autoplay = e.target.checked; });
  $('eq').addEventListener('change', (e) => { eqOn = e.target.checked; applyEq(); });
  $('focusMode').addEventListener('change', (e) => {
    focusMode = e.target.checked;
    localStorage.setItem('om_focusMode', focusMode ? '1' : '0');
    renderFeed();
    refreshMapVisibility();
    if (focusMode) scheduleRender();
  });

  const unlock = () => {
    firstGesture = true;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    pump();
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  document.querySelectorAll('[data-bulk]').forEach((b) => {
    b.addEventListener('click', () => applyBulk(b.dataset.bulk));
  });
  document.querySelectorAll('[data-cat]').forEach((b) => {
    b.addEventListener('click', () => applyCategory(b.dataset.cat));
  });

  setInterval(() => { renderList(); renderFeed(); }, 10000);
  setInterval(updateNpStatusLive, 700);

  initMap();
  setInterval(fadeMap, 5000);

  initSwiper();

  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
    document.body.classList.add('standalone');
  }

  connect();
}

function initSwiper() {
  const wrap = document.getElementById('swiper');
  const tabs = document.querySelectorAll('.m-tab');
  if (!wrap || !tabs.length) return;

  let current = 0;
  let scrolling = false;

  wrap.scrollLeft = 0;
  updateTabs();

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      if (scrolling) return;
      current = i;
      updateTabs();
      scrollToPage(i);
    });
  });

  function updateTabs() {
    tabs.forEach((t, i) => t.classList.toggle('active', i === current));
  }

  function scrollToPage(i) {
    scrolling = true;
    const page = wrap.children[i];
    if (page) page.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    clearTimeout(scrollToPage._timer);
    scrollToPage._timer = setTimeout(() => { scrolling = false; }, 350);
  }

  wrap.addEventListener('scroll', () => {
    if (scrolling) return;
    const idx = Math.round(wrap.scrollLeft / Math.max(wrap.clientWidth, 1));
    if (idx !== current) {
      current = idx;
      updateTabs();
    }
  }, { passive: true });
}

document.addEventListener('DOMContentLoaded', init);
