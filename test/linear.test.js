const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('../pipeline/compute/tco.js');
const linear = require('../pipeline/compute/linear.js');

/**
 * The browser recomputes each page as the reader moves the hourly-rate and
 * team-size controls. These tests exist so the in-page arithmetic can never
 * drift from the arithmetic that generated the page — across a grid of both.
 */

const scenarios = [
  { name: 'per-seat SaaS against a VPS with backup', input: {
      horizon_months: 36,
      incumbent: { costs: [{ amount: 20, period: 'month', per_seat: true }] },
      alternative: { costs: [{ amount: 20, period: 'month' }, { amount: 0.35, period: 'month' }],
                     migration_hours: 10, maintenance_hours_per_month: 0.75 } } },
  { name: 'flat SaaS, heavy maintenance, the SaaS wins', input: {
      horizon_months: 36,
      incumbent: { costs: [{ amount: 35, period: 'month' }] },
      alternative: { costs: [{ amount: 20, period: 'month' }], migration_hours: 24, maintenance_hours_per_month: 1.5 } } },
  { name: 'a one-time purchase against a subscription', input: {
      horizon_months: 36,
      incumbent: { costs: [{ amount: 9.99, period: 'month', per_seat: true }] },
      alternative: { costs: [], one_time_costs: [{ amount: 99, period: 'once' }],
                     migration_hours: 2, maintenance_hours_per_month: 0 } } },
  { name: 'the incumbent also costs admin time', input: {
      horizon_months: 24,
      incumbent: { costs: [{ amount: 30, period: 'month', per_seat: true }], maintenance_hours_per_month: 0.25 },
      alternative: { costs: [{ amount: 20, period: 'month' }], migration_hours: 8, maintenance_hours_per_month: 0.75 } } },
  { name: 'annual billing on both sides', input: {
      horizon_months: 36,
      incumbent: { costs: [{ amount: 240, period: 'year', per_seat: true }] },
      alternative: { costs: [{ amount: 120, period: 'year' }], migration_hours: 6, maintenance_hours_per_month: 0.5 } } },
];

/** Split a compare() input into the per-seat and flat components the browser needs. */
function toModel(input, seats) {
  const perSeat = (list = []) => list.filter((c) => c.per_seat)
    .reduce((n, c) => n + c.amount * (c.period === 'year' ? 1 / 12 : 1), 0);
  const flat = (list = []) => list.filter((c) => !c.per_seat)
    .reduce((n, c) => n + c.amount * (c.period === 'year' ? 1 / 12 : 1), 0);
  const once = (list = [], n) => list.reduce((t, c) => t + c.amount * (c.per_seat ? n : 1), 0);
  return {
    inc_per_seat_monthly: perSeat(input.incumbent.costs),
    inc_flat_monthly: flat(input.incumbent.costs),
    inc_hours_monthly: input.incumbent.maintenance_hours_per_month ?? 0,
    inc_cash_one_time: once(input.incumbent.one_time_costs, seats),
    alt_per_seat_monthly: perSeat(input.alternative.costs),
    alt_flat_monthly: flat(input.alternative.costs),
    alt_hours_monthly: input.alternative.maintenance_hours_per_month ?? 0,
    alt_cash_one_time: once(input.alternative.one_time_costs, seats),
    alt_migration_hours: input.alternative.migration_hours ?? 0,
    horizon_months: input.horizon_months,
    seats,
  };
}

const RATES = [0, 15, 50, 100, 250];
const SEATS = [1, 2, 5, 12, 40];

for (const s of scenarios) {
  test(`browser and server agree across every rate and team size — ${s.name}`, () => {
    for (const seats of SEATS) {
      const m = toModel(s.input, seats);
      for (const rate of RATES) {
        const server = compare({ ...s.input, seats, hourly_rate: rate });
        const client = linear.at(m, rate, seats);
        const where = `at ${seats} seats, $${rate}/hr`;
        assert.equal(client.incumbent_monthly, server.incumbent.monthly, `incumbent monthly ${where}`);
        assert.equal(client.alternative_monthly, server.alternative.monthly, `alternative monthly ${where}`);
        assert.equal(client.alternative_upfront, server.alternative.one_time, `upfront ${where}`);
        assert.equal(client.break_even_month, server.break_even_month, `break-even ${where}`);
        assert.equal(client.savings_at_horizon, server.savings.at_horizon, `savings ${where}`);
        assert.equal(client.verdict, server.verdict, `verdict ${where}`);
      }
    }
  });

  test(`crossover matches the server at every team size — ${s.name}`, () => {
    for (const seats of SEATS) {
      const m = toModel(s.input, seats);
      const server = compare({ ...s.input, seats, hourly_rate: 0 }).break_even_hourly_rate;
      const client = linear.crossover(m, seats);
      if (server === null) assert.equal(client, null, `at ${seats} seats`);
      else assert.ok(Math.abs(client - server) < 0.02, `crossover at ${seats} seats: ${client} vs ${server}`);
    }
  });
}

test('the crossover really is the flip point, at whatever team size', () => {
  const m = toModel(scenarios[0].input, 8);
  for (const seats of [2, 8, 30]) {
    const x = linear.crossover(m, seats);
    assert.ok(linear.at(m, x - 1, seats).savings_at_horizon > 0, `below crossover at ${seats} seats`);
    assert.ok(linear.at(m, x + 1, seats).savings_at_horizon < 0, `above crossover at ${seats} seats`);
  }
});

test('more seats make a per-seat subscription worse, monotonically', () => {
  const m = toModel(scenarios[0].input, 5);
  let previous = -Infinity;
  for (const seats of [1, 2, 5, 10, 25, 60]) {
    const s = linear.at(m, 50, seats).savings_at_horizon;
    assert.ok(s > previous, `savings should rise with seats: ${seats} gave ${s}, previous ${previous}`);
    previous = s;
  }
});

test('seats change nothing when the incumbent is billed flat', () => {
  const m = toModel(scenarios[1].input, 1);
  const one = linear.at(m, 50, 1);
  const many = linear.at(m, 50, 50);
  assert.equal(one.incumbent_monthly, many.incumbent_monthly);
  assert.equal(one.verdict, many.verdict);
  assert.equal(linear.breakEvenSeats(m, 50), null, 'no team size can flip a flat subscription');
});

test('breakEvenSeats finds the team size at which switching starts to pay', () => {
  const m = toModel(scenarios[0].input, 5);
  const n = linear.breakEvenSeats(m, 50);
  assert.ok(n > 1, 'expected a real threshold');
  assert.equal(linear.at(m, 50, n).verdict, 'switch');
  assert.notEqual(linear.at(m, 50, n - 1).verdict, 'switch', 'one seat fewer must not already be a switch');
});

test('breakEvenSeats returns null when even a huge team cannot make it pay', () => {
  const m = toModel(scenarios[1].input, 1);
  assert.equal(linear.breakEvenSeats(m, 500), null);
});

test('the curve starts at upfront and ends at the horizon total, at any team size', () => {
  const m = toModel(scenarios[0].input, 5);
  for (const seats of [1, 9]) {
    const c = linear.curve(m, 50, seats);
    const r = linear.at(m, 50, seats);
    assert.equal(c.length, 37);
    assert.equal(c[0].alternative, r.alternative_upfront);
    assert.equal(c[36].incumbent, Math.round((r.incumbent_monthly * 36) * 100) / 100);
  }
});
