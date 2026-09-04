const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cheapestMeeting } = require('../pipeline/collect/merge.js');

const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
// Its own output directory: this file mutates data/affiliates.json and rebuilds,
// and test files run in parallel, so it must not share site/dist with anything.
const DIST = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcost-aff-'));
const AFF = path.join(ROOT, 'data', 'affiliates.json');
const NODE = process.execPath;

const original = fs.readFileSync(AFF, 'utf8');
const vps = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sources', 'vps.json'), 'utf8'));

function rebuild() {
  execFileSync(NODE, [path.join(ROOT, 'pipeline', 'render', 'build.js')],
    { env: { ...process.env, EXITCOST_NOW: vps.fetched_at }, stdio: 'ignore' });
  execFileSync(NODE, [path.join(ROOT, 'site', 'build.js')],
    { env: { ...process.env, SITE_URL: 'https://exitcost.dev', EXITCOST_DIST: DIST }, stdio: 'ignore' });
}
const page = (slug) => fs.readFileSync(path.join(DIST, 'e', slug, 'index.html'), 'utf8');

function withProgram(program, fn) {
  fs.writeFileSync(AFF, JSON.stringify({ schema_version: 1, programs: [program] }, null, 2));
  try { rebuild(); fn(); } finally { fs.writeFileSync(AFF, original); rebuild(); }
}

test('with no active program, provider links are the plain vendor URLs', () => {
  // Controls its own data rather than depending on what the repo currently
  // ships — otherwise adding a real program breaks a test about the empty case.
  fs.writeFileSync(AFF, JSON.stringify({ schema_version: 1, programs: [] }, null, 2));
  try {
    rebuild();
    const html = page('airtable-to-baserow');
    assert.match(html, /href="https:\/\/www\.vultr\.com\/pricing\/"/);
    assert.doesNotMatch(html, /affiliate link<\/span>/);
  } finally {
    fs.writeFileSync(AFF, original);
    rebuild();
  }
});

test('the referral link that ships is well formed and stated honestly', () => {
  rebuild();
  const live = JSON.parse(fs.readFileSync(AFF, 'utf8'));
  for (const prog of live.programs.filter((p) => p.status === 'active')) {
    assert.match(prog.url, /^https:\/\//, `${prog.provider}: url must be absolute`);
    assert.ok(prog.verified_at, `${prog.provider}: an active program needs a verified_at`);
    if (prog.reader_benefit) {
      // An offer with a time limit must say so. "$300 of credit" without the
      // 30-day expiry would be true and still misleading.
      assert.ok(/\bday|month|year\b/.test(prog.reader_benefit),
        `${prog.provider}: the reader benefit must state its limits, got "${prog.reader_benefit}"`);
    }
  }
});

test('an active program replaces the outbound link and labels it', () => {
  withProgram({
    provider: 'Vultr', url: 'https://www.vultr.com/?ref=TESTCODE', status: 'active',
    reader_benefit: '$300 in free credit to try it', verified_at: '2026-09-04',
  }, () => {
    const html = page('airtable-to-baserow');
    assert.match(html, /href="https:\/\/www\.vultr\.com\/\?ref=TESTCODE"/);
    assert.match(html, /affiliate link<\/span>/);
    assert.match(html, /\$300 in free credit to try it/, "the reader's own benefit must be shown");
    assert.match(html, /rel="sponsored nofollow"/);
  });
});

test('a pending program is ignored — only status "active" with a URL is used', () => {
  withProgram({ provider: 'Vultr', url: null, status: 'pending', reader_benefit: 'nope' }, () => {
    const html = page('airtable-to-baserow');
    assert.doesNotMatch(html, /affiliate link<\/span>/);
    assert.doesNotMatch(html, /nope/);
  });
});

test('INTEGRITY: an affiliate program cannot change which provider is recommended', () => {
  // The disclosure claims provider selection is automated on price alone. This
  // asserts it: the selector is a pure function of plans and requirements, and
  // has no access to the affiliate table at all.
  const plans = [
    { id: 'a:cheap', provider: 'NoProgram', name: 'cheap', vcpu: 2, ram_gb: 4, disk_gb: 80, monthly_usd: 12 },
    { id: 'b:dear',  provider: 'Vultr',     name: 'dear',  vcpu: 2, ram_gb: 4, disk_gb: 80, monthly_usd: 20 },
  ];
  const chosen = cheapestMeeting(plans, { ram_gb: 4, vcpu: 2, disk_gb: 40 });
  assert.equal(chosen.provider, 'NoProgram', 'the cheaper box wins regardless of who pays us');
  const src = fs.readFileSync(path.join(ROOT, 'pipeline', 'collect', 'merge.js'), 'utf8');
  assert.doesNotMatch(src, /affiliate/i, 'the provider selector must not reference affiliates at all');
  const resolver = fs.readFileSync(path.join(ROOT, 'pipeline', 'compute', 'resolve.js'), 'utf8');
  assert.doesNotMatch(resolver, /affiliate/i, 'the resolver must not reference affiliates either');
});

test('INTEGRITY: the same comparison produces identical numbers with and without a program', () => {
  rebuild();
  const before = JSON.parse(fs.readFileSync(path.join(DIST, 'api', 'escapes', 'airtable-to-baserow.json'), 'utf8'));
  withProgram({
    provider: 'Vultr', url: 'https://www.vultr.com/?ref=TESTCODE', status: 'active',
    reader_benefit: 'x', verified_at: '2026-09-04',
  }, () => {
    const after = JSON.parse(fs.readFileSync(path.join(DIST, 'api', 'escapes', 'airtable-to-baserow.json'), 'utf8'));
    assert.deepEqual(after.result, before.result, 'money must not move when a referral link appears');
    assert.equal(after.alternative.box.id, before.alternative.box.id, 'the chosen box must not change');
  });
});

test('every page still carries the affiliate disclosure', () => {
  rebuild();
  for (const f of ['index.html', 'method/index.html', 'e/airtable-to-baserow/index.html']) {
    assert.match(fs.readFileSync(path.join(DIST, f), 'utf8'), /Affiliate disclosure/);
  }
});
