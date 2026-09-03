/**
 * freshness.js — the staleness rules that keep Exit Cost honest.
 *
 * Every number this project publishes carries a `verified_at`. This module is the
 * single place that decides whether a number is fresh enough to publish, and it is
 * deliberately conservative: when in doubt, mark it stale.
 *
 * Pure functions. `now` is always passed in so tests are deterministic.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a number stays trustworthy, by kind of number.
 * SaaS list prices move a few times a year and are the whole trust proposition,
 * so they get the tightest window. VPS prices come off a live API nightly.
 */
const MAX_AGE_DAYS = {
  saas: 45,      // vendor list prices — the most brittle, the most load-bearing
  vps: 7,        // pulled from a live API nightly; a week means the collector broke
  storage: 180,  // B2 / R2 published rates barely move
  project: 30,   // GitHub activity metadata
  default: 45,
};

/** Warn before it expires, so the weekly report can flag it while it is still publishable. */
const WARN_FRACTION = 0.7;

function parseDate(value) {
  if (value instanceof Date) return isNaN(value) ? null : value;
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

function ageInDays(verified_at, now = new Date()) {
  const d = parseDate(verified_at);
  if (!d) return null;
  return (now.getTime() - d.getTime()) / DAY_MS;
}

/**
 * Assess one dated value.
 * Returns { state, age_days, max_age_days, verified_at }
 * where state is 'fresh' | 'aging' | 'stale' | 'undated'.
 *
 * 'undated' is treated exactly as harshly as 'stale'. A number with no provenance
 * is not a number we publish.
 */
function assess(verified_at, kind = 'default', now = new Date()) {
  const max = MAX_AGE_DAYS[kind] ?? MAX_AGE_DAYS.default;
  const age = ageInDays(verified_at, now);
  if (age === null) {
    return { state: 'undated', age_days: null, max_age_days: max, verified_at: verified_at ?? null };
  }
  // A future-dated verification is a clock or data error, not a fresher number.
  if (age < -1) {
    return { state: 'undated', age_days: age, max_age_days: max, verified_at, error: 'verified_at is in the future' };
  }
  let state = 'fresh';
  if (age > max) state = 'stale';
  else if (age > max * WARN_FRACTION) state = 'aging';
  return { state, age_days: Math.round(age * 10) / 10, max_age_days: max, verified_at };
}

const PUBLISHABLE = new Set(['fresh', 'aging']);
const isPublishable = (state) => PUBLISHABLE.has(state);

/**
 * Roll several dated inputs into one verdict for a page.
 * The worst input wins — a page is only as fresh as its stalest number.
 */
function rollup(assessments) {
  const RANK = { fresh: 0, aging: 1, stale: 2, undated: 3 };
  let worst = { state: 'fresh' };
  let oldest = null;
  const problems = [];
  for (const a of assessments) {
    if (RANK[a.state] > RANK[worst.state]) worst = a;
    if (a.age_days !== null && (oldest === null || a.age_days > oldest)) oldest = a.age_days;
    if (!isPublishable(a.state)) problems.push({ label: a.label || 'unlabelled', state: a.state, verified_at: a.verified_at });
  }
  return {
    state: worst.state,
    publishable: isPublishable(worst.state),
    oldest_input_days: oldest === null ? null : Math.round(oldest * 10) / 10,
    problems,
  };
}

/** ISO date (no time) — what goes into the data files and onto the page. */
const today = (now = new Date()) => now.toISOString().slice(0, 10);

module.exports = { assess, rollup, ageInDays, isPublishable, today, MAX_AGE_DAYS, WARN_FRACTION, DAY_MS };
