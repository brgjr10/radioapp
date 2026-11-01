'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8');
const git = (...args) => spawnSync('git', ['-C', repoRoot].concat(args), { encoding: 'utf8' });
// Comments explain why the code looks the way it does, so a source-shape guard
// has to look at code only or it trips over its own documentation.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---------- app.js persistence guards (RADIOAPP-010) ----------

test('every localStorage write in app.js goes through the guarded helper (RADIOAPP-010)', () => {
  const src = read('app.js');
  const writeLocal = src.match(/function writeLocal\([\s\S]*?\n\}/);
  assert.ok(writeLocal, 'writeLocal helper must exist');
  assert.match(writeLocal[0], /try\s*\{/, 'writeLocal must catch');
  assert.match(writeLocal[0], /QuotaExceededError|catch/, 'writeLocal must report the failure');
  assert.match(writeLocal[0], /console\.warn/, 'writeLocal must log what failed and why');

  const rawWrites = [...src.matchAll(/localStorage\.setItem\(/g)];
  // The location/focus-mode keys are single scalars, not the growing dataset,
  // so they stay direct; the dataset writers must all be routed through
  // writeLocal. Assert that none of the om_cache_/om_enabled_/om_tg_config_
  // writes remain unguarded.
  for (const m of rawWrites) {
    const tail = src.slice(m.index, m.index + 90);
    assert.ok(!/om_cache_|om_enabled_|om_tg_config_/.test(tail),
      'unguarded dataset write near: ' + tail.split('\n')[0]);
  }
  for (const key of ['om_cache_', 'om_enabled_', 'om_tg_config_']) {
    assert.match(src, new RegExp("writeLocal\\('" + key), 'save path for ' + key + ' must use writeLocal');
  }
});

test('the load paths keep their existing silent-{} fallback (no behaviour change)', () => {
  const src = read('app.js');
  for (const fn of ['loadEnabled', 'loadCache', 'loadTgConfig']) {
    const m = src.match(new RegExp('function ' + fn + '\\(\\)[\\s\\S]*?\\n\\}'));
    assert.ok(m, fn + ' must exist');
    assert.match(m[0], /catch \{ return/, fn + ' keeps its parse fallback');
  }
});

// ---------- dependency / dead code (RADIOAPP-005, RADIOAPP-019) ----------

test('the dead host backend and its smoketest are gone (RADIOAPP-019)', () => {
  assert.ok(!fs.existsSync(path.join(repoRoot, 'host-backend.js')), 'host-backend.js should be deleted');
  assert.ok(!fs.existsSync(path.join(repoRoot, 'smoketest.js')), 'smoketest.js should be deleted');
  const app = read('app.js');
  assert.ok(!/host-backend/.test(app), 'app.js must not still reference host-backend');
  // The old header claimed the host relayed every call over its own Socket.IO
  // server. The new one must not make that claim.
  const header = app.slice(0, app.indexOf("'use strict'"));
  assert.ok(!/never calls OpenMHz directly/i.test(header), 'the stale architecture claim must be gone');
  assert.match(header, /talks to OpenMHz directly/i);
});

test('package.json and the lockfile agree (RADIOAPP-005)', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.strictEqual(lock.version, pkg.version, 'lock version must match package.json');
  assert.strictEqual(lock.packages[''].version, pkg.version);
  assert.deepStrictEqual(lock.packages[''].dependencies, undefined,
    'the lock must not declare dependencies the package no longer has');
  assert.deepStrictEqual(lock.packages[''].dependencies || {}, pkg.dependencies);
  const declared = Object.keys(lock.packages).filter((k) => k !== '');
  assert.deepStrictEqual(declared, [], 'a zero-dependency project should have no locked packages');
});

test('npm ci is satisfiable from the lockfile (RADIOAPP-005)', (t) => {
  // npm shells out through cmd.exe, which rejects a UNC working directory
  // ("UNC paths are not supported"). That is a Windows/SMB sandbox limit, not a
  // repo defect, so skip rather than fail; the lockfile-shape assertions in the
  // previous test are the part that actually locks this finding down.
  if (repoRoot.startsWith('\\\\')) { t.skip('npm cannot run from a UNC working directory'); return; }
  const r = spawnSync('npm ci --dry-run --no-audit --no-fund', {
    cwd: repoRoot, encoding: 'utf8', shell: true,
  });
  assert.strictEqual(r.status, 0, 'npm ci --dry-run failed:\n' + r.stdout + r.stderr);
});

// ---------- ignore files (RADIOAPP-012, RADIOAPP-016, RADIOAPP-017) ----------

test('.dockerignore excludes secrets, runtime data and fixtures (RADIOAPP-012)', () => {
  const entries = read('.dockerignore').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const need of ['*.key', '*.crt', '*.pem', '*.pfx', '*.p12', '*.db', '*.log',
    'project.json', '.git', 'node_modules', 'ACCESS.MD', 'talkgroups.txt',
    'unmapped-talkgroups.txt', '.qa-tmp', '.kilo']) {
    assert.ok(entries.includes(need), '.dockerignore must contain ' + need);
  }
});

test('.gitignore covers the private key and the cross-project tooling artifacts (RADIOAPP-016/017)', () => {
  const entries = read('.gitignore').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const need of ['*.key', '*.crt', '*.pem', '*.pfx', '*.p12', '*.log',
    'wikijs_mappings.db', 'project.json', '.qa-tmp/']) {
    assert.ok(entries.includes(need), '.gitignore must contain ' + need);
  }
});

