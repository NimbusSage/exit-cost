#!/usr/bin/env node
/**
 * ops/price-probe.js — research tool for adding a vendor to data/saas.json.
 *
 * Fetches a pricing page, runs the anchored extractor, and prints each candidate
 * beside the surrounding sentence so a human can confirm or reject it. This is
 * deliberately NOT automated into the dataset: a stored price is only ever set
 * by a person reading the vendor's own words, and the quote they read gets
 * stored alongside the number.
 *
 *   node ops/price-probe.js <url> <PlanA> <PlanB> ...
 */

const { fetchText, robotsAllows } = require('../pipeline/lib/http.js');
const { htmlToText, extractForPlan, priceFingerprint } = require('../pipeline/collect/extract.js');

async function probe(url, plans, { render = false } = {}) {
  const allowed = await robotsAllows(url);
  if (!allowed.allowed) return { url, blocked: true, reason: allowed.reason };

  let html;
  try {
    if (render) {
      const { renderHtml } = require('./shoot.js');
      html = await renderHtml(url);
    } else {
      html = await fetchText(url, { timeoutMs: 25000 });
    }
  } catch (e) { return { url, error: e.message }; }

  const text = htmlToText(html);
  const out = { url, rendered: render, chars: text.length, fingerprint: priceFingerprint(text).hash, plans: [] };

  for (const name of plans) {
    const r = extractForPlan(text, name, { otherPlans: plans });
    const top = r.candidates[0];
    let context = null;
    if (top) {
      const needle = new RegExp(`.{0,90}\\$\\s?${String(top.amount).replace('.', '\\.')}\\b.{0,110}`);
      const m = text.match(needle);
      context = m ? m[0].trim() : null;
    }
    out.plans.push({ name, confidence: r.confidence, reason: r.reason, candidates: r.candidates.slice(0, 3), context });
  }
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2).filter((a) => a !== '--render');
  const render = process.argv.includes('--render');
  const [url, ...plans] = args;
  if (!url || !plans.length) { console.error('usage: price-probe.js [--render] <url> <Plan> [Plan...]'); process.exit(2); }
  probe(url, plans, { render }).then((r) => {
    if (r.blocked) return console.log(`BLOCKED by robots.txt: ${r.reason}`);
    if (r.error) return console.log(`FETCH FAILED: ${r.error}`);
    console.log(`${r.url}  (${(r.chars / 1000).toFixed(0)}k text, fingerprint ${r.fingerprint})\n`);
    for (const p of r.plans) {
      const c = p.candidates.map((x) => `$${x.amount}/${x.period || '?'}${x.cadence ? `(billed ${x.cadence})` : ''}${x.per_seat ? ' per-seat' : ''}`).join('   ');
      console.log(`  ${p.name.padEnd(22)} ${p.confidence.padEnd(7)} ${c || '-'}`);
      if (p.reason) console.log(`  ${''.padEnd(22)} ${''.padEnd(7)} (${p.reason})`);
      if (p.context) console.log(`  ${''.padEnd(30)} "${p.context}"`);
      console.log('');
    }
  });
}

module.exports = { probe };
