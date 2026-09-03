/**
 * github.js — project health for the open-source side of every comparison.
 *
 * Recommending a dead project is a trust failure as bad as publishing a wrong
 * price, so this collector exists to let a page say "last release 3 years ago,
 * we do not recommend this" in the same breath as the arithmetic.
 *
 * Auth: uses GITHUB_TOKEN if set, otherwise borrows the local `gh` CLI token
 * (5,000 req/hr). Falls back to unauthenticated (60 req/hr) and still works.
 */

const { execFileSync } = require('node:child_process');
const { fetchJson } = require('../lib/http.js');

let cachedToken;
function githubToken() {
  if (cachedToken !== undefined) return cachedToken;
  if (process.env.GITHUB_TOKEN) return (cachedToken = process.env.GITHUB_TOKEN);
  try {
    cachedToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

const DAY_MS = 86400000;

/**
 * GitHub returns "NOASSERTION" when it cannot match a LICENSE file to a known
 * SPDX identifier. That is not a licence name and must never reach a page.
 */
function normaliseLicense(spdx) {
  if (!spdx || spdx === 'NOASSERTION') return null;
  return spdx;
}
const daysSince = (iso, now) => (iso ? Math.round((now - new Date(iso).getTime()) / DAY_MS) : null);

/**
 * Health verdict from activity signals alone. Deliberately blunt: the page needs
 * a defensible one-word answer, and the underlying numbers are published beside it.
 */
function healthVerdict({ archived, days_since_push, days_since_release, has_release }) {
  if (archived) return 'archived';
  if (days_since_push === null) return 'unknown';
  if (days_since_push > 365) return 'dormant';
  if (has_release && days_since_release !== null && days_since_release > 730) return 'dormant';
  if (days_since_push > 180) return 'slowing';
  if (has_release && days_since_release !== null && days_since_release > 365) return 'slowing';
  return 'active';
}

/** A project we should not send readers to, regardless of how good the price looks. */
const NOT_RECOMMENDED = new Set(['archived', 'dormant']);

async function collectRepo(fullName, { now = Date.now() } = {}) {
  const token = githubToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const base = `https://api.github.com/repos/${fullName}`;

  const repo = await fetchJson(base, { headers });

  // A missing releases endpoint is normal (many projects tag only), so treat a
  // 404 here as "no releases" rather than as a collector failure.
  let release = null;
  try {
    release = await fetchJson(`${base}/releases/latest`, { headers, retries: 0 });
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const days_since_push = daysSince(repo.pushed_at, now);
  const days_since_release = daysSince(release?.published_at, now);
  const health = healthVerdict({
    archived: repo.archived,
    days_since_push,
    days_since_release,
    has_release: !!release,
  });

  return {
    full_name: repo.full_name,
    url: repo.html_url,
    homepage: repo.homepage || null,
    description: repo.description || null,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    open_issues: repo.open_issues_count,
    license: normaliseLicense(repo.license?.spdx_id),
    archived: !!repo.archived,
    pushed_at: repo.pushed_at,
    days_since_push,
    latest_release: release ? { tag: release.tag_name, published_at: release.published_at, url: release.html_url } : null,
    days_since_release,
    health,
    recommended: !NOT_RECOMMENDED.has(health),
    verified_at: new Date(now).toISOString(),
  };
}

/** Collect many repos, sequentially and politely. One failure never kills the batch. */
async function collectRepos(fullNames, opts = {}) {
  const projects = {};
  const errors = [];
  for (const name of fullNames) {
    try {
      projects[name] = await collectRepo(name, opts);
    } catch (e) {
      errors.push({ repo: name, error: e.message });
    }
  }
  return { fetched_at: new Date().toISOString(), projects, errors, authenticated: !!githubToken() };
}

module.exports = { collectRepo, collectRepos, healthVerdict, normaliseLicense, githubToken, NOT_RECOMMENDED };
