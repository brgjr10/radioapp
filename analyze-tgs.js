const fs = require('fs');
const path = require('path');

// Load OHIO_PLACES from ohio-cities.js
const citiesSrc = fs.readFileSync(path.join(__dirname, 'ohio-cities.js'), 'utf8');
const m = citiesSrc.match(/window\.OHIO_PLACES\s*=\s*(\[[\s\S]*?\]);/);
if (!m) { console.error('Could not extract OHIO_PLACES'); process.exit(1); }
const OHIO_PLACES = eval('(' + m[1] + ')');

// Load talkgroups.txt and extract names
const html = fs.readFileSync(path.join(__dirname, 'talkgroups.txt'), 'utf8');
const tgMatches = [...html.matchAll(/<span class="text">([^<]+)<\/span>/g)];
const talkgroups = tgMatches.map((_, i, arr) => {
  // Some spans may appear inside other markup; the regex matches all spans
  // We just want the text inside each <span class="text">
  return arr[i][1].trim();
});

// deduplicate while preserving order
const seen = new Set();
const uniqueTGs = [];
for (const name of talkgroups) {
  if (!seen.has(name)) { seen.add(name); uniqueTGs.push(name); }
}

// ---- replicate the matching logic from app.js ----

function normText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const MIN_PLACE_LEN = 4;
const CITY_JITTER = 0.008;

const TG_ALIASES = {
  cuyfalls: 'Cuyahoga Falls',
  munfalls: 'Munroe Falls',
};

const PLACE_OVERRIDES = {};

const ZONE_COUNTIES = ['Adams','Allen','Ashland','Ashtabula','Athens','Auglaize','Belmont','Brown','Butler','Carroll','Champaign','Clark','Clermont','Clinton','Columbiana','Coshocton','Crawford','Cuyahoga','Darke','Defiance','Delaware','Erie','Fairfield','Fayette','Franklin','Fulton','Gallia','Geauga','Greene','Guernsey','Hamilton','Hancock','Hardin','Harrison','Henry','Highland','Hocking','Holmes','Huron','Jackson','Jefferson','Knox','Lake','Lawrence','Licking','Logan','Lorain','Lucas','Madison','Mahoning','Marion','Medina','Meigs','Mercer','Miami','Monroe','Montgomery','Morgan','Morrow','Muskingum','Noble','Ottawa','Paulding','Perry','Pickaway','Pike','Portage','Preble','Putnam','Richland','Ross','Sandusky','Scioto','Seneca','Shelby','Stark','Summit','Trumbull','Tuscarawas','Union','Van Wert','Vinton','Warren','Washington','Wayne','Williams','Wood','Wyandot'];

// Build place index (longest names first)
let _placeIndex = null;
function placeIndex() {
  if (_placeIndex) return _placeIndex;
  _placeIndex = OHIO_PLACES
    .map((p) => ({ n: normText(p.n), la: p.la, lo: p.lo }))
    .filter((p) => p.n.length >= MIN_PLACE_LEN)
    .sort((a, b) => b.n.length - a.n.length);
  return _placeIndex;
}

let _placeByName = null;
function placeByName(name) {
  if (!_placeByName) {
    _placeByName = new Map();
    for (const p of placeIndex()) if (!_placeByName.has(p.n)) _placeByName.set(p.n, p);
  }
  return _placeByName.get(normText(name)) || null;
}

function abbrevIndex() {
  const idx = [];
  for (const p of placeIndex()) {
    const parts = p.n.split(' ');
    if (parts.length < 2 || parts[0].length < 3) continue;
    if (parts[parts.length - 1] === 'county') continue;
    const src = '^' + parts[0].slice(0, 3) + '[a-z]*' + parts.slice(1).join('') + '$';
    try { idx.push({ re: new RegExp(src), la: p.la, lo: p.lo, n: p.n }); } catch {}
  }
  return idx;
}

function applyOverride(p) {
  if (!p) return p;
  const o = PLACE_OVERRIDES[p.n];
  if (o) return { n: p.n, la: o.la, lo: o.lo };
  return p;
}

function zoneOf(alpha) {
  const m2 = /^[a-z]{0,3}(\d{2})/.exec(normText(alpha || ''));
  if (!m2) return null;
  const z = parseInt(m2[1], 10);
  return (z >= 1 && z <= 88) ? z : null;
}

function countyCentroid(zone) {
  if (zone < 1 || zone > 88) return null;
  const centroids = new Map();
  for (const p of placeIndex()) {
    const c = /^(.*) county$/.exec(p.n);
    if (c && !centroids.has(c[1])) centroids.set(c[1], p);
  }
  return centroids.get(ZONE_COUNTIES[zone - 1]) || null;
}

function matchPlace(text) {
  const norm = normText(text);
  if (!norm) return null;
  const tokens = norm.split(' ');

  // 1. manual aliases
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

  // 3. abbreviated multi-word places
  const abbr = abbrevIndex();
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.length < MIN_PLACE_LEN) continue;
    for (let i = 0; i < abbr.length; i++) {
      if (abbr[i].re.test(tok)) return applyOverride({ n: abbr[i].n, la: abbr[i].la, lo: abbr[i].lo });
    }
  }

  // 4. MARCS county zone
  const zone = zoneOf(text);
  if (zone) {
    const c = countyCentroid(zone);
    if (c) return { n: normText(c.n) + ' county', la: c.la, lo: c.lo };
  }

  return null;
}

// ---- run matching ----
const matched = [];
const unmatched = [];
const matchedPlaceNames = new Set();

for (const tg of uniqueTGs) {
  const place = matchPlace(tg);
  if (place) {
    matched.push({ tg, place: place.n, la: place.la, lo: place.lo });
    matchedPlaceNames.add(place.n);
  } else {
    unmatched.push(tg);
  }
}

console.log('=== MATCHED TALKGROUPS ===');
for (const m of matched) {
  console.log(`  "${m.tg}"  →  ${m.place}  (${m.la}, ${m.lo})`);
}

console.log(`\n=== UNMATCHED TALKGROUPS (${unmatched.length}) ===`);
for (const u of unmatched) {
  console.log(`  "${u}"`);
}

// Find unused cities (in OHIO_PLACES but not matched by any talkgroup)
const usedNormalized = new Set();
for (const name of matchedPlaceNames) usedNormalized.add(normText(name));

const unused = OHIO_PLACES.filter(p => !usedNormalized.has(normText(p.n)));
console.log(`\n=== UNUSED CITIES (${unused.length} of ${OHIO_PLACES.length}) ===`);
for (const c of unused) {
  console.log(`  ${c.n}  (${c.la}, ${c.lo})`);
}
