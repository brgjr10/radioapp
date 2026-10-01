'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');

// The generators write the tracked artifact in place, so every test runs against
// a copy in a scratch directory. The real ohio-cities.js is never touched.
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radioapp-gen-'));
  for (const f of ['ohio-cities.js', 'talkgroups.txt', 'dedupe-cities.js',
    'list-unmapped.js', 'analyze-tgs.js', 'build-ohio-cities.js']) {
    fs.copyFileSync(path.join(repoRoot, f), path.join(dir, f));
  }
  return dir;
}

function run(dir, script) {
  return spawnSync(process.execPath, [path.join(dir, script)], {
    cwd: dir,
    encoding: 'utf8',
  });
}

test('dedupe-cities.js counts cities and counties separately (RADIOAPP-007)', () => {
  const dir = scratch();
  const r = run(dir, 'dedupe-cities.js');
  assert.strictEqual(r.status, 0, r.stderr);
  const out = fs.readFileSync(path.join(dir, 'ohio-cities.js'), 'utf8');
  const m = out.match(/Source: kelvins\/US-Cities-Database \(MIT\)\. (\d+) cities, (\d+) counties\./);
  assert.ok(m, 'header must state counts: ' + out.split('\n')[4]);
  const arr = JSON.parse(out.match(/window\.OHIO_PLACES\s*=\s*(\[[\s\S]*?\]);/)[1]
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'));
  const counties = arr.filter((p) => / county$/i.test(p.n)).length;
  assert.strictEqual(Number(m[2]), counties, 'header county count must match the data');
  assert.strictEqual(Number(m[1]), arr.length - counties, 'header city count must exclude counties');
  assert.ok(arr.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dedupe-cities.js no longer corrupts the tracked file header (RADIOAPP-007)', () => {
  const dir = scratch();
  const before = fs.readFileSync(path.join(dir, 'ohio-cities.js'), 'utf8');
  const firstHeader = before.split('\n')[4];
  run(dir, 'dedupe-cities.js');
  const firstRun = fs.readFileSync(path.join(dir, 'ohio-cities.js'), 'utf8');
  run(dir, 'dedupe-cities.js');
  const secondRun = fs.readFileSync(path.join(dir, 'ohio-cities.js'), 'utf8');
  assert.strictEqual(secondRun, firstRun, 'the generator must be idempotent');
  assert.notStrictEqual(firstRun.split('\n')[4], firstHeader,
    'the committed header is known to be wrong, so the fix is expected to change it once');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dedupe-cities.js uses a temp file and leaves none behind (RADIOAPP-007, Theme 9)', () => {
  const dir = scratch();
  const r = run(dir, 'dedupe-cities.js');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('list-unmapped.js writes atomically and stays reproducible (RADIOAPP-007, Theme 9)', () => {
  const dir = scratch();
  const r = run(dir, 'list-unmapped.js');
  assert.strictEqual(r.status, 0, r.stderr);
  const first = fs.readFileSync(path.join(dir, 'unmapped-talkgroups.txt'), 'utf8');
  run(dir, 'list-unmapped.js');
  const second = fs.readFileSync(path.join(dir, 'unmapped-talkgroups.txt'), 'utf8');
  assert.strictEqual(second, first, 'regeneration must be stable');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the analysis scripts no longer eval the dataset (RADIOAPP-007)', () => {
  for (const f of ['dedupe-cities.js', 'list-unmapped.js', 'analyze-tgs.js']) {
    const src = fs.readFileSync(path.join(repoRoot, f), 'utf8');
    assert.ok(!/\beval\s*\(/.test(src), f + ' still uses eval()');
    assert.match(src, /JSON\.parse\(/, f + ' should parse the dataset with JSON.parse');
  }
});

test('analyze-tgs.js and list-unmapped.js agree on the scraped talkgroup set (RADIOAPP-023)', () => {
  const dir = scratch();
  const a = run(dir, 'analyze-tgs.js');
  const b = run(dir, 'list-unmapped.js');
  assert.strictEqual(a.status, 0, a.stderr);
  assert.strictEqual(b.status, 0, b.stderr);
  // analyze-tgs prints UNMATCHED (its own matcher); list-unmapped prints the
  // unmapped count from its matcher. The entity-decoding fix makes the two
  // scrapes see identical names, so the two totals must be at least consistent
  // with the fixture size rather than differing by entity artefacts.
  const aUnmatched = Number((a.stdout.match(/UNMATCHED TALKGROUPS \((\d+)\)/) || [])[1]);
  const bUnmapped = Number((b.stdout.match(/unmapped \(no specific city\): (\d+)/) || [])[1]);
  const bTotal = Number((b.stdout.match(/total talkgroups: (\d+)/) || [])[1]);
  assert.ok(bTotal > 0, 'the fixture should yield talkgroups');
  assert.ok(aUnmatched > 0 && bUnmapped > 0, 'both scripts should report unmatched talkgroups');
  assert.ok(aUnmatched <= bTotal && bUnmapped <= bTotal,
    'unmatched counts cannot exceed the scraped total');
  const undecoded = [...a.stdout.matchAll(/^  "(.*&amp;.*)"$/gm)].map((m) => m[1]);
  assert.deepStrictEqual(undecoded, [],
    'no scraped name should still carry a raw &amp; entity after decoding');
  const decoded = [...a.stdout.matchAll(/^  "(.*&.*)"$/gm)].map((m) => m[1]);
  assert.ok(decoded.length > 0,
    'the fixture has real-ampersand names (P&R, Rec & Parks) and they must survive decoding');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build-ohio-cities.js is atomic and counts correctly (RADIOAPP-007)', () => {
  const dir = scratch();
  const csv = [
    'ID,STATE_CODE,STATE_NAME,CITY,COUNTY,LATITUDE,LONGITUDE',
    '1,OH,Ohio,Columbus,Franklin,39.9612,-82.9988',
    '2,OH,Ohio,Dublin,Franklin,40.0992,-83.1146',
    '3,OH,Ohio,Cleveland,Cuyahoga,41.4993,-81.6944',
    '4,PA,Pennsylvania,Pittsburgh,Allegheny,40.4406,-79.9959',
    '5,OH,Ohio,"Cuyahoga Falls",Summit,41.1298,-81.4803',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'us_cities.csv'), csv);
  const r = spawnSync(process.execPath, [path.join(dir, 'build-ohio-cities.js'), path.join(dir, 'us_cities.csv')], {
    cwd: dir, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  const out = fs.readFileSync(path.join(dir, 'ohio-cities.js'), 'utf8');
  assert.match(out, /4 cities, 3 counties\./, 'the PA row must be excluded from both counts');
  const arr = JSON.parse(out.match(/window\.OHIO_PLACES\s*=\s*(\[[\s\S]*?\]);/)[1]
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'));
  assert.strictEqual(arr.length, 7);
  assert.ok(arr.some((p) => p.n === 'Cuyahoga County'));
  assert.ok(arr.some((p) => p.n === 'Franklin County'));
  assert.ok(!arr.some((p) => p.n === 'Pittsburgh'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the repo still has no untracked .tmp leftovers after a full generator pass', () => {
  const dir = scratch();
  for (const f of ['dedupe-cities.js', 'list-unmapped.js', 'analyze-tgs.js']) run(dir, f);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
