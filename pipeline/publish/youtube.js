#!/usr/bin/env node
/**
 * youtube.js — publish a rendered short to the Exit Cost channel.
 *
 * Needs GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and
 * YOUTUBE_REFRESH_TOKEN. The refresh token comes from ops/youtube-auth.mjs,
 * which is run once on a human's own machine.
 *
 * Refuses to publish a comparison the site itself would not publish, and
 * refuses to publish the same one twice. Uploads are unlisted by default:
 * nothing goes public without someone saying so.
 *
 *   node pipeline/publish/youtube.js --dry-run          what it would post
 *   node pipeline/publish/youtube.js <slug>             publish one
 *   node pipeline/publish/youtube.js --next             the best unpublished one
 */

const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, p } = require('../lib/store.js');

const STATE = p('data', 'sources', 'published-videos.json');
const VIDEO_DIR = p('video', 'out');
const SITE = process.env.SITE_URL || 'https://nimbussage.github.io/exit-cost';

const money = (n, dp = 0) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/* ------------------------------------------------------------- metadata */

/**
 * The title is the whole hook. It gets one line in a feed, so it leads with the
 * two numbers and nothing else — no "watch this", no question mark.
 */
function buildMetadata(e) {
  const r = e.result;
  const alt = e.alternative.name.replace(/ \(self-hosted\)$/, '');
  const inc = `${e.incumbent.vendor} ${e.incumbent.plan}`;
  const seats = r.inputs.seats;
  const x = r.break_even_hourly_rate;

  const title = r.verdict === 'stay'
    ? `${inc} is ${money(r.incumbent.annual)}/yr. Self-hosting ${alt} costs more.`
    : `${inc} is ${money(r.incumbent.annual)}/yr. ${alt} is ${money(r.alternative.annual)}.`;

  const verdictLine = r.verdict === 'stay'
    ? `Our verdict: keep paying. Running ${alt} yourself costs ${money(Math.abs(r.savings.at_horizon))} MORE over three years once your hours are counted.`
    : `Our verdict: worth leaving — it saves ${money(r.savings.at_horizon)} over three years, and breaks even in month ${r.break_even_month}.`;

  const crossLine = (x === null || x < 0)
    ? `There is no hourly rate at which this one pays off.`
    : `It only pays off if an hour of your time is worth less than ${money(x, 2)}.`;

  const description = [
    `${inc}${e.incumbent.per_seat ? `, ${seats} seats` : ''}: ${money(r.incumbent.annual)} a year.`,
    `${alt}, self-hosted: ${money(r.alternative.annual)} a year, all in.`,
    ``,
    verdictLine,
    crossLine,
    ``,
    `Most comparisons like this quietly assume your time is free. This one charges it — ${e.alternative.migration_hours} hours to migrate and ${e.alternative.maintenance_hours_per_month} hours a month to keep it patched and backed up.`,
    ``,
    e.managed ? `There is also a third option: ${e.managed.provider} runs ${e.managed.app} for you from ${money(e.managed.monthly_usd, 2)}/month, with no upkeep hours at all.\n` : ``,
    `Full working, with sliders for your own hourly rate and team size:`,
    `${SITE}/e/${e.slug}/`,
    ``,
    `Every price is verified against the vendor's own page and dated. ${e.incumbent.vendor} price confirmed ${e.incumbent.verified_at}. Hosting from ${e.alternative.box.provider}'s live catalogue.`,
    ``,
    `All 30 comparisons, and the open data behind them: ${SITE}`,
    ``,
    `Some hosting links on the site are referral links. They never affect which provider is recommended — that is chosen on price alone.`,
  ].filter((l) => l !== undefined).join('\n');

  const tags = [
    'self hosting', 'selfhosted', 'saas', e.incumbent.vendor.toLowerCase(), alt.toLowerCase(),
    `${e.incumbent.vendor.toLowerCase()} alternative`, 'open source', 'cost comparison',
    'total cost of ownership', e.category,
  ].filter(Boolean).slice(0, 12);

  return {
    snippet: {
      title: title.length > 100 ? title.slice(0, 97) + '…' : title,
      description: description.slice(0, 4900),
      tags,
      categoryId: '28',          // Science & Technology
      defaultLanguage: 'en',
    },
    status: {
      privacyStatus: process.env.YOUTUBE_PRIVACY || 'unlisted',
      selfDeclaredMadeForKids: false,
      embeddable: true,
    },
  };
}

/* ------------------------------------------------------------- selection */

/**
 * Does the rendered video still show the numbers the data now holds?
 *
 * Videos are rendered once and the prices move underneath them. A short quoting
 * last month's figure, with a description quoting this month's, is the same
 * failure as publishing an unverified price — except it is on YouTube forever
 * and cannot be quietly corrected.
 */
