const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const vps = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sources', 'vps.json'), 'utf8'));

let built = false;
function build(slug) {
  if (!built) {
    execFileSync(NODE, [path.join(ROOT, 'pipeline', 'render', 'build.js')],
      { env: { ...process.env, EXITCOST_NOW: vps.fetched_at }, stdio: 'ignore' });
    built = true;
  }
  execFileSync(NODE, [path.join(ROOT, 'video', 'build.js'), slug], { stdio: 'ignore' });
  return fs.readFileSync(path.join(ROOT, 'video', 'out', slug, 'index.html'), 'utf8');
}
const model = (slug) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'build', 'escapes', `${slug}.json`), 'utf8'));

const money0 = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
const money2 = (n) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

for (const slug of ['notion-to-outline', 'auth0-to-keycloak', 'airtable-to-baserow']) {
  test(`INTEGRITY: the video quotes the same figures as the page — ${slug}`, () => {
    const html = build(slug);
    const e = model(slug);
    const r = e.result;

    assert.ok(html.includes(money0(r.incumbent.annual)), 'the subscription cost differs from the page');
    assert.ok(html.includes(money0(r.alternative.cash_monthly * 12)), 'the hosting cost differs from the page');
    assert.ok(html.includes(money2(r.alternative.monthly)), 'the monthly total differs from the page');
    if (r.break_even_hourly_rate !== null && r.break_even_hourly_rate > 0) {
      assert.ok(html.includes(money2(r.break_even_hourly_rate)), 'the crossover rate differs from the page');
    }
  });
}

test('the video states the verdict the page reached, not a more flattering one', () => {
  const stay = build('auth0-to-keycloak');
  assert.equal(model('auth0-to-keycloak').result.verdict, 'stay');
  assert.match(stay, /Keep paying\./, 'a "stay" comparison must say so in the video too');
  assert.doesNotMatch(stay, /Leave it\./);

  const sw = build('airtable-to-baserow');
  assert.equal(model('airtable-to-baserow').result.verdict, 'switch');
  assert.match(sw, /Leave it\./);
});

test('the composition satisfies the render contract', () => {
  const html = build('notion-to-outline');
  assert.match(html, /data-composition-id="short"/);
  assert.match(html, /data-width="1080"[\s\S]*?data-height="1920"/);
  assert.match(html, /window\.__timelines\['short'\]/, 'the timeline must be registered under the composition id');
  assert.match(html, /gsap\.timeline\(\{ paused: true \}\)/, 'the timeline must be built paused for seeking');
  assert.doesNotMatch(html, /repeat:\s*-1/, 'an infinite repeat has no finite duration to render');
  assert.doesNotMatch(html, /Math\.random\(\)/, 'a render must be reproducible from its time value alone');
  assert.doesNotMatch(html, /Date\.now\(\)/, 'no render-time clocks');
  // Every clip needs its timing attributes or it will not appear.
  const clips = [...html.matchAll(/<section[^>]*class="clip"[^>]*>/g)].map((m) => m[0]);
  assert.ok(clips.length >= 5);
  for (const c of clips) {
    assert.match(c, /data-start="/);
    assert.match(c, /data-duration="/);
    assert.match(c, /data-track-index="/);
    assert.match(c, /id="/, 'every clip needs a stable id');
  }
});

test('the video links to the live site rather than a placeholder', () => {
  const html = build('notion-to-outline');
  assert.match(html, /nimbussage\.github\.io\/exit-cost|exitcost/, 'the closing card must carry a real address');
});
