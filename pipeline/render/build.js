#!/usr/bin/env node
/**
 * render/build.js — turn the dataset into the computed page models everything else renders.
 *
 * This is the only place escapes are resolved. The site, the video pipeline, the
 * public JSON API and the newsletter all read its output, so they can never
 * disagree about a number.
 */

const { readJson, writeJson, listJson, p } = require('../lib/store.js');
const { flattenPlans } = require('../collect/merge.js');
const { resolveAll } = require('../compute/resolve.js');
const { today } = require('../lib/freshness.js');

const OUT = (...parts) => p('data', 'build', ...parts);

function loadContext(now = new Date()) {
  const vps = readJson(p('data', 'sources', 'vps.json'), { providers: {} });
  return {
    now,
    // Stale providers are excluded from selection: we will not price an escape
    // off a number we could not confirm.
    vpsPlans: flattenPlans(vps),
    saas: readJson(p('data', 'saas.json'), { vendors: [] }),
    storage: readJson(p('data', 'storage.json'), { options: [] }),
    projects: readJson(p('data', 'sources', 'projects.json'), { projects: {} }).projects || {},
  };
}

function loadEscapes() {
  return listJson(p('data', 'escapes')).map((f) => readJson(f)).filter(Boolean);
}

function main() {
  // EXITCOST_NOW pins the clock. Nightly runs leave it unset; tests set it to the
  // date the committed pricing was fetched, so they do not rot with the calendar.
  const now = process.env.EXITCOST_NOW ? new Date(process.env.EXITCOST_NOW) : new Date();
  const ctx = loadContext(now);
  const escapes = loadEscapes();

  if (!ctx.vpsPlans.length) {
    console.error('FATAL: no fresh VPS plans available. Refusing to build pages off stale hosting prices.');
    process.exit(1);
  }

  const { pages, blocked } = resolveAll(escapes, ctx);

  const index = {
    generated_at: now.toISOString(),
    day: today(now),
    counts: { total: escapes.length, published: pages.length, blocked: blocked.length },
    vps_plans: ctx.vpsPlans.length,
    escapes: pages.map((r) => ({
      slug: r.slug, title: r.title, summary: r.summary, category: r.category,
      verdict: r.result.verdict,
      incumbent: r.incumbent.vendor, incumbent_plan: r.incumbent.plan, seats: r.incumbent.seats,
      alternative: r.alternative.name,
      incumbent_annual: r.result.incumbent.annual,
      alternative_annual: r.result.alternative.annual,
      break_even_month: r.result.break_even_month,
      break_even_hourly_rate: r.result.break_even_hourly_rate,
      savings_year_3: r.result.savings.year_3,
      freshness: r.freshness.state,
      updated_at: r.updated_at,
    })),
    blocked: blocked.map((b) => ({ slug: b.slug, reason: b.block_reason || b.errors?.join('; ') })),
  };

  writeJson(OUT('index.json'), index);
  for (const r of pages) writeJson(OUT('escapes', `${r.slug}.json`), r);

  console.log(`built ${pages.length}/${escapes.length} escapes from ${ctx.vpsPlans.length} live VPS plans`);
  for (const b of blocked) console.log(`  BLOCKED ${b.slug}: ${b.block_reason || b.errors?.join('; ')}`);
  return index;
}

if (require.main === module) main();
module.exports = { main, loadContext, loadEscapes };
