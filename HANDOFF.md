# Handoff

Read this first if you are picking this up cold. It is the state of things, the
rules that are not obvious from the code, and the traps that have already cost
time. `README.md` is the pitch; this is the operating manual.

Last updated: 2026-09-21, day 22.

---

## What this is

Exit Cost computes the real cost of leaving a SaaS subscription, **including the
operator's own time**, and publishes the hourly rate at which the answer flips.
That rate is the only original thing here; everything else is plumbing around it.

Live: https://nimbussage.github.io/exit-cost/ · Repo: NimbusSage/exit-cost

The goal is $100/day with near-zero operating cost. It is not there. It earns
through one referral programme and has no measured traffic yet.

---

## State

| | |
|---|---|
| Comparisons live | 30 — 19 switch, 1 marginal, 10 stay |
| Tests | 253, all passing (`npm test`) |
| Preflight | 8/8 (`npm run verify`) |
| Unattended nightly runs | 22 consecutive days, zero drift |
| Prices self-confirming | 20 of 21 |
| Revenue | Vultr referral on 23 pages. Nothing else. |
| Traffic | Unmeasured. Search Console verified, no data yet. |
| Deployment kits | 3, each deployed and verified by running it |
| Videos | 30 rendered, none published |

Gate 1 (30 comparisons + 7 unattended days) is met. Gates 2–4 depend on traffic
and cannot be evaluated.

---

## What runs without anyone

- **Nightly 05:17 UTC** (`.github/workflows/publish.yml`) — refresh every
  hosting catalogue and vendor pricing page, rebuild, redeploy, then smoke-test
  the live site and fail loudly if it broke. Commits refreshed prices back, which
  is the audit trail.
- **Mondays 14:00 UTC** (`.github/workflows/report.yml`) — files the weekly
  report as a GitHub issue, which emails the owner.

If you change anything that affects published numbers, run `npm test &&
npm run verify` before pushing. CI runs both anyway.

---

## Blocked on a human

1. **YouTube consent.** `ops/youtube-auth.mjs` must be run on a machine with a
   browser; a loopback redirect cannot reach a headless server. It prints a
   refresh token for `YOUTUBE_REFRESH_TOKEN`. Until then nothing can be
   published. `pipeline/publish/youtube.js` is built and waiting.
2. **The music bed's licence.** `video/assets/bgm/LICENCE.json` is marked
   UNCONFIRMED and `blocks_public_release: true`. Do not publish a video using
   it until the source is confirmed.
3. **Analytics.** Search Console is verified but has no data. Gates 2 and 3 are
   unanswerable until it does.

---

## Rules that are not negotiable

Enforced by tests, not convention. Do not weaken them to make something pass.

- A collector that fails keeps the last known value and **never** advances
  `verified_at`.
- An unknown cost makes a comparison refuse to compute rather than approximate.
- Prices past their freshness window do not publish.
- A dormant or archived upstream project blocks publication regardless of price.
- Affiliate links never touch provider selection. That is a pure function of
  price and requirements, and `test/affiliates.test.js` asserts the published
  numbers are byte-identical with and without a programme active.
- If every comparison ever says "switch", `ops/verify.js` fails the build. A
  site where self-hosting always wins is an advert, not a comparison.
- Never state a URL, price or programme term that has not been fetched in this
  session. Four invented affiliate URLs cost a day.

---

## Traps that have actually bitten

Each of these cost real time. They are pinned by regression tests; if a test
here looks strange, this is why.

- **"Billed annually" is a cadence, not a unit.** "$20 per seat/month, billed
  annually" is $20 a *month*. Reading it as yearly is a 12x error.
- **A price belongs to the last plan name before it.** Any window that searches
  backwards lets a "contact sales" tier inherit the price above it. In the
  PikaPods catalogue the price *follows* its app — reading the preceding one
  shifts every price by a row.
- **The extractor needs the page's other tier names**, not just the plans we
  store, or untracked tiers bleed their prices into tracked ones
  (`page_plan_names` in `data/saas.json`).
- **Some vendors never state a field near the price.** Vercel's headline omits
  that it is per developer seat. A plan declares `check_ignores` with an
  `extraction_note`; the amount itself can never be exempt.
- **`pg_isready` lies during startup.** It answers yes to the temporary
  postmaster `initdb` runs, so a healthcheck goes green before the database
  exists. Query the database instead.
- **One failed fetch must not erase a provider.** It did, and took the only
  revenue link off every page while everything looked healthy. Exclusion is by
  `verified_at` age, never by "the last fetch failed".
- **HTTP 200 is not evidence a deploy works.** A deploy once returned 200 on
  every URL while serving a completely unstyled page. `ops/smoke.js` follows the
  live page's own references.
- **`site/build.js` clears `dist/` every run.** Root-level files that must
  survive (search-engine verification) go in `site/static/`.
- **Test files run in parallel and two of them build the site.** Each builds
  into its own temp directory via `EXITCOST_DIST`.
- **`p()` in `pipeline/lib/store.js` joins against the repo root.** Passing it an
  absolute path writes to a nested duplicate tree.
- **A detached shell does not source nvm.** `nohup node video/build.js --render`
  ran on Node 18, every render failed, and the script exited 0 — leaving thirty
  stale videos that looked freshly built. Batch renders now check their own
  runtime and exit non-zero on any failure. Background anything long as:
  `. "$HOME/.nvm/nvm.sh" && nvm use 22 && …`

---

## Things that are true and easy to get wrong

- **DigitalOcean pricing needs no account.** It is read from their public
  pricing page. A token is preferred if one exists but is not required.
- **Hetzner is unavailable** — pricing is not extractable without an account,
  and they have no affiliate programme, so it costs accuracy and no revenue.
- **The DigitalOcean affiliate application was rejected**, most likely because
  the AWIN publisher account is registered as InferHaven, which is a competitor.
  Do not reapply under that profile.
- **The affiliate layer for this audience is genuinely thin.** That is tested,
  not assumed — see `data/affiliates.json` `_research`. The deployment kits and
  the managed-hosting column are the better revenue paths.
- **Do not run a kit's `install.sh` on the workstation.** It enables `ufw` and
  would cut the owner's tmux sessions.
- **Docker works here** (LXC, nesting already enabled, overlayfs). Kits are
  validated by deploying them, not by reading them.

---

## Where decisions are recorded

- `data/affiliates.json` — every programme, its status, and why. Includes the
  research that ruled programmes out, so it is not repeated.
- `data/saas.json` — every price with the sentence from the vendor page that
  justifies it, plus any declared unverifiable fields and why.
- `kits/apps/*.json` — each kit's spec and a `validated` block recording what
  was actually run and what was not.
- `video/assets/bgm/LICENCE.json` — provenance for the music bed.
- Commit messages. They explain *why*, including the bugs found and what they
  cost. `git log` is the design history.

---

## If you are wondering what to do next

In rough order of value:

1. Nothing, if the owner has not unblocked YouTube. Publishing is the next real
   step and it needs their consent run.
2. More comparisons. Search surface is the binding constraint. Use
   `ops/price-probe.js` to research a vendor, read the quoted context yourself,
   and store the price by hand — never wire extraction straight into the dataset.
3. More kits, validated by deploying them. `kits/build.js --verify` checks every
   pinned image tag against the registry.
4. Do not build more tooling. There is enough. The constraint is traffic and
   revenue, not capability.
