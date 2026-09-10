#!/usr/bin/env node
/**
 * ops/audit.js — measure the live pages rather than guess at them.
 *
 * Checks the things that actually decide whether a page ranks and whether it can
 * be read: weight, contrast, heading order, form labelling, link text, and the
 * structured data that makes the numbers citeable. Reports; it does not fix.
 */

const { shoot } = require('./shoot.js');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PROBE = `(() => {
  const out = { url: location.href, issues: [], stats: {} };

  // ---- weight -------------------------------------------------------------
  const res = performance.getEntriesByType('resource');
  const bytes = res.reduce((n, r) => n + (r.transferSize || r.encodedBodySize || 0), 0);
  out.stats.requests = res.length + 1;
  out.stats.transferred_kb = Math.round(bytes / 1024);
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) {
    out.stats.dom_content_loaded_ms = Math.round(nav.domContentLoadedEventEnd);
    out.stats.load_ms = Math.round(nav.loadEventEnd);
  }
  if (out.stats.transferred_kb > 700) out.issues.push('page transfers ' + out.stats.transferred_kb + ' KB');

  // ---- contrast -----------------------------------------------------------
  const lum = (c) => {
    const [r, g, b] = c.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number)
      .map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const bgOf = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c;
    }
    return getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)';
  };
  let worst = { ratio: 99 };
  document.querySelectorAll('p,a,span,td,th,li,h1,h2,h3,label,output,small,b').forEach((el) => {
    if (!el.textContent.trim() || el.offsetParent === null) return;
    const st = getComputedStyle(el);
    try {
      const l1 = lum(st.color), l2 = lum(bgOf(el));
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(st.fontSize);
      const large = size >= 24 || (size >= 18.66 && +st.fontWeight >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need && ratio < worst.ratio) {
        worst = { ratio: Math.round(ratio * 100) / 100, need, text: el.textContent.trim().slice(0, 40), color: st.color, size };
      }
    } catch (e) {}
  });
  out.stats.worst_contrast = worst.ratio === 99 ? 'all pass' : worst;
  if (worst.ratio !== 99) out.issues.push('contrast ' + worst.ratio + ':1 (needs ' + worst.need + ') on "' + worst.text + '"');

  // ---- headings -----------------------------------------------------------
  const hs = [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => +h.tagName[1]);
  out.stats.h1_count = hs.filter((h) => h === 1).length;
  if (out.stats.h1_count !== 1) out.issues.push(out.stats.h1_count + ' h1 elements');
  for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] > 1) { out.issues.push('heading jumps h' + hs[i - 1] + ' to h' + hs[i]); break; }

  // ---- controls -----------------------------------------------------------
  document.querySelectorAll('input,select,textarea').forEach((el) => {
    const labelled = el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
    if (!labelled) out.issues.push('unlabelled control: ' + (el.id || el.type));
  });

  // ---- links --------------------------------------------------------------
  const vague = [...document.querySelectorAll('a')].filter((a) => /^(here|click here|read more|link|this)$/i.test(a.textContent.trim()));
  if (vague.length) out.issues.push(vague.length + ' links with vague text');
  const noHref = [...document.querySelectorAll('a')].filter((a) => !a.getAttribute('href'));
  if (noHref.length) out.issues.push(noHref.length + ' anchors without href');

  // ---- SEO / citation -----------------------------------------------------
  out.stats.title = document.title;
  out.stats.title_len = document.title.length;
  if (!document.title || document.title.length > 65) out.issues.push('title is ' + document.title.length + ' chars');
  const desc = document.querySelector('meta[name=description]')?.content || '';
  out.stats.description_len = desc.length;
  if (!desc) out.issues.push('no meta description');
  else if (desc.length > 160) out.issues.push('meta description is ' + desc.length + ' chars');
  if (!document.querySelector('link[rel=canonical]')) out.issues.push('no canonical');
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')];
  out.stats.jsonld_blocks = ld.length;
  ld.forEach((s) => { try { JSON.parse(s.textContent); } catch (e) { out.issues.push('invalid JSON-LD'); } });

  // ---- images / layout ----------------------------------------------------
  const unsized = [...document.querySelectorAll('img')].filter((i) => !i.getAttribute('width') && !i.getAttribute('height'));
  if (unsized.length) out.issues.push(unsized.length + ' images without dimensions');
  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    out.issues.push('horizontal overflow: ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth);
  }
  const lang = document.documentElement.getAttribute('lang');
  if (!lang) out.issues.push('no lang attribute');

  return out;
})()`;

async function main() {
  const base = (process.argv[2] || 'https://nimbussage.github.io/exit-cost').replace(/\/$/, '');
  const pages = ['/', '/method/', '/e/airtable-to-baserow/', '/e/zapier-to-n8n/'];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcost-audit-'));
  let total = 0;

  console.log(`exit-cost audit — ${base}\n`);
  for (const page of pages) {
    const url = base + page;
    // Mobile viewport: it is the harder case and the one most readers use.
    const out = path.join(tmp, 'shot.png');
    let captured = '';
    const origLog = console.log;
    console.log = (s) => { captured += s; };
    try {
      await shoot({ url, out, evaluate: PROBE, width: 390, height: 844 });
    } finally { console.log = origLog; }

    let r;
    try { r = JSON.parse(captured); } catch { console.log(`  ${page}: probe failed`); continue; }
    const s = r.stats;
    console.log(`${page}`);
    console.log(`  ${s.requests} requests · ${s.transferred_kb} KB · DOM ${s.dom_content_loaded_ms}ms · load ${s.load_ms}ms`);
    console.log(`  title ${s.title_len} chars · description ${s.description_len} · JSON-LD ${s.jsonld_blocks} · contrast ${typeof s.worst_contrast === 'string' ? s.worst_contrast : s.worst_contrast.ratio + ':1'}`);
    if (r.issues.length) { r.issues.forEach((i) => console.log(`  ISSUE  ${i}`)); total += r.issues.length; }
    else console.log('  clean');
    console.log('');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(total ? `${total} issue(s)` : 'no issues found');
  process.exitCode = 0;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
