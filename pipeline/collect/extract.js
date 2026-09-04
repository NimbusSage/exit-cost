/**
 * extract.js — anchored price extraction from a vendor pricing page.
 *
 * A global "find every $NN on the page" regex produces wrong answers: a pricing
 * page is full of unrelated numbers (annual totals, savings claims, add-ons,
 * footnotes). So instead we anchor on the plan name and only accept a price that
 * sits close to it, and we return a CONFIDENCE rather than a bare number.
 *
 * Nothing here ever decides to publish. It produces candidates; the caller
 * applies the acceptance policy in saas.js, which refuses anything ambiguous.
 */

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&apos;': "'" };

/** Strip a page to readable text, preserving rough word order for anchoring. */
function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Currency tokens we understand. Anything else is left alone rather than assumed to be USD. */
const PRICE_RE = /(?:(US\$|C\$|A\$|\$|€|£)\s?([0-9]{1,4}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?))|(?:([0-9]{1,4}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s?(€|£))/g;

const SYMBOL_CURRENCY = { '$': 'USD', 'US$': 'USD', 'C$': 'CAD', 'A$': 'AUD', '€': 'EUR', '£': 'GBP' };

/** Every price token in a text blob, with its character offset. */
function findPrices(text) {
  const out = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const symbol = m[1] || m[4];
    const raw = m[2] || m[3];
    const amount = parseFloat(raw.replace(/,/g, ''));
    if (!isFinite(amount)) continue;
    out.push({ amount, currency: SYMBOL_CURRENCY[symbol] || null, index: m.index, text: m[0].trim() });
  }
  return out;
}

/**
 * Billing period inferred from the words immediately after a price.
 *
 * The trap this function exists to avoid: "$20 per user/month, billed annually"
 * is a MONTHLY price on an annual cadence, not a $20/year price. Conflating the
 * two is a 12x error, so "billed annually" is parsed as cadence and is never
 * allowed to set the unit.
 *
 * Returns { unit, cadence }. `unit` is null when the page does not state one —
 * and null is a rejection, not a quiet default to "month".
 */
function inferPeriod(text, priceEnd, window = 70) {
  const tail = text.slice(priceEnd, priceEnd + window).toLowerCase();

  // Cadence first, and remove it so it cannot be mistaken for a unit.
  let cadence = null;
  const billed = tail.match(/\bbilled\s+(annually|yearly|per\s+year|monthly|per\s+month)\b/);
  if (billed) cadence = /annual|year/.test(billed[1]) ? 'annual' : 'monthly';
  const rest = billed ? tail.replace(billed[0], ' ') : tail;

  let unit = null;
  if (/\bone[-\s]?time\b|\blifetime\b|\bforever\b|\bpay\s+once\b/.test(rest)) unit = 'once';
  else if (/\/\s?(mo|month)\b|\bper\s+month\b|\ba\s+month\b|\bmonthly\b|\buser\s?\/\s?month\b|\bseat\s?\/\s?month\b/.test(rest)) unit = 'month';
  else if (/\/\s?(yr|year)\b|\bper\s+year\b|\ba\s+year\b|\byearly\b|\bannually\b/.test(rest)) unit = 'year';
  // Cadence alone never sets the unit: "billed annually" with no /month or /year
  // nearby leaves the unit genuinely unknown, which is the correct answer.

  return { unit, cadence };
}

/** Whether the price is quoted per seat. Same rule: silence is not a yes. */
function inferPerSeat(text, priceStart, priceEnd, window = 80) {
  const around = (text.slice(Math.max(0, priceStart - 40), priceEnd + window)).toLowerCase();
  return /\bper\s+(user|seat|member|person|editor|agent|host|author|contributor)\b/.test(around)
      || /\/\s?(user|seat|member|agent|editor|host)\b/.test(around)
      || /\b(user|seat|member|agent)\s?\/\s?month\b/.test(around);
}

