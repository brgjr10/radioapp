const fs = require('fs');
const citiesSrc = fs.readFileSync('ohio-cities.js', 'utf8');
const m = citiesSrc.match(/window\.OHIO_PLACES\s*=\s*(\[[\s\S]*?\]);/);
const OHIO_PLACES = eval('(' + m[1] + ')');

const html = fs.readFileSync('talkgroups.txt', 'utf8');
const raw = [...html.matchAll(/<span class="text">([^<]+)<\/span>/g)]
  .map((x) => x[1].replace(/&amp;/g, '&').trim());
const seen = new Set();
const tgs = [];
for (const n of raw) { if (!seen.has(n)) { seen.add(n); tgs.push(n); } }

function normText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const MIN = 4;
const idx = OHIO_PLACES
  .map((p) => ({ n: normText(p.n), la: p.la, lo: p.lo }))
  .filter((p) => p.n.length >= MIN)
  .sort((a, b) => b.n.length - a.n.length);

// A talkgroup is "unmapped" if its title does not name a specific Ohio
// city/county — it therefore falls back to the Summit County center dot.
function matchPlace(text) {
  const norm = normText(text);
  if (!norm) return null;
  const hay = ' ' + norm + ' ';
  for (const p of idx) {
    if (hay.indexOf(' ' + p.n + ' ') !== -1) return p;
  }
  return null;
}

const unmatched = tgs.filter((tg) => !matchPlace(tg));
fs.writeFileSync('unmapped-talkgroups.txt', unmatched.join('\n') + '\n');
console.log('total talkgroups:', tgs.length, '| unmapped (no specific city):', unmatched.length);
