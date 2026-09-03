const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEscape, resolveAll } = require('../pipeline/compute/resolve.js');

const NOW = new Date('2026-09-03T12:00:00Z');
const iso = (d) => d;

const ctx = (over = {}) => ({
  now: NOW,
  vpsPlans: [
    { id: 'vultr:small', provider: 'Vultr', name: 'vc2-1c-1gb', vcpu: 1, ram_gb: 1, disk_gb: 25, bandwidth_tb: 1, monthly_usd: 6, verified_at: '2026-09-02T00:00:00Z', url: 'u' },
    { id: 'vultr:mid',   provider: 'Vultr', name: 'vc2-1c-2gb', vcpu: 1, ram_gb: 2, disk_gb: 55, bandwidth_tb: 2, monthly_usd: 10, verified_at: '2026-09-02T00:00:00Z', url: 'u' },
  ],
  saas: { vendors: [{ id: 'notion', name: 'Notion', pricing_url: 'https://n', category: 'docs',
    plans: [{ id: 'business', name: 'Business', amount: 20, period: 'month', per_seat: true, currency: 'USD', billed: 'annual', quote: '$20 per member / month', verified_at: '2026-09-01' }] }] },
  storage: { default: 'b2', options: [{ id: 'b2', name: 'Backblaze B2', usd_per_gb_month: 0.00695, verified_at: '2026-08-20', pricing_url: 'https://b' }] },
  projects: { 'outline/outline': { full_name: 'outline/outline', stars: 40000, health: 'active', recommended: true, verified_at: '2026-09-03T00:00:00Z' } },
  ...over,
});

const escape = (over = {}) => ({
  slug: 'notion-to-outline', title: 'Notion to Outline', summary: 's', category: 'docs',
  incumbent: { vendor: 'notion', plan: 'business', seats: 10 },
  alternative: { name: 'Outline', repo: 'outline/outline', requirements: { ram_gb: 2, vcpu: 1, disk_gb: 25 },
    backup_gb: 30, migration_hours: 8, maintenance_hours_per_month: 0.5 },
  tradeoffs: { you_lose: ['databases'], you_gain: ['markdown'] },
  caveats: ['needs an auth provider'],
  ...over,
});

test('resolves a healthy escape into a publishable page model', () => {
  const r = resolveEscape(escape(), ctx());
  assert.equal(r.publishable, true);
  assert.equal(r.incumbent.vendor, 'Notion');
  assert.equal(r.result.incumbent.annual, 2400);          // 10 seats x $20 x 12
  assert.equal(r.alternative.box.id, 'vultr:mid');        // cheapest meeting 2GB
  assert.equal(r.alternative.storage.gb, 30);
  assert.equal(r.result.verdict, 'switch');
  assert.ok(r.result.break_even_hourly_rate > 0);
});

test('picks the cheapest box that meets the requirement, not the cheapest box', () => {
  const r = resolveEscape(escape(), ctx());
  assert.equal(r.alternative.box.ram_gb, 2, 'the 1GB box is cheaper but too small');
});

test('carries the vendor quote through so the page can show its own evidence', () => {
  const r = resolveEscape(escape(), ctx());
  assert.equal(r.incumbent.quote, '$20 per member / month');
  assert.equal(r.incumbent.source_url, 'https://n');
});

test('the curve and the sensitivity band are both produced', () => {
  const r = resolveEscape(escape(), ctx());
  assert.equal(r.curve.length, 37);
  assert.ok(r.sensitivity.length >= 5);
  assert.equal(r.sensitivity[0].hourly_rate, 0);
});

// ------------------------------------------------------------- INTEGRITY

test('INTEGRITY: a stale SaaS price makes the escape unpublishable', () => {
  const c = ctx();
  c.saas.vendors[0].plans[0].verified_at = '2026-06-01';   // 94 days old, past the 45-day window
  const r = resolveEscape(escape(), c);
  assert.equal(r.publishable, false);
  assert.equal(r.freshness.state, 'stale');
  assert.equal(r.freshness.problems[0].label, 'Notion Business price');
});

test('INTEGRITY: a stale VPS price makes the escape unpublishable', () => {
  const c = ctx();
  c.vpsPlans = c.vpsPlans.map((p) => ({ ...p, verified_at: '2026-08-01T00:00:00Z' }));  // 33 days, vps window is 7
  const r = resolveEscape(escape(), c);
  assert.equal(r.publishable, false);
  assert.equal(r.freshness.state, 'stale');
});

test('INTEGRITY: an undated price is refused exactly like a stale one', () => {
  const c = ctx();
  delete c.saas.vendors[0].plans[0].verified_at;
  const r = resolveEscape(escape(), c);
  assert.equal(r.publishable, false);
  assert.equal(r.freshness.state, 'undated');
});

test('INTEGRITY: no VPS plan large enough means no page, never a smaller box', () => {
  const r = resolveEscape(escape({ alternative: { ...escape().alternative, requirements: { ram_gb: 64, vcpu: 16 } } }), ctx());
  assert.equal(r.publishable, false);
  assert.match(r.errors[0], /no VPS plan meets/);
});

test('INTEGRITY: a dormant upstream project blocks publication however good the price is', () => {
  const c = ctx();
  c.projects['outline/outline'] = { full_name: 'outline/outline', health: 'dormant', recommended: false, verified_at: '2026-09-03T00:00:00Z' };
  const r = resolveEscape(escape(), c);
  assert.equal(r.publishable, false);
  assert.match(r.block_reason, /dormant/);
  assert.ok(r.result.savings.year_3 > 0, 'the arithmetic still favoured switching — we blocked it anyway');
});

test('INTEGRITY: an unknown vendor or plan is an error, not a zero', () => {
  assert.match(resolveEscape(escape({ incumbent: { vendor: 'nope', plan: 'x', seats: 1 } }), ctx()).errors[0], /no vendor/);
  assert.match(resolveEscape(escape({ incumbent: { vendor: 'notion', plan: 'nope', seats: 1 } }), ctx()).errors[0], /no plan/);
});

test('resolveAll splits publishable pages from blocked ones', () => {
  const c = ctx();
  const bad = escape({ slug: 'too-big', alternative: { ...escape().alternative, requirements: { ram_gb: 999 } } });
  const { pages, blocked } = resolveAll([escape(), bad], c);
  assert.deepEqual(pages.map((p) => p.slug), ['notion-to-outline']);
  assert.deepEqual(blocked.map((b) => b.slug), ['too-big']);
});

test('seat count drives the verdict, and the model reflects that', () => {
  const one = resolveEscape(escape({ incumbent: { vendor: 'notion', plan: 'business', seats: 1 } }), ctx());
  const many = resolveEscape(escape({ incumbent: { vendor: 'notion', plan: 'business', seats: 25 } }), ctx());
  assert.equal(one.result.verdict, 'stay', 'one seat of Notion is cheaper than a VPS plus your time');
  assert.equal(many.result.verdict, 'switch');
  assert.ok(many.result.break_even_hourly_rate > one.result.break_even_hourly_rate);
});
