'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const serve = require(path.join(repoRoot, 'serve.js'));

// ---------- unit: the static allow-list (RADIOAPP-001) ----------

test('static allow-list resolves only the PWA assets', () => {
  const allowed = [
    '/', '/index.html', '/m', '/mobile', '/mobile.html', '/app.js',
    '/ohio-cities.js', '/styles.css', '/mobile.css', '/sw.js',
    '/manifest.webmanifest', '/icon.svg',
  ];
  for (const p of allowed) {
    assert.ok(serve.resolveStaticPath(p), p + ' should resolve');
  }
  assert.strictEqual(serve.resolveStaticPath('/'), '/index.html');
  assert.strictEqual(serve.resolveStaticPath('/m'), '/mobile.html');
  assert.strictEqual(serve.resolveStaticPath('/mobile'), '/mobile.html');
});

test('static allow-list refuses secrets, dotfiles and fixtures (RADIOAPP-001)', () => {
  const refused = [
    '/server.key', '/server.crt', '/.git/HEAD', '/.git/config', '/.git/index',
    '/project.json', '/wikijs_mappings.db', '/wikijs_mcp.log',
    '/package.json', '/package-lock.json', '/Dockerfile', '/docker-compose.yml',
    '/.dockerignore', '/.gitignore', '/ACCESS.MD', '/radioapp.yaml',
    '/talkgroups.txt', '/unmapped-talkgroups.txt', '/host-backend.js',
    '/../package.json', '/%2e%2e/package.json', '/..\\package.json',
  ];
  for (const p of refused) {
    assert.strictEqual(serve.resolveStaticPath(p), null, p + ' must not resolve');
  }
  assert.ok(!serve.PUBLIC_FILES.has('/server.key'));
});

// ---------- unit: the SSRF address guard (RADIOAPP-003) ----------

test('isPrivateAddr covers loopback, RFC1918, link-local and mapped forms', () => {
  const priv = [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.4.110', '169.254.169.254', '0.0.0.0', '0.0.0.1', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.4.110',
  ];
  for (const a of priv) assert.ok(serve.isPrivateAddr(a), a + ' should be private');

  for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
    assert.ok(!serve.isPrivateAddr(a), a + ' should be public');
  }
});

// ---------- unit: cross-origin relay refusal (RADIOAPP-004) ----------

test('originAllowed refuses a cross-site Origin and allows same-origin', () => {
  assert.ok(serve.originAllowed({ headers: { host: 'radio:5050' } }));
  assert.ok(serve.originAllowed({ headers: { host: 'radio:5050', origin: 'http://radio:5050' } }));
  assert.ok(!serve.originAllowed({ headers: { host: 'radio:5050', origin: 'https://evil.example' } }));
  assert.ok(!serve.originAllowed({ headers: { host: 'radio:5050', origin: 'not a url' } }));
});

test('proxy destination allow-list is off by default, so audio is never silently broken (RADIOAPP-004)', () => {
  assert.ok(serve.hostAllowed('api.openmhz.com'));
  assert.ok(serve.hostAllowed('example.com'));
});

// ---------- integration: live server ----------

function rawRequest(port, rawPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: rawPath, method: 'GET', headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

let child = null;
let port = 0;

// The campaign runs nine fix agents in parallel against a shared port range, so
// bind an ephemeral port rather than assuming 18102 is free.
function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

test.before(async () => {
  port = await freePort();
  child = spawn(process.execPath, ['serve.js'], {
    cwd: repoRoot,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('running at')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited early: ' + code)); });
  });
});

test.after(() => {
  if (child) child.kill();
});

test('live: the app itself still serves every asset it needs', async () => {
  for (const p of ['/', '/m', '/index.html', '/mobile.html', '/app.js', '/styles.css',
    '/mobile.css', '/ohio-cities.js', '/sw.js', '/manifest.webmanifest', '/icon.svg']) {
    const r = await rawRequest(port, p);
    assert.strictEqual(r.status, 200, p + ' -> ' + r.status);
    assert.ok(r.body.length > 0, p + ' should not be empty');
  }
});

test('live: server.key and .git are no longer reachable (RADIOAPP-001)', async () => {
  const paths = ['/server.key', '/server.crt', '/.git/HEAD', '/.git/config',
    '/.git/index', '/project.json', '/wikijs_mappings.db', '/wikijs_mcp.log',
    '/package.json', '/Dockerfile', '/talkgroups.txt', '/unmapped-talkgroups.txt',
    '/.gitignore', '/.dockerignore', '/ACCESS.MD'];
  for (const p of paths) {
    const r = await rawRequest(port, p);
    assert.ok(r.status === 404 || r.status === 403, p + ' -> ' + r.status + ' (was 200)');
    assert.ok(!/BEGIN|PRIVATE|origin|refs\/heads/.test(r.body), p + ' leaked content');
  }
});

test('live: a null byte is a 400, not a process kill (RADIOAPP-002)', async () => {
  const r = await rawRequest(port, '/index%00.html');
  assert.strictEqual(r.status, 400);
  const after = await rawRequest(port, '/');
  assert.strictEqual(after.status, 200, 'server must survive the null-byte request');
  assert.strictEqual(child.exitCode, null, 'process must still be running');
});

test('live: malformed percent-encoding is a 400, not a crash (RADIOAPP-002)', async () => {
  const r = await rawRequest(port, '/%zz');
  assert.ok(r.status === 400 || r.status === 404, 'got ' + r.status);
  assert.strictEqual((await rawRequest(port, '/')).status, 200);
  assert.strictEqual(child.exitCode, null);
});

test('live: traversal attempts stay refused (RADIOAPP-001)', async () => {
  for (const p of ['/%2e%2e%2fpackage.json', '/..%2f..%2fAGENTS.md', '/..\\package.json']) {
    const r = await rawRequest(port, p);
    assert.ok(r.status === 404 || r.status === 403, p + ' -> ' + r.status);
  }
});

test('live: security headers are present on every static response (RADIOAPP-008)', async () => {
  for (const p of ['/', '/app.js', '/manifest.webmanifest']) {
    const r = await rawRequest(port, p);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff', p);
    assert.strictEqual(r.headers['x-frame-options'], 'DENY', p);
    assert.strictEqual(r.headers['referrer-policy'], 'no-referrer', p);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/, p);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/, p);
    assert.match(r.headers['content-security-policy'], /object-src 'none'/, p);
  }
});

