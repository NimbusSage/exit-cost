#!/usr/bin/env node
/**
 * site/build.js — static site generator.
 *
 * No framework and no dependencies: the whole site is ~30 data-driven pages with
 * one interactive control, and a build toolchain would be more moving parts to
 * keep alive unattended than the pages are worth. Output is plain HTML that any
 * static host will serve.
 */

const fs = require('node:fs');
const path = require('node:path');
const { readJson, listJson, p } = require('../pipeline/lib/store.js');
const chart = require('./assets/chart.js');

const DIST = process.env.EXITCOST_DIST || path.join(__dirname, 'dist');

/**
 * Affiliate links live in data/affiliates.json and are applied ONLY to the
 * outbound link. Provider selection is automated on price and never consults
 * this table — that separation is what makes the disclosure honest.
 */
let AFFILIATES = new Map();
function loadAffiliates() {
  const d = readJson(p('data', 'affiliates.json'), { programs: [] });
  AFFILIATES = new Map((d.programs || [])
    .filter((a) => a.status === 'active' && a.url)
    .map((a) => [a.provider, a]));
}
/** The link for a provider, plus any genuine offer the reader gets by using it. */
function providerLink(provider, plainUrl) {
  const a = AFFILIATES.get(provider);
  return a ? { url: a.url, affiliate: true, benefit: a.reader_benefit || null }
           : { url: plainUrl, affiliate: false, benefit: null };
}

/**
 * Deploys land either at a domain root or under a project subpath
 * (nimbussage.github.io/exit-cost). Every internal href goes through u().
 */
let BASE = '';
const u = (p) => BASE + p;   // BASE is '' at a domain root, '/exit-cost' under a subpath
const SITE_NAME = 'Exit Cost';
const TAGLINE = 'What it really costs to leave a subscription.';

/* ------------------------------------------------------------------ helpers */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n, dp = 2) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signed = (n, dp = 0) => (n < 0 ? '−' : '') + money(n, dp);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const niceDate = (iso) => (iso ? DATE_FMT.format(new Date(iso)) : 'undated');

function write(rel, body) {
  const file = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name), dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/* ------------------------------------------------------------------- layout */

