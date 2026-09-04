const test = require('node:test');
const assert = require('node:assert/strict');
const { htmlToText, findPrices, inferPeriod, inferPerSeat, extractForPlan, priceFingerprint } = require('../pipeline/collect/extract.js');

// ---------------------------------------------------------------- htmlToText

test('htmlToText: drops scripts, styles and comments entirely', () => {
  const t = htmlToText('<div>Plus</div><script>var x = "$999";</script><style>.a{content:"$888"}</style><!-- $777 --><p>$10</p>');
  assert.equal(t, 'Plus $10');
});

test('htmlToText: decodes the entities that show up in pricing copy', () => {
  assert.equal(htmlToText('<p>Team&nbsp;&amp;&nbsp;Co &#36;12</p>'), 'Team & Co $12');
});

// ---------------------------------------------------------------- findPrices

test('findPrices: reads symbols before and after the amount', () => {
  const p = findPrices('$10 and €20 and 30£ and US$40');
  assert.deepEqual(p.map((x) => [x.amount, x.currency]), [[10, 'USD'], [20, 'EUR'], [30, 'GBP'], [40, 'USD']]);
});

test('findPrices: handles thousands separators and cents', () => {
  assert.deepEqual(findPrices('$1,299.50').map((x) => x.amount), [1299.5]);
});

test('findPrices: a bare number with no currency is not a price', () => {
  assert.deepEqual(findPrices('unlimited 500 members'), []);
});

// -------------------------------------------------------- period vs cadence

test('REGRESSION: "billed annually" is a cadence and must not become a yearly unit', () => {
  // "$20 per seat/month, billed annually" is $20 a MONTH. Reading it as $20/year
  // is a 12x error and would poison every downstream number.
  const text = '$20 per seat/month, billed annually';
  const r = inferPeriod(text, 3);
  assert.equal(r.unit, 'month');
  assert.equal(r.cadence, 'annual');
});

test('a genuine yearly unit is still read as yearly', () => {
  assert.equal(inferPeriod('$240 per year', 4).unit, 'year');
  assert.equal(inferPeriod('$240/yr', 4).unit, 'year');
});

test('INTEGRITY: "billed annually" alone leaves the unit unknown rather than guessing', () => {
  const r = inferPeriod('$99 billed annually', 3);
  assert.equal(r.unit, null, 'no /month or /year stated, so the unit is genuinely unknown');
  assert.equal(r.cadence, 'annual');
});

test('one-time and lifetime pricing is recognised', () => {
  assert.equal(inferPeriod('$99 one-time payment', 3).unit, 'once');
  assert.equal(inferPeriod('$99 lifetime', 3).unit, 'once');
});

test('INTEGRITY: a price with no period words at all yields null', () => {
  assert.equal(inferPeriod('$99 for everything you need', 3).unit, null);
});

test('inferPerSeat: per-user phrasings are detected, flat pricing is not', () => {
  assert.equal(inferPerSeat('$10 per user / month', 0, 3), true);
  assert.equal(inferPerSeat('$10 /seat/month', 0, 3), true);
  assert.equal(inferPerSeat('$10 per month for the whole team', 0, 3), false);
});

// ------------------------------------------------------------ extractForPlan

test('extractForPlan: an unambiguous plan block reads high confidence', () => {
  const text = 'Standard $10 per seat/month Pro $20 per seat/month';
  const r = extractForPlan(text, 'Standard', { otherPlans: ['Pro'] });
  assert.equal(r.confidence, 'high');
  assert.equal(r.candidates[0].amount, 10);
  assert.equal(r.candidates[0].period, 'month');
  assert.equal(r.candidates[0].per_seat, true);
});

test('INTEGRITY: several different prices near the plan name drops confidence to low', () => {
  const text = 'Plus $10 per month or $96 per year or $0 to try';
  const r = extractForPlan(text, 'Plus');
  assert.equal(r.confidence, 'low');
  assert.match(r.reason, /different prices/);
});

test('INTEGRITY: a plan name absent from the page is low confidence, not an empty success', () => {
  const r = extractForPlan('Standard $10 per month', 'Enterprise');
  assert.equal(r.confidence, 'low');
  assert.match(r.reason, /not found/);
});

test('INTEGRITY: a price without a stated period is capped at medium', () => {
  const r = extractForPlan('Standard $10 for your team', 'Standard');
  assert.equal(r.confidence, 'medium');
  assert.match(r.reason, /period not stated/);
});

test('extractForPlan: a price far from the plan name is not attributed to it', () => {
  const filler = ' words '.repeat(60);
  const r = extractForPlan(`Standard${filler}$10 per month`, 'Standard');
  assert.equal(r.candidates.length, 0);
});

test('extractForPlan: matches the plan name as a word, not as a substring', () => {
  // "Pro" must not match inside "Product" or "Professional-services"
  const r = extractForPlan('Our Product costs $999 per month. Pro $15 per seat/month', 'Pro', { otherPlans: ['Product'] });
  assert.equal(r.confidence, 'high');
  assert.equal(r.candidates[0].amount, 15);
});

// --------------------------------------------------------- change detection

test('priceFingerprint: identical price sets hash identically despite copy changes', () => {
  const a = priceFingerprint('Plus $10 per month. Best value!');
  const b = priceFingerprint('Plus $10 per month. Now with more features!');
  assert.equal(a.hash, b.hash);
});

test('priceFingerprint: a changed price changes the hash', () => {
  assert.notEqual(priceFingerprint('Plus $10/mo').hash, priceFingerprint('Plus $12/mo').hash);
});

test('priceFingerprint: a new plan appearing changes the hash', () => {
  assert.notEqual(priceFingerprint('Plus $10/mo').hash, priceFingerprint('Plus $10/mo Team $30/mo').hash);
});

test('priceFingerprint: order on the page does not affect the hash', () => {
  assert.equal(priceFingerprint('$10 $20').hash, priceFingerprint('$20 $10').hash);
});

test('extractForPlan: a sibling plan\'s price is not attributed to this plan', () => {
  const text = 'Free $0 per month Standard $10 per seat/month Pro $20 per seat/month Enterprise contact us';
  const plans = ['Free', 'Standard', 'Pro', 'Enterprise'];
  const std = extractForPlan(text, 'Standard', { otherPlans: plans });
  const pro = extractForPlan(text, 'Pro', { otherPlans: plans });
  assert.equal(std.confidence, 'high');
  assert.equal(std.candidates[0].amount, 10);
  assert.equal(pro.confidence, 'high');
  assert.equal(pro.candidates[0].amount, 20);
});

test('extractForPlan: a plan with genuinely no price stays low even with siblings known', () => {
  const text = 'Standard $10 per seat/month Enterprise contact sales for a quote';
  const r = extractForPlan(text, 'Enterprise', { otherPlans: ['Standard', 'Enterprise'] });
  assert.equal(r.confidence, 'low');
});

test('REGRESSION: per-agent and per-editor billing count as per-seat', () => {
  // Missing these turns an 8-seat bill into a flat one, understating the
  // incumbent by a factor of the team size.
  assert.equal(inferPerSeat('$19 /agent/month', 0, 3), true);
  assert.equal(inferPerSeat('$19 per agent, per month', 0, 3), true);
  assert.equal(inferPerSeat('$8 per editor / month', 0, 3), true);
  assert.equal(inferPerSeat('$12 per host per month', 0, 3), true);
  assert.equal(inferPerSeat('$19 per month for your whole team', 0, 3), false);
});