test('the private key is still untracked and ignored, and was never committed (RADIOAPP-016)', () => {
  const tracked = git('ls-files', '--error-unmatch', 'server.key');
  assert.notStrictEqual(tracked.status, 0, 'server.key must not be tracked');
  const ignored = git('check-ignore', '-v', 'server.key');
  assert.strictEqual(ignored.status, 0, 'server.key must be gitignored');
  const history = git('log', '--all', '--oneline', '--', 'server.key');
  assert.strictEqual(history.stdout.trim(), '', 'server.key must never have been committed');
});

// serve.js used to read server.crt at module load (RADIOAPP-015). The HTTPS
// branch is gone, so the cert is no longer needed on disk; the file is
// gitignored now and was untracked in a later commit (9c63202), which is what
// this guard asserts.
test('the cert is untracked and gitignored (RADIOAPP-016)', () => {
  const tracked = git('ls-files', '--error-unmatch', 'server.crt');
  assert.notStrictEqual(tracked.status, 0, 'server.crt must not be tracked');
  const ignored = git('check-ignore', '-v', 'server.crt');
  assert.strictEqual(ignored.status, 0, 'server.crt must be gitignored');
});

// ---------- the HTTPS branch and .env loading (RADIOAPP-015, RADIOAPP-012) ----------

test('serve.js cannot die at require time on a TLS bundle (RADIOAPP-015)', () => {
  const src = stripComments(read('serve.js'));
  // The old ternary ran https.createServer({pfx}) at module load, above the
  // require.main guard, and threw "mac verify failure" before any handler.
  for (const m of src.matchAll(/(\w+)\.createServer\(/g)) {
    assert.strictEqual(m[1], 'http',
      'serve.js must only ever construct the plain http server, found ' + m[0]);
  }
  assert.ok(!/HTTPS_PFX_PASSWORD|HTTPS_KEY|HTTPS_CERT/.test(src),
    'the removed PKCS#12/PEM variables must not be read at all');
  assert.ok(!/useHttps|https\.createServer/.test(src),
    'no https branch may survive');
  assert.match(src, /server = http\.createServer\(handleRequest\)/);
  assert.match(stripComments(read('serve.js')), /http\.createServer\(handleRequest\)/);
  assert.match(read('serve.js'), /TLS is terminated by the reverse proxy/,
    'the listen log must state where TLS actually happens');
});

test('a bogus HTTPS_PFX_PASSWORD cannot reach the server any more (RADIOAPP-015)', () => {
  const r = spawnSync(process.execPath, ['--env-file-if-exists=.env', 'serve.js'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env, {
      PORT: '0', HTTPS_PFX_PASSWORD: 'bogus-passphrase', HTTPS_KEY: './server.key',
    }),
  });
  assert.ok(!/mac verify/i.test(r.stdout + r.stderr),
    'the PKCS#12 mac verify failure must not be reachable');
  assert.ok(!/ERR_CRYPTO|secure-context/.test(r.stdout + r.stderr),
    'no TLS context may be constructed at all');
});

