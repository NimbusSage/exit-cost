const test = require('node:test');
const assert = require('node:assert/strict');
const { lookup, PROVIDERS } = require('../pipeline/collect/managed.js');
const { resolveManaged } = require('../pipeline/compute/resolve.js');

const parse = PROVIDERS.pikapods.parse;

// A faithful slice of the catalogue's flattened shape: the price FOLLOWS the app
// it belongs to, with the next app's name immediately after it.
const CATALOGUE = 'PikaPods header blurb Project Page Run Your Own From $9.9/month '
  + 'Baserow Create your own online database without technical experience. Project Page Run Your Own From $6.7/month '
  + 'Beszel Lightweight server monitoring platform. Project Page Run Your Own From $2.0/month '
  + 'Uptime Kuma A self-hosted monitoring tool. Project Page Run Your Own From $3.3/month '
  + 'Vaultwarden Alternative implementation of the Bitwarden server API. Project Page Run Your Own From $1.8/month '
  + 'Vikunja The to-do app to organize your life. Project Page Run Your Own From $2.7/month ';

test('parses each app with the price that follows its name', () => {
  const apps = parse(CATALOGUE);
  const byLabel = (n) => apps.find((a) => a.label.toLowerCase().startsWith(n.toLowerCase()));
  assert.equal(byLabel('Baserow').from_usd_month, 6.7);
  assert.equal(byLabel('Beszel').from_usd_month, 2.0);
  assert.equal(byLabel('Vaultwarden').from_usd_month, 1.8);
  assert.equal(byLabel('Vikunja').from_usd_month, 2.7);
});

test('REGRESSION: reading the price that precedes a name shifts every app by one', () => {
  // The first attempt attributed $4.80 to Baserow, which is the price of the app
  // listed above it. Every price on the page was wrong by one row.
  const apps = parse(CATALOGUE);
  const baserow = apps.find((a) => a.label.startsWith('Baserow'));
  assert.notEqual(baserow.from_usd_month, 9.9, 'that is the header price, not Baserow\'s');
  assert.equal(baserow.from_usd_month, 6.7);
});

test('the page header is not treated as an app', () => {
  const apps = parse(CATALOGUE);
  assert.ok(!apps.some((a) => a.label.startsWith('PikaPods')));
});

test('lookup matches on a word boundary, including multi-word names', () => {
  const managed = { providers: { pikapods: { ok: true, name: 'PikaPods', url: 'u', source_url: 's', apps: parse(CATALOGUE) } } };
  assert.equal(lookup(managed, 'pikapods', 'Baserow').from_usd_month, 6.7);
  assert.equal(lookup(managed, 'pikapods', 'baserow').from_usd_month, 6.7);
  assert.equal(lookup(managed, 'pikapods', 'Uptime Kuma').from_usd_month, 3.3);
});

test('INTEGRITY: an app they do not offer returns null, never a neighbour\'s price', () => {
  const managed = { providers: { pikapods: { ok: true, apps: parse(CATALOGUE) } } };
  assert.equal(lookup(managed, 'pikapods', 'Outline'), null);
  assert.equal(lookup(managed, 'pikapods', 'Bas'), null, 'a partial name must not match');
  assert.equal(lookup(managed, 'pikapods', ''), null);
  assert.equal(lookup(managed, 'pikapods', null), null);
});

test('INTEGRITY: a failed or stale provider yields no managed option', () => {
  assert.equal(lookup({ providers: { pikapods: { ok: false } } }, 'pikapods', 'Baserow'), null);
  assert.equal(lookup({}, 'pikapods', 'Baserow'), null);
  assert.equal(lookup(null, 'pikapods', 'Baserow'), null);
});

test('INTEGRITY: a catalogue that suddenly parses to almost nothing is a failure', async () => {
  // A layout change that yields three apps must not quietly replace 127 real
  // prices with three.
  const short = 'Foo thing Project Page Run Your Own From $1.0/month Bar thing Project Page Run Your Own From $2.0/month ';
  assert.ok(parse(short).length < 20, 'the guard in collectProvider trips below 20');
});

// ------------------------------------------------------------------ resolver

const managedData = (over = {}) => ({
  providers: {
    pikapods: {
      ok: true, name: 'PikaPods', url: 'https://pikapods', source_url: 'https://pikapods/apps',
      note: 'They run it.', verified_at: '2026-09-10T00:00:00Z',
      apps: parse(CATALOGUE), ...over,
    },
  },
});
const escape = (over = {}) => ({
  slug: 'x', alternative: { name: 'Vaultwarden (self-hosted)', migration_hours: 6 }, ...over,
});
const incumbent = { costs: [{ amount: 8.99, period: 'month', per_seat: true }] };

test('the managed option removes the maintenance hours entirely', () => {
  const m = resolveManaged(escape(), { managed: managedData() }, 8, 50, 36, incumbent);
  assert.ok(m, 'expected a managed option');
  assert.equal(m.monthly_usd, 1.8);
  assert.equal(m.result.alternative.time_monthly, 0, 'not spending the hours is the product');
  assert.equal(m.result.alternative.monthly, 1.8);
});

test('migration is assumed to be half the self-hosted estimate, and stated', () => {
  const m = resolveManaged(escape(), { managed: managedData() }, 8, 50, 36, incumbent);
  assert.equal(m.migration_hours, 3, 'half of 6');
  const explicit = resolveManaged(escape({ managed_migration_hours: 9 }), { managed: managedData() }, 8, 50, 36, incumbent);
  assert.equal(explicit.migration_hours, 9, 'an escape may state its own');
});

test('INTEGRITY: stale managed prices do not publish, exactly like every other price', () => {
  const m = resolveManaged(escape(), { managed: managedData({ stale: true }) }, 8, 50, 36, incumbent);
  assert.equal(m, null);
});

test('INTEGRITY: no managed data at all means no third option, not a zero', () => {
  assert.equal(resolveManaged(escape(), {}, 8, 50, 36, incumbent), null);
  assert.equal(resolveManaged(escape({ alternative: { name: 'Nothing (self-hosted)', migration_hours: 4 } }),
    { managed: managedData() }, 8, 50, 36, incumbent), null);
});

test('the managed option carries its own provenance', () => {
  const m = resolveManaged(escape(), { managed: managedData() }, 8, 50, 36, incumbent);
  assert.equal(m.provider, 'PikaPods');
  assert.ok(m.source_url);
  assert.ok(m.verified_at);
  assert.match(m.quote, /Run Your Own From \$1\.8\/month/);
});

test('managed can beat the incumbent where running it yourself does not', () => {
  // The whole reason the column exists: an expensive hour makes DIY lose and
  // managed win, and without it the reader is told to keep paying.
  const heavyDiy = { costs: [{ amount: 10, period: 'month' }], migration_hours: 8, maintenance_hours_per_month: 1 };
  const inc = { costs: [{ amount: 19.99, period: 'month' }] };
  const { compare } = require('../pipeline/compute/tco.js');
  const diy = compare({ seats: 1, horizon_months: 36, hourly_rate: 50, incumbent: inc, alternative: heavyDiy });
  const m = resolveManaged(
    { slug: 'x', alternative: { name: 'Vikunja (self-hosted)', migration_hours: 8 } },
    { managed: managedData() }, 1, 50, 36, inc);
  assert.equal(diy.verdict, 'stay');
  assert.equal(m.result.verdict, 'switch');
});
