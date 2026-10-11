# Expansion & monetization research — 2026-10-11

Research-only session. Nothing in `data/saas.json` or any escape file was touched; everything below
is a candidate list for you to green-light or veto before any write. URLs listed here have been
fetched at least once today; prices are not recorded here because the site's rule is that only a
human write into saas.json (via the quote path). This file is the shortlist.

## Part 1: candidate vendors with crawlable pricing

Existing coverage (30 escapes across 12 incumbent vendors): notion, airtable, zapier, auth0,
calendly, 1password, docusign, vercel, plausible, todoist, miro, chatwoot-cloud. The biggest cost
buckets a real team pays are still missing, and the ones below passed a fetch test (200, prices in
HTML, either human-readable or schema.org machine-readable):

| Vendor | Category | Notes for the escape build |
|---|---|---|
| Slack (`/pricing`) | chat | $7.25/$15 per user/mo annual — biggest monthly bill per seat in the index; self-hosted pairing is Rocket.Chat or Zulip/Mattermost. Cookie-walled but prices in the HTML curl got. |
| monday.com (`/pricing`) | project mgmt | $9–$19 per seat annual; pair with Focalboard/Vikunja/Leantime. |
| Asana (`/pricing`) | project mgmt | $10.99 Starter / $24.99 Advanced annual; same self-host pool as monday. |
| ClickUp (`/pricing`) | project mgmt | $7/$12 per user annual. |
| Jira (atlassian.com) | ticket/PM | Machine-readable schema.org prices ($7.91 Standard, $14.54 Premium per user/mo) — cheapest to collect reliably. Pair with OpenProject/Plane/Redmine. |
| Sentry (`/pricing`) | error tracking | $26 Team / $80 Business per month; natural pairing with self-hosted GlitchTip/Sentry-CE. |
| Figma (`/pricing/`) | design | $3 Colab seat, $16/$45 per editor annual; pair with Penpot. Biggest TOC argument in the whole space. |
| Dropbox (`/pricing`) | file sync | Pair with Nextcloud. Cookie-walled but 200 OK. |
| 1Password Teams Starter | already have 1P; just add the `Teams Starter` plan rows. |
| Intercom (`/pricing/`) | support | Pair with existing Chatwoot escape, or use as a second support-inbox incumbent. |
| Zendesk (`/pricing/`) | support | Prices 403 through curl (Cloudflare) — still eligible if a browser fetch works. |
| Mailchimp/HubSpot/Twilio/SendGrid | email/CRM/comms | Public prices but usage-based; only viable with the "floor price" caveat the site already uses for Zapier. |

Deliberately screened out this round (worth retrying only if a fetch path changes): box.com (403
Cloudflare), zendesk (403), freshworks (404 at the tested URL), all the "Contact sales"-only
enterprise quotes (Box Enterprise, Zoom Workplace contact-names, etc.).

Open-source replacement catalogue is already rich for most buckets: Rocket.Chat, Mattermost, Zulip,
Matrix/Element, OpenProject, Plane, Focalboard, GlitchTip, Penpot, Nextcloud, Kimai. The gap is not
"no alternative exists", it is "nobody has run the exit-cost math on these". Every candidate also
feeds the OpenStore cross-link engine because most of them already appear in OpenStore's `replaces`
fields.

### Proposed first batch (6 vendors, 12–15 escapes)
Slack, monday, Asana, Jira, Sentry, Figma. Reason: all six pass crawl, they cover chat + PM +
monitoring + design (four untouched categories), OpenStore already lists replacements for each, and
per-seat billing means the same projection plumbing the site already uses for Notion/Airtable
transfers cleanly.

## Part 2: monetization paths beyond Vultr + kits

Ranked by fit with the site's core promise (no sponsored ranking, no price rewriting). Ordered
soonest-payoff first.

1. **Vultr + (future) second hosting affiliate on every escape page** — already live. Keep
   automating via `data/affiliates.json`. Add: Hetzner (10/15% recurring per their partner program),
   DigitalOcean (retry once the site has its own domain and traffic), Backblaze (actively lists
   affiliate terms). Each is a one-line data change.
2. **Kits** — the existing paid-migration-kit product. Bulk up the existing `data/kits.json` path
   with one kit per popular escape rather than one generic kit; the page for `notion-to-appflowy`
   is the natural point of sale.
3. **Data licensing — feed is CC BY 4.0 already; the pay tier is "no attribution, plus API SLA"**.
   Two realistic buyers: OpenStore (uses the prices to enrich its directory), and Vendr-style
   SaaS-procurement trackers who currently hand-copied these numbers. Publish a
   `/api/full.json` (all 30+ escapes, with the raw linear program) and price it up at
   ~$99/mo for commercial-no-attribution + a stable paid endpoint. Requires almost no new code —
   the feed already exists, this is a second render target and a Stripe link.
4. **Sponsored-listing equivalent (strict, non-ranking)**: allow a vendor to pay for a *label*
   ("this comparison maintained by the project") only when the self-hosted side listed is a project
   they sponsor, and only when the price shown is theirs. Labelled, never ranked higher, never
   allowed to influence a verdict. This is how Nomad List and CodeFund kept trust. Risk: even a
   hint of vendor influence destroys the core promise; consider only once there is traffic and only
   via a " Foundations" page the reader can ignore.
5. **GitHub Sponsors page** with a "what the money pays for" line item per tier (e.g. "$5 = one
   nightly VPS price refresh"). Cheap to set up, converts the technical audience, no trust cost.
   Being a data-aggregation site, it reads more like a public-good plea than a sales funnel, which
   is fine.
6. **Consulting / migration-as-a-service referral** — you have the migration-hours estimate for
   every escape; if a visitor says "I want this done, not just priced", route them to a small
   fee-share network of self-hosting consultancies, or to PikaPods/CapRover-hosted managed offers.
   Highest per-lead value, lowest volume; measure demand via the existing "how long does migration
   really take" question in the smoke checks.
7. **Not worth pursuing now**: programmatic ads (destroys the promise), "premium plan" gating
   content (the site's price is transparency itself), selling user data (never).

### OpenStore revenue angle (found this session)
OpenStore is 5 days old, has no pricing data, and Pull from our `/api/openstore.json` feed.
Composition entry: if they launch a paid tier, ExitCost is a natural free-data partner; if not, the
cross-links are still the win. `ops/openstore-outreach.md` already holds this — no new prep needed.

### Autonomous/agentic-loop near-term steps
The pipeline already runs itself: nightly collect → build → verify → publish, fail-safe on every
fetch, committed as an audit-trail. The two things still missing for a "close to perfect for full
production" agentic loop are:
- a llm-driven curation agent that screens new escape candidates against the same keep rules used
  above (public pricing, human-verified quote, no price rewriting) — 20 lines of prompt mostly
  lifted from this file's Part 1 table; and
- a human-in-the-loop step that watches `last_check_ok` and `needs_reverification` rows so that when
  prices drift past the 45-day freshness window, a single review PR re-verifies instead of silently
  dropping escapes from the site.
Both slot into the existing `pipeline/collect/index.js` → `site/build.js` path with no new
infrastructure.

## Recommended sequencing
This week: batch 1 escapes (Slack, monday, Asana, Jira, Sentry, Figma) + Vultr/Hetzner affiliate.
Next: Sponsors page, then decide between the paid-API tier and the "kit-per-escape" deepening.