test('.env.example no longer advertises the deleted HTTPS variables (RADIOAPP-015)', () => {
  const env = read('.env.example');
  assert.ok(!/^HTTPS_(KEY|CERT|PFX_PASSWORD)=/m.test(env),
    '.env.example must not document a variable the server ignores');
  assert.ok(!/^HTTPS_(KEY|CERT|PFX_PASSWORD)/m.test(env),
    '.env.example must not name the removed HTTPS variables as active config');
  assert.match(env, /PROXY_ALLOW_HOSTS=/, 'the live proxy config must still be documented');
  assert.match(env, /reverse proxy/i, '.env.example must say where TLS lives');
});

test('the documented .env remediation is actually wired up (RADIOAPP-012)', () => {
  const pkg = JSON.parse(read('package.json'));
  // serve.js tells the user to "set PROXY_ALLOW_HOSTS in .env". If nothing loads
  // that file, following the documented remediation changes nothing.
  assert.match(pkg.scripts.start, /--env-file-if-exists=\.env\b/,
    'npm start must load .env via node --env-file-if-exists');
  assert.ok(!/--env-file=\.env\b(?!-)/.test(pkg.scripts.start),
    'bare --env-file hard-errors when .env is missing; use --env-file-if-exists');
  // The container entrypoint and compose must reach the same file.
  assert.match(read('Dockerfile'), /--env-file-if-exists=\.env\b/,
    'the image CMD must load .env the same way');
  assert.match(read('docker-compose.yml'), /env_file:/,
    'compose must pass a .env through to the container');
  // The flag needs Node >= 20.12; --env-file itself is 20.6, so the engines
  // floor has to follow it or `npm start` breaks on the declared minimum.
  assert.ok(/>=\s*20\.(1[2-9]|[2-9]\d)/.test(pkg.engines.node),
    'engines.node must require the version that has --env-file-if-exists');
});

test('.env is never committed or baked into the image (RADIOAPP-012)', () => {
  const tracked = git('ls-files', '--error-unmatch', '.env');
  assert.notStrictEqual(tracked.status, 0, '.env must not be tracked');
  const di = read('.dockerignore').split(/\r?\n/).map((s) => s.trim());
  assert.ok(di.includes('.env'), '.dockerignore must exclude .env (the Dockerfile does COPY . .)');
  assert.ok(di.includes('!.env.example'), '.dockerignore must keep .env.example in the image');
});

// ---------- configuration surface (RADIOAPP-009, RADIOAPP-024) ----------

test('the hand-maintained compose file sets only env vars the server reads (RADIOAPP-009)', () => {
  const src = read('serve.js');
  const text = read('docker-compose.yml');
  for (const name of [...text.matchAll(/^\s{4,}([A-Z][A-Z0-9_]+):/gm)].map((x) => x[1])) {
    assert.ok(src.includes('process.env.' + name),
      'docker-compose.yml sets ' + name + ' but serve.js never reads it');
  }
  // The CasaOS manifests are generated by the CasaOS UI and still carry the
  // inert OM_* trio plus base-image vars, so the guard against the operational
  // trap is documentation: README must say explicitly that they are not read.
  const readme = read('README.md');
  for (const name of ['OM_API', 'OM_SYSTEM', 'OM_ALLOW_DIRECT']) {
    assert.ok(readme.includes(name), 'README must name the inert var ' + name);
  }
  assert.match(readme, /are \*\*not\*\*\s+read by the server/,
    'README must state plainly that the CasaOS OM_* vars are not read by the server');
});

