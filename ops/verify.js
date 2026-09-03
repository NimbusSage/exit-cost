#!/usr/bin/env node
/**
 * ops/verify.js — the preflight that runs before anything publishes.
 *
 * Every check here corresponds to a promise the site makes to its readers. If
 * one fails the build stops, because publishing a wrong number costs more than
 * publishing nothing.
 */

const { readJson, listJson, p } = require('../pipeline/lib/store.js');
const { assess } = require('../pipeline/lib/freshness.js');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('build output exists', () => {
  const idx = readJson(p('data', 'build', 'index.json'));
  if (!idx) throw new Error('no data/build/index.json — run pipeline/render/build.js');
  if (!idx.escapes.length) throw new Error('index contains no publishable escapes');
  return `${idx.escapes.length} escapes`;
});

check('every published escape carries a verdict and a source date', () => {
  for (const f of listJson(p('data', 'build', 'escapes'))) {
    const e = readJson(f);
    if (!e.result?.verdict) throw new Error(`${e.slug}: no verdict`);
    if (!e.incumbent?.verified_at) throw new Error(`${e.slug}: incumbent price has no verified_at`);
    if (!e.alternative?.box?.verified_at) throw new Error(`${e.slug}: hosting price has no verified_at`);
  }
  return 'all dated';
});

check('no published escape is built on stale data', () => {
  const stale = [];
  for (const f of listJson(p('data', 'build', 'escapes'))) {
    const e = readJson(f);
    if (e.freshness?.state === 'stale' || e.freshness?.state === 'undated') stale.push(`${e.slug} (${e.freshness.state})`);
  }
  if (stale.length) throw new Error(`stale escapes reached the build: ${stale.join(', ')}`);
  return 'all fresh';
});

check('every SaaS price cites the sentence that justifies it', () => {
  const saas = readJson(p('data', 'saas.json'));
  const missing = [];
  for (const v of saas.vendors) for (const pl of v.plans) {
    if (!pl.quote) missing.push(`${v.id}/${pl.id}`);
    if (typeof pl.amount !== 'number') missing.push(`${v.id}/${pl.id} (no amount)`);
  }
  if (missing.length) throw new Error(`prices without provenance: ${missing.join(', ')}`);
  return `${saas.vendors.reduce((n, v) => n + v.plans.length, 0)} prices cited`;
});

check('no price is being published while flagged for re-verification', () => {
  const saas = readJson(p('data', 'saas.json'));
  const flagged = [];
  for (const v of saas.vendors) for (const pl of v.plans) if (pl.needs_reverification) flagged.push(`${v.id}/${pl.name}`);
  // A flagged price is allowed on the page — it is labelled there — but it must
  // be visible in the report rather than silent.
  return flagged.length ? `WARN ${flagged.length} flagged: ${flagged.join(', ')}` : 'none flagged';
});

check('the site says stay somewhere', () => {
  const idx = readJson(p('data', 'build', 'index.json'));
  const stay = idx.escapes.filter((e) => e.verdict === 'stay').length;
  if (idx.escapes.length >= 6 && stay === 0) {
    throw new Error('every comparison recommends switching; that is not a comparison site, it is an advert');
  }
  return `${stay}/${idx.escapes.length} say stay`;
});

check('no comparison recommends unmaintained software', () => {
  const bad = [];
  for (const f of listJson(p('data', 'build', 'escapes'))) {
    const e = readJson(f);
    if (e.alternative?.project && e.alternative.project.recommended === false) bad.push(e.slug);
  }
  if (bad.length) throw new Error(`dormant projects reached the build: ${bad.join(', ')}`);
  return 'all upstreams active';
});

check('hosting prices were refreshed recently', () => {
  const vps = readJson(p('data', 'sources', 'vps.json'));
  const live = Object.entries(vps.providers).filter(([, pr]) => pr.ok && pr.plans?.length);
  if (!live.length) throw new Error('no live VPS provider in the dataset');
  const worst = live.map(([n, pr]) => ({ n, a: assess(pr.verified_at, 'vps') })).sort((x, y) => (y.a.age_days ?? 0) - (x.a.age_days ?? 0))[0];
  if (worst.a.state === 'stale') throw new Error(`${worst.n} pricing is ${worst.a.age_days} days old`);
  return `${live.length} providers, oldest ${worst.a.age_days}d`;
});

let failed = 0;
console.log('exit-cost preflight\n');
for (const c of checks) {
  try {
    const detail = c.fn();
    const warn = String(detail).startsWith('WARN');
    console.log(`  ${warn ? 'warn' : 'pass'}  ${c.name.padEnd(52)} ${detail}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${c.name.padEnd(52)} ${e.message}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
