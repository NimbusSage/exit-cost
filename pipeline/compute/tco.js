/**
 * tco.js — the arithmetic core of Exit Cost.
 *
 * Pure functions only. No I/O, no network, no clock reads beyond what is passed in.
 * Everything downstream (site, video, API) is plumbing around this file.
 *
 * Design rule: this module is CATEGORY-AGNOSTIC. It compares the total cost of
 * staying on `incumbent` against the total cost of moving to `alternative` over a
 * horizon, and it charges the operator's time as a real cost. It does not know or
 * care whether the alternative is self-hosted software, a cheaper SaaS, or a
 * one-time purchase. That keeps a category pivot a config change, not a rewrite.
 *
 * Integrity rule: a cost with `unknown: true` poisons the result. We return
 * `computable: false` rather than substituting a guess. A wrong number is worse
 * than no number.
 */

const MONTHS_PER_YEAR = 12;

/** Round to cents. Avoids float dust like 71.00000000000001 leaking into pages. */
const money = (n) => Math.round(n * 100) / 100;

/** Round to 2dp for rates/ratios. */
const rate = (n) => Math.round(n * 100) / 100;

/**
 * Normalise a price entry to a plain monthly number.
 *
 * Accepts:
 *   { amount, period: 'month'|'year'|'once', per_seat: bool }
 * with `seats` applied when per_seat.
 *
 * Returns { monthly, one_time }. A 'once' price contributes only to one_time.
 */
function toMonthly(entry, seats = 1) {
  if (!entry || typeof entry.amount !== 'number' || !isFinite(entry.amount)) {
    throw new TypeError('price entry requires a finite numeric `amount`');
  }
  if (entry.amount < 0) throw new RangeError('price amount cannot be negative');
  const units = entry.per_seat ? seats : 1;
  if (!Number.isInteger(units) || units < 1) {
    throw new RangeError('seats must be a positive integer');
  }
  const total = entry.amount * units;
  switch (entry.period) {
    case 'month': return { monthly: total, one_time: 0 };
    case 'year':  return { monthly: total / MONTHS_PER_YEAR, one_time: 0 };
    case 'once':  return { monthly: 0, one_time: total };
    default: throw new TypeError(`unknown period: ${JSON.stringify(entry.period)}`);
  }
}

/**
 * Sum a list of price entries into { monthly, one_time }.
 * Any entry flagged `unknown: true` makes the whole sum unknown — this is the
 * mechanism by which a failed collector refuses to produce a number.
 */
function sumCosts(entries = [], seats = 1) {
  let monthly = 0, one_time = 0, unknown = false;
  const unknown_items = [];
  for (const e of entries) {
    if (e && e.unknown) {
      unknown = true;
      unknown_items.push(e.label || 'unlabelled cost');
      continue;
    }
    const { monthly: m, one_time: o } = toMonthly(e, seats);
    monthly += m;
    one_time += o;
  }
  return { monthly, one_time, unknown, unknown_items };
}

/**
 * Break-even month: the first whole month at which cumulative alternative cost
 * has fallen to or below cumulative incumbent cost.
 *
 * Returns a positive integer, 0 (cheaper immediately), or null (never).
 */
function breakEvenMonth(deltaMonthly, deltaUpfront) {
  // deltaMonthly  = incumbent monthly - alternative monthly (positive = saving/mo)
  // deltaUpfront  = alternative one-time - incumbent one-time (positive = cost to switch)
  if (deltaUpfront <= 0) return 0;              // cheaper from day one
  if (deltaMonthly <= 0) return null;           // never catches up
  return Math.ceil(deltaUpfront / deltaMonthly);
}

/**
 * The signature number of this product.
 *
 * At what hourly value of the operator's time does the verdict flip?
 * Below this rate, switching wins over the horizon. Above it, staying wins.
 *
 * Solves for r in:
 *   incumbent_total(H) = alt_cash_one_time + alt_cash_monthly*H + r*(migration_h + maint_h*H)
 *
 * Returns null when the operator's time does not enter the comparison at all
 * (no migration hours and no maintenance hours), because then no rate flips it.
 */
function breakEvenHourlyRate({ incumbentTotalCash, altTotalCash, migrationHours, maintenanceHoursPerMonth, incumbentMaintenanceHoursPerMonth = 0, horizonMonths }) {
  // Net hours the switch actually costs: the alternative's migration and upkeep,
  // LESS whatever upkeep the incumbent was already consuming. Omitting that second
  // term overstates the crossover whenever the SaaS also costs the operator time.
  const netHours = migrationHours
    + maintenanceHoursPerMonth * horizonMonths
    - incumbentMaintenanceHoursPerMonth * horizonMonths;
  if (Math.abs(netHours) < 1e-9) return null;
  const cashHeadroom = incumbentTotalCash - altTotalCash;
  return cashHeadroom / netHours;
}

/**
 * Compare an incumbent against an alternative.
 *
 * @param {object} input
 * @param {object} input.incumbent   { costs: [priceEntry], one_time_costs?: [priceEntry] }
 * @param {object} input.alternative { costs: [priceEntry], one_time_costs?: [priceEntry],
 *                                     migration_hours: number, maintenance_hours_per_month: number }
 * @param {number} input.seats
 * @param {number} input.horizon_months
 * @param {number} input.hourly_rate  value of the operator's own time
 */
