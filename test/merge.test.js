const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeProviders, flattenPlans, cheapestMeeting } = require('../pipeline/collect/merge.js');

const plan = (id, provider, ram_gb, monthly_usd, extra = {}) =>
  ({ id, provider, name: id, vcpu: 1, ram_gb, disk_gb: 40, bandwidth_tb: 1, monthly_usd, currency: 'USD', ...extra });

const previous = {
  fetched_at: '2026-08-01T00:00:00Z',
  fx: { rate: 1.10, verified_at: '2026-08-01' },
  providers: {
    vultr:  { ok: true, stale: false, verified_at: '2026-08-01T00:00:00Z', plans: [plan('vultr:a', 'Vultr', 2, 10)] },
    linode: { ok: true, stale: false, verified_at: '2026-08-01T00:00:00Z', plans: [plan('linode:a', 'Linode', 2, 12)] },
  },
};

test('a successful collector replaces the old plans and advances verified_at', () => {
  const { merged, report } = mergeProviders(previous, {
    fetched_at: '2026-09-03T00:00:00Z',
    fx: { rate: 1.16, verified_at: '2026-09-03' },
    providers: {
      vultr: { ok: true, source_url: 'u', fetched_at: '2026-09-03T00:00:00Z', plans: [plan('vultr:a', 'Vultr', 2, 11)] },
    },
  });
  assert.equal(merged.providers.vultr.plans[0].monthly_usd, 11);
  assert.equal(merged.providers.vultr.verified_at, '2026-09-03T00:00:00Z');
  assert.equal(merged.providers.vultr.stale, false);
  assert.deepEqual(report.updated, [{ name: 'vultr', plans: 1, was: 1 }]);
});

test('INTEGRITY: a failed collector keeps the old price and does NOT advance verified_at', () => {
  const { merged, report } = mergeProviders(previous, {
    fetched_at: '2026-09-03T00:00:00Z',
    fx: { rate: 1.16 },
    providers: {
      vultr: { ok: false, error: 'HTTP 503', fetched_at: '2026-09-03T00:00:00Z' },
    },
  });
  const v = merged.providers.vultr;
  assert.equal(v.plans[0].monthly_usd, 10, 'the last known good price survives untouched');
  assert.equal(v.verified_at, '2026-08-01T00:00:00Z', 'verified_at must NOT move on a failure');
  assert.equal(v.stale, true);
  assert.equal(v.last_error, 'HTTP 503');
  assert.equal(v.last_attempt_at, '2026-09-03T00:00:00Z');
  assert.equal(report.kept_stale.length, 1);
  assert.equal(report.kept_stale[0].reason, 'HTTP 503');
});

test('INTEGRITY: a collector returning an empty plan list counts as a failure, not as "no plans exist"', () => {
  const { merged } = mergeProviders(previous, {
    fetched_at: '2026-09-03T00:00:00Z', fx: {},
    providers: { vultr: { ok: true, source_url: 'u', fetched_at: '2026-09-03T00:00:00Z', plans: [] } },
  });
  assert.equal(merged.providers.vultr.plans.length, 1, 'old plans kept rather than wiped');
  assert.equal(merged.providers.vultr.stale, true);
});

test('a provider that was never collected and has no history yields an empty, stale entry', () => {
  const { merged, report } = mergeProviders(null, {
    fetched_at: '2026-09-03T00:00:00Z', fx: {},
    providers: { hetzner: { ok: false, skipped: true, reason: 'HETZNER_API_TOKEN not set', fetched_at: '2026-09-03T00:00:00Z' } },
  });
  assert.deepEqual(merged.providers.hetzner.plans, []);
  assert.equal(merged.providers.hetzner.stale, true);
  assert.deepEqual(report.skipped, [{ name: 'hetzner', reason: 'HETZNER_API_TOKEN not set' }]);
  assert.deepEqual(report.lost, []);
});

test('a hard failure with no history is reported as lost, distinct from a clean skip', () => {
  const { report } = mergeProviders(null, {
    fetched_at: '2026-09-03T00:00:00Z', fx: {},
    providers: { vultr: { ok: false, error: 'DNS failure', fetched_at: '2026-09-03T00:00:00Z' } },
  });
  assert.deepEqual(report.lost, [{ name: 'vultr', reason: 'DNS failure' }]);
  assert.deepEqual(report.skipped, []);
});

