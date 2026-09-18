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
 * Is `other` the same price as `stored`, expressed over a different period?
 *
 * Pricing pages routinely show both framings — "$10 per month, $120 billed
 * annually" — and the extractor rightly calls that ambiguous. But it is not
 * ambiguous when one figure matches what we stored and the other is that same
 * figure over a year: it is the page agreeing with us twice.
 *
 * Deliberately narrow. A neighbouring tier's price is NOT explicable, so
 * "$10 and $20" stays ambiguous and goes to a human — which is the case where
 * a wrong confirmation would actually hurt.
 */
function explicableCounterpart(stored, other) {
  if (other === 0) return true;                        // a free tier mentioned alongside
  if (sameAmount(other, stored * 12)) return true;     // the annual framing of a monthly price
  if (sameAmount(other, stored / 12)) return true;     // the monthly framing of an annual price
  return false;
}

/**
 * Decide what an extraction says about a stored price. Pure, so the policy that
 * guards the entire trust proposition is testable without a network.
 */
function classify(stored, extraction) {
  if (!extraction || !extraction.candidates?.length) {
    return { agreement: 'unverifiable', reason: extraction?.reason || 'no confident extraction' };
  }

  let got = extraction.candidates[0];

  if (extraction.confidence !== 'high') {
    // Accept a lower-confidence extraction only when one candidate matches what
    // we stored exactly — amount, period and per-seat — and every other candidate
    // is the same price over a different period. Anything else stays for a human.
    const ign = new Set(stored.check_ignores || []);
    const exact = extraction.candidates.find((c) =>
      sameAmount(c.amount, stored.amount)
      && (ign.has('period') || c.period === stored.period)
      && (ign.has('per_seat') || !!c.per_seat === !!stored.per_seat)
      && (ign.has('currency') || !c.currency || !stored.currency || c.currency === stored.currency));
    if (!exact) {
      return { agreement: 'unverifiable', reason: extraction.reason || 'no candidate matches the stored price' };
    }
    const others = [...new Set(extraction.candidates.map((c) => c.amount))].filter((a) => !sameAmount(a, stored.amount));
    if (!others.every((a) => explicableCounterpart(stored.amount, a))) {
      return {
        agreement: 'unverifiable',
        reason: `the stored price appears, but so do unrelated figures (${others.join(', ')}) — a human should look`,
      };
    }
    return { agreement: 'match', found: exact, via: 'period-counterpart' };
  }

  // Some vendors never state a field near the price — Vercel's headline reads
  // "$20 /mo." and says nothing about seats, though it bills per developer seat.
  // A plan may declare which fields its page cannot express, so the cross-check
  // compares only what is actually checkable rather than reporting a drift every
  // night that no human can resolve. Declaring it is deliberate and auditable;
  // loosening the matcher for everyone would not be.
  const ignored = new Set(stored.check_ignores || []);

  // A period or per-seat mismatch is a structural change (per-seat -> flat, monthly
  // -> annual). Never reconcile that automatically; the arithmetic depends on it.
  if (!ignored.has('period') && got.period !== stored.period) {
    return { agreement: 'drift', reason: `billing period changed: stored ${stored.period}, page says ${got.period ?? 'unstated'}`, found: got };
  }
  if (!ignored.has('per_seat') && !!got.per_seat !== !!stored.per_seat) {
    return { agreement: 'drift', reason: `per-seat billing changed: stored ${!!stored.per_seat}, page says ${got.per_seat}`, found: got };
  }
  if (!ignored.has('currency') && got.currency && stored.currency && got.currency !== stored.currency) {
    return { agreement: 'drift', reason: `currency changed: stored ${stored.currency}, page says ${got.currency}`, found: got };
  }
  // The amount itself is never ignorable — that is the number we publish.
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
/**
 * Render a page with a headless browser.
 *
 * Some vendors ship an empty pricing table in the initial response and build it
 * with JavaScript; a plain fetch sees no prices at all, so the stored value can
 * never self-confirm and eventually ages out. Reading the page the way a browser
 * does is the only honest way to see what they publish.
 *
 * Returns null if no browser is available, so a machine without Chrome degrades
 * to plain fetching rather than failing the run.
 */
async function renderIfPossible(url) {
  try {
    const { renderHtml } = require('../../ops/shoot.js');
    return await renderHtml(url, { waitMs: 3500 });
  } catch (e) {
    return null;
  }
}

async function checkVendor(vendor, { today, respectRobots = true, allowRender = true } = {}) {
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

  // Include every tier shown on the page, not just the ones we price. Without
  // the neighbours the extractor cannot tell where one plan's block ends, and a
  // tier we do not track bleeds its price into one we do.
  const planNames = [...new Set([
    ...vendor.plans.map((p) => p.page_label || p.name),
    ...(vendor.page_plan_names || []),
  ])];
  const assess = (pageText) => vendor.plans.map((stored) => {
    const label = stored.page_label || stored.name;
    return { stored, extraction: extractForPlan(pageText, label, { otherPlans: planNames }) };
  });

  let text = htmlToText(html);
  let results = assess(text);
  let rendered = false;

  // Retry with a browser only when the plain fetch found no price anywhere —
  // rendering every vendor nightly would be slow and is almost never needed.
  const foundNothing = results.every((r) => !r.extraction.candidates?.length);
  if (foundNothing && allowRender) {
    const renderedHtml = await renderIfPossible(url);
    if (renderedHtml) {
      const renderedText = htmlToText(renderedHtml);
      const renderedResults = assess(renderedText);
      if (renderedResults.some((r) => r.extraction.candidates?.length)) {
        text = renderedText;
        results = renderedResults;
        rendered = true;
      }
    }
  }

  const fingerprint = priceFingerprint(text);
  const plans = results.map((r) => applyCheck(r.stored, classify(r.stored, r.extraction), { today }));

  return {
    ...out,
    ok: true,
    rendered,
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

module.exports = { checkVendor, checkAll, classify, applyCheck, summarise, sameAmount, explicableCounterpart };
