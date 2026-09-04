const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
// Own output directory — test files run in parallel and both build the site.
const DIST = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcost-site-'));
const NODE = process.execPath;

/**
 * The site is generated from data/build/, which is not committed. Rather than
 * depend on a previous command having run, these tests regenerate it — pinning
 * the clock to the date the committed pricing was collected, so the suite does
 * not start failing as that data ages.
 */
const vps = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sources', 'vps.json'), 'utf8'));
const PINNED_NOW = vps.fetched_at;

let prepared = false;
function prepare() {
  if (prepared) return;
  execFileSync(NODE, [path.join(ROOT, 'pipeline', 'render', 'build.js')],
    { env: { ...process.env, EXITCOST_NOW: PINNED_NOW }, stdio: 'ignore' });
  prepared = true;
}

function buildWith(siteUrl) {
  prepare();
  execFileSync(NODE, [path.join(ROOT, 'site', 'build.js')], { env: { ...process.env, SITE_URL: siteUrl, EXITCOST_DIST: DIST }, stdio: 'ignore' });
  return (rel) => fs.readFileSync(path.join(DIST, rel), 'utf8');
}

/** Every root-relative href/src the generator emitted. */
function internalRefs(html) {
  return [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
}

test('a subpath deploy prefixes every internal link with the base path', () => {
  const read = buildWith('https://nimbussage.github.io/exit-cost');
  for (const page of ['index.html', 'method/index.html', 'e/notion-to-outline/index.html']) {
    for (const ref of internalRefs(read(page))) {
      assert.ok(ref.startsWith('/exit-cost/'), `${page}: ${ref} is not under the base path`);
    }
  }
});

test('every internal link resolves to a file that exists', () => {
  const read = buildWith('https://nimbussage.github.io/exit-cost');
  const seen = new Set();
  for (const page of ['index.html', 'method/index.html', 'e/notion-to-outline/index.html', 'e/auth0-to-keycloak/index.html']) {
    for (const ref of internalRefs(read(page))) {
      const rel = ref.replace(/^\/exit-cost\//, '');
      const target = rel.endsWith('/') ? path.join(DIST, rel, 'index.html') : path.join(DIST, rel);
      if (seen.has(target)) continue;
      seen.add(target);
      assert.ok(fs.existsSync(target), `${page} links to ${ref}, which does not exist`);
    }
  }
  assert.ok(seen.size >= 6, 'expected several distinct internal links to check');
});

test('a root-domain deploy emits no base path', () => {
  const read = buildWith('https://exitcost.dev');
  const refs = internalRefs(read('index.html'));
  assert.ok(refs.includes('/assets/style.css'));
  assert.ok(!refs.some((r) => r.startsWith('/exit-cost/')));
});

test('canonical URLs and the sitemap use the configured site URL', () => {
  const read = buildWith('https://exitcost.dev');
  assert.match(read('index.html'), /<link rel="canonical" href="https:\/\/exitcost\.dev\/">/);
  assert.match(read('e/notion-to-outline/index.html'), /canonical" href="https:\/\/exitcost\.dev\/e\/notion-to-outline\/"/);
  const sm = read('sitemap.xml');
  assert.match(sm, /<loc>https:\/\/exitcost\.dev\/<\/loc>/);
  assert.ok((sm.match(/<loc>/g) || []).length >= 12);
});

test('every page carries the affiliate disclosure', () => {
  const read = buildWith('https://exitcost.dev');
  for (const page of ['index.html', 'method/index.html', 'e/notion-to-outline/index.html']) {
    assert.match(read(page), /Affiliate disclosure/, `${page} is missing the FTC disclosure`);
  }
});

test('a "stay" page reads as a recommendation to stay, not a soft sell', () => {
  const read = buildWith('https://exitcost.dev');
  const html = read('e/auth0-to-keycloak/index.html');
  assert.match(html, /verdict-line v-stay/);
  assert.match(html, /<span class="verdict-word">Stay\.<\/span>/);
  assert.match(html, /costs you/);
  assert.doesNotMatch(html, /breaks even, month/);
});

test('links to affiliate-eligible providers are marked rel="sponsored"', () => {
  const read = buildWith('https://exitcost.dev');
  const html = read('e/notion-to-outline/index.html');
  const vultr = html.match(/<a href="[^"]*vultr[^"]*"[^>]*>/i);
  assert.ok(vultr, 'expected a link to the hosting provider');
  assert.match(vultr[0], /rel="sponsored nofollow"/);
});

test('structured data is present and well formed on an escape page', () => {
  const read = buildWith('https://exitcost.dev');
  const m = read('e/notion-to-outline/index.html').match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'no JSON-LD block');
  const ld = JSON.parse(m[1]);
  assert.equal(ld['@type'], 'Article');
  assert.ok(ld.about.length === 2);
  assert.equal(ld.about[0].offers.priceCurrency, 'USD');
});

test('the public API lists every published comparison with an absolute URL', () => {
  const read = buildWith('https://exitcost.dev');
  const api = JSON.parse(read('api/index.json'));
  assert.ok(api.count >= 10);
  assert.equal(api.escapes.length, api.count);
  for (const e of api.escapes) {
    assert.match(e.url, /^https:\/\/exitcost\.dev\/e\//);
    assert.ok(fs.existsSync(path.join(DIST, 'api', 'escapes', `${e.slug}.json`)));
  }
});

test('the index orders each group by the crossover rate, not alphabetically', () => {
  const read = buildWith('https://exitcost.dev');
  const html = read('index.html');
  const nums = [...html.matchAll(/class="idx-num">([^<]*)<span class="idx-verdict v-(\w+)-t"/g)]
    .map((m) => ({ raw: m[1].trim(), verdict: m[2] }));
  const parse = (r) => (r === '—' ? null : parseFloat(r.replace(/[$,]/g, '')));

  const sw = nums.filter((n) => n.verdict === 'switch').map((n) => parse(n.raw));
  assert.ok(sw.length >= 10);
  for (let i = 1; i < sw.length; i++) {
    assert.ok(sw[i] <= sw[i - 1], `switch list is not descending at ${i}: ${sw[i - 1]} then ${sw[i]}`);
  }

  const stay = nums.filter((n) => n.verdict === 'stay').map((n) => parse(n.raw)).filter((v) => v !== null);
  for (let i = 1; i < stay.length; i++) {
    assert.ok(stay[i] >= stay[i - 1], `stay list is not ascending at ${i}: ${stay[i - 1]} then ${stay[i]}`);
  }
});