test('a provider dropped from the collector list keeps its data but goes stale', () => {
  const { merged } = mergeProviders(previous, {
    fetched_at: '2026-09-03T00:00:00Z', fx: {},
    providers: { vultr: { ok: true, source_url: 'u', fetched_at: '2026-09-03T00:00:00Z', plans: [plan('vultr:a', 'Vultr', 2, 10)] } },
  });
  assert.equal(merged.providers.linode.plans.length, 1);
  assert.equal(merged.providers.linode.stale, true);
  assert.match(merged.providers.linode.last_error, /no longer defined/);
});

test('a failed FX lookup keeps the previous rate rather than dropping to null', () => {
  const { merged } = mergeProviders(previous, {
    fetched_at: '2026-09-03T00:00:00Z',
    fx: { rate: null, error: 'timeout' },
    providers: {},
  });
  assert.equal(merged.fx.rate, 1.10);
});

test('report.ok is false only when the dataset holds no plans at all', () => {
  const empty = mergeProviders(null, {
    fetched_at: 'x', fx: {},
    providers: { vultr: { ok: false, error: 'down', fetched_at: 'x' } },
  });
  assert.equal(empty.report.ok, false);
  const partial = mergeProviders(previous, {
    fetched_at: 'x', fx: {},
    providers: { vultr: { ok: false, error: 'down', fetched_at: 'x' } },
  });
  assert.equal(partial.report.ok, true, 'stale-but-present data still lets the site build');
});

// ------------------------------------------------------------ plan selection

const plans = [
  plan('vultr:small',  'Vultr',  1, 6,  { vcpu: 1, disk_gb: 25 }),
  plan('vultr:mid',    'Vultr',  2, 10, { vcpu: 1, disk_gb: 55 }),
  plan('linode:mid',   'Linode', 2, 12, { vcpu: 1, disk_gb: 50 }),
  plan('vultr:big',    'Vultr',  4, 20, { vcpu: 2, disk_gb: 80 }),
];

test('cheapestMeeting: picks the cheapest plan that clears every requirement', () => {
  const p = cheapestMeeting(plans, { ram_gb: 2, vcpu: 1, disk_gb: 50 });
  assert.equal(p.id, 'vultr:mid');
});

test('cheapestMeeting: a disk requirement can rule out a cheaper box', () => {
  const p = cheapestMeeting(plans, { ram_gb: 1, vcpu: 1, disk_gb: 60 });
  assert.equal(p.id, 'vultr:big');
});

test('INTEGRITY: cheapestMeeting returns null rather than an undersized box', () => {
  assert.equal(cheapestMeeting(plans, { ram_gb: 64 }), null);
  assert.equal(cheapestMeeting([], { ram_gb: 1 }), null);
});

test('cheapestMeeting: can be restricted to named providers', () => {
  const p = cheapestMeeting(plans, { ram_gb: 2, providers: ['Linode'] });
  assert.equal(p.id, 'linode:mid');
});

test('cheapestMeeting: ties break deterministically, not by array order', () => {
  const tied = [plan('b:x', 'B', 2, 10), plan('a:x', 'A', 2, 10)];
  assert.equal(cheapestMeeting(tied, { ram_gb: 2 }).id, 'a:x');
  assert.equal(cheapestMeeting([...tied].reverse(), { ram_gb: 2 }).id, 'a:x');
});

test('flattenPlans: stale providers are excluded by default and included on request', () => {
  const merged = {
    providers: {
      vultr:  { ok: true,  stale: false, verified_at: 'v', plans: [plan('vultr:a', 'Vultr', 2, 10)] },
      linode: { ok: false, stale: true,  verified_at: 'o', plans: [plan('linode:a', 'Linode', 2, 12)] },
    },
  };
  assert.deepEqual(flattenPlans(merged).map(p => p.id), ['vultr:a']);
  assert.deepEqual(flattenPlans(merged, { includeStale: true }).map(p => p.id).sort(), ['linode:a', 'vultr:a']);
});
