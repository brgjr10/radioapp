'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;

const root = __dirname;
const port = process.env.PORT || 5050;
const host = process.env.HOST || '0.0.0.0';

const HTTPS_KEY = process.env.HTTPS_KEY || path.join(root, 'server.key');
const HTTPS_CERT = process.env.HTTPS_CERT || path.join(root, 'server.crt');
const HTTPS_PFX_PASSWORD = process.env.HTTPS_PFX_PASSWORD;
const useHttps = HTTPS_PFX_PASSWORD && fs.existsSync(HTTPS_KEY);

const ALLOW_PRIVATE_PROXY = process.env.ALLOW_PRIVATE_PROXY === '1';
// Optional destination allow-list, off by default because the audio URLs come
// from whatever host OpenMHz hands back per call and pinning them here would
// silently break playback. Set PROXY_ALLOW_HOSTS to a comma-separated host list
// (e.g. "api.openmhz.com,d1.iz2nn.com") to turn it on.
const PROXY_ALLOW_HOSTS = (process.env.PROXY_ALLOW_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const PROXY_MAX_CONCURRENT = Number(process.env.PROXY_MAX_CONCURRENT) || 8;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// The repository checkout is the process root, so serving it wholesale would
// publish server.key, .git/, project.json, *.db and the analysis fixtures.
// Only the PWA's own assets are reachable; everything else 404s.
const PUBLIC_FILES = new Set([
  '/index.html',
  '/mobile.html',
  '/app.js',
  '/ohio-cities.js',
  '/styles.css',
  '/mobile.css',
  '/sw.js',
  '/manifest.webmanifest',
  '/icon.svg',
]);

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
    "connect-src 'self' https://api.openmhz.com wss://api.openmhz.com https://ipwho.is",
    // Audio is fetched directly from the host OpenMHz names per call
    // (app.js sets isLocalApi = false), and that host is not knowable here, so
    // media-src stays open to https rather than guess an allow-list and break
    // playback. http: stays blocked.
    "media-src 'self' blob: data: https:",
    "font-src 'self' data:",
    "worker-src 'self'",
  ].join('; '),
};

function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.startsWith('[')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function isPrivateAddr(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    const a = p[0], b = p[1];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true;
    if (s.startsWith('ff')) return true;
    // IPv4-mapped / IPv4-compatible forms, e.g. ::ffff:127.0.0.1
    const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4) return isPrivateAddr(v4[1]);
    return false;
  }
  return true;
}

function hostAllowed(hostname) {
  // Fail-open by design: the OpenMHz recording host is chosen per call and could
  // not be pinned from here, and a wrong default breaks playback outright. The
  // private/loopback ranges stay blocked by isPrivateAddr, so an empty list
  // exposes public destinations only - not the LAN. What it does not stop is a
  // public hostname that resolves to an internal address (DNS rebinding), which
  // is why the empty case warns loudly at startup instead of staying silent.
  if (!PROXY_ALLOW_HOSTS.length) return true;
  const h = hostname.toLowerCase();
  return PROXY_ALLOW_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}

const PROXY_HEADERS = [
  'content-type', 'content-length', 'content-range',
  'accept-ranges', 'cache-control', 'etag', 'last-modified',
];

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range',
  'access-control-max-age': '600',
};

function setCors(res) {
  for (const k in CORS_HEADERS) res.setHeader(k, CORS_HEADERS[k]);
}

function handleOptions(res) {
  res.writeHead(204, CORS_HEADERS);
  res.end();
}

// The app fetches /proxy from its own origin only. A cross-site Origin means a
// third-party page is borrowing this box as a relay, so it is refused; a
// missing Origin (plain <audio>/<img> GETs) is still allowed.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

let inFlight = 0;

function handleProxy(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { handleOptions(res); return; }
  if (!originAllowed(req)) { res.writeHead(403); res.end('Forbidden origin'); return; }

  let target;
  try {
    target = new URL(req.url, 'http://localhost').searchParams.get('url');
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }
  if (!target) { res.writeHead(400); res.end('Missing url'); return; }

  let t;
  try { t = new URL(target); }
  catch { res.writeHead(400); res.end('Bad url'); return; }

  if (t.protocol !== 'http:' && t.protocol !== 'https:') {
    res.writeHead(400); res.end('Unsupported protocol'); return;
  }
  if (!hostAllowed(t.hostname)) {
    res.writeHead(403); res.end('Forbidden host'); return;
  }
  if (isPrivateHost(t.hostname)) {
    res.writeHead(403); res.end('Forbidden host'); return;
  }

  resolveUpstream(t).then((addr) => {
    if (!addr) { res.writeHead(403); res.end('Forbidden host'); return; }
    startProxy(req, res, t, addr);
  }).catch((e) => {
    console.error('[proxy] could not resolve ' + t.hostname + ': ' + e.message);
    if (res.headersSent) { try { res.destroy(); } catch {} return; }
    res.writeHead(502); res.end('Proxy error: ' + e.message);
  });
}

// The hostname denylist cannot see through a wildcard DNS name, so the address
// it actually resolves to is what gets validated, and the connection is pinned
// to that address so it cannot be re-resolved to something else mid-flight.
function resolveUpstream(t) {
  if (ALLOW_PRIVATE_PROXY) {
    return dns.lookup(t.hostname, { all: true }).then((a) => a[0] || null);
  }
  return dns.lookup(t.hostname, { all: true }).then((addrs) => {
    if (!addrs.length) return null;
    if (addrs.some((a) => isPrivateAddr(a.address))) return null;
    return addrs[0];
  });
}

