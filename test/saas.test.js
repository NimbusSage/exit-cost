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

// ------------------------------------ confirming through a period counterpart

const { explicableCounterpart } = require('../pipeline/collect/saas.js');
const medium = (cands, reason = 'two prices near the plan name') =>
  ({ confidence: 'medium', reason, candidates: cands });
const cand = (over = {}) => ({ amount: 10, period: 'month', per_seat: true, currency: 'USD', ...over });

test('a page showing the monthly and annual framing of our stored price confirms it', () => {
  // "$10 per seat/month, $120 billed annually" is the page agreeing with us twice.
  const c = classify(stored, medium([cand(), cand({ amount: 120, period: 'month' })]));
  assert.equal(c.agreement, 'match');
  assert.equal(c.via, 'period-counterpart');
});

test('a free tier quoted alongside does not block confirmation', () => {
  assert.equal(classify(stored, medium([cand(), cand({ amount: 0 })])).agreement, 'match');
});

test('INTEGRITY: a neighbouring tier\'s price keeps it ambiguous', () => {
  // $10 and $20 could be this tier and the next, or could be a price rise with
  // the old figure still on the page. That is exactly when a human should look.
  const c = classify(stored, medium([cand(), cand({ amount: 20 })]));
  assert.equal(c.agreement, 'unverifiable');
  assert.match(c.reason, /unrelated figures/);
});

test('INTEGRITY: no candidate matching the stored price is never a confirmation', () => {
  const c = classify(stored, medium([cand({ amount: 12 }), cand({ amount: 144, period: 'month' })]));
  assert.equal(c.agreement, 'unverifiable');
  assert.match(c.reason, /no candidate matches|two prices/);
});

test('INTEGRITY: a matching amount with the wrong period or billing is not a confirmation', () => {
  assert.equal(classify(stored, medium([cand({ period: 'year' })])).agreement, 'unverifiable');
  assert.equal(classify(stored, medium([cand({ per_seat: false })])).agreement, 'unverifiable');
  assert.equal(classify(stored, medium([cand({ currency: 'EUR' })])).agreement, 'unverifiable');
});

test('explicableCounterpart is narrow on purpose', () => {
  assert.equal(explicableCounterpart(10, 120), true);
  assert.equal(explicableCounterpart(120, 10), true);
  assert.equal(explicableCounterpart(10, 0), true);
  assert.equal(explicableCounterpart(10, 20), false);
  assert.equal(explicableCounterpart(10, 9.99), false);
  assert.equal(explicableCounterpart(10, 100), false);
});

test('a high-confidence drift is still a drift, not rescued by the new path', () => {
  const c = classify(stored, { confidence: 'high', candidates: [cand({ amount: 12 })] });
  assert.equal(c.agreement, 'drift');
});

// -------------------------------------- fields a vendor's page cannot express

test('a plan may declare a field its page never states, and that field is skipped', () => {
  // Vercel's headline reads "$20 /mo." and says nothing about seats, though it
  // bills per developer seat. Without this the nightly check reports a drift
  // every night that no human can resolve, which trains people to ignore drifts.
  const vercel = { ...stored, per_seat: true, check_ignores: ['per_seat'] };
  const page = { confidence: 'high', candidates: [{ amount: 10, period: 'month', per_seat: false, currency: 'USD' }] };
  assert.equal(classify(vercel, page).agreement, 'match');
});

test('INTEGRITY: declaring a field unverifiable never excuses a changed amount', () => {
  const vercel = { ...stored, check_ignores: ['per_seat', 'period', 'currency'] };
  const page = { confidence: 'high', candidates: [{ amount: 12, period: 'month', per_seat: false }] };
  const c = classify(vercel, page);
  assert.equal(c.agreement, 'drift', 'the amount is the number we publish and is never ignorable');
  assert.equal(c.delta_pct, 20);
});

test('INTEGRITY: a field is only skipped for the plan that declares it', () => {
  const page = { confidence: 'high', candidates: [{ amount: 10, period: 'month', per_seat: false, currency: 'USD' }] };
  assert.equal(classify(stored, page).agreement, 'drift', 'a plan without the declaration still drifts');
});

test('the declaration also applies on the lower-confidence path', () => {
  const vercel = { ...stored, check_ignores: ['per_seat'] };
  const c = classify(vercel, { confidence: 'medium', reason: 'two prices',
    candidates: [{ amount: 10, period: 'month', per_seat: false, currency: 'USD' },
                 { amount: 120, period: 'month', per_seat: false, currency: 'USD' }] });
  assert.equal(c.agreement, 'match');
});

test('every declared check_ignores in the live data is explained', () => {
  // A silent exemption is indistinguishable from a bug.
  const saas = require('../data/saas.json');
  for (const v of saas.vendors) {
    for (const pl of v.plans) {
      if (pl.check_ignores?.length) {
        assert.ok(pl.extraction_note, `${v.id}/${pl.id} skips ${pl.check_ignores} without saying why`);
        assert.ok(!pl.check_ignores.includes('amount'), `${v.id}/${pl.id}: the amount can never be exempt`);
      }
    }
  }
});

test('every vendor with page_plan_names lists the plans we price', () => {
  const saas = require('../data/saas.json');
  for (const v of saas.vendors) {
    if (!v.page_plan_names) continue;
    for (const pl of v.plans) {
      const label = pl.page_label || pl.name;
      assert.ok(v.page_plan_names.includes(label),
        `${v.id}: page_plan_names omits "${label}", so its own block cannot be clipped`);
    }
  }
});
