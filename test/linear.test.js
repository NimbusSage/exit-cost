const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('../pipeline/compute/tco.js');
const linear = require('../pipeline/compute/linear.js');

/**
 * The browser recomputes each page as the reader drags the hourly-rate slider.
 * These tests exist so that the in-page arithmetic can never drift away from the
 * arithmetic that generated the page.
 */

const scenarios = [
  { name: 'per-seat SaaS vs VPS with backup', input: {
      seats: 5, horizon_months: 36,
      incumbent: { costs: [{ amount: 20, period: 'month', per_seat: true }] },
      alternative: { costs: [{ amount: 20, period: 'month' }, { amount: 0.35, period: 'month' }],
                     migration_hours: 10, maintenance_hours_per_month: 0.75 } } },
  { name: 'flat SaaS, heavy maintenance, SaaS wins', input: {
      seats: 1, horizon_months: 36,
      incumbent: { costs: [{ amount: 35, period: 'month' }] },
      alternative: { costs: [{ amount: 20, period: 'month' }], migration_hours: 24, maintenance_hours_per_month: 1.5 } } },
  { name: 'one-time purchase against a subscription', input: {
      seats: 1, horizon_months: 36,
      incumbent: { costs: [{ amount: 9.99, period: 'month' }] },
      alternative: { costs: [], one_time_costs: [{ amount: 99, period: 'once' }],
                     migration_hours: 2, maintenance_hours_per_month: 0 } } },
  { name: 'incumbent also costs admin time', input: {
      seats: 3, horizon_months: 24,
      incumbent: { costs: [{ amount: 30, period: 'month', per_seat: true }], maintenance_hours_per_month: 0.25 },
      alternative: { costs: [{ amount: 20, period: 'month' }], migration_hours: 8, maintenance_hours_per_month: 0.75 } } },
];

/** Flatten a compare() input into the seven numbers the browser model needs. */
function toModel(input) {
  const seats = input.seats ?? 1;
  const sum = (list = []) => list.reduce((n, c) => n + c.amount * (c.per_seat ? seats : 1) * (c.period === 'year' ? 1 / 12 : 1), 0);
  const once = (list = []) => list.reduce((n, c) => n + c.amount * (c.per_seat ? seats : 1), 0);
  return {
    inc_cash_monthly: sum(input.incumbent.costs),
    inc_hours_monthly: input.incumbent.maintenance_hours_per_month ?? 0,
    inc_cash_one_time: once(input.incumbent.one_time_costs),
    alt_cash_monthly: sum(input.alternative.costs),
    alt_hours_monthly: input.alternative.maintenance_hours_per_month ?? 0,
    alt_cash_one_time: once(input.alternative.one_time_costs),
    alt_migration_hours: input.alternative.migration_hours ?? 0,
    horizon_months: input.horizon_months,
  };
}

const RATES = [0, 5, 15, 25, 50, 75, 100, 150, 250];

for (const s of scenarios) {
  test(`browser model matches tco.compare() across every rate — ${s.name}`, () => {
    const m = toModel(s.input);
    for (const rate of RATES) {
      const server = compare({ ...s.input, hourly_rate: rate });
      const client = linear.at(m, rate);
      assert.equal(client.incumbent_monthly, server.incumbent.monthly, `incumbent monthly at $${rate}`);
      assert.equal(client.alternative_monthly, server.alternative.monthly, `alternative monthly at $${rate}`);
      assert.equal(client.alternative_upfront, server.alternative.one_time, `alternative upfront at $${rate}`);
      assert.equal(client.break_even_month, server.break_even_month, `break-even at $${rate}`);
      assert.equal(client.savings_at_horizon, server.savings.at_horizon, `savings at $${rate}`);
      assert.equal(client.verdict, server.verdict, `verdict at $${rate}`);
    }
  });

  test(`browser crossover matches tco's break-even hourly rate — ${s.name}`, () => {
    const m = toModel(s.input);
    const server = compare({ ...s.input, hourly_rate: 0 }).break_even_hourly_rate;
    const client = linear.crossover(m);
    if (server === null) assert.equal(client, null);
    else assert.ok(Math.abs(client - server) < 0.02, `crossover ${client} vs ${server}`);
  });
}

test('the crossover really is the flip point in the browser model too', () => {
  const m = toModel(scenarios[0].input);
  const x = linear.crossover(m);
  assert.ok(linear.at(m, x - 1).savings_at_horizon > 0);
  assert.ok(linear.at(m, x + 1).savings_at_horizon < 0);
});

test('browser curve month 0 is upfront only and ends at the horizon total', () => {
  const m = toModel(scenarios[0].input);
  const c = linear.curve(m, 50);
  const r = linear.at(m, 50);
  assert.equal(c.length, 37);
  assert.equal(c[0].alternative, r.alternative_upfront);
  assert.equal(c[36].incumbent, Math.round(r.incumbent_monthly * 36 * 100) / 100);
});
