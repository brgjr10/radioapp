'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = process.env.PORT || 5050;

const HTTPS_KEY = process.env.HTTPS_KEY || path.join(root, 'server.key');
const HTTPS_CERT = process.env.HTTPS_CERT || path.join(root, 'server.crt');
const HTTPS_PFX_PASSWORD = process.env.HTTPS_PFX_PASSWORD;
const useHttps = HTTPS_PFX_PASSWORD && fs.existsSync(HTTPS_KEY);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
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

const PROXY_HEADERS = [
  'content-type', 'content-length', 'content-range',
  'accept-ranges', 'cache-control', 'etag', 'last-modified',
];

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range',
  'access-control-max-age': '86400',
};

function setCors(res) {
  for (const k in CORS_HEADERS) res.setHeader(k, CORS_HEADERS[k]);
}

function handleOptions(res) {
  res.writeHead(204, CORS_HEADERS);
  res.end();
}

function handleProxy(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { handleOptions(res); return; }

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
  if (isPrivateHost(t.hostname)) {
    res.writeHead(403); res.end('Forbidden host'); return;
  }

  const lib = t.protocol === 'https:' ? https : http;
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];

  const preq = lib.request(t, { method: req.method, headers, timeout: 20000 }, (pres) => {
    const out = { ...CORS_HEADERS };
    for (const k of PROXY_HEADERS) if (pres.headers[k]) out[k] = pres.headers[k];
    if (pres.headers['access-control-allow-origin']) out['access-control-allow-origin'] = pres.headers['access-control-allow-origin'];
    res.writeHead(pres.statusCode, out);
    pres.pipe(res);
    pres.on('error', () => { try { res.destroy(); } catch {} });
  });

  preq.on('error', (e) => {
    if (res.headersSent) { try { res.destroy(); } catch {} }
    else { res.writeHead(502); res.end('Proxy error: ' + e.message); }
  });
  preq.on('timeout', () => { try { preq.destroy(); } catch {} res.writeHead(504); res.end('Proxy timeout'); });
  req.on('error', () => { try { preq.destroy(); } catch {} });
  preq.end();
}

const server = useHttps
  ? https.createServer({ pfx: fs.readFileSync(HTTPS_KEY), passphrase: HTTPS_PFX_PASSWORD }, (req, res) => {
      if (req.url.startsWith('/proxy')) { handleProxy(req, res); return; }
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      else if (urlPath === '/mobile') urlPath = '/mobile.html';
      else if (urlPath === '/m') urlPath = '/mobile.html';
      const filePath = path.normalize(path.join(root, urlPath));
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
        res.writeHead(200, headers);
        res.end(data);
      });
    })
  : http.createServer((req, res) => {
      if (req.url.startsWith('/proxy')) { handleProxy(req, res); return; }
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      else if (urlPath === '/mobile') urlPath = '/mobile.html';
      else if (urlPath === '/m') urlPath = '/mobile.html';
      const filePath = path.normalize(path.join(root, urlPath));
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
        res.writeHead(200, headers);
        res.end(data);
      });
    });

server.listen(port, () => {
  console.log('OpenMHz Activity Monitor running at ' + (useHttps ? 'https' : 'http') + '://localhost:' + port);
});