/** Word-boundary matcher for a plan name (so "Pro" does not match "Product"). */
function planNameRe(name) {
  return new RegExp(`(?<![A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'gi');
}

/**
 * Assign every price on the page to exactly one plan.
 *
 * The rule that makes this reliable: a price belongs to the LAST plan name
 * mentioned before it. That is how a pricing page actually reads top to bottom,
 * and it means one price can never be counted for two tiers — which is what
 * caused "contact sales" tiers to silently inherit the price printed above them.
 */
function assignPrices(text, planNames, { window = 220 } = {}) {
  const prices = findPrices(text);
  const anchors = [];
  for (const n of planNames) {
    for (const m of text.matchAll(planNameRe(n))) anchors.push({ plan: n, index: m.index, end: m.index + m[0].length });
  }
  anchors.sort((a, b) => a.index - b.index);

  const byPlan = new Map(planNames.map((n) => [n, []]));
  const seenAnchor = new Set(anchors.map((a) => a.plan));

  for (const p of prices) {
    let owner = null;
    for (const a of anchors) {
      if (a.end <= p.index) owner = a;
      else break;
    }
    if (!owner) continue;                             // price appears before any plan name
    const distance = p.index - owner.end;
    if (distance > window) continue;                  // too far from its plan to be its price
    const end = p.index + p.text.length;
    const per = inferPeriod(text, end);
    byPlan.get(owner.plan).push({
      amount: p.amount,
      currency: p.currency,
      period: per.unit,
      cadence: per.cadence,
      per_seat: inferPerSeat(text, p.index, end),
      distance,
    });
  }
  return { byPlan, seenAnchor };
}

/**
 * Candidate prices for one named plan, with a confidence the caller can act on.
 *
 * Confidence:
 *   'high'   exactly one distinct amount for this plan, and a billing unit was stated
 *   'medium' one distinct amount but no stated unit, or exactly two amounts
 *            (typically the monthly and annual framings of the same tier)
 *   'low'    several distinct amounts, or none, or the plan name is absent
 *
 * `otherPlans` should list the sibling tiers on the page. Without them, prices
 * from adjacent tiers bleed into this one.
 */
function extractForPlan(text, planName, { window = 220, otherPlans = [] } = {}) {
  const all = [...new Set([planName, ...otherPlans])];
  const { byPlan, seenAnchor } = assignPrices(text, all, { window });

  if (!seenAnchor.has(planName)) {
    return { plan: planName, confidence: 'low', reason: 'plan name not found on page', candidates: [] };
  }

  // Collapse duplicates, keeping the closest instance of each distinct quote.
  const seen = new Map();
  for (const c of byPlan.get(planName) || []) {
    const key = `${c.amount}|${c.currency}|${c.period}|${c.cadence}|${c.per_seat}`;
    const prior = seen.get(key);
    if (!prior || c.distance < prior.distance) seen.set(key, c);
  }
  const candidates = [...seen.values()].sort((a, b) => a.distance - b.distance);
  const distinctAmounts = new Set(candidates.map((c) => c.amount));

  let confidence = 'low', reason = null;
  if (candidates.length === 0) { reason = 'no price found near the plan name'; }
  else if (distinctAmounts.size === 1 && candidates[0].period) { confidence = 'high'; }
  else if (distinctAmounts.size === 1) { confidence = 'medium'; reason = 'billing period not stated near the price'; }
  else if (distinctAmounts.size === 2 && candidates[0].period) { confidence = 'medium'; reason = 'two prices near the plan name (likely monthly and annual)'; }
  else { reason = `${distinctAmounts.size} different prices near the plan name`; }

  return { plan: planName, confidence, reason, candidates };
}

/**
 * A stable fingerprint of the page's pricing content.
 *
 * The point is change DETECTION, not extraction: when this fingerprint moves we
 * know the vendor touched their pricing and the stored number needs re-checking.
 * Built from the sorted set of price tokens so that unrelated marketing-copy
 * edits do not trigger a false alarm.
 */
function priceFingerprint(text) {
  const amounts = [...new Set(findPrices(text).map((p) => `${p.currency || '?'}${p.amount}`))].sort();
  const crypto = require('node:crypto');
  return { hash: crypto.createHash('sha256').update(amounts.join('|')).digest('hex').slice(0, 16), token_count: amounts.length, tokens: amounts };
}

module.exports = { htmlToText, findPrices, inferPeriod, inferPerSeat, extractForPlan, assignPrices, priceFingerprint, PRICE_RE };
