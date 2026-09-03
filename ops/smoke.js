#!/usr/bin/env node
/**
 * ops/smoke.js — check the LIVE site, not the build output.
 *
 * Written after a deploy that returned HTTP 200 on every URL while serving a
 * completely unstyled page: the HTML referenced /assets/style.css while the
 * asset lived at /exit-cost/assets/style.css. Status codes alone do not tell
 * you a site is working, so this follows the page's own references.
 *
 *   node ops/smoke.js https://nimbussage.github.io/exit-cost/
 */

const base = (process.argv[2] || process.env.SITE_URL || 'https://nimbussage.github.io/exit-cost').replace(/\/$/, '') + '/';

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  pass  ${msg}`);

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ExitCostSmoke/1.0' }, redirect: 'follow' });
  return { ok: res.ok, status: res.status, type: res.headers.get('content-type') || '', body: res.ok ? await res.text() : '' };
}

async function main() {
  console.log(`exit-cost smoke test — ${base}\n`);

  const home = await get(base);
  if (!home.ok) { fail(`homepage returned ${home.status}`); return done(); }
  pass(`homepage ${home.status}`);

  if (!/What it really costs to leave a subscription/.test(home.body)) fail('homepage is missing its headline');
  else pass('homepage renders its own content');

  // Follow every reference the page actually makes, which is the check that
  // would have caught the unstyled deploy.
  const refs = [...home.body.matchAll(/(?:href|src)="((?:\/|https?:\/\/)[^"]*)"/g)]
    .map((m) => m[1])
    .filter((r) => !r.startsWith('http') || r.startsWith(new URL(base).origin))
    .filter((r) => !/^(mailto:|#)/.test(r));

  const unique = [...new Set(refs)];
  let broken = 0;
  for (const ref of unique) {
    const url = ref.startsWith('http') ? ref : new URL(ref, base).toString();
    const r = await get(url);
    if (!r.ok) { fail(`${ref} -> ${r.status}`); broken++; }
  }
  if (!broken) pass(`all ${unique.length} references on the homepage resolve`);

  // The stylesheet must be reachable AND be the real thing.
  const cssRef = unique.find((r) => r.endsWith('.css'));
  if (!cssRef) fail('the homepage links no stylesheet at all');
  else {
    const css = await get(new URL(cssRef, base).toString());
    if (!css.type.includes('css')) fail(`stylesheet served as ${css.type}`);
    else if (!/--paper/.test(css.body)) fail('stylesheet does not contain the expected tokens');
    else pass('stylesheet is served and contains the design tokens');

    // @import inside the CSS is resolved relative to the CSS, and is easy to break.
    const imp = css.body.match(/@import url\(['"]?([^'")]+)['"]?\)/);
    if (imp) {
      const fontCss = await get(new URL(imp[1], new URL(cssRef, base)).toString());
      if (!fontCss.ok) fail(`stylesheet imports ${imp[1]}, which returns ${fontCss.status}`);
      else {
        pass('imported font stylesheet resolves');
        const face = fontCss.body.match(/url\(([^)]+\.woff2)\)/);
        if (face) {
          const f = await get(new URL(face[1].replace(/['"]/g, ''), new URL(imp[1], new URL(cssRef, base))).toString());
          f.ok ? pass('webfont files resolve') : fail(`webfont ${face[1]} returns ${f.status}`);
        }
      }
    }
  }

  // The scripts that power the hourly-rate control.
  for (const js of unique.filter((r) => r.endsWith('.js'))) {
    const r = await get(new URL(js, base).toString());
    if (!r.ok) fail(`${js} -> ${r.status}`);
    else if (js.endsWith('linear.js') && !/crossover/.test(r.body)) fail('linear.js is served but looks wrong');
  }
  pass('page scripts resolve');

  // A comparison page and the open data.
  const api = await get(new URL('api/index.json', base).toString());
  if (!api.ok) fail(`api/index.json -> ${api.status}`);
  else {
    let data;
    try { data = JSON.parse(api.body); } catch { return fail('api/index.json is not valid JSON'), done(); }
    if (!data.escapes?.length) fail('the API lists no comparisons');
    else {
      pass(`API lists ${data.escapes.length} comparisons`);
      const one = await get(data.escapes[0].url);
      if (!one.ok) fail(`${data.escapes[0].url} -> ${one.status}`);
      else if (!/id="rate"/.test(one.body)) fail('a comparison page is missing the hourly-rate control');
      else pass('a comparison page carries the hourly-rate control');

      const stale = data.escapes.filter((e) => e.freshness === 'stale' || e.freshness === 'undated');
      if (stale.length) fail(`${stale.length} live comparisons are built on stale data: ${stale.map((s) => s.slug).join(', ')}`);
      else pass('no live comparison is built on stale data');
    }
  }

  done();
}

function done() {
  console.log(`\n${failures.length ? `${failures.length} FAILURES` : 'all checks passed'}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('smoke test crashed:', e.message); process.exit(1); });