test('live: the CSP allows every third party the app actually uses (RADIOAPP-008)', async () => {
  const r = await rawRequest(port, '/');
  const csp = r.headers['content-security-policy'];
  assert.match(csp, /script-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
  assert.match(csp, /style-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
  assert.match(csp, /connect-src[^;]*https:\/\/api\.openmhz\.com/);
  assert.match(csp, /connect-src[^;]*wss:\/\/api\.openmhz\.com/);
  assert.match(csp, /connect-src[^;]*https:\/\/ipwho\.is/);
  assert.match(csp, /img-src[^;]*tile\.openstreetmap\.org/);
  assert.match(csp, /media-src[^;]*blob:/);
  // app.js:1447 sets isLocalApi = false, so audio is fetched directly from the
  // host OpenMHz names. media-src must not be narrowed to a guessed host list.
  assert.match(csp, /media-src[^;]*https:/,
    'media-src must permit https audio from the OpenMHz-supplied host');
  assert.ok(!/media-src[^;]*http:/.test(csp), 'media-src must not permit plain http');
});

test('live: neither HTML page ships an inline script, so the strict CSP holds (RADIOAPP-006/014)', async () => {
  for (const p of ['/index.html', '/mobile.html']) {
    const r = await rawRequest(port, p);
    const inline = r.body.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi);
    assert.ok(!inline, p + ' has an inline <script>: ' + JSON.stringify(inline));
  }
});

test('live: both pages now register the service worker from app.js (RADIOAPP-014)', async () => {
  const app = await rawRequest(port, '/app.js');
  assert.match(app.body, /serviceWorker\.register\('\/sw\.js'\)/);
  const mobile = await rawRequest(port, '/mobile.html');
  assert.ok(!/navigator\.serviceWorker\.register/.test(mobile.body), 'mobile.html should not inline it');
});

test('live: index.html declares an icon and the manifest, so /favicon.ico is never requested (RADIOAPP-013)', async () => {
  const r = await rawRequest(port, '/');
  assert.match(r.body, /<link rel="icon"[^>]*href="icon\.svg"/);
  assert.match(r.body, /<link rel="manifest"[^>]*href="manifest\.webmanifest"/);
});

test('live: the service worker precache list no longer contains a 404 (RADIOAPP-006)', async () => {
  const sw = await rawRequest(port, '/sw.js');
  assert.match(sw.body, /allSettled/);
  const shell = sw.body.match(/const APP_SHELL = \[([\s\S]*?)\];/)[1]
    .split('\n')
    .map((s) => (s.match(/'([^']+)'/) || [])[1])
    .filter(Boolean);
  assert.ok(shell.length >= 8, 'precache list should still cover the app shell');
  assert.ok(!shell.includes('/socket.io/socket.io.js'), 'dead precache entry still present');
  for (const entry of shell) {
    const r = await rawRequest(port, entry);
    assert.strictEqual(r.status, 200, 'precached ' + entry + ' -> ' + r.status);
  }
});

test('live: /proxy refuses private destinations and bad protocols (RADIOAPP-003/004)', async () => {
  const denied = [
    'http://127.0.0.1:' + port + '/',
    'http://localhost:' + port + '/',
    'http://192.168.4.110/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'file:///C:/Windows/win.ini',
    'gopher://127.0.0.1/',
  ];
  for (const u of denied) {
    const r = await rawRequest(port, '/proxy?url=' + encodeURIComponent(u));
    assert.ok(r.status === 400 || r.status === 403, u + ' -> ' + r.status);
  }
  const missing = await rawRequest(port, '/proxy');
  assert.strictEqual(missing.status, 400);
});

test('live: a DNS name that resolves inward is refused (RADIOAPP-003)', async (t) => {
  // nip.io maps 127.0.0.1.nip.io straight to loopback; skip if it does not resolve here.
  const dns = require('node:dns').promises;
  let addrs;
  try { addrs = await dns.lookup('127.0.0.1.nip.io', { all: true }); }
  catch { t.skip('nip.io does not resolve from this host'); return; }
  assert.ok(addrs.some((a) => serve.isPrivateAddr(a.address)), 'precondition: nip.io resolves to a private address');
  const r = await rawRequest(port, '/proxy?url=' + encodeURIComponent('http://127.0.0.1.nip.io:' + port + '/app.js'));
  assert.strictEqual(r.status, 403, 'DNS-rebinding bypass must be refused');
});

test('live: a cross-site Origin cannot borrow the proxy (RADIOAPP-004)', async () => {
  const r = await rawRequest(port, '/proxy?url=' + encodeURIComponent('https://example.com/'), {
    origin: 'https://evil.example',
  });
  assert.strictEqual(r.status, 403);
});

test('live: security headers are absent from proxy responses but CORS is present (RADIOAPP-004/008)', async () => {
  const r = await rawRequest(port, '/proxy');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.headers['access-control-allow-origin'], '*');
  assert.strictEqual(r.headers['access-control-max-age'], '600');
});
