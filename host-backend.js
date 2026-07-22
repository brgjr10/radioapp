'use strict';

const { io: ioClient } = require('socket.io-client');
const https = require('https');
const http = require('http');

const MAX_FEED = 200;
const MAX_TIMES = 10000;
const HISTORY_PAGES = 100;
const WINDOWS = { h1: 3600e3, h6: 21600e3, h24: 86400e3 };

const BROWSER_UA = 'Mozilla/5.0 (compatible; radioapp/2.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: 20000,
    }, (res) => {
      res.on('error', reject);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        } else {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

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

class HostBackend {
  constructor(io, opts = {}) {
    this.io = io;
    this.apiBase = (opts.apiBase || 'https://api.openmhz.com').replace(/\/+$/, '');
    this.system = (opts.system || 'marcs_sc').toLowerCase();
    this.allowDirect = !!opts.allowDirect;
    this.log = opts.log || console;

    this.clientCount = 0;
    this.active = false;        // are we currently making API calls?
    this.liveSocket = null;
    this.liveConnected = false;

    // Mirrors the clients need to render without re-fetching anything.
    this.tgNames = {};          // num -> { alpha, description }
    this.feed = [];             // recent calls (newest first), capped
    this.historyCursor = null;
    this.historyPages = 0;
    this._historyTimer = null;
    this._failure = null;
    this._directOffered = false;
  }

  // ---- client lifecycle ----
  addClient(socket) {
    this.clientCount++;
    this.log.info(`[backend] client connected — ${this.clientCount} connected`);
    socket.emit('snapshot', {
      system: this.system,
      apiBase: this.apiBase,
      tgNames: this.tgNames,
      feed: this.feed,
      active: this.active,
      liveConnected: this.liveConnected,
      failure: this._failure,
    });
    if (this.clientCount === 1) this.start();
  }

  removeClient() {
    this.clientCount = Math.max(0, this.clientCount - 1);
    this.log.info(`[backend] client disconnected — ${this.clientCount} connected`);
    if (this.clientCount === 0) this.stop();
  }

  broadcast(event, payload) {
    this.io.emit(event, payload);
  }

  // ---- activation ----
  start() {
    if (this.active) return;
    this.active = true;
    this._failure = null;
    this.log.info(`[backend] activating — system=${this.system} api=${this.apiBase}`);
    this.broadcast('state', { active: true, liveConnected: false, clientCount: this.clientCount, failure: null });
    this.fetchTalkgroups().catch((e) => {
      this.log.warn('[backend] talkgroups fetch failed:', e.message);
      this.maybeOfferDirect('talkgroups: ' + e.message);
    });
    this.fetchHistory().catch((e) => {
      this.log.warn('[backend] history fetch failed:', e.message);
      this.maybeOfferDirect('history: ' + e.message);
    });
    this.connectLive();
  }

  // Put the backend to sleep: no sockets, no polling, no API traffic.
  stop() {
    if (!this.active) return;
    this.active = false;
    this.log.info('[backend] no clients connected — idling (no API calls)');
    if (this.liveSocket) { try { this.liveSocket.close(); } catch {} this.liveSocket = null; }
    this.liveConnected = false;
    if (this._historyTimer) { clearTimeout(this._historyTimer); this._historyTimer = null; }
    // Reset history cursor so the next activation re-seeds the *recent* picture
    // (calls that happened while we were idle are not in our stale cursor).
    this.historyCursor = null;
    this.historyPages = 0;
    this.broadcast('state', { active: false, liveConnected: false, clientCount: 0, failure: this._failure });
  }

  // ---- talkgroups ----
  async fetchTalkgroups() {
    const body = await httpGet(`${this.apiBase}/${this.system}/talkgroups`);
    const data = JSON.parse(body);
    const list = data.talkgroups || {};
    for (const num in list) {
      const tg = list[num];
      this.tgNames[num] = { alpha: tg.alpha, description: tg.description };
    }
    this.broadcast('talkgroups', { system: this.system, tgNames: this.tgNames });
  }

  // ---- history (seeds activity counts) ----
  async fetchHistory() {
    if (this.historyPages >= HISTORY_PAGES) return;
    let url;
    if (this.historyCursor == null) {
      url = `${this.apiBase}/${this.system}/calls?filter-type=all&filter-starred=false`;
    } else {
      url = `${this.apiBase}/${this.system}/calls/older?time=${this.historyCursor}&filter-type=all&filter-starred=false`;
    }
    const body = await httpGet(url);
    const data = JSON.parse(body);
    const calls = data.calls || [];
    if (calls.length === 0) { this.historyPages = HISTORY_PAGES; return; }
    for (const c of calls) this.ingest(c);
    this.historyCursor = callTime(calls[calls.length - 1]);
    this.historyPages++;
    this.broadcast('history', { calls });
    const oldestInPage = callTime(calls[calls.length - 1]);
    if (this.active && (Date.now() - oldestInPage) <= WINDOWS.h24) {
      this._historyTimer = setTimeout(() => this.fetchHistory().catch(() => {}), 120);
    }
  }

  // ---- live socket ----
  connectLive() {
    if (this.liveSocket) return;
    this.log.info(`[backend] connecting live socket to ${this.apiBase}`);
    let sock;
    try {
      sock = ioClient(this.apiBase, {
        transports: ['polling', 'websocket'],
        reconnection: true,
        timeout: 20000,
        extraHeaders: {
          'User-Agent': BROWSER_UA,
        },
      });
    } catch (e) {
      this.onLiveFailure(e);
      return;
    }
    this.liveSocket = sock;

    sock.on('connect', () => {
      this.liveConnected = true;
      this.log.info('[backend] live socket connected');
      sock.emit('start', {
        shortName: this.system,
        filterCode: '',
        filterName: 'all',
        filterStarred: false,
        filterType: 'all',
      });
      this.broadcast('state', { active: true, liveConnected: true, clientCount: this.clientCount, failure: null });
    });

    sock.on('disconnect', () => {
      this.liveConnected = false;
      this.broadcast('state', { active: this.active, liveConnected: false, clientCount: this.clientCount, failure: this._failure });
    });

    sock.on('connect_error', (e) => {
      this.log.warn('[backend] live socket error:', e && e.message ? e.message : e);
      this.onLiveFailure(e);
    });

    sock.on('new message', (raw) => {
      let call;
      try { call = JSON.parse(raw); } catch { return; }
      if (!call || call.talkgroupNum == null) return;
      this.ingest(call);
      this.broadcast('new message', call);
    });
  }

  onLiveFailure(e) {
    const msg = e && e.message ? e.message : String(e);
    this._failure = 'Live feed unavailable: ' + msg;
    this.log.warn('[backend]', this._failure);
    this.broadcast('state', { active: this.active, liveConnected: false, clientCount: this.clientCount, failure: this._failure });
    // Shut the broken socket down so we don't spin on reconnection attempts.
    if (this.liveSocket) { try { this.liveSocket.close(); } catch {} this.liveSocket = null; }
    this.maybeOfferDirect('live: ' + msg);
  }

  // If the host itself cannot reach OpenMHz (e.g. api.openmhz.com's Cloudflare
  // browser challenge blocks non-browser clients), let the browsers fall back
  // to connecting directly. This keeps the app usable; set OM_ALLOW_DIRECT=1 to
  // enable it. Off by default so the unified backend is the normal path.
  maybeOfferDirect(reason) {
    if (!this.allowDirect || this._directOffered) return;
    this._directOffered = true;
    this.log.warn(`[backend] offering direct client fallback (${reason})`);
    this.broadcast('use-direct', { apiBase: this.apiBase, system: this.system });
  }

  // ---- shared call intake (host mirror used for snapshots) ----
  ingest(call) {
    if (!call || call.talkgroupNum == null) return false;
    if (call._id && this.feed.some((c) => c._id === call._id)) return false;
    this.feed.unshift(call);
    while (this.feed.length > MAX_FEED) this.feed.pop();
    return true;
  }
}

module.exports = { HostBackend, callTime };
