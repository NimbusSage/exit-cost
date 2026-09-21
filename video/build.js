#!/usr/bin/env node
/**
 * video/build.js — generate a vertical data short for each comparison.
 *
 * One composition shape, values baked in per escape. Baking rather than using
 * runtime variables keeps every render a plain deterministic HTML file that can
 * be opened, diffed and debugged on its own.
 *
 * 1080x1920, 32s, no narration — text and motion only, so the piece costs
 * nothing to produce and reads with the sound off, which is how these are
 * actually watched.
 *
 *   node video/build.js [slug ...]      generate
 *   node video/build.js --render        generate, then render each to MP4
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readJson, listJson, p } = require('../pipeline/lib/store.js');
const chart = require('../site/assets/chart.js');

const OUT = path.join(__dirname, 'out');
const BGM_SRC = path.join(__dirname, 'assets', 'bgm', 'bed.mp3');
const SITE_URL = (process.env.SITE_URL || 'nimbussage.github.io/exit-cost').replace(/^https?:\/\//, '');
let TOTAL_ESCAPES = 20;

/** Each generated project is self-contained, so its fonts are copied in. */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}
const W = 1080, H = 1920, FPS = 30, DUR = 32;

/** The mark, inlined so a render needs no asset lookup. */
const MARK = `<svg viewBox="0 0 512 512" aria-hidden="true">
  <g stroke="#8b919b" stroke-linecap="butt" fill="none">
    <path d="M152 128 L152 368 L392 368" stroke-width="20"/>
    <g stroke-width="18"><path d="M120 168 H152 M120 248 H152 M120 328 H152"/><path d="M216 400 V368 M288 400 V368 M360 400 V368"/></g>
  </g>
  <g fill="none" stroke-linecap="round">
    <path d="M152 368 L378 146" stroke="#a81e27" stroke-width="44"/>
    <path d="M152 256 L378 208" stroke="#0b5137" stroke-width="44"/>
  </g></svg>`;
const WORDMARK = `<div class="wordmark">${MARK}<span>Exit Cost</span></div>`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/**
 * Size the big figure to the frame rather than to a guess.
 * DM Mono advances about 0.6em per character; the usable width is the frame
 * less its padding. Capped so short numbers do not become absurd.
 */
function figPx(text, { cap, maxWidth = 1080 - 168 }) {
  return Math.min(cap, Math.floor(maxWidth / (text.length * 0.62)));
}

const money0 = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
const money2 = (n) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The chart, re-projected into the short's aspect. The site's renderer is reused
 * so the video can never disagree with the page about where the lines cross.
 */
function chartSvg(e) {
  const g = chart.geometry(e.curve, {
    breakEven: e.result.break_even_month,
    width: 640, height: 600, pad: { t: 20, r: 20, b: 54, l: 96 },
  });
  const vb = g.viewBox.split(' ').map(Number);
  const parts = [];
  parts.push(`<svg id="chart-svg" viewBox="${g.viewBox}" preserveAspectRatio="xMidYMid meet">`);
  for (const t of g.yTicks) {
    parts.push(`<line class="g" x1="${g.plot.x0}" x2="${g.plot.x1}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/>`);
    parts.push(`<text class="ax" x="${g.plot.x0 - 12}" y="${(t.y + 7).toFixed(1)}" text-anchor="end">${t.label}</text>`);
  }
  // The first and last ticks sit on the plot edges, so centring them pushes half
  // the label outside the viewBox and it gets clipped.
  g.xTicks.forEach((t, i) => {
    const anchor = i === 0 ? 'start' : i === g.xTicks.length - 1 ? 'end' : 'middle';
    parts.push(`<text class="ax" x="${t.x.toFixed(1)}" y="${g.plot.y1 + 34}" text-anchor="${anchor}">${t.label}</text>`);
  });
  parts.push(`<path class="li" d="${g.paths.inc}"/>`);
  parts.push(`<path class="la" d="${g.paths.alt}"/>`);
  if (g.cross) parts.push(`<circle id="cross-dot" cx="${g.cross.x.toFixed(1)}" cy="${g.cross.y.toFixed(1)}" r="6"/>`);
  // A paper-coloured panel parked over the plot and slid right reveals the lines.
  // Sliding a solid rect is a pure transform, which stays deterministic under seeking.
  parts.push(`<rect id="wipe" x="${g.plot.x0 - 1}" y="0" width="${g.plot.x1 - g.plot.x0 + 20}" height="${vb[3]}"/>`);
  parts.push('</svg>');
  return parts.join('');
}

