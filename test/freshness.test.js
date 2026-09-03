const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, rollup, ageInDays, isPublishable, today, MAX_AGE_DAYS, DAY_MS } = require('../pipeline/lib/freshness.js');

const NOW = new Date('2026-09-03T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

test('ageInDays: measures from verified_at to now', () => {
  assert.equal(Math.round(ageInDays(daysAgo(10), NOW)), 10);
});

test('ageInDays: null for a value that is not a date', () => {
  assert.equal(ageInDays(undefined, NOW), null);
  assert.equal(ageInDays('', NOW), null);
  assert.equal(ageInDays('not a date', NOW), null);
});

test('assess: a recent saas price is fresh', () => {
  assert.equal(assess(daysAgo(5), 'saas', NOW).state, 'fresh');
});

test('assess: an aging saas price is still publishable but flagged', () => {
  const a = assess(daysAgo(35), 'saas', NOW);   // 35 of 45 days -> past 70%
  assert.equal(a.state, 'aging');
  assert.equal(isPublishable(a.state), true);
});

test('assess: past the window it is stale and not publishable', () => {
  const a = assess(daysAgo(60), 'saas', NOW);
  assert.equal(a.state, 'stale');
  assert.equal(isPublishable(a.state), false);
});

test('assess: vps prices expire much faster than saas prices', () => {
  assert.equal(assess(daysAgo(10), 'vps', NOW).state, 'stale');
  assert.equal(assess(daysAgo(10), 'saas', NOW).state, 'fresh');
});

test('INTEGRITY: an undated number is treated as harshly as a stale one', () => {
  const a = assess(null, 'saas', NOW);
  assert.equal(a.state, 'undated');
  assert.equal(isPublishable(a.state), false);
});

test('INTEGRITY: a future-dated number is rejected, not treated as extra fresh', () => {
  const a = assess(new Date(NOW.getTime() + 30 * DAY_MS).toISOString(), 'saas', NOW);
  assert.equal(a.state, 'undated');
  assert.match(a.error, /future/);
});

test('rollup: a page is only as fresh as its stalest input', () => {
  const r = rollup([
    { ...assess(daysAgo(1), 'vps', NOW), label: 'Vultr plan' },
    { ...assess(daysAgo(90), 'saas', NOW), label: 'Notion Plus' },
  ]);
  assert.equal(r.state, 'stale');
  assert.equal(r.publishable, false);
  assert.deepEqual(r.problems.map(p => p.label), ['Notion Plus']);
});

test('rollup: all-fresh inputs are publishable with no problems', () => {
  const r = rollup([
    { ...assess(daysAgo(1), 'vps', NOW), label: 'Vultr plan' },
    { ...assess(daysAgo(2), 'saas', NOW), label: 'Notion Plus' },
  ]);
  assert.equal(r.state, 'fresh');
  assert.equal(r.publishable, true);
  assert.deepEqual(r.problems, []);
});

test('rollup: an undated input outranks a merely stale one as the reported problem', () => {
  const r = rollup([
    { ...assess(daysAgo(90), 'saas', NOW), label: 'stale one' },
    { ...assess(null, 'saas', NOW), label: 'undated one' },
  ]);
  assert.equal(r.state, 'undated');
  assert.equal(r.problems.length, 2);
});

test('today: returns a bare ISO date', () => {
  assert.equal(today(NOW), '2026-09-03');
});

test('the storage window is the loosest and vps the tightest', () => {
  assert.ok(MAX_AGE_DAYS.vps < MAX_AGE_DAYS.saas);
  assert.ok(MAX_AGE_DAYS.saas < MAX_AGE_DAYS.storage);
});
