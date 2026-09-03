const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compare, curve, sensitivity, toMonthly, sumCosts,
  breakEvenMonth, breakEvenHourlyRate,
} = require('../pipeline/compute/tco.js');

// ---------------------------------------------------------------- toMonthly

test('toMonthly: monthly price passes through', () => {
  assert.deepEqual(toMonthly({ amount: 10, period: 'month' }), { monthly: 10, one_time: 0 });
});

test('toMonthly: annual price divides by 12', () => {
  assert.deepEqual(toMonthly({ amount: 120, period: 'year' }), { monthly: 10, one_time: 0 });
});

test('toMonthly: one-time price lands in one_time, not monthly', () => {
  assert.deepEqual(toMonthly({ amount: 99, period: 'once' }), { monthly: 0, one_time: 99 });
});

test('toMonthly: per_seat multiplies by seats', () => {
  assert.deepEqual(toMonthly({ amount: 10, period: 'month', per_seat: true }, 5), { monthly: 50, one_time: 0 });
});

test('toMonthly: non-per_seat ignores seats', () => {
  assert.deepEqual(toMonthly({ amount: 10, period: 'month' }, 5), { monthly: 10, one_time: 0 });
});

test('toMonthly: rejects unknown period', () => {
  assert.throws(() => toMonthly({ amount: 10, period: 'fortnight' }), TypeError);
});

test('toMonthly: rejects non-numeric amount', () => {
  assert.throws(() => toMonthly({ amount: '10', period: 'month' }), TypeError);
  assert.throws(() => toMonthly({ amount: NaN, period: 'month' }), TypeError);
  assert.throws(() => toMonthly({ amount: Infinity, period: 'month' }), TypeError);
});

test('toMonthly: rejects negative amount', () => {
  assert.throws(() => toMonthly({ amount: -5, period: 'month' }), RangeError);
});

test('toMonthly: rejects fractional or zero seats', () => {
  assert.throws(() => toMonthly({ amount: 10, period: 'month', per_seat: true }, 2.5), RangeError);
  assert.throws(() => toMonthly({ amount: 10, period: 'month', per_seat: true }, 0), RangeError);
});

// ----------------------------------------------------------------- sumCosts

test('sumCosts: adds monthly and one_time separately', () => {
  const r = sumCosts([
    { amount: 5, period: 'month' },
    { amount: 60, period: 'year' },
    { amount: 100, period: 'once' },
  ]);
  assert.equal(r.monthly, 10);
  assert.equal(r.one_time, 100);
  assert.equal(r.unknown, false);
});

test('sumCosts: a single unknown entry poisons the whole sum', () => {
  const r = sumCosts([
    { amount: 5, period: 'month' },
    { unknown: true, label: 'Notion Business seat price' },
  ]);
  assert.equal(r.unknown, true);
  assert.deepEqual(r.unknown_items, ['Notion Business seat price']);
});

test('sumCosts: empty list is zero and known', () => {
  assert.deepEqual(sumCosts([]), { monthly: 0, one_time: 0, unknown: false, unknown_items: [] });
});

// ----------------------------------------------------------- breakEvenMonth

test('breakEvenMonth: no upfront cost breaks even immediately', () => {
  assert.equal(breakEvenMonth(10, 0), 0);
  assert.equal(breakEvenMonth(10, -50), 0);
});

test('breakEvenMonth: null when the alternative never catches up', () => {
  assert.equal(breakEvenMonth(0, 100), null);
  assert.equal(breakEvenMonth(-5, 100), null);
});

test('breakEvenMonth: rounds up to a whole month', () => {
  assert.equal(breakEvenMonth(10, 100), 10);
  assert.equal(breakEvenMonth(10, 101), 11);  // 10.1 -> 11
  assert.equal(breakEvenMonth(3, 10), 4);     // 3.33 -> 4
});

// ------------------------------------------------------- breakEvenHourlyRate

test('breakEvenHourlyRate: null when the operator spends no hours', () => {
  assert.equal(breakEvenHourlyRate({
    incumbentTotalCash: 1000, altTotalCash: 200,
    migrationHours: 0, maintenanceHoursPerMonth: 0, horizonMonths: 36,
  }), null);
});

