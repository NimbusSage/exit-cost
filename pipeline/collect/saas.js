/**
 * saas.js — the SaaS side of every comparison, and the most brittle input we have.
 *
 * The architecture, and the reason for it:
 *
 *   Stored prices are HUMAN-VERIFIED and carry a source_url and a verified_at.
 *   They are the only thing that ever publishes.
 *
 *   This collector does not extract prices in order to publish them. It fetches
 *   the vendor's pricing page and CROSS-CHECKS the stored value against it:
 *
 *     match         extraction agrees with the stored price  -> refresh verified_at,
 *                   the number stays live with no human involvement
 *     drift         extraction is confident and DISAGREES    -> keep the old price,
 *                   flag needs_reverification, escalate to the weekly report
 *     unverifiable  extraction is not confident enough       -> keep the old price,
 *                   do NOT refresh verified_at; age will make it stale on its own
 *
 * So the machine runs itself while prices hold, and asks for a human exactly when
 * a vendor actually changes a price. It never publishes a number it inferred.
 */

const { fetchText, robotsAllows } = require('../lib/http.js');
const { htmlToText, extractForPlan, priceFingerprint } = require('./extract.js');

/** Cent-level equality; vendors quote to 2dp. */
const sameAmount = (a, b) => Math.abs(a - b) < 0.005;

/**
 * Decide what an extraction says about a stored price. Pure, so the policy that
 * guards the entire trust proposition is testable without a network.
 */
function classify(stored, extraction) {
  if (!extraction || extraction.confidence !== 'high' || !extraction.candidates?.length) {
    return { agreement: 'unverifiable', reason: extraction?.reason || 'no confident extraction' };
  }
  const got = extraction.candidates[0];

  // A period or per-seat mismatch is a structural change (per-seat -> flat, monthly
  // -> annual). Never reconcile that automatically; the arithmetic depends on it.
  if (got.period !== stored.period) {
    return { agreement: 'drift', reason: `billing period changed: stored ${stored.period}, page says ${got.period ?? 'unstated'}`, found: got };
  }
  if (!!got.per_seat !== !!stored.per_seat) {
    return { agreement: 'drift', reason: `per-seat billing changed: stored ${!!stored.per_seat}, page says ${got.per_seat}`, found: got };
  }
  if (got.currency && stored.currency && got.currency !== stored.currency) {
    return { agreement: 'drift', reason: `currency changed: stored ${stored.currency}, page says ${got.currency}`, found: got };
  }
  if (!sameAmount(got.amount, stored.amount)) {
    const delta_pct = stored.amount === 0 ? null : Math.round(((got.amount - stored.amount) / stored.amount) * 1000) / 10;
    return { agreement: 'drift', reason: `price changed: stored ${stored.amount}, page says ${got.amount}`, found: got, delta_pct };
  }
  return { agreement: 'match', found: got };
}

/**
 * Apply the classification to a stored plan record.
 * Returns a NEW record; never mutates. The one rule that matters: `amount` is
 * only ever changed by a human, never by this function.
 */
function applyCheck(stored, classification, { today }) {
  const base = { ...stored };
  delete base.check_error;

  if (classification.agreement === 'match') {
    return {
      ...base,
      verified_at: today,
      last_auto_confirmed_at: today,
      needs_reverification: false,
      check: { agreement: 'match', at: today },
    };
  }
  if (classification.agreement === 'drift') {
    return {
      ...base,                                   // amount deliberately untouched
      needs_reverification: true,
      check: {
        agreement: 'drift',
        at: today,
        reason: classification.reason,
        observed: classification.found ? { amount: classification.found.amount, period: classification.found.period, per_seat: classification.found.per_seat } : null,
        delta_pct: classification.delta_pct ?? null,
      },
    };
  }
  return {
    ...base,                                     // verified_at deliberately NOT refreshed
    check: { agreement: 'unverifiable', at: today, reason: classification.reason },
  };
}

/**
 * Check one vendor's whole pricing page.
 * `vendor` is a record from data/saas.json.
 */
async function checkVendor(vendor, { today, respectRobots = true } = {}) {
  const url = vendor.pricing_url;
  const out = { id: vendor.id, pricing_url: url, checked_at: today };

  if (respectRobots) {
    const allowed = await robotsAllows(url);
    if (!allowed.allowed) {
      return { ...out, ok: false, blocked: true, reason: `robots.txt disallows: ${allowed.reason}`, plans: vendor.plans };
    }
  }

  let html;
  try {
    html = await fetchText(url, { timeoutMs: 25000 });
  } catch (e) {
    return { ...out, ok: false, reason: `fetch failed: ${e.message}`, plans: vendor.plans };
  }

  const text = htmlToText(html);
  const fingerprint = priceFingerprint(text);
  const planNames = vendor.plans.map((p) => p.page_label || p.name);

  const plans = vendor.plans.map((stored) => {
    const label = stored.page_label || stored.name;
    const extraction = extractForPlan(text, label, { otherPlans: planNames });
    const classification = classify(stored, extraction);
    return applyCheck(stored, classification, { today });
  });

  return {
    ...out,
    ok: true,
    fingerprint,
    fingerprint_changed: vendor.fingerprint ? vendor.fingerprint.hash !== fingerprint.hash : null,
    plans,
  };
}

/** Check every vendor, sequentially and politely. */
async function checkAll(vendors, opts = {}) {
  const results = [];
  for (const v of vendors) {
    try {
      results.push(await checkVendor(v, opts));
    } catch (e) {
      results.push({ id: v.id, ok: false, reason: `unhandled: ${e.message}`, plans: v.plans });
    }
  }
  return results;
}

/** Roll a set of check results into the counts the weekly report needs. */
function summarise(results) {
  const s = { vendors: results.length, ok: 0, failed: 0, blocked: 0, match: 0, drift: 0, unverifiable: 0, drifted: [] };
  for (const r of results) {
    if (r.blocked) s.blocked++;
    else if (r.ok) s.ok++;
    else s.failed++;
    for (const p of r.plans || []) {
      const a = p.check?.agreement;
      if (a === 'match') s.match++;
      else if (a === 'drift') { s.drift++; s.drifted.push({ vendor: r.id, plan: p.name, ...p.check }); }
      else if (a === 'unverifiable') s.unverifiable++;
    }
  }
  return s;
}

module.exports = { checkVendor, checkAll, classify, applyCheck, summarise, sameAmount };