test('ALLOW_PRIVATE_PROXY, HOST, PROXY_ALLOW_HOSTS and PROXY_MAX_CONCURRENT are all honoured (RADIOAPP-009/024)', () => {
  const src = read('serve.js');
  for (const v of ['ALLOW_PRIVATE_PROXY', 'HOST', 'PROXY_ALLOW_HOSTS', 'PROXY_MAX_CONCURRENT', 'PORT']) {
    assert.ok(src.includes('process.env.' + v), v + ' must be read from the environment');
  }
  // ALLOW_PRIVATE_PROXY must gate the address check, not just be read.
  assert.match(src, /if \(ALLOW_PRIVATE_PROXY\)/,
    'the private-address check must be conditional on ALLOW_PRIVATE_PROXY');
  // the bind address must be passed to listen, not hardcoded
  assert.match(src, /server\.listen\(port, host,/,
    'listen() must use the HOST value so the bind is visible in code');
});

test('the README documents every environment variable the server reads (RADIOAPP-009)', () => {
  const readme = read('README.md');
  for (const v of ['ALLOW_PRIVATE_PROXY', 'PROXY_ALLOW_HOSTS', 'PROXY_MAX_CONCURRENT', 'HOST', 'PORT']) {
    assert.ok(readme.includes(v), 'README must document ' + v);
  }
  assert.ok(/not\s+\*\*read\*\s+by the server|are \*\*not\*\*/.test(readme)
    || /OM_API/.test(readme), 'README should address the inert compose env vars');
  assert.ok(readme.includes('npm test'), 'README must document how to run the tests');
});

test('Brodie\'s untracked WIP files are still present and untouched (QA_REPORT section 8)', () => {
  for (const f of ['project.json', 'wikijs_mappings.db']) {
    assert.ok(fs.existsSync(path.join(repoRoot, f)), f + ' must not be deleted by a fix agent');
  }
  const untracked = git('status', '--porcelain');
  // project.json / wikijs_mappings.db are now ignored, so they no longer appear
  // as ??; what matters is that they still exist on disk and are not modified
  // tracked files. Assert no tracked file outside the fix set is dirty.
  const dirty = untracked.stdout.split(/\r?\n/)
    .filter((l) => l.startsWith(' M') || l.startsWith('M ') || l.startsWith(' D') || l.startsWith('D '));
  const allowed = [
    'serve.js', 'app.js', 'sw.js', 'index.html', 'mobile.html', 'README.md',
    'dedupe-cities.js', 'list-unmapped.js', 'analyze-tgs.js', 'build-ohio-cities.js',
    'package.json', 'package-lock.json', '.gitignore', '.dockerignore',
    'docker-compose.yml', 'host-backend.js', 'smoketest.js',
    // RADIOAPP-015 removed the broken HTTPS branch, so .env.example stopped
    // documenting HTTPS_*/HTTPS_PFX_PASSWORD; the .env remediation (RADIOAPP-012)
    // needs --env-file in the image entrypoint and in compose.
    '.env.example', 'Dockerfile',
    // The suite itself is part of the fix set: it gains a regression guard for
    // every finding above, so it is expected to be dirty while a fix is in flight.
    'test/serve.test.js', 'test/generators.test.js', 'test/hygiene.test.js',
    // Generated data and fixtures live on an NTFS-through-FUSE mount, which
    // rewrites CRLF->LF on read; they show as fully-modified on every checkout
    // and are not part of any fix in flight.
    'ohio-cities.js', 'unmapped-talkgroups.txt',
    // Map tile attribution styling for the dark theme (RADIOAPP-008).
    'styles.css',
  ];
  for (const line of dirty) {
    const f = line.slice(3).trim().replace(/^"/, '').replace(/"$/, '');
    assert.ok(allowed.includes(f), 'unexpected dirty tracked file: ' + f);
  }
});
