/**
 * merge.js — how a failed collector is allowed to affect the dataset.
 *
 * The rule, from which everything else follows: a collector that fails must never
 * change a number. It keeps the last known good value, marks it stale, and raises
 * it in the report for a human decision. It never guesses, never interpolates,
 * never falls back to a hardcoded price.
 *
 * Pure function so the behaviour can be tested without touching the network.
 */

/**
 * @param {object|null} previous  the last written file, or null on first run
 * @param {object} fresh          the result of collectAll()
 * @returns {{merged: object, report: object}}
 */
function mergeProviders(previous, fresh) {
  const prev = previous?.providers || {};
  const providers = {};
  const report = { updated: [], kept_stale: [], skipped: [], lost: [], first_seen: [] };

  for (const [name, result] of Object.entries(fresh.providers || {})) {
    const old = prev[name];

    if (result.ok && Array.isArray(result.plans) && result.plans.length) {
      providers[name] = {
        ok: true,
        stale: false,
        source_url: result.source_url,
        fetched_at: result.fetched_at,
        verified_at: result.fetched_at,
        plans: result.plans,
      };
      if (!old || !old.plans?.length) report.first_seen.push(name);
      else report.updated.push({ name, plans: result.plans.length, was: old.plans.length });
      continue;
    }

    // Collector did not produce data. Preserve, do not invent.
    const reason = result.error || result.reason || 'unknown failure';
    if (old && Array.isArray(old.plans) && old.plans.length) {
      providers[name] = {
        ...old,
        ok: false,
        stale: true,
        last_error: reason,
        last_attempt_at: result.fetched_at,
        // verified_at deliberately NOT advanced — the data is as old as it was.
      };
      report.kept_stale.push({ name, reason, verified_at: old.verified_at, plans: old.plans.length });
    } else {
      providers[name] = { ok: false, stale: true, plans: [], last_error: reason, last_attempt_at: result.fetched_at };
      (result.skipped ? report.skipped : report.lost).push({ name, reason });
    }
  }

  // A provider that vanished from the collector list keeps its data untouched.
  for (const [name, old] of Object.entries(prev)) {
    if (!providers[name]) providers[name] = { ...old, stale: true, last_error: 'collector no longer defined' };
  }

  const merged = {
    fetched_at: fresh.fetched_at,
    fx: fresh.fx?.rate ? fresh.fx : (previous?.fx ?? fresh.fx),
    providers,
  };

  const total = Object.values(providers).reduce((n, p) => n + (p.plans?.length || 0), 0);
  report.total_plans = total;
  report.healthy = Object.values(providers).filter((p) => p.ok).length;
  report.ok = total > 0;
  return { merged, report };
}

/** Flatten a merged file into a single plan list, dropping stale providers unless asked. */
function flattenPlans(merged, { includeStale = false } = {}) {
  const out = [];
  for (const [name, p] of Object.entries(merged.providers || {})) {
    if (!includeStale && p.stale) continue;
    for (const plan of p.plans || []) {
      out.push({ ...plan, _provider_key: name, verified_at: p.verified_at, stale: !!p.stale });
    }
  }
  return out;
}

/**
 * Cheapest plan that actually meets a requirement.
 * Returns null when nothing qualifies — callers must handle that as "no number",
 * not as "pick the biggest one anyway".
 */
function cheapestMeeting(plans, { ram_gb = 0, vcpu = 0, disk_gb = 0, providers = null } = {}) {
  const eligible = plans.filter((p) =>
    p.ram_gb >= ram_gb &&
    p.vcpu >= vcpu &&
    p.disk_gb >= disk_gb &&
    (!providers || providers.includes(p.provider)));
  if (!eligible.length) return null;
  return eligible.sort((a, b) =>
    a.monthly_usd - b.monthly_usd ||
    b.ram_gb - a.ram_gb ||
    a.id.localeCompare(b.id))[0];
}

module.exports = { mergeProviders, flattenPlans, cheapestMeeting };
