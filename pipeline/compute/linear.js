/**
 * linear.js — the cost model as an explicit function of the two things that
 * actually vary between readers: what their hour is worth, and how many seats
 * they have.
 *
 * Every cost is linear in both, which means the whole comparison can be
 * recomputed in the browser from a handful of numbers as sliders move. That is
 * what makes the controls on each page instant and exact rather than an
 * interpolation between precomputed points.
 *
 * Seats matter more than anything else on the page: a per-seat subscription
 * scales with them while a server does not, so the same comparison can say
 * "obviously switch" at 20 seats and "obviously stay" at 2. A page fixed to one
 * seat count is simply wrong for most of the people reading it.
 *
 * This is NOT a second implementation of the model — it is the same closed form
 * as tco.js, and test/linear.test.js asserts they agree across a grid of rates
 * and seat counts. If they ever diverge, that test fails.
 *
 * Loads in Node (require) and in the browser (window.ExitCost).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExitCost = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var money = function (n) { return Math.round(n * 100) / 100; };

  /**
   * @param {object} m  {
   *   inc_per_seat_monthly, inc_flat_monthly, inc_hours_monthly, inc_cash_one_time,
   *   alt_per_seat_monthly, alt_flat_monthly, alt_hours_monthly, alt_cash_one_time,
   *   alt_migration_hours, horizon_months, seats
   * }
   * @param {number} rate   value of one hour of the operator's time
   * @param {number} seats  team size; defaults to the page's own
   */
  function at(m, rate, seats) {
    var h = m.horizon_months || 36;
    var n = seats === undefined || seats === null ? (m.seats || 1) : seats;

    var incMonthly = (m.inc_per_seat_monthly || 0) * n + (m.inc_flat_monthly || 0)
                   + (m.inc_hours_monthly || 0) * rate;
    var altMonthly = (m.alt_per_seat_monthly || 0) * n + (m.alt_flat_monthly || 0)
                   + (m.alt_hours_monthly || 0) * rate;

    var incUpfront = m.inc_cash_one_time || 0;
    var altUpfront = (m.alt_cash_one_time || 0) + (m.alt_migration_hours || 0) * rate;

    var deltaMonthly = incMonthly - altMonthly;
    var deltaUpfront = altUpfront - incUpfront;

    var breakEven;
    if (deltaUpfront <= 0) breakEven = 0;
    else if (deltaMonthly <= 0) breakEven = null;
    else breakEven = Math.ceil(deltaUpfront / deltaMonthly);

    var incAt = function (k) { return incUpfront + incMonthly * k; };
    var altAt = function (k) { return altUpfront + altMonthly * k; };
    var savings = money(incAt(h) - altAt(h));

    var verdict;
    if (breakEven === null || breakEven > h || savings <= 0) verdict = 'stay';
    else if (savings < 100 || breakEven > h / 2) verdict = 'marginal';
    else verdict = 'switch';

    return {
      rate: rate,
      seats: n,
      incumbent_monthly: money(incMonthly),
      alternative_monthly: money(altMonthly),
      alternative_upfront: money(altUpfront),
      incumbent_cash_monthly: money((m.inc_per_seat_monthly || 0) * n + (m.inc_flat_monthly || 0)),
      alternative_cash_monthly: money((m.alt_per_seat_monthly || 0) * n + (m.alt_flat_monthly || 0)),
      delta_monthly: money(deltaMonthly),
      break_even_month: breakEven,
      savings_at_horizon: savings,
      savings_year_1: money(incAt(12) - altAt(12)),
      verdict: verdict,
      incAt: incAt,
      altAt: altAt,
    };
  }

  /**
   * The hourly rate at which the verdict flips over the horizon, at a given
   * team size. Null when the operator's time never enters the comparison.
   */
  function crossover(m, seats) {
    var h = m.horizon_months || 36;
    var n = seats === undefined || seats === null ? (m.seats || 1) : seats;

    var hours = (m.alt_migration_hours || 0)
              + (m.alt_hours_monthly || 0) * h
              - (m.inc_hours_monthly || 0) * h;
    if (Math.abs(hours) < 1e-9) return null;

    var incCash = ((m.inc_per_seat_monthly || 0) * n + (m.inc_flat_monthly || 0)) * h + (m.inc_cash_one_time || 0);
    var altCash = ((m.alt_per_seat_monthly || 0) * n + (m.alt_flat_monthly || 0)) * h + (m.alt_cash_one_time || 0);
    return Math.round(((incCash - altCash) / hours) * 100) / 100;
  }

  /**
   * The team size at which switching starts to pay, holding the hourly rate
   * fixed. The mirror of `crossover`, and often the more useful of the two:
   * "this is worth doing once you are past six people" is a decision someone
   * can act on immediately.
   *
   * Returns null when seats do not enter the comparison (nothing is per-seat),
   * or when no team size makes it pay.
   */
  function breakEvenSeats(m, rate, maxSeats) {
    var h = m.horizon_months || 36;
    var cap = maxSeats || 200;
    var perSeatDelta = (m.inc_per_seat_monthly || 0) - (m.alt_per_seat_monthly || 0);
    if (Math.abs(perSeatDelta) < 1e-9) return null;      // seats change nothing

    for (var n = 1; n <= cap; n++) {
      var r = at(m, rate, n);
      if (r.verdict === 'switch') return n;
    }
    return null;
  }

  /** Cumulative cost curves at a given rate and team size, for the chart. */
  function curve(m, rate, seats, months) {
    months = months || m.horizon_months || 36;
    var r = at(m, rate, seats);
    var out = [];
    for (var i = 0; i <= months; i++) {
      out.push({ month: i, incumbent: money(r.incAt(i)), alternative: money(r.altAt(i)) });
    }
    return out;
  }

  return { at: at, crossover: crossover, breakEvenSeats: breakEvenSeats, curve: curve };
});