test('breakEvenHourlyRate: cash headroom divided by total hours', () => {
  // $720 headroom, 8 migration + 0.5/mo * 36 = 26 hours -> $27.69/hr
  const r = breakEvenHourlyRate({
    incumbentTotalCash: 1000, altTotalCash: 280,
    migrationHours: 8, maintenanceHoursPerMonth: 0.5, horizonMonths: 36,
  });
  assert.ok(Math.abs(r - 720 / 26) < 1e-9);
});

test('breakEvenHourlyRate: negative when the alternative loses on cash alone', () => {
  const r = breakEvenHourlyRate({
    incumbentTotalCash: 100, altTotalCash: 500,
    migrationHours: 5, maintenanceHoursPerMonth: 0, horizonMonths: 36,
  });
  assert.ok(r < 0, 'a cash-losing alternative cannot be rescued by cheap time');
});

// ------------------------------------------------------------------ compare

const notionVsAppflowy = {
  seats: 2,
  horizon_months: 36,
  hourly_rate: 50,
  incumbent: {
    costs: [{ amount: 10, period: 'month', per_seat: true, label: 'Notion Plus seat' }],
  },
  alternative: {
    costs: [
      { amount: 4.59, period: 'month', label: 'Hetzner CX22' },
      { amount: 0.60, period: 'month', label: 'Backblaze B2 100GB' },
    ],
    migration_hours: 6,
    maintenance_hours_per_month: 0.5,
  },
};

test('compare: computes the headline monthly and annual figures', () => {
  const r = compare({ ...notionVsAppflowy, hourly_rate: 0 });
  assert.equal(r.computable, true);
  assert.equal(r.incumbent.monthly, 20);        // 2 seats x $10
  assert.equal(r.incumbent.annual, 240);
  assert.equal(r.alternative.cash_monthly, 5.19);
  assert.equal(r.alternative.annual, 62.28);
});

test('compare: at $0/hr the operator time lines are zero but hours are still recorded', () => {
  const r = compare({ ...notionVsAppflowy, hourly_rate: 0 });
  assert.equal(r.alternative.time_monthly, 0);
  assert.equal(r.alternative.time_one_time, 0);
  assert.equal(r.break_even_month, 0, 'free time means it is cheaper from day one');
});

test('compare: charging time pushes break-even out to a real month', () => {
  const r = compare(notionVsAppflowy);        // $50/hr
  // upfront = 6h * $50 = $300; monthly delta = 20 - (5.19 + 25) = -10.19 -> never
  assert.equal(r.alternative.time_one_time, 300);
  assert.equal(r.alternative.time_monthly, 25);
  assert.equal(r.break_even_month, null);
  assert.equal(r.verdict, 'stay');
});

test('compare: at a modest hourly rate the switch does pay off', () => {
  const r = compare({ ...notionVsAppflowy, hourly_rate: 15 });
  // monthly: inc 20 vs alt 5.19 + 7.5 = 12.69 -> delta 7.31/mo; upfront 6*15 = 90
  assert.equal(r.delta.monthly, 7.31);
  assert.equal(r.break_even_month, 13);       // ceil(90 / 7.31) = 13
  assert.equal(r.verdict, 'switch');
});

test('compare: reports the hourly rate at which the verdict flips', () => {
  const r = compare({ ...notionVsAppflowy, hourly_rate: 0 });
  // cash: inc 20*36 = 720; alt 5.19*36 = 186.84; headroom 533.16
  // hours: 6 + 0.5*36 = 24  ->  $22.22/hr
  assert.equal(r.break_even_hourly_rate, 22.22);
});

test('compare: the crossover rate actually flips the verdict', () => {
  const base = notionVsAppflowy;
  const cross = compare({ ...base, hourly_rate: 0 }).break_even_hourly_rate;
  const below = compare({ ...base, hourly_rate: cross - 5 });
  const above = compare({ ...base, hourly_rate: cross + 5 });
  assert.ok(below.savings.at_horizon > 0, 'below the crossover, switching saves money');
  assert.ok(above.savings.at_horizon < 0, 'above the crossover, staying saves money');
});

test('compare: seats scale the incumbent and change the answer', () => {
  const one  = compare({ ...notionVsAppflowy, seats: 1,  hourly_rate: 0 });
  const many = compare({ ...notionVsAppflowy, seats: 20, hourly_rate: 0 });
  assert.equal(one.incumbent.monthly, 10);
  assert.equal(many.incumbent.monthly, 200);
  assert.ok(many.break_even_hourly_rate > one.break_even_hourly_rate,
    'more seats means the switch tolerates a more expensive hour');
});

