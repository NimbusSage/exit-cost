/**
 * vps.js — live VPS pricing.
 *
 * Vultr and Linode publish plan catalogues with no authentication, so those two
 * refresh nightly with zero setup. Hetzner and DigitalOcean require an API token;
 * their collectors run only when the token is present and are otherwise skipped
 * cleanly. A skipped provider is never faked — it simply does not appear.
 *
 * Output shape (data/sources/vps.json):
 *   { fetched_at, providers: { <name>: { ok, source_url, fetched_at, plans: [...] } } }
 *
 * Normalised plan:
 *   { id, provider, name, vcpu, ram_gb, disk_gb, bandwidth_tb, monthly_usd, currency, url }
 */

const { fetchJson } = require('../lib/http.js');

const round2 = (n) => Math.round(n * 100) / 100;

/** Vultr — public, unauthenticated. */
async function collectVultr() {
  const source_url = 'https://api.vultr.com/v2/plans';
  const data = await fetchJson(source_url);
  if (!data || !Array.isArray(data.plans)) throw new Error('Vultr: unexpected response shape');

  const plans = data.plans
    // Exclude the free tier (not viable for a production self-host), IPv6-only
    // plans (breaks too much), and anything with a GPU.
    .filter((p) => p.monthly_cost > 0 && !/-free$|-v6$/.test(p.id) && p.gpu_brand === 'none')
    .map((p) => ({
      id: `vultr:${p.id}`,
      provider: 'Vultr',
      name: p.id,
      vcpu: p.vcpu_count,
      ram_gb: round2(p.ram / 1024),
      disk_gb: p.disk,
      bandwidth_tb: round2(p.bandwidth / 1024),
      monthly_usd: round2(p.monthly_cost),
      currency: 'USD',
      url: 'https://www.vultr.com/pricing/',
    }))
    .filter((p) => p.vcpu > 0 && p.ram_gb > 0);

  if (!plans.length) throw new Error('Vultr: zero usable plans after filtering');
  return { ok: true, source_url, plans };
}

/** Linode / Akamai — public, unauthenticated. */
async function collectLinode() {
  const source_url = 'https://api.linode.com/v4/linode/types';
  const data = await fetchJson(source_url);
  if (!data || !Array.isArray(data.data)) throw new Error('Linode: unexpected response shape');

  const plans = data.data
    // Shared/dedicated general-purpose only. GPU classes carry null prices.
    .filter((t) => ['nanode', 'standard', 'dedicated', 'highmem'].includes(t.class))
    .filter((t) => t.price && typeof t.price.monthly === 'number' && t.price.monthly > 0)
    .map((t) => ({
      id: `linode:${t.id}`,
      provider: 'Linode',
      name: t.label,
      vcpu: t.vcpus,
      ram_gb: round2(t.memory / 1024),
      disk_gb: Math.round(t.disk / 1024),
      bandwidth_tb: round2(t.transfer / 1024),
      monthly_usd: round2(t.price.monthly),
      currency: 'USD',
      url: 'https://www.linode.com/pricing/',
    }));

  if (!plans.length) throw new Error('Linode: zero usable plans after filtering');
  return { ok: true, source_url, plans };
}

/**
 * Hetzner Cloud — needs a read-only API token in HETZNER_API_TOKEN.
 * Hetzner quotes in EUR; we convert with a dated rate rather than a live FX call,
 * and the rate itself is a verified input like any other number.
 */
