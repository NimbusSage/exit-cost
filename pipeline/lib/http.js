/**
 * http.js — the only place this project touches the network.
 *
 * Every fetch is polite (identifying UA, timeout, backoff) and every failure is
 * loud. Collectors never invent data on failure; they surface the error and the
 * caller keeps the last known good value and marks it stale.
 */

const UA = 'ExitCostBot/0.1 (+https://github.com/NimbusSage/exit-cost; contact via GitHub issues)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch JSON with a timeout and bounded retries on transient failures.
 * Throws on any non-2xx or unparseable body. Never returns a partial object.
 */
async function fetchJson(url, { headers = {}, timeoutMs = 20000, retries = 2, retryDelayMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
        signal: ac.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        err.status = res.status;
        // 4xx other than 429 will not fix itself on retry.
        if (res.status !== 429 && res.status < 500) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.fatal || attempt === retries) break;
      await sleep(retryDelayMs * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Fetch text (robots.txt, HTML) under the same politeness rules. */
async function fetchText(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), { status: res.status });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal robots.txt check for our own UA. Conservative by design: if robots.txt
 * cannot be read we assume we are NOT allowed, rather than assuming we are.
 */
async function robotsAllows(url, userAgent = 'ExitCostBot') {
  const u = new URL(url);
  let txt;
  try {
    txt = await fetchText(`${u.origin}/robots.txt`, { timeoutMs: 10000 });
  } catch {
    return { allowed: false, reason: 'robots.txt unreachable' };
  }
  const lines = txt.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  let groups = [], current = null;
  for (const line of lines) {
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, field, value] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (field === 'user-agent') {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if (current && (field === 'allow' || field === 'disallow')) {
      current.rules.push({ type: field, path: value });
    }
  }
  const ua = userAgent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const group = specific || wildcard;
  if (!group) return { allowed: true, reason: 'no applicable group' };

  // Longest-match wins, Allow beats Disallow on a tie (standard behaviour).
  let best = null;
  for (const r of group.rules) {
    if (r.path === '') continue;
    const pattern = r.path.replace(/\*/g, '');
    if (!u.pathname.startsWith(pattern.split('$')[0])) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow')) best = r;
  }
  if (!best) return { allowed: true, reason: 'no matching rule' };
  return { allowed: best.type === 'allow', reason: `${best.type}: ${best.path}` };
}

module.exports = { fetchJson, fetchText, robotsAllows, UA, sleep };