test('compare: publishes the cases where staying is correct', () => {
  // One seat, cheap SaaS, heavy maintenance. Self-hosting genuinely loses here.
  const r = compare({
    seats: 1, horizon_months: 36, hourly_rate: 75,
    incumbent: { costs: [{ amount: 4, period: 'month', label: 'Cheap SaaS' }] },
    alternative: {
      costs: [{ amount: 6, period: 'month', label: 'VPS' }],
      migration_hours: 10, maintenance_hours_per_month: 1,
    },
  });
  assert.equal(r.verdict, 'stay');
  assert.equal(r.break_even_month, null);
  assert.ok(r.savings.year_3 < 0);
  assert.ok(r.break_even_hourly_rate < 0, 'it loses on cash before time is even counted');
});

test('compare: a switch that is technically cheaper but not worth the bother reads marginal', () => {
  const r = compare({
    seats: 1, horizon_months: 36, hourly_rate: 50,
    incumbent: { costs: [{ amount: 5, period: 'month' }] },
    alternative: {
      costs: [{ amount: 4, period: 'month' }],
      migration_hours: 0.5, maintenance_hours_per_month: 0,
    },
  });
  // saves $1/mo = $36 over 36 months, minus $25 of migration time = $11. True, and trivial.
  assert.equal(r.verdict, 'marginal');
  assert.ok(r.savings.at_horizon > 0 && r.savings.at_horizon < 100);
});

test('compare: one-time alternative purchase amortises against a subscription', () => {
  const r = compare({
    seats: 1, horizon_months: 36, hourly_rate: 0,
    incumbent: { costs: [{ amount: 9.99, period: 'month' }] },
    alternative: { costs: [], one_time_costs: [{ amount: 99, period: 'once' }],
                   migration_hours: 0, maintenance_hours_per_month: 0 },
  });
  assert.equal(r.alternative.one_time, 99);
  assert.equal(r.break_even_month, 10);   // ceil(99 / 9.99)
  assert.equal(r.verdict, 'switch');
});

test('compare: an incumbent that also costs the operator time is credited for it', () => {
  const withoutIncTime = compare({
    seats: 1, horizon_months: 36, hourly_rate: 50,
    incumbent: { costs: [{ amount: 30, period: 'month' }] },
    alternative: { costs: [{ amount: 10, period: 'month' }], migration_hours: 4, maintenance_hours_per_month: 0.4 },
  });
  const withIncTime = compare({
    seats: 1, horizon_months: 36, hourly_rate: 50,
    incumbent: { costs: [{ amount: 30, period: 'month' }], maintenance_hours_per_month: 0.2 },
    alternative: { costs: [{ amount: 10, period: 'month' }], migration_hours: 4, maintenance_hours_per_month: 0.4 },
  });
  assert.ok(withIncTime.savings.year_3 > withoutIncTime.savings.year_3,
    'admin time already spent on the incumbent counts in the alternative\'s favour');
});

// ------------------------------------------------------- INTEGRITY (§9 gate)

test('INTEGRITY: an unknown price makes the comparison refuse to compute', () => {
  const r = compare({
    seats: 2, horizon_months: 36, hourly_rate: 50,
    incumbent: { costs: [{ unknown: true, label: 'Notion Business seat price' }] },
    alternative: { costs: [{ amount: 5, period: 'month' }], migration_hours: 1, maintenance_hours_per_month: 0 },
  });
  assert.equal(r.computable, false);
  assert.equal(r.reason, 'unknown_cost_input');
  assert.deepEqual(r.unknown_items, ['Notion Business seat price']);
  assert.equal(r.verdict, undefined, 'an uncomputable comparison must not carry a verdict');
  assert.equal(r.savings, undefined, 'an uncomputable comparison must not carry savings');
});

test('INTEGRITY: an unknown cost on either side is enough to refuse', () => {
  const alt = compare({
    seats: 1, horizon_months: 36, hourly_rate: 50,
    incumbent: { costs: [{ amount: 20, period: 'month' }] },
    alternative: { costs: [{ unknown: true, label: 'VPS plan price' }], migration_hours: 1, maintenance_hours_per_month: 0 },
  });
  assert.equal(alt.computable, false);
});

