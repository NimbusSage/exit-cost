/**
 * linear.js — the cost model as an explicit function of the operator's hourly rate.
 *
 * Every cost in this model is linear in `rate`, which means the whole comparison
 * can be recomputed in the browser from seven numbers as the reader drags a
 * slider. That is what makes the hourly-rate control on each page instant and
 * exact rather than an interpolation between precomputed points.
 *
 * This is NOT a second implementation of the model — it is the same closed form,
 * and test/linear.test.js asserts it agrees with tco.compare() across a range of
 * rates. If the two ever diverge, that test fails.
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
   * @param {object} m  { inc_cash_monthly, inc_hours_monthly,
   *                      alt_cash_monthly, alt_hours_monthly,
   *                      alt_cash_one_time, alt_migration_hours,
   *                      inc_cash_one_time, horizon_months }
   * @param {number} rate  value of one hour of the operator's time
   */
  function at(m, rate) {
    var h = m.horizon_months || 36;

    var incMonthly = m.inc_cash_monthly + (m.inc_hours_monthly || 0) * rate;
    var altMonthly = m.alt_cash_monthly + (m.alt_hours_monthly || 0) * rate;
    var incUpfront = m.inc_cash_one_time || 0;
    var altUpfront = (m.alt_cash_one_time || 0) + (m.alt_migration_hours || 0) * rate;

    var deltaMonthly = incMonthly - altMonthly;
    var deltaUpfront = altUpfront - incUpfront;

    var breakEven;
    if (deltaUpfront <= 0) breakEven = 0;
    else if (deltaMonthly <= 0) breakEven = null;
    else breakEven = Math.ceil(deltaUpfront / deltaMonthly);

    var incAt = function (n) { return incUpfront + incMonthly * n; };
    var altAt = function (n) { return altUpfront + altMonthly * n; };
    var savings = money(incAt(h) - altAt(h));

    var verdict;
    if (breakEven === null || breakEven > h || savings <= 0) verdict = 'stay';
    else if (savings < 100 || breakEven > h / 2) verdict = 'marginal';
    else verdict = 'switch';

    return {
      rate: rate,
      incumbent_monthly: money(incMonthly),
      alternative_monthly: money(altMonthly),
      alternative_upfront: money(altUpfront),
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
   * The hourly rate at which the verdict flips over the horizon.
   * Null when the operator's time never enters the comparison.
   */
  function crossover(m) {
    var h = m.horizon_months || 36;
    var hours = (m.alt_migration_hours || 0) + (m.alt_hours_monthly || 0) * h
              - (m.inc_hours_monthly || 0) * h;
    if (Math.abs(hours) < 1e-9) return null;
    var cash = (m.inc_cash_monthly * h + (m.inc_cash_one_time || 0))
             - (m.alt_cash_monthly * h + (m.alt_cash_one_time || 0));
    return Math.round((cash / hours) * 100) / 100;
  }

  /** Cumulative cost curves at a given rate, for the chart. */
  function curve(m, rate, months) {
    months = months || m.horizon_months || 36;
    var r = at(m, rate);
    var out = [];
    for (var i = 0; i <= months; i++) out.push({ month: i, incumbent: money(r.incAt(i)), alternative: money(r.altAt(i)) });
    return out;
  }

  return { at: at, crossover: crossover, curve: curve };
});