function layout({ title, description, canonical, body, jsonld = null, scripts = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta name="twitter:card" content="summary">
<link rel="stylesheet" href="${u('/assets/style.css')}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='%23edeef0'/><text y='24' x='4' font-family='Georgia,serif' font-size='22' fill='%23000'>&#8709;</text></svg>">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
</head>
<body>
<div class="wrap">
<header class="masthead">
  <a class="wordmark" href="${u('/')}">${SITE_NAME}</a>
  <nav>
    <a href="${u('/')}">Comparisons</a>
    <a href="${u('/method/')}">How we count</a>
    <a href="${u('/api/index.json')}">Data</a>
  </nav>
</header>
<main>
${body}
</main>
<footer class="site">
  <p><b>Affiliate disclosure.</b> Some links to hosting and backup providers on this site
  are affiliate links, and we may earn a commission if you sign up through one. It costs
  you nothing extra. It also does not affect the arithmetic: provider selection is
  automated — the cheapest plan meeting the stated requirements wins — and we publish the
  comparisons where staying on the subscription is the right answer.</p>
  <p>Prices are list prices in USD, exclusive of tax, and each carries the date it was
  last verified. We are not affiliated with any of the vendors compared here.
  <a href="${u('/method/')}">How we count</a> · <a href="${u('/api/index.json')}">Open data</a></p>
</footer>
</div>
${scripts}
</body>
</html>`;
}

/* ------------------------------------------------------------- escape page */

const VERDICT_SENTENCE = {
  switch:   (alt, save, yrs) => `<span class="verdict-word">Switch.</span> At $50 an hour, ${alt} saves you <b>${money(save, 0)}</b> over ${yrs} years.`,
  marginal: (alt, save, yrs) => `<span class="verdict-word">Marginal.</span> At $50 an hour, ${alt} saves you <b>${money(save, 0)}</b> over ${yrs} years.`,
  stay:     (alt, save, yrs) => `<span class="verdict-word">Stay.</span> At $50 an hour, ${alt} costs you <b>${money(save, 0)}</b> more over ${yrs} years.`,
};

function crossoverCopy(e) {
  const x = e.result.break_even_hourly_rate;
  const alt = e.alternative.name.replace(/ \(self-hosted\)$/, '');
  const inc = `${e.incumbent.vendor} ${e.incumbent.plan}`;
  const yrs = e.result.inputs.horizon_months / 12;

  if (x === null) return { headline: null, lede: 'Neither option asks for any of your time, so this one turns on cash alone.', note: 'Move the controls below to see how it changes with team size.' };

  if (x < 0) return {
    headline: null,
    lede: `${alt} costs more than ${inc} in cash alone at this size.`,
    note: `Before a single hour of your time is counted, it is already behind. No hourly rate makes it pay${e.incumbent.per_seat ? ' — but adding people does' : ''}.`,
  };

  // The headline number is the same either way, but a $7 crossover and a $260
  // crossover mean opposite things, and the sentence under it has to say so.
  if (x < 15) return {
    headline: x,
    lede: 'This one only pays off if your hour is worth less than',
    note: `That is below the minimum wage almost anywhere this software is run. In practice it means stay on ${inc}: the subscription is cheaper than the hours ${alt} would take, and it is not close.`,
  };

  if (x < 40) return {
    headline: x,
    lede: 'This one only pays off if your hour is worth less than',
    note: `That is a low bar. Unless your time is genuinely cheap, or you would enjoy running ${alt} enough not to count the hours, ${inc} is the better deal.`,
  };

  return {
    headline: x,
    lede: 'Worth doing only if your hour is worth less than',
    note: `Below that rate, moving to ${alt} pays for itself inside ${yrs} years. Above it, your time is worth more than the saving, and you should stay on ${inc}.`,
  };
}

function statementRows(e) {
  const inc = e.incumbent, alt = e.alternative, r = e.result;
  const seatNote = inc.per_seat
    ? `${money(inc.amount)}/${inc.period} × <span id="seat-note">${plural(inc.seats, 'seat', 'seats')}</span>`
    : `${money(inc.amount)}/${inc.period}, flat`;

  const incRows = [
    `<tr><td>${esc(inc.vendor)} ${esc(inc.plan)}<div class="note">${seatNote}${inc.billed ? `, billed ${esc(inc.billed)}` : ''}</div></td><td class="amt" id="inc-cash">${money(r.incumbent.cash_monthly)}</td></tr>`,
  ];
  if (r.incumbent.time_monthly > 0) {
    incRows.push(`<tr><td>Your time<div class="note">${e.incumbent.maintenance_hours_per_month ?? 0} h/month administering it</div></td><td class="amt" id="inc-time-monthly">${money(r.incumbent.time_monthly)}</td></tr>`);
  }

  const hostLink = providerLink(alt.box.provider, alt.box.url);
  const altRows = [
    `<tr><td><a href="${esc(hostLink.url)}" rel="sponsored nofollow">${esc(alt.box.provider)} ${esc(alt.box.name)}</a><div class="note">${alt.box.vcpu} vCPU · ${alt.box.ram_gb} GB RAM · ${alt.box.disk_gb} GB disk${alt.box.bandwidth_tb ? ` · ${alt.box.bandwidth_tb} TB transfer` : ''}${hostLink.benefit ? ` · <b>${esc(hostLink.benefit)}</b> via our referral link` : ''}</div></td><td class="amt">${money(alt.box.monthly_usd)}</td></tr>`,
  ];
  if (alt.storage) {
    altRows.push(`<tr><td>${esc(alt.storage.name)} backup<div class="note">${alt.storage.gb} GB at ${money(alt.storage.usd_per_gb_month, 5)}/GB/month</div></td><td class="amt">${money(alt.storage.monthly_usd)}</td></tr>`);
  }
  altRows.push(`<tr><td>Your time<div class="note">${alt.maintenance_hours_per_month} h/month keeping it patched and backed up</div></td><td class="amt" id="alt-time-monthly">${money(r.alternative.time_monthly)}</td></tr>`);

  return { incRows, altRows };
}

function provenanceTable(e) {
  const rows = [];
  rows.push(`<tr><td><a href="${esc(e.incumbent.source_url)}" rel="nofollow">${esc(e.incumbent.vendor)} pricing page</a></td><td>${niceDate(e.incumbent.verified_at)}</td></tr>`);
  const host = providerLink(e.alternative.box.provider, e.alternative.box.url);
  rows.push(`<tr><td><a href="${esc(host.url)}" rel="sponsored nofollow">${esc(e.alternative.box.provider)} plan catalogue</a>${host.affiliate ? ' <span class="aff">affiliate link</span>' : ''}</td><td>${niceDate(e.alternative.box.verified_at)}</td></tr>`);
  if (e.alternative.storage) rows.push(`<tr><td><a href="${esc(e.alternative.storage.pricing_url)}" rel="sponsored nofollow">${esc(e.alternative.storage.name)} pricing</a></td><td>${niceDate(e.alternative.storage.verified_at)}</td></tr>`);
  if (e.alternative.project) rows.push(`<tr><td><a href="${esc(e.alternative.project.url)}">${esc(e.alternative.project.full_name)} activity</a></td><td>${niceDate(e.alternative.project.verified_at)}</td></tr>`);
  return rows.join('\n');
}

function escapePage(e, siteUrl) {
  const r = e.result;
  const yrs = r.inputs.horizon_months / 12;
  const altShort = e.alternative.name.replace(/ \(self-hosted\)$/, '');
  const x = crossoverCopy(e);
  const { incRows, altRows } = statementRows(e);

  // Split the incumbent into its per-seat and flat parts so the browser can
  // re-price the whole comparison as the reader changes their team size. Seats
  // are the dominant variable — a page fixed to one seat count is wrong for
  // most of the people reading it.
  const perMonth = (amount, period) => (period === 'year' ? amount / 12 : amount);
  const incMonthlyUnit = perMonth(e.incumbent.amount, e.incumbent.period);

  const model = {
    alternative_short: esc(altShort),
    incumbent_short: esc(`${e.incumbent.vendor} ${e.incumbent.plan}`),
    per_seat: !!e.incumbent.per_seat,
    model: {
      inc_per_seat_monthly: e.incumbent.per_seat ? incMonthlyUnit : 0,
      inc_flat_monthly: e.incumbent.per_seat ? 0 : incMonthlyUnit,
      inc_hours_monthly: e.incumbent.maintenance_hours_per_month ?? 0,
      inc_cash_one_time: r.incumbent.one_time,
      // Everything on the self-hosted side is flat: a server does not care how
      // many people use it, which is the entire reason seats decide this.
      alt_per_seat_monthly: 0,
      alt_flat_monthly: r.alternative.cash_monthly,
      alt_hours_monthly: e.alternative.maintenance_hours_per_month,
      alt_cash_one_time: r.alternative.cash_one_time,
      alt_migration_hours: e.alternative.migration_hours,
      horizon_months: r.inputs.horizon_months,
      seats: r.inputs.seats,
    },
  };

  const pj = e.alternative.project;
  const svg = chart.svg(e.curve, { breakEven: r.break_even_month, alt: `Cumulative cost of ${e.incumbent.vendor} ${e.incumbent.plan} against ${altShort} over ${r.inputs.horizon_months} months` });

  const body = `
<article class="standfirst">
  <p class="route"><b>${esc(e.incumbent.vendor)} ${esc(e.incumbent.plan)}</b>${e.incumbent.per_seat ? `, <span id="route-seats">${plural(r.inputs.seats, 'seat', 'seats')}</span>` : ''} &rarr; <b>${esc(altShort)}</b>, self-hosted</p>

  <p class="verdict-line v-${r.verdict}" id="verdict">${VERDICT_SENTENCE[r.verdict](esc(altShort), r.savings.at_horizon, yrs)}</p>

  <p class="muted" id="crossover-lede" style="margin:1.4rem 0 0">${esc(x.lede || 'At the team size below, this comparison turns on cash rather than time.')}</p>
  <span class="crossover" id="crossover-figure">${x.headline !== null ? `${money(x.headline, 2)}<span class="per">/hr</span>` : '—'}</span>
  <p class="crossover-note measure" id="crossover-note">${x.note}</p>

  ${e.incumbent.needs_reverification ? `<p class="flag">${esc(e.incumbent.vendor)} appears to have changed this price since we last verified it. The figure below is the last one we confirmed by hand, dated ${niceDate(e.incumbent.verified_at)}. We are re-checking it.</p>` : ''}
  ${pj && pj.health === 'slowing' ? `<p class="flag">${esc(pj.full_name)} has been quiet for ${pj.days_since_push} days. Still maintained, but worth a look at the repository before you commit to it.</p>` : ''}

  <div class="rate">
    <div class="rate-top">
      <label for="rate">What is an hour of your time worth?</label>
      <output id="rate-out" for="rate">$50/hr</output>
    </div>
    <input type="range" id="rate" min="0" max="250" step="5" value="50" aria-label="Your hourly rate in dollars">
    <div class="rate-scale"><span>$0</span><span>$125</span><span>$250</span></div>

    ${e.incumbent.per_seat ? `
    <div class="rate-top" style="margin-top:1.4rem">
      <label for="seats">How many people?</label>
      <output id="seats-out" for="seats">${r.inputs.seats}</output>
    </div>
    <input type="range" id="seats" min="1" max="60" step="1" value="${r.inputs.seats}" aria-label="Number of seats">
    <div class="rate-scale"><span>1</span><span>30</span><span>60</span></div>` : `
    <p class="small muted" style="margin:1.1rem 0 0">${esc(e.incumbent.vendor)} ${esc(e.incumbent.plan)} is billed flat rather than per seat, so team size does not change this comparison.</p>`}

    <p class="small muted" style="margin:.9rem 0 0">Every figure on this page updates as you move these. Most comparisons of this kind quietly assume your time is free and your team never changes size.</p>
  </div>

  ${e.incumbent.per_seat ? `<p class="threshold" id="threshold"></p>` : ''}

  <div class="chart">${svg}</div>
  <div class="chart-key">
    <span class="k-inc"><i></i>${esc(e.incumbent.vendor)} ${esc(e.incumbent.plan)}</span>
    <span class="k-alt"><i></i>${esc(altShort)}, all in</span>
    <span>Breaks even <b id="be-month">${r.break_even_month === null ? 'never' : 'month ' + r.break_even_month}</b></span>
  </div>

  <p class="section-head">What you pay now</p>
  <table class="statement">
    ${incRows.join('\n    ')}
    <tr class="total"><td>Every month</td><td class="amt" id="inc-monthly">${money(r.incumbent.monthly)}</td></tr>
  </table>

  <p class="section-head">What the escape costs</p>
  <table class="statement">
    ${altRows.join('\n    ')}
    <tr class="total"><td>Every month</td><td class="amt" id="alt-monthly">${money(r.alternative.monthly)}</td></tr>
    <tr><td style="padding-top:.9rem">Migration, once<div class="note">${e.alternative.migration_hours} hours of your time, our estimate</div></td><td class="amt" id="alt-upfront" style="padding-top:.9rem">${money(r.alternative.one_time)}</td></tr>
  </table>

  <p class="section-head">The difference</p>
  <table class="statement">
    <tr><td>Saved each month</td><td class="amt ${r.delta.monthly < 0 ? 'neg' : 'pos'}" id="delta-monthly">${signed(r.delta.monthly, 2)}</td></tr>
    <tr><td>After one year</td><td class="amt ${r.savings.year_1 < 0 ? 'neg' : 'pos'}" id="save-1yr">${signed(r.savings.year_1)}</td></tr>
    <tr class="grand"><td>After ${yrs} years</td><td class="amt ${r.savings.at_horizon < 0 ? 'neg' : 'pos'}" id="save-horizon">${signed(r.savings.at_horizon)}</td></tr>
  </table>

  <p class="section-head">What you give up, and what you get</p>
  <div class="two-col">
    <div class="lose"><h3>You lose</h3><ul>${e.tradeoffs.you_lose.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
    <div class="gain"><h3>You gain</h3><ul>${e.tradeoffs.you_gain.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
  </div>

  ${e.caveats.length ? `<p class="section-head">Read this before you decide</p><ul class="caveats measure">${e.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}

  ${pj ? `<p class="section-head">Is the project alive?</p>
  <p class="measure">${esc(pj.full_name)} has ${pj.stars.toLocaleString('en-US')} stars, was last pushed ${plural(pj.days_since_push, 'day', 'days')} ago${pj.latest_release ? `, and last cut a release (${esc(pj.latest_release.tag)}) ${plural(pj.days_since_release, 'day', 'days')} ago` : ' and does not cut tagged releases'}. ${pj.license ? `Licence: ${esc(pj.license)}. ` : 'Its licence is not one GitHub recognises automatically, so check the repository before you rely on it. '}We rate it <b>${esc(pj.health)}</b>. We do not publish comparisons against software that has gone dormant, however good the arithmetic looks.</p>` : ''}

  <div class="provenance">
    <p style="margin-bottom:.5rem">Every number above comes from one of these, on the date shown. ${e.incumbent.quote ? `The ${esc(e.incumbent.vendor)} figure is the site's own wording: &ldquo;${esc(e.incumbent.quote)}&rdquo;.` : ''}</p>
    <table>${provenanceTable(e)}</table>
    <p style="margin-top:.7rem">Hosting requirements (${e.alternative.requirements.vcpu || 1} vCPU, ${e.alternative.requirements.ram_gb} GB RAM, ${e.alternative.requirements.disk_gb} GB disk), migration hours and maintenance hours are our estimates, not measurements. They are the numbers most worth arguing with, so we put them where you can see them. The cheapest plan meeting those requirements is selected automatically from ${esc(e.alternative.box.provider)}, Vultr and Linode's live catalogues.</p>
    <p><a href="${u(`/api/escapes/${esc(e.slug)}.json`)}">This comparison as JSON</a></p>
  </div>
</article>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: e.title,
    description: e.summary,
    datePublished: e.updated_at,
    dateModified: e.updated_at,
    author: { '@type': 'Organization', name: SITE_NAME },
    publisher: { '@type': 'Organization', name: SITE_NAME },
    mainEntityOfPage: `${siteUrl}/e/${e.slug}/`,
    about: [
      { '@type': 'SoftwareApplication', name: `${e.incumbent.vendor} ${e.incumbent.plan}`, applicationCategory: e.category,
        offers: { '@type': 'Offer', price: e.incumbent.amount, priceCurrency: 'USD', priceValidUntil: e.incumbent.verified_at } },
      { '@type': 'SoftwareApplication', name: altShort, applicationCategory: e.category, ...(pj ? { url: pj.url } : {}) },
    ],
  };

  return layout({
    title: `${e.title} — ${SITE_NAME}`,
    description: e.summary,
    canonical: `${siteUrl}/e/${e.slug}/`,
    body,
    jsonld,
    scripts: `<script type="application/json" id="escape-model">${JSON.stringify(model)}</script>
<script src="${u('/assets/linear.js')}"></script>
<script src="${u('/assets/chart.js')}"></script>
<script src="${u('/assets/page.js')}"></script>`,
  });
}

/* -------------------------------------------------------------- index page */

function indexPage(index, siteUrl) {
  const byVerdict = { switch: [], marginal: [], stay: [] };
  for (const e of index.escapes) byVerdict[e.verdict].push(e);

  // The crossover rate is the headline number, so it should order the list.
  // Among the ones worth leaving, the most compelling case leads; among the ones
  // to keep paying for, the most hopeless leads, which is the more useful read.
  const rate = (e) => (e.break_even_hourly_rate === null ? -Infinity : e.break_even_hourly_rate);
  byVerdict.switch.sort((a, b) => rate(b) - rate(a) || a.slug.localeCompare(b.slug));
  byVerdict.marginal.sort((a, b) => rate(b) - rate(a) || a.slug.localeCompare(b.slug));
  byVerdict.stay.sort((a, b) => rate(a) - rate(b) || a.slug.localeCompare(b.slug));

  const row = (e) => {
    const alt = e.alternative.replace(/ \(self-hosted\)$/, '');
    const x = e.break_even_hourly_rate;
    const num = x === null || x < 0 ? '—' : money(x, 2);
    return `<li><a href="${u(`/e/${esc(e.slug)}/`)}">
      <span class="idx-title">${esc(e.incumbent)} ${esc(e.incumbent_plan)} &rarr; ${esc(alt)}</span>
      <span class="idx-sub">${plural(e.seats, 'seat', 'seats')} · ${money(e.incumbent_annual, 0)}/yr now · ${money(e.alternative_annual, 0)}/yr self-hosted</span>
      <span class="idx-num">${num}<span class="idx-verdict v-${e.verdict}-t">${e.verdict === 'switch' ? 'switch' : e.verdict === 'stay' ? 'stay' : 'marginal'}</span></span>
    </a></li>`;
  };

  const section = (title, list, blurb) => list.length ? `
    <p class="section-head">${title}</p>
    <p class="measure muted small" style="margin-top:-.1rem">${blurb}</p>
    <ul class="index-list">${list.map(row).join('')}</ul>` : '';

  const body = `
<div class="standfirst">
  <h1 class="measure">What it really costs to leave a subscription.</h1>
  <p class="dek measure">Self-hosting advocates leave out the expensive part: your own time.
  Every comparison here charges it, and publishes the hourly rate at which the answer flips.</p>
  <p class="measure">Right now ${byVerdict.stay.length} of these ${index.escapes.length} comparisons conclude you should
  keep paying the subscription. Those are the ones that make the rest worth reading.</p>
</div>

${section('Worth leaving', byVerdict.switch, 'The number on the right is what your hour would have to be worth before staying becomes the better deal.')}
${section('Close enough to be a coin toss', byVerdict.marginal, 'Technically cheaper. Probably not worth the disruption.')}
${section('Keep paying', byVerdict.stay, 'The arithmetic says stay. In most of these the subscription is simply cheaper than the box plus the hours.')}

<p class="section-head">How to read the number</p>
<p class="measure">The figure beside each comparison is its <b>break-even hourly rate</b> — the value of your
own time at which switching stops paying. If your hour is worth less than that, self-hosting wins.
If it is worth more, you are better off paying the subscription and spending the time on something
else. On a dash, self-hosting costs more in cash alone and no hourly rate rescues it.</p>
<p class="measure">Every page shows the working: what you pay now, what the escape costs, what
we assumed about your hours, and the date each price was last verified.
<a href="${u('/method/')}">How we count</a>.</p>`;

  return layout({
    title: `${SITE_NAME} — ${TAGLINE}`,
    description: 'The real, fully-loaded cost of leaving a SaaS subscription — including your own time. Live pricing, verified dates, and the comparisons where staying is the right answer.',
    canonical: `${siteUrl}/`,
    body,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: siteUrl, description: TAGLINE,
    },
  });
}

/* ------------------------------------------------------------- method page */

function methodPage(index, siteUrl) {
  const body = `
<div class="standfirst">
  <h1 class="measure">How we count</h1>
  <p class="dek measure">The arithmetic is simple. The honesty is in what gets included.</p>
</div>

<p class="section-head">Your time is a cost</p>
<p class="measure">Almost every self-hosting comparison comes down to "$240 a year versus $60 a year,
so obviously self-host". That is only true if your time is free. It is not, so we charge it: the hours
to migrate, and the hours each month to keep the thing patched, backed up and running. Then we solve
for the hourly rate at which the two totals meet. That rate is the headline number on every page,
and it is the one figure here you will not find anywhere else.</p>

<p class="section-head">Where the prices come from</p>
<p class="measure">Hosting prices come straight from Vultr's and Linode's public plan catalogues,
refreshed nightly. The cheapest plan that meets the stated requirements is chosen automatically —
we do not pick the provider by hand, and we do not pick the one that pays best.</p>
<p class="measure">SaaS list prices are verified by hand against the vendor's own pricing page, and
each one is stored with the exact sentence that justifies it. A nightly job re-reads those pages and
compares what it finds against what we stored. If they agree, the verification date moves forward.
If they disagree, the stored price does <em>not</em> change — the page is flagged and a human
re-checks it. A collector that fails keeps the last known value and marks it stale.</p>

<p class="section-head">What we refuse to do</p>
<ul class="caveats measure">
  <li>We never publish a number we could not verify. If a price cannot be confirmed, the comparison
  goes stale and comes down rather than going out with a guess.</li>
  <li>We never claim self-hosting is always cheaper. ${index.escapes.filter((e) => e.verdict === 'stay').length}
  of the ${index.escapes.length} comparisons on this site conclude that you should keep paying.</li>
  <li>We never recommend software that has stopped moving. If the upstream project goes dormant or
  gets archived, the comparison is pulled regardless of how good the price looks.</li>
  <li>Affiliate relationships never touch the arithmetic. Provider selection is automated and the
  code is the same for every comparison.</li>
</ul>

<p class="section-head">What is an estimate</p>
<p class="measure">Three inputs are our judgement rather than a measurement: the size of box each
piece of software needs, the hours to migrate, and the hours per month to maintain it. We set them
conservatively — biased toward the subscription — because the worst thing this site could do is talk
someone into a migration that never paid off. They are printed on every page so you can disagree with
them, and the slider lets you test how much they matter.</p>

<p class="section-head">Your team size decides most of it</p>
<p class="measure">A per-seat subscription scales with headcount; a server does not care how many
people use it. That single fact decides most of these comparisons, which is why every page with a
per-seat incumbent lets you set your own team size rather than fixing one. The same comparison can
honestly say "obviously switch" at twenty people and "obviously stay" at two, and a page that
picked one number for you would be wrong for nearly everyone reading it.</p>
<p class="measure">Each page also states the team size at which switching starts to pay at your
hourly rate — usually the more actionable of the two numbers, because "worth doing once you are
past six people" is a decision you can make today.</p>

<p class="section-head">Horizon and assumptions</p>
<ul class="caveats measure">
  <li>Costs are compared over 36 months unless a page says otherwise.</li>
  <li>Migration and maintenance hours do not scale with team size. Moving twenty people off Notion
  is not twice the work of moving ten, and pretending otherwise would flatter the subscription.</li>
  <li>Prices are US list prices, in USD, excluding tax.</li>
  <li>Annual-billing discounts are used where the vendor offers them, since that is the cheaper
  honest comparison for the subscription.</li>
  <li>No discounting of future cash flows. Over three years at these amounts it would change the
  conclusions by less than the error in our hour estimates.</li>
  <li>One server, no redundancy. A high-availability self-hosted deployment costs considerably more
  and would lose most of these comparisons.</li>
</ul>

<p class="section-head">Use the data</p>
<p class="measure">Every comparison is available as JSON, with the same provenance the pages carry.
It is free to use, including commercially, with attribution.
<a href="${u('/api/index.json')}">Start here</a>.</p>`;

  return layout({
    title: `How we count — ${SITE_NAME}`,
    description: 'The method behind Exit Cost: charging your own time, verifying every price, and refusing to publish numbers we could not confirm.',
    canonical: `${siteUrl}/method/`,
    body,
  });
}

/* -------------------------------------------------------------------- main */

function main() {
  const siteUrl = (process.env.SITE_URL || 'https://nimbussage.github.io/exit-cost').replace(/\/$/, '');
  BASE = new URL(siteUrl).pathname.replace(/\/$/, '');
  loadAffiliates();
  const index = readJson(p('data', 'build', 'index.json'));
  if (!index) { console.error('FATAL: no data/build/index.json. Run `npm run build:data` first.'); process.exit(1); }

  const escapes = listJson(p('data', 'build', 'escapes')).map((f) => readJson(f)).filter(Boolean);
  if (!escapes.length) { console.error('FATAL: no built escapes to publish.'); process.exit(1); }

  fs.rmSync(DIST, { recursive: true, force: true });
  copyDir(path.join(__dirname, 'assets'), path.join(DIST, 'assets'));
  fs.copyFileSync(p('pipeline', 'compute', 'linear.js'), path.join(DIST, 'assets', 'linear.js'));

  write('index.html', indexPage(index, siteUrl));
  write('method/index.html', methodPage(index, siteUrl));
  for (const e of escapes) write(`e/${e.slug}/index.html`, escapePage(e, siteUrl));

  // Public JSON API — the point of it is to be citeable and linkable.
  write('api/index.json', JSON.stringify({
    name: SITE_NAME, description: TAGLINE, url: siteUrl,
    licence: 'CC BY 4.0 — free to use with attribution',
    generated_at: index.generated_at,
    method: `${siteUrl}/method/`,
    count: escapes.length,
    escapes: index.escapes.map((e) => ({ ...e, url: `${siteUrl}/e/${e.slug}/`, json: `${siteUrl}/api/escapes/${e.slug}.json` })),
  }, null, 2));
  for (const e of escapes) write(`api/escapes/${e.slug}.json`, JSON.stringify(e, null, 2));

  const urls = ['/', '/method/', ...escapes.map((e) => `/e/${e.slug}/`)];
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${siteUrl}${u}</loc><lastmod>${index.day}</lastmod></url>`).join('\n')}
</urlset>`);
  write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
  write('.nojekyll', '');

  const files = urls.length + escapes.length + 4;
  console.log(`site built: ${escapes.length} comparisons, ${files} files -> site/dist`);
  console.log(`   ${siteUrl}`);
  return { files, escapes: escapes.length };
}

if (require.main === module) main();
module.exports = { main, layout, escapePage, indexPage };
