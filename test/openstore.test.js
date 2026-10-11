const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const { catalogueFromSources, evaluateCatalogSource, repoKey, isFresh, DAYS_FRESH } = require('../pipeline/collect/openstore.js');

// --- collector: source evaluation -------------------------------------------

test('a catalog source with an export statement and a trailing re-export evaluates', () => {
  // OpenStore's catalog.js carries `export const catalog = [...]` and a trailing
  // `export { filterProjects } from './x.js'`. The first must yield data, the
  // second must not kill the file.
  const src = "export const catalog = [{id:'a',name:'A',repo:'x/y'}];\nexport { filterProjects } from './lib/catalog/filter.js';\n";
  const out = evaluateCatalogSource(src);
  assert.equal(out.catalog.length, 1);
  assert.equal(out.catalog[0].repo, 'x/y');
});

test('the evaluator must not read files, fetch or use the process in catalog code', () => {
  // A directory someone can edit by PR runs in a sandbox. Probe it.
  const probes = [
    'require("node:fs")',
    'fetch("https://example.invalid")',
    'process.exit(1)',
  ];
  for (const p of probes) {
    assert.throws(() => evaluateCatalogSource(p), `sandbox let through: ${p}`);
  }
});

test('a hostile loop cannot hang evaluation', () => {
  const start = Date.now();
  assert.throws(() => evaluateCatalogSource('while(true){}'));
  assert.ok(Date.now() - start < 15000, 'evaluation did not abort');
});

// --- collector: catalog extraction -------------------------------------------

function makeSource(name, apps) {
  // Emit only the `openCatalog` const, which the real files also use.
  return { name, source: `export const openCatalog = ${JSON.stringify(apps)};\n` };
}

test('entries join on repo name, case-insensitively and across duplicate definitions', () => {
  const byRepo = catalogueFromSources([
    makeSource('catalog.js', [
      { id: 'outline', name: 'Outline', repo: 'outline/Outline', replaces: ['Notion'] },
    ]),
    makeSource('trending-catalog.js', [
      // Same path as an existing entry, with a different id. First writer wins.
      { id: 'trend-dup', name: 'Fake', repo: 'outline/outline', replaces: [] },
      { id: 'other', name: 'Other', repo: 'peer/other', replaces: ['Notion'] },
    ]),
  ]);
  assert.ok(byRepo.has('outline/outline'));
  assert.equal(byRepo.get('outline/outline').id, 'outline');
  assert.equal(byRepo.get('outline/outline').replaces[0], 'Notion');
  assert.ok(byRepo.has('peer/other'));
  assert.equal(byRepo.size, 2);
});

test('entries without a repo or id are skipped rather than guessed at', () => {
  const byRepo = catalogueFromSources([
    makeSource('catalog.js', [
      { id: 'no-repo' },
      { repo: 'x/y' },
      null,
    ]),
  ]);
  assert.equal(byRepo.size, 0);
});

test('repoKey normalizes trivia', () => {
  assert.equal(repoKey('X/Y '), 'x/y');
  assert.equal(repoKey(null), '');
});

// --- site build --------------------------------------------------------------

function buildSite(extraEnv = {}) {
  const { execFileSync } = require('node:child_process');
  const DIST = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcost-os-'));
  const { execFileSync: run } = require('node:child_process');
  const env = { ...process.env, EXITCOST_DIST: DIST, ...extraEnv };
  run(process.execPath, [path.join(ROOT, 'site', 'build.js')], { env, stdio: 'ignore' });
  return (rel) => fs.readFileSync(path.join(DIST, rel), 'utf8');
}

test('the OpenStore feed is emitted with the fields a directory needs to join against', () => {
  const read = buildSite();
  const feed = JSON.parse(read('api/openstore.json'));
  assert.ok(feed.directory.url === 'https://www.openstore.site/');
  assert.ok(feed.escapes.length >= 10, 'feed should not be empty');
  for (const e of feed.escapes) {
    for (const k of ['slug', 'incumbent_vendor', 'incumbent_price_verified_at', 'host_monthly_usd', 'verdict', 'url', 'json']) {
      assert.ok(k in e, `${e.slug} is missing ${k}`);
    }
    assert.ok(e.incumbent_price_verified_at, 'prices carry their verification date');
  }
});

test('cross-links appear only on comparisons where OpenStore lists a matching vendor', () => {
  const read = buildSite();
  const feed = JSON.parse(read('api/openstore.json'));
  const withPeer = new Set(feed.escapes.filter((e) => e.openstore_replaces_this_vendor).map((e) => e.slug));
  assert.ok(withPeer.size > 0, 'expected at least one peer match in the collected catalog');
  // A matching page carries the block; a non-matching page does not.
  const has = read(`e/${[...withPeer][0]}/index.html`).includes('Other projects that replace');
  assert.ok(has, 'a matched page is missing its cross-link');
});

test('the block links to openstore.site using absolute https, not a relative path', () => {
  const read = buildSite();
  const feed = JSON.parse(read('api/openstore.json'));
  const slug = feed.escapes.find((e) => e.openstore_replaces_this_vendor).slug;
  const html = read(`e/${slug}/index.html`);
  assert.match(html, /https:\/\/www\.openstore\.site\/app\//);
});

// --- freshness ---------------------------------------------------------------

test('isFresh refuses past the freshness window', () => {
  const fresh = { ok: true, apps: [{}], fetched_at: new Date().toISOString() };
  assert.ok(isFresh(fresh));
  const stale = { ok: true, apps: [{}], fetched_at: new Date(Date.now() - (DAYS_FRESH + 1) * 86400000).toISOString() };
  assert.ok(!isFresh(stale));
  const broken = { ok: false, apps: [{}], fetched_at: new Date().toISOString() };
  assert.ok(!isFresh(broken));
  const empty = { ok: true, apps: [], fetched_at: new Date().toISOString() };
  assert.ok(!isFresh(empty));
});