test('INTEGRITY: rejects a nonsense horizon rather than silently defaulting', () => {
  const base = { incumbent: { costs: [] }, alternative: { costs: [] } };
  assert.throws(() => compare({ ...base, horizon_months: 0 }), RangeError);
  assert.throws(() => compare({ ...base, horizon_months: -12 }), RangeError);
  assert.throws(() => compare({ ...base, horizon_months: 12.5 }), RangeError);
});

test('INTEGRITY: rejects a negative hourly rate', () => {
  const base = { incumbent: { costs: [] }, alternative: { costs: [] } };
  assert.throws(() => compare({ ...base, hourly_rate: -10 }), RangeError);
});

test('INTEGRITY: rejects negative hour inputs', () => {
  assert.throws(() => compare({
    incumbent: { costs: [] },
    alternative: { costs: [], migration_hours: -1 },
  }), RangeError);
});

// -------------------------------------------------------------------- curve

test('curve: month 0 is upfront only, and length matches the request', () => {
  const r = compare(notionVsAppflowy);
  const c = curve(r, 36);
  assert.equal(c.length, 37);
  assert.equal(c[0].month, 0);
  assert.equal(c[0].incumbent, r.incumbent.one_time);
  assert.equal(c[0].alternative, r.alternative.one_time);
  assert.equal(c[36].alternative, r.totals.at_36_months.alternative);
});

test('curve: an uncomputable result yields no curve', () => {
  assert.deepEqual(curve({ computable: false }), []);
});

test('curve: the lines actually cross at the reported break-even month', () => {
  const r = compare({ ...notionVsAppflowy, hourly_rate: 15 });
  const c = curve(r, 36);
  const be = r.break_even_month;
  assert.ok(c[be - 1].alternative > c[be - 1].incumbent, 'still behind the month before');
  assert.ok(c[be].alternative <= c[be].incumbent, 'ahead at the break-even month');
});

// -------------------------------------------------------------- sensitivity

test('sensitivity: verdict degrades monotonically as time gets more expensive', () => {
  const band = sensitivity(notionVsAppflowy);
  assert.equal(band[0].hourly_rate, 0);
  assert.equal(band[0].verdict, 'switch');
  assert.equal(band[band.length - 1].verdict, 'stay');
  for (let i = 1; i < band.length; i++) {
    assert.ok(band[i].savings_at_horizon <= band[i - 1].savings_at_horizon,
      'savings must not increase as the hourly rate rises');
  }
});

test('REGRESSION: the crossover rate accounts for admin time the incumbent already costs', () => {
  // If the SaaS itself eats 0.25h/month, switching only costs the DIFFERENCE in
  // hours. Ignoring that overstates the crossover and makes self-hosting look
  // better than it is.
  const base = {
    seats: 3, horizon_months: 24,
    incumbent: { costs: [{ amount: 30, period: 'month', per_seat: true }] },
    alternative: { costs: [{ amount: 20, period: 'month' }], migration_hours: 8, maintenance_hours_per_month: 0.75 },
  };
  const withIncTime = {
    ...base,
    incumbent: { ...base.incumbent, maintenance_hours_per_month: 0.25 },
  };

  const a = compare({ ...base, hourly_rate: 0 }).break_even_hourly_rate;
  const b = compare({ ...withIncTime, hourly_rate: 0 }).break_even_hourly_rate;
  assert.ok(b > a, 'time the incumbent already costs raises the rate at which staying wins');

  // And the reported crossover must genuinely be the flip point.
  assert.ok(compare({ ...withIncTime, hourly_rate: b - 1 }).savings.at_horizon > 0);
  assert.ok(compare({ ...withIncTime, hourly_rate: b + 1 }).savings.at_horizon < 0);
});

test('the crossover is null when both sides cost the same number of hours', () => {
  const r = compare({
    seats: 1, horizon_months: 36, hourly_rate: 50,
    incumbent: { costs: [{ amount: 30, period: 'month' }], maintenance_hours_per_month: 0.5 },
    alternative: { costs: [{ amount: 10, period: 'month' }], migration_hours: 0, maintenance_hours_per_month: 0.5 },
  });
  assert.equal(r.break_even_hourly_rate, null, 'no net time difference means no rate can flip it');
});
