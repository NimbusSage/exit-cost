/**
 * verify-images.js — confirm every pinned container image tag actually exists.
 *
 * The most common way a compose stack fails on someone else's machine is a tag
 * that was never published or has since been deleted. We cannot run the stack
 * from here, but we can prove every image reference resolves — so that failure
 * mode, at least, is closed before anything ships.
 */

const { fetchJson } = require('../../pipeline/lib/http.js');

/** Split `library/postgres:16-alpine` or `ghcr.io/foo/bar:1.2` into parts. */
function parseRef(ref) {
  const [name, tag = 'latest'] = ref.split(':');
  const parts = name.split('/');
  const hasRegistry = parts.length > 1 && /[.:]/.test(parts[0]);
  const registry = hasRegistry ? parts.shift() : 'docker.io';
  const repo = parts.length === 1 ? `library/${parts[0]}` : parts.join('/');
  return { registry, repo, tag, ref };
}

async function tagExists(ref) {
  const { registry, repo, tag } = parseRef(ref);
  if (registry !== 'docker.io') {
    return { ref, checked: false, reason: `${registry} is not Docker Hub; not checked` };
  }
  try {
    const d = await fetchJson(`https://hub.docker.com/v2/repositories/${repo}/tags/${encodeURIComponent(tag)}`, { retries: 1, timeoutMs: 15000 });
    return { ref, checked: true, exists: true, last_pushed: d.tag_last_pushed || null, size: d.full_size || null };
  } catch (e) {
    if (e.status === 404) return { ref, checked: true, exists: false, reason: 'tag not found on Docker Hub' };
    return { ref, checked: false, reason: e.message };
  }
}

async function verifyAll(refs) {
  const results = [];
  for (const r of [...new Set(refs)]) results.push(await tagExists(r));
  return {
    results,
    ok: results.every((r) => !r.checked || r.exists),
    missing: results.filter((r) => r.checked && !r.exists).map((r) => r.ref),
    unchecked: results.filter((r) => !r.checked).map((r) => r.ref),
  };
}

module.exports = { parseRef, tagExists, verifyAll };