function startProxy(req, res, t, addr) {
  if (inFlight >= PROXY_MAX_CONCURRENT) {
    res.writeHead(503); res.end('Proxy busy'); return;
  }
  inFlight++;

  const lib = t.protocol === 'https:' ? https : http;
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];

  const opts = {
    protocol: t.protocol,
    hostname: t.hostname,
    port: t.port || (t.protocol === 'https:' ? 443 : 80),
    path: t.pathname + t.search,
    method: req.method,
    headers,
    timeout: 20000,
    // Node 20+ happy-eyeballs resolves with {all:true} and wants an array
    // back; the single-address form is still used on older runtimes. Pinning
    // here is what stops a validated name being re-resolved mid-connection.
    lookup: (hostname, options, cb) => {
      if (options && options.all) cb(null, [addr]);
      else cb(null, addr.address, addr.family);
    },
  };
  if (t.protocol === 'https:') opts.servername = t.hostname;

  let settled = false;
  const release = () => { if (!settled) { settled = true; inFlight--; } };

  const preq = lib.request(opts, (pres) => {
    const out = { ...CORS_HEADERS };
    for (const k of PROXY_HEADERS) if (pres.headers[k]) out[k] = pres.headers[k];
    if (pres.headers['access-control-allow-origin']) out['access-control-allow-origin'] = pres.headers['access-control-allow-origin'];
    res.writeHead(pres.statusCode, out);
    pres.pipe(res);
    pres.on('error', (e) => {
      console.error('[proxy] upstream stream error from ' + t.hostname + ': ' + e.message);
      try { res.destroy(); } catch {}
    });
    pres.on('end', release);
  });

  preq.on('error', (e) => {
    console.error('[proxy] request to ' + t.hostname + ' failed: ' + e.message);
    if (res.headersSent) { try { res.destroy(); } catch {} }
    else { res.writeHead(502); res.end('Proxy error: ' + e.message); }
  });
  preq.on('timeout', () => {
    console.error('[proxy] timeout after 20s talking to ' + t.hostname);
    preq.destroy();
    if (res.headersSent) { try { res.destroy(); } catch {} return; }
    res.writeHead(504); res.end('Proxy timeout');
  });
  req.on('error', (e) => {
    console.error('[proxy] client request error: ' + e.message);
    try { preq.destroy(); } catch {}
  });
  res.on('close', release);
  preq.end();
}

function resolveStaticPath(rawPath) {
  if (rawPath === '/') return '/index.html';
  if (rawPath === '/mobile' || rawPath === '/m') return '/mobile.html';
  if (!PUBLIC_FILES.has(rawPath)) return null;
  return rawPath;
}

function handleStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }
  if (urlPath.indexOf('\0') !== -1) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  const resolved = resolveStaticPath(urlPath);
  if (!resolved) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }

  const filePath = path.normalize(path.join(root, resolved));
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': types[ext] || 'application/octet-stream' };
    if (/\.(js|css|html|webmanifest|svg)$/.test(ext)) {
      if (/\.(webmanifest|svg)$/.test(ext)) headers['Cache-Control'] = 'public, max-age=86400';
      else if (/sw\.js$/.test(filePath)) headers['Cache-Control'] = 'no-cache';
      else { headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'; headers['Pragma'] = 'no-cache'; headers['Expires'] = '0'; }
    }
    res.writeHead(200, { ...BASE_HEADERS, ...headers });
    res.end(data);
  });
}

function handleRequest(req, res) {
  if (req.url.startsWith('/proxy')) { handleProxy(req, res); return; }
  handleStatic(req, res);
}

const server = useHttps
  ? https.createServer({ pfx: fs.readFileSync(HTTPS_KEY), passphrase: HTTPS_PFX_PASSWORD }, handleRequest)
  : http.createServer(handleRequest);

server.on('clientError', (e) => {
  console.error('[server] client error: ' + e.message);
  if (e.code === 'ECONNRESET') return;
});

function shutdown(signal) {
  console.log('[server] ' + signal + ' received, closing listeners');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  console.error('[server] uncaught exception: ' + (e && e.stack ? e.stack : e));
});

module.exports = { server, PUBLIC_FILES, BASE_HEADERS, resolveStaticPath, isPrivateHost, isPrivateAddr, hostAllowed, originAllowed };

if (require.main === module) {
  server.listen(port, host, () => {
    console.log('OpenMHz Activity Monitor running at ' + (useHttps ? 'https' : 'http') + '://' + host + ':' + port);
    if (!PROXY_ALLOW_HOSTS.length) {
      console.warn('[server] WARNING: PROXY_ALLOW_HOSTS is empty, so the media proxy will relay from ANY public host.');
      console.warn('[server] Private and loopback destinations stay blocked, but a public hostname that resolves to an internal address is not (DNS rebinding).');
      console.warn('[server] Fix: set PROXY_ALLOW_HOSTS in .env to a comma-separated list of the OpenMHz audio hosts you use, e.g. PROXY_ALLOW_HOSTS=api.openmhz.com');
    }
  });
}