async function collectHetzner({ eurUsd }) {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return { ok: false, skipped: true, reason: 'HETZNER_API_TOKEN not set' };
  if (!eurUsd || !eurUsd.rate) return { ok: false, skipped: true, reason: 'no EUR/USD rate available' };

  const source_url = 'https://api.hetzner.cloud/v1/server_types';
  const data = await fetchJson(source_url, { headers: { Authorization: `Bearer ${token}` } });
  if (!data || !Array.isArray(data.server_types)) throw new Error('Hetzner: unexpected response shape');

  const plans = [];
  for (const t of data.server_types) {
    if (t.deprecated) continue;
    // Hetzner prices per location; take the cheapest location that is actually
    // orderable, and say which one it was.
    let best = null;
    for (const pr of t.prices || []) {
      const gross = parseFloat(pr.price_monthly?.gross);
      if (!isFinite(gross) || gross <= 0) continue;
      if (!best || gross < best.gross) best = { gross, location: pr.location };
    }
    if (!best) continue;
    plans.push({
      id: `hetzner:${t.name}`,
      provider: 'Hetzner',
      name: t.name.toUpperCase(),
      vcpu: t.cores,
      ram_gb: round2(t.memory),
      disk_gb: t.disk,
      bandwidth_tb: round2((t.included_traffic || 0) / 1e12),
      monthly_eur: round2(best.gross),
      monthly_usd: round2(best.gross * eurUsd.rate),
      currency: 'USD',
      quoted_currency: 'EUR',
      fx_rate: eurUsd.rate,
      fx_verified_at: eurUsd.verified_at,
      location: best.location,
      url: 'https://www.hetzner.com/cloud/',
    });
  }
  if (!plans.length) throw new Error('Hetzner: zero usable plans after filtering');
  return { ok: true, source_url, plans };
}

/** DigitalOcean — needs a read-only token in DO_API_TOKEN. */
async function collectDigitalOcean() {
  const token = process.env.DO_API_TOKEN;
  if (!token) return { ok: false, skipped: true, reason: 'DO_API_TOKEN not set' };

  const source_url = 'https://api.digitalocean.com/v2/sizes?per_page=200';
  const data = await fetchJson(source_url, { headers: { Authorization: `Bearer ${token}` } });
  if (!data || !Array.isArray(data.sizes)) throw new Error('DigitalOcean: unexpected response shape');

  const plans = data.sizes
    .filter((s) => s.available && s.price_monthly > 0)
    .map((s) => ({
      id: `do:${s.slug}`,
      provider: 'DigitalOcean',
      name: s.description || s.slug,
      vcpu: s.vcpus,
      ram_gb: round2(s.memory / 1024),
      disk_gb: s.disk,
      bandwidth_tb: round2(s.transfer),
      monthly_usd: round2(s.price_monthly),
      currency: 'USD',
      url: 'https://www.digitalocean.com/pricing/droplets',
    }));

  if (!plans.length) throw new Error('DigitalOcean: zero usable plans after filtering');
  return { ok: true, source_url, plans };
}

/** European Central Bank publishes a free daily reference rate, no key needed. */
async function collectEurUsd() {
  const source_url = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD';
  try {
    const d = await fetchJson(source_url, { timeoutMs: 12000, retries: 1 });
    const rate = d?.rates?.USD;
    if (typeof rate !== 'number' || rate <= 0) throw new Error('no USD rate in response');
    return { rate: round2(rate * 10000) / 10000, verified_at: d.date, source_url };
  } catch (e) {
    return { rate: null, error: e.message, source_url };
  }
}

const COLLECTORS = {
  vultr: collectVultr,
  linode: collectLinode,
  hetzner: collectHetzner,
  digitalocean: collectDigitalOcean,
};

/**
 * Run every collector. One provider failing never fails the run — the caller
 * merges successes over the last known good file and marks the rest stale.
 */
async function collectAll() {
  const fetched_at = new Date().toISOString();
  const eurUsd = await collectEurUsd();
  const providers = {};

  for (const [name, fn] of Object.entries(COLLECTORS)) {
    try {
      const r = await fn({ eurUsd });
      providers[name] = { ...r, fetched_at };
    } catch (e) {
      providers[name] = { ok: false, skipped: false, error: e.message, fetched_at };
    }
  }
  return { fetched_at, fx: eurUsd, providers };
}

module.exports = { collectAll, collectVultr, collectLinode, collectHetzner, collectDigitalOcean, collectEurUsd, COLLECTORS };
