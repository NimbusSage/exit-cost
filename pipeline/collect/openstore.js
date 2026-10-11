#!/usr/bin/env node
/**
 * collect/openstore.js — one collector, one job: keep a small copy of the
 * OpenStore directory (openstore.site) so comparison pages can link to a
 * project's entry there and the site can publish a feed OpenStore can pull.
 *
 * OpenStore publishes its catalog as plain JS module files in its repository.
 * They read as `export const name = [...]`, i.e. exactly what a bundler would
 * chew through, and there is no JSON endpoint, so this file evaluates the
 * sources inside a bare `vm` context rather than getting clever. Fetches are
 * fail-safe like every other collector in this repo: a network failure keeps
 * the last copy on disk, marks the step stale, and refuses to advance
 * `verified_at`.
 */

const vm = require('node:vm');

const REPO = 'dev-krish-xyz/OpenStore';
/**
 * Two routes to the same three files. raw.githubusercontent.com hiccuped once
 * in CI and a single-homed source turned "one transient failure" into "the
 * links silently vanish from every page". jsDelivr mirrors any GitHub repo's
 * files straight from its CDN, so it stands in when raw is unreachable.
 */
const MIRRORS = [
  (file) => `https://raw.githubusercontent.com/${REPO}/HEAD/${file}`,
  (file) => `https://cdn.jsdelivr.net/gh/${REPO}@main/${file}`,
];
const SOURCES = ['catalog.js', 'open-catalog.js', 'trending-catalog.js'];
const DAYS_FRESH = 45;
const DAYS_KEEP = 90;

/**
 * Run one catalog source and pull the const exports out of it. The files carry
 * `export` statements, which a plain script cannot, so they are stripped: the
 * `export const ...` declarations at the top become plain declarations, and any
 * trailing re-export line (`export { filterProjects } from './x.js'`) is
 * dropped entirely, since it is a bundler concern and our join needs none of it.
 * Everything runs in a fresh context with a timeout, so a catalog that grew a
 * hostile line does not get a network, filesystem, or the rest of the process.
 */
function evaluateCatalogSource(source) {
  const src = source
    .replace(/^export\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^export\s+/gm, '');
  const sandbox = { console: undefined, fetch: undefined, process: undefined };
  vm.createContext(sandbox);
  return vm.runInNewContext(`(() => {
    ${src}
    return {
      catalog: typeof catalog !== 'undefined' ? catalog : null,
      openCatalog: typeof openCatalog !== 'undefined' ? openCatalog : null,
      trendingCatalog: typeof trendingCatalog !== 'undefined' ? trendingCatalog : null,
    };
  })()`, sandbox, { timeout: 5000 });
}

/** Lowercase the two halves of `owner/name` so the join survives casing drift. */
const repoKey = (r) => String(r || '').trim().toLowerCase();

/**
 * Turn three raw module files into one flat repo → entry map. Entries without a
 * repo or an id are not joinable and are skipped rather than guessed at.
 */
function catalogueFromSources(sources) {
  const byRepo = new Map();
  for (const { name, source } of sources) {
    const exports = evaluateCatalogSource(source);
    for (const group of [exports.catalog, exports.openCatalog, exports.trendingCatalog]) {
      if (!Array.isArray(group)) continue;
      for (const e of group) {
        if (typeof e?.repo !== 'string' || typeof e?.id !== 'string') continue;
        const key = repoKey(e.repo);
        if (!key) continue;
        const firstTimeString = Array.isArray(e.replaces) ? e.replaces.map(String) : [];
        // First writer wins; the curated file lists a project before trending does.
        if (!byRepo.has(key)) {
          byRepo.set(key, {
            id: e.id,
            name: typeof e.name === 'string' ? e.name : e.id,
            repo: e.repo,
            category: typeof e.category === 'string' ? e.category : null,
            replaces: firstTimeString,
            selfHosted: !!e.selfHosted,
            website: typeof e.website === 'string' ? e.website : null,
            url: `https://www.openstore.site/app/${encodeURIComponent(e.id)}`,
            source_file: name,
          });
        }
      }
    }
  }
  return byRepo;
}

async function fetchText(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Try each mirror in turn; the first that answers wins. */
async function fetchWithFallback(file, { log = () => {} } = {}) {
  let lastError;
  for (const mirror of MIRRORS) {
    try {
      return await fetchText(mirror(file));
    } catch (e) {
      lastError = e;
      log(`  retry   ${file} via next mirror after: ${e.message}`);
    }
  }
  throw lastError;
}

/**
 * The whole collection step. Returns the shape everything downstream expects:
 * `{ ok, fetched_at, verified_at, apps: [...] }` on success, or
 * `{ ok: false, error }` from which the caller keeps the previous file.
 */
async function fetchCatalog({ log = () => {} } = {}) {
  const fetched_at = new Date().toISOString();
  const done = [];
  for (const file of SOURCES) {
    const source = await fetchWithFallback(file, { log });
    done.push({ name: file, source });
    log(`  ok      ${REPO}/${file}`);
  }
  const byRepo = catalogueFromSources(done);
  const apps = [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  if (!apps.length) throw new Error('OpenStore catalogs parsed to nothing');
  return {
    ok: true,
    fetched_at,
    verified_at: fetched_at,
    source_repo: REPO,
    files: SOURCES,
    count: apps.length,
    apps,
  };
}

const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;
const isFresh = (store) => !!store?.ok && !!store?.apps?.length && daysSince(store.fetched_at) <= DAYS_FRESH;

/**
 * The caller-side rule: use the stored copy only while it is within the keep
 * window and not explicitly void. Age is checked here rather than trusted to
 * the absence of a `stale` flag, because a copy that simply stopped being
 * refreshed must stop being published too — quietly, on its own date.
 */
const isUsable = (store) => !!store?.ok && !!store?.apps?.length && !store.stale_of_failure && daysSince(store.fetched_at) <= DAYS_KEEP;

module.exports = { fetchCatalog, catalogueFromSources, evaluateCatalogSource, repoKey, isFresh, isUsable, DAYS_FRESH, DAYS_KEEP };
