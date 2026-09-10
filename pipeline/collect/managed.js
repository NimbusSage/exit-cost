/**
 * managed.js — managed self-hosting prices.
 *
 * Exit Cost used to present a binary: keep paying the subscription, or run a
 * server yourself. There is a real third option — someone else runs the same
 * open-source software for you — and for a reader whose hour is expensive it is
 * often the honest answer. Without it, every such reader is told "stay on the
 * SaaS", which is the wrong advice and the least useful thing the site could say.
 *
 * The prices collected here are the provider's own published per-app minimum,
 * quoted as a minimum on the page. They are not equivalent to the sized box the
 * DIY column prices, and the page says so.
 */

const { fetchText, robotsAllows } = require('../lib/http.js');
const { htmlToText } = require('./extract.js');

const PROVIDERS = {
  pikapods: {
    name: 'PikaPods',
    catalogue: 'https://www.pikapods.com/apps',
    url: 'https://www.pikapods.com/',
    note: 'Runs the same open-source software, applies updates, and takes daily encrypted backups to storage you own.',
    /**
     * The catalogue reads as a flat run of
     *   <AppName> <description> Project Page Run Your Own From $<price>/month
     * so an app's price is the one that FOLLOWS its name, not the one before it.
     * Reading it backwards silently shifts every price by one app.
     */
    parse(text) {
      const MARKER = /Project Page Run Your Own From \$([0-9]+(?:\.[0-9]+)?)\/month/g;
      const apps = [];
      let cursor = 0;
      for (const m of text.matchAll(MARKER)) {
        const chunk = text.slice(cursor, m.index).trim();
        cursor = m.index + m[0].length;
        if (!chunk) continue;
        // The app's name opens the chunk, but its description follows immediately
        // and also starts with a capital, so there is no reliable boundary in the
        // flattened text. Keep the leading words and match by prefix at lookup
        // time — that handles both "Baserow" and "Uptime Kuma" without guessing.
        const label = chunk.split(/\s+/).slice(0, 4).join(' ');
        if (!label || !/^[A-Za-z0-9]/.test(label)) continue;
        apps.push({
          label,
          from_usd_month: parseFloat(m[1]),
          quote: `${label} … Run Your Own From $${m[1]}/month`,
        });
      }
      // The first chunk is the page header, not an app.
      return apps.filter((a) => !/^PikaPods\b/.test(a.label));
    },
  },
};

async function collectProvider(key) {
  const p = PROVIDERS[key];
  if (!p) throw new Error(`unknown managed provider: ${key}`);

  const allowed = await robotsAllows(p.catalogue);
  if (!allowed.allowed) return { ok: false, blocked: true, reason: `robots.txt disallows: ${allowed.reason}` };

  const text = htmlToText(await fetchText(p.catalogue, { timeoutMs: 25000 }));
  const apps = p.parse(text);
  if (apps.length < 20) throw new Error(`${p.name}: only ${apps.length} apps parsed — the catalogue layout has probably changed`);

  return { ok: true, name: p.name, url: p.url, source_url: p.catalogue, note: p.note, count: apps.length, apps };
}

async function collectAll() {
  const fetched_at = new Date().toISOString();
  const providers = {};
  for (const key of Object.keys(PROVIDERS)) {
    try {
      providers[key] = { ...(await collectProvider(key)), fetched_at, verified_at: fetched_at };
    } catch (e) {
      providers[key] = { ok: false, error: e.message, fetched_at };
    }
  }
  return { fetched_at, providers };
}

/**
 * Look an app up by name. Matches on a word boundary at the start of the
 * catalogue label, so "Baserow" finds "Baserow Create your own…". Returns null
 * rather than guessing — an app the provider does not offer must show as
 * absent, not as a price for something else.
 */
function lookup(managed, providerKey, appName) {
  const p = managed?.providers?.[providerKey];
  if (!p?.ok || !appName || !Array.isArray(p.apps)) return null;
  const want = String(appName).toLowerCase();
  const hit = p.apps.find((a) => {
    const label = a.label.toLowerCase();
    return label === want || label.startsWith(want + ' ');
  });
  if (!hit) return null;
  return { provider: p.name, url: p.url, note: p.note, source_url: p.source_url, verified_at: p.verified_at, ...hit };
}

module.exports = { collectAll, collectProvider, lookup, PROVIDERS };
