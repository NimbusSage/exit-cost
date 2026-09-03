/**
 * resolve.js — join an escape record to live pricing and produce a publishable page model.
 *
 * An escape record says what to compare and how big the box needs to be. It does
 * NOT hardcode a price. This module resolves those requirements against the live
 * VPS catalogue, the verified SaaS table and the storage rates, then hands the
 * result to tco.compare().
 *
 * Every number it emits carries provenance, and any missing or stale input makes
 * the whole escape unpublishable rather than approximately right.
 */

const { compare, curve, sensitivity } = require('./tco.js');
const { cheapestMeeting } = require('../collect/merge.js');
const { assess, rollup } = require('../lib/freshness.js');

/** Default value of the operator's own hour. Stated on every page, and adjustable. */
const DEFAULT_HOURLY_RATE = 50;
const DEFAULT_HORIZON_MONTHS = 36;

function findVendorPlan(saas, vendorId, planId) {
  const vendor = (saas.vendors || []).find((v) => v.id === vendorId);
  if (!vendor) return { error: `no vendor "${vendorId}" in saas.json` };
  const plan = (vendor.plans || []).find((p) => p.id === planId);
  if (!plan) return { error: `vendor "${vendorId}" has no plan "${planId}"` };
  return { vendor, plan };
}

/**
 * Build the full page model for one escape.
 *
 * @param {object} escape    a record from data/escapes/*.json
 * @param {object} ctx       { vpsPlans, saas, storage, projects, now }
 */
function resolveEscape(escape, ctx) {
  const { vpsPlans = [], saas = {}, storage = {}, projects = {}, now = new Date() } = ctx;
  const errors = [];
  const dated = [];

  // ---- incumbent -----------------------------------------------------------
  const { vendor, plan, error } = findVendorPlan(saas, escape.incumbent.vendor, escape.incumbent.plan);
  if (error) errors.push(error);

  // ---- the box -------------------------------------------------------------
  const req = escape.alternative.requirements || {};
  const box = cheapestMeeting(vpsPlans, {
    ram_gb: req.ram_gb || 0,
    vcpu: req.vcpu || 0,
    disk_gb: req.disk_gb || 0,
    providers: escape.alternative.providers || null,
  });
  if (!box) errors.push(`no VPS plan meets ${JSON.stringify(req)} — refusing to substitute a smaller box`);

  // ---- backup --------------------------------------------------------------
  const storeId = escape.alternative.storage || storage.default;
  const store = (storage.options || []).find((o) => o.id === storeId);
  const backupGb = escape.alternative.backup_gb ?? 0;
  if (backupGb > 0 && !store) errors.push(`no storage option "${storeId}"`);

  // ---- project health ------------------------------------------------------
  const project = escape.alternative.repo ? projects[escape.alternative.repo] : null;
  if (escape.alternative.repo && !project) errors.push(`no project data for ${escape.alternative.repo}`);

  if (errors.length) {
    return { slug: escape.slug, publishable: false, errors, freshness: { state: 'undated', publishable: false, problems: [] } };
  }

  // ---- provenance ----------------------------------------------------------
  dated.push({ ...assess(plan.verified_at, 'saas', now), label: `${vendor.name} ${plan.name} price` });
  dated.push({ ...assess(box.verified_at, 'vps', now), label: `${box.provider} ${box.name} price` });
  if (backupGb > 0) dated.push({ ...assess(store.verified_at, 'storage', now), label: `${store.name} storage rate` });
  if (project) dated.push({ ...assess(project.verified_at, 'project', now), label: `${project.full_name} activity` });
  const freshness = rollup(dated);

  // ---- the arithmetic ------------------------------------------------------
  const seats = escape.incumbent.seats ?? 1;
  const hourly_rate = escape.hourly_rate ?? DEFAULT_HOURLY_RATE;
  const horizon_months = escape.horizon_months ?? DEFAULT_HORIZON_MONTHS;

  const storageMonthly = backupGb > 0 ? backupGb * store.usd_per_gb_month : 0;
  const extraCosts = (escape.alternative.extra_costs || []).map((c) => ({ ...c }));

  const input = {
    seats,
    horizon_months,
    hourly_rate,
    incumbent: {
      costs: [{ amount: plan.amount, period: plan.period, per_seat: plan.per_seat, label: `${vendor.name} ${plan.name}` }],
      maintenance_hours_per_month: escape.incumbent.maintenance_hours_per_month ?? 0,
    },
    alternative: {
      costs: [
        { amount: box.monthly_usd, period: 'month', label: `${box.provider} ${box.name}` },
        ...(storageMonthly > 0 ? [{ amount: storageMonthly, period: 'month', label: `${store.name} backup, ${backupGb} GB` }] : []),
        ...extraCosts,
      ],
      one_time_costs: escape.alternative.one_time_costs || [],
      migration_hours: escape.alternative.migration_hours ?? 0,
      maintenance_hours_per_month: escape.alternative.maintenance_hours_per_month ?? 0,
    },
  };

  const result = compare(input);
  if (!result.computable) {
    return { slug: escape.slug, publishable: false, errors: [`uncomputable: ${result.reason}`, ...(result.unknown_items || [])], freshness };
  }

  // A dead upstream project is a hard stop regardless of how good the price looks.
  const projectBlocked = project && !project.recommended;

  return {
    slug: escape.slug,
    title: escape.title,
    summary: escape.summary,
    publishable: freshness.publishable && !projectBlocked,
    block_reason: projectBlocked ? `${project.full_name} is ${project.health}; we do not send readers to unmaintained software` : null,
    freshness,
    incumbent: {
      vendor: vendor.name, vendor_id: vendor.id, plan: plan.name, plan_id: plan.id,
      amount: plan.amount, period: plan.period, per_seat: plan.per_seat, billed: plan.billed,
      seats, quote: plan.quote, caveat: plan.caveat || null,
      source_url: vendor.pricing_url, verified_at: plan.verified_at,
      needs_reverification: !!plan.needs_reverification,
    },
    alternative: {
      name: escape.alternative.name,
      repo: escape.alternative.repo || null,
      project: project || null,
      box: {
        provider: box.provider, name: box.name, id: box.id,
        vcpu: box.vcpu, ram_gb: box.ram_gb, disk_gb: box.disk_gb, bandwidth_tb: box.bandwidth_tb,
        monthly_usd: box.monthly_usd, url: box.url, verified_at: box.verified_at,
      },
      storage: backupGb > 0 ? { ...store, gb: backupGb, monthly_usd: Math.round(storageMonthly * 100) / 100 } : null,
      requirements: req,
      migration_hours: input.alternative.migration_hours,
      maintenance_hours_per_month: input.alternative.maintenance_hours_per_month,
    },
    result,
    curve: curve(result, horizon_months),
    sensitivity: sensitivity(input),
    tradeoffs: escape.tradeoffs || { you_lose: [], you_gain: [] },
    caveats: escape.caveats || [],
    category: escape.category || vendor.category || null,
    updated_at: (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10),
  };
}

/** Resolve many, splitting publishable from blocked so the report can say why. */
function resolveAll(escapes, ctx) {
  const pages = [], blocked = [];
  for (const e of escapes) {
    const r = resolveEscape(e, ctx);
    (r.publishable ? pages : blocked).push(r);
  }
  return { pages, blocked };
}

module.exports = { resolveEscape, resolveAll, findVendorPlan, DEFAULT_HOURLY_RATE, DEFAULT_HORIZON_MONTHS };
