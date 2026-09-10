#!/usr/bin/env node
/**
 * ops/report.js — the weekly report.
 *
 * This is the only thing a human is expected to read routinely, so it is written
 * to be skimmed in about a minute and to lead with anything that needs a person.
 * If nothing needs a person, it says so in the first line and the rest is optional.
 */

const { execFileSync } = require('node:child_process');
const { readJson, listJson, p } = require('../pipeline/lib/store.js');
const { assess } = require('../pipeline/lib/freshness.js');

/**
 * Consecutive days the nightly job has refreshed data without a human.
 *
 * Read from the git history rather than a counter, because the history is the
 * evidence: each nightly run commits its own price refresh, so the run of
 * consecutive dated commits IS the record of unattended operation. A counter
 * would just be something else to keep truthful.
 */
function unattendedDays() {
  let out;
  try {
    out = execFileSync('git', ['log', '--pretty=%s', '--grep=nightly price refresh', '-n', '90'],
      { cwd: p('.'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return 0; }

  const days = [...new Set([...out.matchAll(/nightly price refresh (\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]))]
    .sort().reverse();
  if (!days.length) return 0;

  const DAY = 86400000;
  const today = new Date().toISOString().slice(0, 10);
  // Allow the streak to start today or yesterday — the job runs at 05:17 UTC, so
  // before then the newest commit is legitimately yesterday's.
  const gapFromToday = Math.round((new Date(today) - new Date(days[0])) / DAY);
  if (gapFromToday > 1) return 0;

  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    if (Math.round((new Date(days[i - 1]) - new Date(days[i])) / DAY) === 1) streak++;
    else break;
  }
  return streak;
}

/** Affiliate programs that are actually live, read from the data rather than assumed. */
function connectedPrograms() {
  const d = readJson(p('data', 'affiliates.json'), { programs: [] });
  return (d.programs || []).filter((a) => a.status === 'active' && a.url);
}

const GATES = [
  { n: 1, day: 30,  test: (s) => s.published >= 30 && s.unattended_days >= 7,
    label: '30 comparisons live, pipeline unattended 7 days',
    miss: 'the autonomy is not real yet — fix that before adding volume' },
  { n: 2, day: 60,  test: (s) => (s.visitors_per_day >= 100 || s.video_views_month >= 10000) && s.conversions >= 1,
    label: '100 visitors/day or 10k video views/month, and one affiliate conversion',
    miss: 'the format is wrong — change the content angle, keep the machine' },
  { n: 3, day: 120, test: (s) => s.revenue_per_day >= 10,
    label: '$10/day run rate',
    miss: 'diagnose traffic vs conversion; pivot category or stop' },
  { n: 4, day: 180, test: (s) => s.revenue_per_day >= 40,
    label: '$40/day, on track for $100/day by month 8',
    miss: 'honest reassessment, no sunk-cost continuation' },
];

const START = process.env.EXITCOST_START || '2026-09-03';
const day = (now) => Math.floor((now - new Date(START)) / 86400000);

const bullet = (s) => `  - ${s}`;

function main() {
  const now = new Date();
  const out = [];
  const needsHuman = [];

  const index = readJson(p('data', 'build', 'index.json'));
  const saas = readJson(p('data', 'saas.json'));
  const vps = readJson(p('data', 'sources', 'vps.json'), { providers: {} });
  const projects = readJson(p('data', 'sources', 'projects.json'), { projects: {} }).projects || {};
  const metrics = readJson(p('data', 'metrics.json'), {});

  // ---- anything that needs a person ---------------------------------------
  for (const v of saas.vendors || []) {
    for (const pl of v.plans || []) {
      if (pl.needs_reverification) {
        needsHuman.push(`${v.name} ${pl.name}: page now shows ${pl.check?.observed?.amount ?? '?'}, we publish ${pl.amount}. ${pl.check?.reason || ''}  ->  ${v.pricing_url}`);
      }
    }
  }
  for (const v of saas.vendors || []) {
    for (const pl of v.plans || []) {
      const a = assess(pl.verified_at, 'saas', now);
      if (a.state === 'stale') needsHuman.push(`${v.name} ${pl.name}: price is ${a.age_days} days old and has stopped publishing. Re-verify at ${v.pricing_url}`);
    }
  }
  for (const [name, pr] of Object.entries(projects)) {
    if (!pr.recommended) needsHuman.push(`${name} is ${pr.health}. Comparisons against it are pulled. Pick a different alternative or retire the page.`);
  }
  for (const [name, pv] of Object.entries(vps.providers || {})) {
    if (pv.stale && !/TOKEN not set/.test(pv.last_error || '')) {
      needsHuman.push(`${name} pricing has not refreshed: ${pv.last_error}`);
    }
  }

  // ---- header --------------------------------------------------------------
  const d = day(now);
  out.push(`EXIT COST — weekly report`);
  out.push(`${now.toISOString().slice(0, 10)}  ·  day ${d}`);
  out.push('');
  out.push(needsHuman.length
    ? `${needsHuman.length} thing${needsHuman.length === 1 ? '' : 's'} need you. Everything else is running.`
    : `Nothing needs you this week.`);
  out.push('');

  if (needsHuman.length) {
    out.push('NEEDS YOU');
    needsHuman.forEach((h) => out.push(bullet(h)));
    out.push('');
  }

  // ---- what is live --------------------------------------------------------
  const verdicts = {};
  for (const e of index?.escapes || []) verdicts[e.verdict] = (verdicts[e.verdict] || 0) + 1;
  out.push('WHAT IS LIVE');
  out.push(bullet(`${index?.counts?.published ?? 0} comparisons published, ${index?.counts?.blocked ?? 0} blocked`));
  out.push(bullet(`${verdicts.switch || 0} say switch, ${verdicts.marginal || 0} marginal, ${verdicts.stay || 0} say stay`));
  out.push(bullet(`${saas.vendors.length} vendors, ${saas.vendors.reduce((n, v) => n + v.plans.length, 0)} verified prices`));
  const liveProviders = Object.entries(vps.providers || {}).filter(([, pv]) => pv.ok);
  out.push(bullet(`hosting: ${liveProviders.map(([n]) => n).join(', ') || 'none'} (${Object.values(vps.providers).reduce((n, pv) => n + (pv.plans?.length || 0), 0)} plans)`));
  const skipped = Object.entries(vps.providers || {}).filter(([, pv]) => /TOKEN not set/.test(pv.last_error || ''));
  if (skipped.length) out.push(bullet(`not connected: ${skipped.map(([n]) => n).join(', ')} — each needs a free read-only API token`));
  out.push('');

  // ---- price checks --------------------------------------------------------
  const agree = { match: 0, drift: 0, unverifiable: 0 };
  const aging = [];
  for (const v of saas.vendors || []) for (const pl of v.plans || []) {
    const a2 = pl.check?.agreement;
    if (a2) agree[a2] = (agree[a2] || 0) + 1;
    const a = assess(pl.verified_at, 'saas', now);
    if (a.state === 'aging') aging.push(`${v.name} ${pl.name} (${a.age_days}d)`);
  }
  out.push('PRICE CHECKS');
  out.push(bullet(`${agree.match} confirmed automatically, ${agree.drift} drifted, ${agree.unverifiable} could not be read`));
  if (aging.length) out.push(bullet(`ageing, will stop publishing if not confirmed: ${aging.join(', ')}`));
  if (agree.unverifiable) out.push(bullet(`the unreadable ones keep their hand-verified value and expire on their own — no action needed unless they reach the list above`));
  out.push('');

  // ---- money ---------------------------------------------------------------
  out.push('MONEY');
  const live = connectedPrograms();
  const pending = (readJson(p('data', 'affiliates.json'), { programs: [] }).programs || [])
    .filter((a) => a.status !== 'active');
  if (!live.length) {
    out.push(bullet('no affiliate program is live — this is the whole revenue path and nothing earns until one is'));
  } else {
    for (const a of live) {
      const pages = (index?.escapes || []).filter((e) => e.alternative || true).length;
      out.push(bullet(`${a.provider}: live — ${a.pays}`));
      if (a.reader_benefit) out.push(`      reader gets ${a.reader_benefit}`);
    }
    out.push(bullet('earnings are not visible from here — check the provider dashboard; there is no API to read them'));
  }
  for (const a of pending) out.push(bullet(`${a.provider}: not applied for yet — ${a.pays || 'terms unknown'}`));
  if (metrics.visitors_per_day === undefined) out.push(bullet('no analytics connected — traffic is unmeasured, so gates 2 and 3 cannot be evaluated'));
  else out.push(bullet(`${metrics.visitors_per_day}/day visitors, ${metrics.video_views_month ?? 0} video views this month`));
  out.push('');

  // ---- gates ---------------------------------------------------------------
  const unattended = unattendedDays();
  const state = {
    published: index?.counts?.published ?? 0,
    unattended_days: unattended,
    visitors_per_day: metrics.visitors_per_day ?? 0,
    video_views_month: metrics.video_views_month ?? 0,
    conversions: (metrics.affiliate_programs || []).reduce((n, a) => n + (a.conversions || 0), 0),
    revenue_per_day: metrics.revenue_per_day ?? 0,
  };
  out.push('AUTONOMY');
  out.push(bullet(unattended
    ? `${unattended} consecutive day${unattended === 1 ? '' : 's'} of unattended nightly refreshes`
    : 'the nightly refresh has not committed today or yesterday — check the workflow'));
  out.push('');

  out.push('GATES');
  for (const g of GATES) {
    const due = g.day - d;
    const ok = g.test(state);
    const when = due > 0 ? `in ${due}d` : `${-due}d overdue`;
    out.push(bullet(`gate ${g.n} (day ${g.day}, ${when}): ${ok ? 'on track' : 'not met'} — ${g.label}`));
    if (!ok && due <= 0) out.push(`      if still missed: ${g.miss}`);
  }
  out.push('');
  out.push(`site   https://nimbussage.github.io/exit-cost/`);
  out.push(`code   https://github.com/NimbusSage/exit-cost`);

  const text = out.join('\n');
  console.log(text);
  return { text, needsHuman };
}

if (require.main === module) main();
module.exports = { main, GATES };