function compare(input) {
  const {
    incumbent,
    alternative,
    seats = 1,
    horizon_months = 36,
    hourly_rate = 50,
  } = input;

  if (!incumbent || !alternative) throw new TypeError('compare() needs incumbent and alternative');
  if (!Number.isInteger(horizon_months) || horizon_months < 1) {
    throw new RangeError('horizon_months must be a positive integer');
  }
  if (typeof hourly_rate !== 'number' || hourly_rate < 0 || !isFinite(hourly_rate)) {
    throw new RangeError('hourly_rate must be a non-negative finite number');
  }

  const inc = sumCosts([...(incumbent.costs || []), ...(incumbent.one_time_costs || [])], seats);
  const alt = sumCosts([...(alternative.costs || []), ...(alternative.one_time_costs || [])], seats);

  // Integrity gate: refuse to emit numbers built on an unknown input.
  if (inc.unknown || alt.unknown) {
    return {
      computable: false,
      reason: 'unknown_cost_input',
      unknown_items: [...inc.unknown_items, ...alt.unknown_items],
    };
  }

  const migrationHours = Number(alternative.migration_hours ?? 0);
  const maintPerMonth  = Number(alternative.maintenance_hours_per_month ?? 0);
  const incMaintPerMonth = Number(incumbent.maintenance_hours_per_month ?? 0);
  if (migrationHours < 0 || maintPerMonth < 0 || incMaintPerMonth < 0) {
    throw new RangeError('hour inputs cannot be negative');
  }

  // Time, priced. This is the line every other comparison omits.
  const altTimeMonthly = maintPerMonth * hourly_rate;
  const incTimeMonthly = incMaintPerMonth * hourly_rate;
  const altTimeUpfront = migrationHours * hourly_rate;

  const incMonthlyAll = inc.monthly + incTimeMonthly;
  const altMonthlyAll = alt.monthly + altTimeMonthly;
  const incUpfrontAll = inc.one_time;
  const altUpfrontAll = alt.one_time + altTimeUpfront;

  const deltaMonthly = incMonthlyAll - altMonthlyAll;
  const deltaUpfront = altUpfrontAll - incUpfrontAll;

  const be = breakEvenMonth(deltaMonthly, deltaUpfront);

  const totalAt = (m) => ({
    incumbent:   money(incUpfrontAll + incMonthlyAll * m),
    alternative: money(altUpfrontAll + altMonthlyAll * m),
  });

  const h = horizon_months;
  const at12 = totalAt(12), at36 = totalAt(36), atH = totalAt(h);

  const crossoverRate = breakEvenHourlyRate({
    incumbentTotalCash: inc.one_time + inc.monthly * h,
    altTotalCash:       alt.one_time + alt.monthly * h,
    migrationHours,
    maintenanceHoursPerMonth: maintPerMonth,
    incumbentMaintenanceHoursPerMonth: incMaintPerMonth,
    horizonMonths: h,
  });

  const savingsAtHorizon = money(atH.incumbent - atH.alternative);

  // Verdict. `marginal` exists so the product can honestly say "not worth the bother".
  let verdict;
  if (be === null) verdict = 'stay';
  else if (be > horizon_months) verdict = 'stay';
  else if (savingsAtHorizon <= 0) verdict = 'stay';
  else if (savingsAtHorizon < 100 || (be > horizon_months / 2)) verdict = 'marginal';
  else verdict = 'switch';

  return {
    computable: true,
    inputs: { seats, horizon_months: h, hourly_rate },
    incumbent: {
      cash_monthly: money(inc.monthly),
      time_monthly: money(incTimeMonthly),
      monthly: money(incMonthlyAll),
      one_time: money(incUpfrontAll),
      annual: money(incMonthlyAll * 12),
    },
    alternative: {
      cash_monthly: money(alt.monthly),
      time_monthly: money(altTimeMonthly),
      monthly: money(altMonthlyAll),
      one_time: money(altUpfrontAll),
      cash_one_time: money(alt.one_time),
      time_one_time: money(altTimeUpfront),
      annual: money(altMonthlyAll * 12),
    },
    delta: {
      monthly: money(deltaMonthly),
      upfront_to_switch: money(deltaUpfront),
      annual: money(deltaMonthly * 12),
    },
    break_even_month: be,
    break_even_hourly_rate: crossoverRate === null ? null : rate(crossoverRate),
    totals: { at_12_months: at12, at_36_months: at36, at_horizon: atH },
    savings: {
      year_1: money(at12.incumbent - at12.alternative),
      year_3: money(at36.incumbent - at36.alternative),
      at_horizon: savingsAtHorizon,
    },
    verdict,
  };
}

/**
 * Cumulative cost curves, for charting. Month 0 = upfront only.
 * Kept separate from compare() so the site can render a chart without recomputing.
 */
function curve(result, months = 36) {
  if (!result.computable) return [];
  const out = [];
  for (let m = 0; m <= months; m++) {
    out.push({
      month: m,
      incumbent:   money(result.incumbent.one_time + result.incumbent.monthly * m),
      alternative: money(result.alternative.one_time + result.alternative.monthly * m),
    });
  }
  return out;
}

/**
 * Sensitivity band: how the verdict moves across plausible hourly rates.
 * Publishing this is the honesty mechanism — the answer genuinely depends on
 * what the reader's time is worth, and we show that instead of hiding it.
 */
function sensitivity(input, rates = [0, 25, 50, 75, 100, 150, 200]) {
  return rates.map((hourly_rate) => {
    const r = compare({ ...input, hourly_rate });
    return r.computable
      ? { hourly_rate, verdict: r.verdict, break_even_month: r.break_even_month, savings_at_horizon: r.savings.at_horizon }
      : { hourly_rate, verdict: null, computable: false };
  });
}

module.exports = {
  compare,
  curve,
  sensitivity,
  toMonthly,
  sumCosts,
  breakEvenMonth,
  breakEvenHourlyRate,
  MONTHS_PER_YEAR,
};