function videoMatchesData(e) {
  const html = path.join(VIDEO_DIR, e.slug, 'index.html');
  if (!fs.existsSync(html)) return { ok: false, why: 'the composition it was rendered from is gone' };
  const src = fs.readFileSync(html, 'utf8');
  const money0 = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  const checks = [
    ['the subscription cost', money0(e.result.incumbent.annual)],
    ['the self-hosted cost', money0(e.result.alternative.cash_monthly * 12)],
  ];
  for (const [what, want] of checks) {
    if (!src.includes(want)) return { ok: false, why: `${what} has changed to ${want} since it was rendered` };
  }
  return { ok: true };
}

function candidates() {
  const published = readJson(STATE, { videos: {} }).videos || {};
  const out = [];
  for (const f of fs.readdirSync(p('data', 'build', 'escapes'))) {
    const e = readJson(p('data', 'build', 'escapes', f));
    if (!e) continue;
    const mp4 = path.join(VIDEO_DIR, `${e.slug}.mp4`);
    if (!fs.existsSync(mp4)) continue;
    if (e.freshness?.state === 'stale' || e.freshness?.state === 'undated') continue;
    const match = videoMatchesData(e);
    if (!match.ok) { out.push({ e, mp4, blocked: match.why, alreadyPublished: !!published[e.slug] }); continue; }
    out.push({ e, mp4, alreadyPublished: !!published[e.slug] });
  }
  // The biggest annual figure is the strongest hook, so it goes first.
  return out.sort((a, b) => b.e.result.incumbent.annual - a.e.result.incumbent.annual);
}

/* ---------------------------------------------------------------- upload */

async function accessToken() {
  const { GOOGLE_OAUTH_CLIENT_ID: id, GOOGLE_OAUTH_CLIENT_SECRET: secret, YOUTUBE_REFRESH_TOKEN: refresh } = process.env;
  if (!id || !secret || !refresh) {
    throw new Error('missing GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET or YOUTUBE_REFRESH_TOKEN');
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`token refresh failed: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function upload(mp4, metadata) {
  const token = await accessToken();
  const body = fs.readFileSync(mp4);

  // Resumable, because a failed simple upload gives you nothing to retry from.
  const start = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(body.length),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify(metadata),
    });
  if (!start.ok) throw new Error(`initiate failed: ${start.status} ${await start.text()}`);
  const location = start.headers.get('location');
  if (!location) throw new Error('no upload URL returned');

  const put = await fetch(location, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) },
    body,
  });
  if (!put.ok) throw new Error(`upload failed: ${put.status} ${await put.text()}`);
  return put.json();
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const next = args.includes('--next');
  const slug = args.find((a) => !a.startsWith('--'));

  const all = candidates();
  if (!all.length) { console.error('nothing to publish: no rendered video matches a fresh comparison'); process.exit(1); }

  let picks;
  if (slug) picks = all.filter((c) => c.e.slug === slug);
  else if (next) picks = all.filter((c) => !c.alreadyPublished && !c.blocked).slice(0, 1);
  else picks = all.slice(0, dry ? 3 : 0);

  if (!picks.length) { console.log('nothing to do — everything rendered has been published'); return; }

  for (const { e, mp4, alreadyPublished, blocked } of picks) {
    if (blocked) {
      console.log(`\n── ${e.slug}  BLOCKED — ${blocked}`);
      console.log('   re-render it before publishing: node video/build.js ' + e.slug + ' --render');
      if (!dry) continue;
      continue;
    }
    const meta = buildMetadata(e);
    if (dry) {
      console.log(`\n── ${e.slug} ${alreadyPublished ? '(already published)' : ''}`);
      console.log(`file        ${path.relative(process.cwd(), mp4)} (${Math.round(fs.statSync(mp4).size / 1024)} KB)`);
      console.log(`privacy     ${meta.status.privacyStatus}`);
      console.log(`title (${String(meta.snippet.title.length).padStart(2)}) ${meta.snippet.title}`);
      console.log(`tags        ${meta.snippet.tags.join(', ')}`);
      console.log(`description\n${meta.snippet.description.split('\n').map((l) => '  ' + l).join('\n')}`);
      continue;
    }
    if (alreadyPublished) { console.log(`${e.slug}: already published, skipping`); continue; }

    console.log(`uploading ${e.slug} …`);
    const res = await upload(mp4, meta);
    const state = readJson(STATE, { videos: {} });
    state.videos = state.videos || {};
    state.videos[e.slug] = { id: res.id, url: `https://youtu.be/${res.id}`, published_at: new Date().toISOString(), privacy: meta.status.privacyStatus };
    writeJson(STATE, state);
    console.log(`  https://youtu.be/${res.id}  (${meta.status.privacyStatus})`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { buildMetadata, candidates };