const BGM = fs.existsSync(BGM_SRC);

function composition(e) {
  const r = e.result;
  const altShort = e.alternative.name.replace(/ \(self-hosted\)$/, '');
  const inc = `${e.incumbent.vendor} ${e.incumbent.plan}`;
  const seats = r.inputs.seats;
  const x = r.break_even_hourly_rate;
  const yrs = r.inputs.horizon_months / 12;

  const verdictWord = r.verdict === 'switch' ? 'Leave it.' : r.verdict === 'stay' ? 'Keep paying.' : 'Barely worth it.';
  const verdictClass = r.verdict === 'switch' ? 'credit' : r.verdict === 'stay' ? 'debit' : 'muted';

  const crossoverBig = x === null || x < 0 ? null : money2(x);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${W}, height=${H}">
<title>Exit Cost — ${esc(inc)} to ${esc(altShort)}</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  @import url('assets/fonts.css');
  :root {
    --paper:#edeef0; --ink:#000; --muted:#565c66; --rule:#c0c4cb;
    --debit:#a81e27; --credit:#0b5137;
    --serif:'Newsreader',Georgia,serif; --mono:'DM Mono',ui-monospace,monospace;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:#000; }
  #root { position:relative; width:${W}px; height:${H}px; overflow:hidden; font-family:var(--serif); }
  .bg { position:absolute; inset:0; background:var(--paper); }
  .clip { position:absolute; inset:0; padding:120px 84px; display:flex; flex-direction:column; justify-content:center; }
  .kicker { font-size:60px; color:var(--ink); font-weight:500; line-height:1.22; margin:0 0 20px; }
  .kicker b { color:var(--ink); font-weight:600; }
  .say { font-size:98px; font-weight:500; line-height:1.1; margin:0 0 28px; letter-spacing:-.028em; max-width:13ch; }
  .fig { font-family:var(--mono); font-weight:500; letter-spacing:-.05em; line-height:.92; margin:0; }
  .fig-xl { font-size:268px; }
  .fig-lg { font-size:198px; }
  .per { font-family:var(--serif); font-size:.3em; letter-spacing:normal; color:var(--muted); margin-left:.1em; }
  .debit { color:var(--debit); } .credit { color:var(--credit); } .muted { color:var(--muted); }
  .rule { height:2px; background:var(--rule); margin:34px 0; }
  .line { display:grid; grid-template-columns:1fr auto; align-items:baseline; font-size:60px; margin:0 0 22px; gap:6px 40px; }
  .line .amt { font-family:var(--mono); font-feature-settings:'tnum' 1; white-space:nowrap; }
  .line .lbl { color:var(--ink); line-height:1.2; }
  .note { font-size:46px; color:var(--muted); line-height:1.32; margin:24px 0 0; max-width:22ch; }

  #chart-svg { width:100%; height:auto; display:block; }
  #chart-svg .g { stroke:var(--rule); stroke-width:1; }
  #chart-svg .ax { font-family:var(--mono); font-size:19px; fill:var(--muted); }
  #chart-svg .li { fill:none; stroke:var(--debit); stroke-width:4.5; }
  #chart-svg .la { fill:none; stroke:var(--credit); stroke-width:4.5; stroke-dasharray:10 6; }
  #chart-svg #cross-dot { fill:var(--paper); stroke:var(--ink); stroke-width:4; }
  #chart-svg #wipe { fill:var(--paper); }

  .wordmark { position:absolute; left:84px; bottom:74px; display:flex; align-items:center; gap:22px; }
  .wordmark svg { width:82px; height:82px; display:block; }
  .wordmark span { font-size:46px; color:var(--muted); letter-spacing:-.01em; }
  .cta-url { font-family:var(--mono); font-size:44px; color:var(--ink); margin-top:16px; }
</style>
</head>
<body>
<div id="root" data-composition-id="short" data-width="${W}" data-height="${H}" data-duration="${DUR}" data-fps="${FPS}">
  <div class="bg"></div>
${BGM ? `
  <!-- Music bed. A direct child of the composition root: the runtime only drives
       media that sits here, and anything nested renders silent. -->
  <audio id="bgm" src="assets/bgm/bed.mp3" data-start="0" data-duration="${DUR}" data-track-index="0" data-volume="1"></audio>` : ''}

  <section id="scene-bill" class="clip" data-start="0" data-duration="5" data-track-index="1">
    <p class="kicker" id="s1-k">You pay for <b>${esc(inc)}</b>${seats > 1 ? `, ${seats} seats` : ''}.</p>
    <p class="fig debit" id="s1-f" style="font-size:${figPx(money0(r.incumbent.annual), { cap: 268 })}px">${money0(r.incumbent.annual)}</p>
    <p class="kicker" id="s1-y" style="margin-top:18px">every year</p>
  </section>

  <section id="scene-alternative" class="clip" data-start="5" data-duration="4.6" data-track-index="2">
    <p class="kicker" id="s2-k">Self-host <b>${esc(altShort)}</b> instead.</p>
    <p class="fig credit" id="s2-f" style="font-size:${figPx(money0(r.alternative.cash_monthly * 12), { cap: 268 })}px">${money0(r.alternative.cash_monthly * 12)}</p>
    <p class="kicker" id="s2-y" style="margin-top:18px">a year, all in</p>
  </section>

  <section id="scene-your-time" class="clip" data-start="9.6" data-duration="5.4" data-track-index="3">
    <p class="say" id="s3-h">But your time isn't free.</p>
    <div id="s3-rows">
      <div class="line"><span class="lbl">Server and backup</span><span class="amt">${money2(r.alternative.cash_monthly)}</span></div>
      <div class="line"><span class="lbl">Keeping it running, ${e.alternative.maintenance_hours_per_month} h/mo</span><span class="amt">${money2(r.alternative.time_monthly)}</span></div>
      <div class="rule"></div>
      <div class="line"><span class="lbl">Every month</span><span class="amt">${money2(r.alternative.monthly)}</span></div>
    </div>
    <p class="note" id="s3-n">Plus ${e.alternative.migration_hours} hours to move, once.</p>
  </section>

  <section id="scene-chart" class="clip" data-start="15" data-duration="7.6" data-track-index="4" style="justify-content:center">
    <p class="kicker" id="s4-k" style="margin-bottom:34px">What it costs over ${yrs} years</p>
    <div id="s4-chart">${chartSvg(e)}</div>
    <div class="line" id="s4-key" style="margin-top:44px; font-size:38px">
      <span class="lbl"><span class="debit">&#9473;&#9473;</span> ${esc(inc)}</span>
      <span class="lbl"><span class="credit">&#9548;&#9548;</span> ${esc(altShort)}</span>
    </div>
  </section>

  <section id="scene-verdict" class="clip" data-start="22.6" data-duration="6.4" data-track-index="5">
    ${crossoverBig ? `
    <p class="kicker" id="s5-k">Worth doing only if your hour is worth under</p>
    <p class="fig" id="s5-f" style="font-size:${figPx(crossoverBig + "/hr", { cap: 198 })}px">${crossoverBig}<span class="per">/hr</span></p>
    <p class="say ${verdictClass}" id="s5-v" style="margin-top:44px; font-size:66px">${verdictWord}</p>`
    : `
    <p class="say" id="s5-k">${esc(altShort)} costs more in cash alone.</p>
    <p class="say ${verdictClass}" id="s5-v" style="margin-top:32px">${verdictWord}</p>`}
  </section>

  <section id="scene-close" class="clip" data-start="29" data-duration="3" data-track-index="6">
    <p class="say" id="s6-h" style="font-size:70px">${TOTAL_ESCAPES} of these.<br>All with the working shown.</p>
    <p class="cta-url" id="s6-u">${SITE_URL}</p>
  </section>

  ${WORDMARK}
</div>

<script>
  window.__timelines = window.__timelines || {};
  var tl = gsap.timeline({ paused: true });
  var IN  = { opacity: 0, y: 46, duration: 0.55, ease: 'power3.out' };
  var OUT = { opacity: 0, duration: 0.35, ease: 'power2.in' };

  // Scene 1 — the bill
  tl.from('#s1-k', IN, 0.15)
    .from('#s1-f', { opacity: 0, scale: 0.86, duration: 0.6, ease: 'back.out(1.6)' }, 0.75)
    .from('#s1-y', IN, 1.25)
    .to(['#s1-k', '#s1-f', '#s1-y'], OUT, 4.5);

  // Scene 2 — the alternative
  tl.from('#s2-k', IN, 5.2)
    .from('#s2-f', { opacity: 0, scale: 0.86, duration: 0.6, ease: 'back.out(1.6)' }, 5.75)
    .from('#s2-y', IN, 6.25)
    .to(['#s2-k', '#s2-f', '#s2-y'], OUT, 9.15);

  // Scene 3 — the part everyone leaves out
  tl.from('#s3-h', IN, 9.8)
    .from('#s3-rows .line', { opacity: 0, y: 26, duration: 0.4, stagger: 0.22, ease: 'power2.out' }, 10.4)
    .from('#s3-n', IN, 11.9)
    .to(['#s3-h', '#s3-rows', '#s3-n'], OUT, 14.6);

  // Scene 4 — the lines, revealed by sliding the cover panel off to the right
  tl.from('#s4-k', IN, 15.2)
    .from('#s4-chart', { opacity: 0, duration: 0.4 }, 15.4)
    .to('#wipe', { x: 660, duration: 2.4, ease: 'power1.inOut' }, 15.9)
    .from('#cross-dot', { opacity: 0, scale: 0, duration: 0.45, ease: 'back.out(2)', transformOrigin: '50% 50%' }, 18.1)
    .from('#s4-key', IN, 18.5)
    .to(['#s4-k', '#s4-chart', '#s4-key'], OUT, 22.2);

  // Scene 5 — the verdict
  tl.from('#s5-k', IN, 22.8)
    .from('#s5-f', { opacity: 0, scale: 0.88, duration: 0.65, ease: 'back.out(1.5)' }, 23.35)
    .from('#s5-v', IN, 24.5)
    .to(['#s5-k', '#s5-f', '#s5-v'], OUT, 28.6);

  // Scene 6 — the close
  tl.from('#s6-h', IN, 29.15)
    .from('#s6-u', IN, 29.9);

  window.__timelines['short'] = tl;
</script>
</body>
</html>`;
}

function main() {
  const args = process.argv.slice(2);
  const render = args.includes('--render');
  const only = args.filter((a) => !a.startsWith('--'));

  let escapes = listJson(p('data', 'build', 'escapes')).map((f) => readJson(f)).filter(Boolean);
  if (only.length) escapes = escapes.filter((e) => only.includes(e.slug));
  if (!escapes.length) { console.error('no escapes to build — run pipeline/render/build.js first'); process.exit(1); }
  const index = readJson(p('data', 'build', 'index.json'));
  if (index?.counts?.published) TOTAL_ESCAPES = index.counts.published;

  fs.mkdirSync(OUT, { recursive: true });
  const made = [];
  for (const e of escapes) {
    const dir = path.join(OUT, e.slug);
    fs.mkdirSync(dir, { recursive: true });
    copyDir(path.join(__dirname, 'assets'), path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), composition(e), 'utf8');
    made.push({ slug: e.slug, dir });
  }
  console.log(`generated ${made.length} compositions in video/out`);

  if (render) {
    // Fail early and legibly. A detached shell does not source nvm, so this
    // silently ran on Node 18 and every render failed with a message nobody
    // read — leaving thirty stale videos that looked freshly built.
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) {
      console.error(`FATAL: rendering needs Node >= 22, this is ${process.versions.node}.`);
      console.error('       In a detached shell, source nvm first:');
      console.error('       . "$HOME/.nvm/nvm.sh" && nvm use 22 && node video/build.js --render');
      process.exit(1);
    }
    const failures = [];
    for (const m of made) {
      const outFile = path.join(OUT, `${m.slug}.mp4`);
      console.log(`rendering ${m.slug} ...`);
      try {
        execFileSync('npx', ['--yes', 'hyperframes', 'render', m.dir, '-o', outFile, '-q', 'standard', '--quiet'],
          { stdio: 'inherit', env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' } });
      } catch (err) {
        console.error(`  render failed for ${m.slug}`);
        failures.push(m.slug);
      }
    }
    if (failures.length) {
      console.error(`\n${failures.length} of ${made.length} renders failed: ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`rendered ${made.length} videos`);
  }
  return made;
}

if (require.main === module) main();
module.exports = { composition, main };
