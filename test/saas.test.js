const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, applyCheck, summarise } = require('../pipeline/collect/saas.js');

const stored = { id: 'plus', name: 'Plus', amount: 10, period: 'month', per_seat: true, currency: 'USD', verified_at: '2026-07-01', verified_by: 'human' };
const high = (over = {}) => ({ confidence: 'high', candidates: [{ amount: 10, period: 'month', per_seat: true, currency: 'USD', ...over }] });
const TODAY = '2026-09-03';

// ------------------------------------------------------------------ classify

test('classify: an agreeing extraction is a match', () => {
  assert.equal(classify(stored, high()).agreement, 'match');
});

test('classify: a different amount is drift, with the percentage stated', () => {
  const c = classify(stored, high({ amount: 12 }));
  assert.equal(c.agreement, 'drift');
  assert.equal(c.delta_pct, 20);
  assert.match(c.reason, /price changed/);
});

test('classify: a changed billing period is drift even when the amount matches', () => {
  const c = classify(stored, high({ period: 'year' }));
  assert.equal(c.agreement, 'drift');
  assert.match(c.reason, /billing period changed/);
});

test('classify: a change from per-seat to flat pricing is drift', () => {
  const c = classify(stored, high({ per_seat: false }));
  assert.equal(c.agreement, 'drift');
  assert.match(c.reason, /per-seat/);
});

test('classify: a currency change is drift', () => {
  const c = classify(stored, high({ currency: 'EUR' }));
  assert.equal(c.agreement, 'drift');
  assert.match(c.reason, /currency changed/);
});

test('classify: sub-cent float noise is not treated as a change', () => {
  assert.equal(classify(stored, high({ amount: 10.001 })).agreement, 'match');
});

test('INTEGRITY: a low-confidence extraction is unverifiable, never a match or a drift', () => {
  assert.equal(classify(stored, { confidence: 'low', reason: '3 different prices', candidates: [] }).agreement, 'unverifiable');
  assert.equal(classify(stored, { confidence: 'medium', candidates: [{ amount: 10 }] }).agreement, 'unverifiable');
  assert.equal(classify(stored, null).agreement, 'unverifiable');
});

// ----------------------------------------------------------------- applyCheck

test('a match refreshes verified_at, keeping the number alive with no human', () => {
  const r = applyCheck(stored, classify(stored, high()), { today: TODAY });
  assert.equal(r.amount, 10);
  assert.equal(r.verified_at, TODAY);
  assert.equal(r.last_auto_confirmed_at, TODAY);
  assert.equal(r.needs_reverification, false);
});

test('INTEGRITY: drift never changes the stored amount', () => {
  const r = applyCheck(stored, classify(stored, high({ amount: 12 })), { today: TODAY });
  assert.equal(r.amount, 10, 'the published number must not move without a human');
  assert.equal(r.needs_reverification, true);
  assert.equal(r.check.observed.amount, 12, 'but what we saw is recorded for the human to act on');
  assert.equal(r.check.delta_pct, 20);
});

test('INTEGRITY: drift does not refresh verified_at, so the price ages out on its own', () => {
  const r = applyCheck(stored, classify(stored, high({ amount: 12 })), { today: TODAY });
  assert.equal(r.verified_at, '2026-07-01');
});

test('INTEGRITY: an unverifiable check refreshes nothing at all', () => {
  const r = applyCheck(stored, { agreement: 'unverifiable', reason: 'page changed shape' }, { today: TODAY });
  assert.equal(r.amount, 10);
  assert.equal(r.verified_at, '2026-07-01', 'an unreadable page must not count as verification');
  assert.equal(r.check.agreement, 'unverifiable');
});

test('applyCheck never mutates the record it was given', () => {
  const original = { ...stored };
  applyCheck(stored, classify(stored, high({ amount: 99 })), { today: TODAY });
  assert.deepEqual(stored, original);
});

test('a plan that drifts and later matches again clears its reverification flag', () => {
  const drifted = applyCheck(stored, classify(stored, high({ amount: 12 })), { today: TODAY });
  assert.equal(drifted.needs_reverification, true);
  const recovered = applyCheck(drifted, classify(drifted, high()), { today: '2026-09-10' });
  assert.equal(recovered.needs_reverification, false);
  assert.equal(recovered.verified_at, '2026-09-10');
});

// ------------------------------------------------------------------ summarise

test('summarise: counts agreements and lists every drift for the report', () => {
  const s = summarise([
    { id: 'notion', ok: true, plans: [
      { name: 'Plus', check: { agreement: 'match' } },
      { name: 'Business', check: { agreement: 'drift', reason: 'price changed', delta_pct: 20 } },
    ] },
    { id: 'slack', ok: true, plans: [{ name: 'Pro', check: { agreement: 'unverifiable' } }] },
    { id: 'zoom', ok: false, reason: 'fetch failed', plans: [] },
    { id: 'x', ok: false, blocked: true, plans: [] },
  ]);
  assert.equal(s.vendors, 4);
  assert.equal(s.ok, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.match, 1);
  assert.equal(s.drift, 1);
  assert.equal(s.unverifiable, 1);
  assert.deepEqual(s.drifted.map((d) => `${d.vendor}/${d.plan}`), ['notion/Business']);
});
