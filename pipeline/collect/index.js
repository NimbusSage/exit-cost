#!/usr/bin/env node
/**
 * collect/index.js — the nightly data refresh.
 *
 * Runs every collector, merges results under the fail-safe rules, and writes a
 * machine-readable run record. It exits non-zero only when the dataset ends up
 * with nothing usable in it; a single failed provider is a normal, survivable day
 * and is reported rather than escalated.
 */

const path = require('node:path');
const { readJson, writeJson, listJson, p } = require('../lib/store.js');
const { collectAll } = require('./vps.js');
const { mergeProviders } = require('./merge.js');
const { collectRepos } = require('./github.js');
const { checkAll, summarise } = require('./saas.js');
const { today } = require('../lib/freshness.js');

const VPS_FILE      = p('data', 'sources', 'vps.json');
const PROJECTS_FILE = p('data', 'sources', 'projects.json');
const SAAS_FILE     = p('data', 'saas.json');
const RUN_FILE      = p('data', 'sources', 'last-run.json');

const arg = (name) => process.argv.includes(`--${name}`);

async function main() {
  const started = new Date();
  const day = today(started);
  const dry = arg('dry-run');
  const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
  const run = { started_at: started.toISOString(), day, dry_run: dry, steps: {} };

  const log = (...a) => console.log(...a);
  log(`exit-cost collect  ${started.toISOString()}${dry ? '  [DRY RUN]' : ''}`);

  // ---- 1. VPS pricing ------------------------------------------------------
  if (!only || only === 'vps') {
    log('\n[vps] fetching provider catalogues');
    const fresh = await collectAll();
    const { merged, report } = mergeProviders(readJson(VPS_FILE), fresh);
    if (!dry) writeJson(VPS_FILE, merged);
    run.steps.vps = report;
    for (const u of report.updated)     log(`  ok      ${u.name}: ${u.plans} plans`);
    for (const f of report.first_seen)  log(`  new     ${f}`);
    for (const k of report.kept_stale)  log(`  STALE   ${k.name}: ${k.reason} (keeping ${k.plans} plans from ${k.verified_at})`);
    for (const s of report.skipped)     log(`  skip    ${s.name}: ${s.reason}`);
    for (const l of report.lost)        log(`  LOST    ${l.name}: ${l.reason}`);
    log(`  -> ${report.total_plans} plans across ${report.healthy} healthy providers`);
    if (fresh.fx?.rate) log(`  fx      EUR/USD ${fresh.fx.rate} (${fresh.fx.verified_at})`);
  }

  // ---- 2. Project health ---------------------------------------------------
  if (!only || only === 'projects') {
    const repos = [...new Set(listJson(p('data', 'escapes'))
      .map((f) => readJson(f))
      .map((e) => e?.alternative?.repo)
      .filter(Boolean))];
    log(`\n[projects] checking ${repos.length} repositories`);
    const res = await collectRepos(repos);
    if (!dry) writeJson(PROJECTS_FILE, res);
    run.steps.projects = { checked: repos.length, ok: Object.keys(res.projects).length, errors: res.errors, authenticated: res.authenticated };
    for (const [name, pr] of Object.entries(res.projects)) {
      const flag = pr.recommended ? 'ok    ' : 'BLOCK ';
      log(`  ${flag}  ${name.padEnd(30)} ${String(pr.stars).padStart(7)}*  ${pr.health}`);
    }
    for (const e of res.errors) log(`  ERROR   ${e.repo}: ${e.error}`);
  }

  // ---- 3. SaaS price cross-check ------------------------------------------
  if (!only || only === 'saas') {
    const saas = readJson(SAAS_FILE);
    log(`\n[saas] cross-checking ${saas.vendors.length} vendor pricing pages`);
    const results = await checkAll(saas.vendors, { today: day });
    const summary = summarise(results);

    const byId = new Map(results.map((r) => [r.id, r]));
    const updated = {
      ...saas,
      vendors: saas.vendors.map((v) => {
        const r = byId.get(v.id);
        if (!r) return v;
        return { ...v, plans: r.plans || v.plans, fingerprint: r.fingerprint ?? v.fingerprint, last_checked_at: day, last_check_ok: !!r.ok, last_check_reason: r.ok ? null : r.reason };
      }),
    };
    if (!dry) writeJson(SAAS_FILE, updated);
    run.steps.saas = summary;

    for (const r of results) {
      if (!r.ok) { log(`  FAIL    ${r.id}: ${r.reason}`); continue; }
      const marks = (r.plans || []).map((pl) => `${pl.name}:${pl.check?.agreement?.[0] ?? '?'}`).join(' ');
      log(`  ${r.fingerprint_changed ? 'CHANGED' : 'ok     '} ${r.id.padEnd(12)} ${marks}`);
    }
    log(`  -> ${summary.match} confirmed, ${summary.drift} drifted, ${summary.unverifiable} unverifiable`);
    for (const d of summary.drifted) log(`  DRIFT   ${d.vendor}/${d.plan}: ${d.reason}`);
  }

  // ---- done ----------------------------------------------------------------
  run.finished_at = new Date().toISOString();
  run.duration_s = Math.round((Date.now() - started.getTime()) / 100) / 10;

  const vpsOk = run.steps.vps ? run.steps.vps.ok : true;
  run.ok = vpsOk;
  if (!dry) writeJson(RUN_FILE, run);

  log(`\ndone in ${run.duration_s}s  ok=${run.ok}`);
  if (!run.ok) {
    console.error('FATAL: the dataset has no usable VPS pricing. Nothing will publish.');
    process.exit(1);
  }
}

main().catch((e) => { console.error('collect failed:', e); process.exit(1); });
