# Setup — what still needs you

Everything here needs a human. Nothing here can be done from the server.

This is the durable version of the status board; it lives in the repo so it
outlasts any chat link. For the technical state of the project see
[HANDOFF.md](HANDOFF.md).

Last updated 2026-09-21, day 22.

---

## Where things stand

| | Status |
|---|---|
| Vultr referral | **Earning.** Live on 23 comparisons. |
| Search Console | **Verified.** No traffic data yet. |
| Logo and channel art | **Ready.** In `brand/`. |
| Videos | **30 rendered**, with music. None published. |
| YouTube consent | **Needs you.** Blocks all publishing. |
| Google OAuth branding | **Needs you.** Two issues, below. |
| DigitalOcean affiliate | **Rejected.** Closed; see HANDOFF.md. |
| DigitalOcean API token | **Delete it.** It was pasted into a chat and we do not use it. |

---

## 1. Google OAuth branding — two issues

### "The website of your home page URL is not registered to you"

This is the real blocker, and it cannot be fixed by editing the site.

Google requires the OAuth home page to be on a **domain you can prove you own**.
`nimbussage.github.io` belongs to GitHub, so you can never prove ownership of
it — verifying the *URL prefix* in Search Console, which you did, is a different
and weaker thing than owning the domain. There is no way through this on a
`github.io` address.

Two ways out:

**A. Buy a domain — recommended.** `exitcost.dev` was available at the time of
writing, about $12–14 a year at Cloudflare Registrar (they sell at cost). Then:

1. Add these DNS records, **grey cloud / DNS-only** — orange-cloud proxying
   breaks GitHub's certificate issuance:

   ```
   A     @    185.199.108.153
   A     @    185.199.109.153
   A     @    185.199.110.153
   A     @    185.199.111.153
   CNAME www  nimbussage.github.io
   ```

   (These are GitHub's published Pages IPs. Re-check them at
   `https://api.github.com/meta` before relying on this note.)
2. In Search Console, add a **Domain** property for the new domain and verify by
   DNS TXT record. A Domain property is what Google's branding check wants.
3. Tell the agent. Migration is one pass: `CNAME` file, `SITE_URL`, rebuild with
   new canonicals and sitemap, enforce HTTPS, re-run the smoke test. The old
   `github.io` URLs keep redirecting.

This also fixes the affiliate problem — a publisher profile on its own domain
reviews far better than a subdomain of someone else's.

**B. Use a subdomain of a domain you already own.** You own `inferhaven.dev`, so
`exitcost.inferhaven.dev` can be verified. Free and immediate. The cost is that
Exit Cost then reads as an InferHaven project, which is plausibly why the
DigitalOcean affiliate application was rejected — their reviewer saw a
competitor. Fine as a stopgap; migrating twice costs more than migrating once.

### "Your privacy policy page does not have sufficient content"

**Fixed.** There is now a real privacy policy at `/privacy/`. The URL you gave
Google pointed at `/data/`, which is the open-dataset page, not a policy.

In the Google Cloud console, set the privacy policy URL to:

```
https://nimbussage.github.io/exit-cost/privacy/
```

…or the equivalent on your new domain, if you take option A. It covers what the
site stores, what GitHub logs, what the referral links do, and — the part Google
actually checks — exactly what the publishing app can and cannot do, including
the Limited Use declaration.

Then choose **"I have fixed the issues"** and request re-verification. Expect
the home-page issue to come back until the domain is sorted.

---

## 2. Authorise the YouTube channel

Two minutes, on your own machine. Until this is done nothing can be published.

```sh
git clone https://github.com/NimbusSage/exit-cost
cd exit-cost
export GOOGLE_OAUTH_CLIENT_ID='...apps.googleusercontent.com'
export GOOGLE_OAUTH_CLIENT_SECRET='...'
node ops/youtube-auth.mjs
```

It opens the consent screen, you approve the Exit Cost channel, and it prints a
refresh token. Add it as a repository secret named exactly
`YOUTUBE_REFRESH_TOKEN` at
<https://github.com/NimbusSage/exit-cost/settings/secrets/actions>, then clear
your terminal scrollback.

It has to run on your machine because Google redirects a Desktop-app client to
`127.0.0.1`, which cannot reach a headless server — and because the token should
never touch the server or a transcript.

The scope requested is upload-only. Uploads default to **unlisted**; nothing
becomes public without someone saying so.

---

## 3. Delete the DigitalOcean API token

<https://cloud.digitalocean.com/account/api/tokens> → the `…` beside it → Delete.

It was pasted into a chat and is therefore in a transcript. We never used it and
do not need it: DigitalOcean pricing is read from their public pricing page, so
there is no account, card or token involved.

---

## 4. Confirm the music licence

`video/assets/bgm/LICENCE.json` is marked `UNCONFIRMED` with
`blocks_public_release: true`.

The bed is cut from `leberch-lofi-hip-hop-519408.mp3`, which you supplied. The
filename follows the Pixabay pattern, and Pixabay's Content License permits
commercial use without attribution — but that is an inference from a filename,
not a verified fact.

Confirm where it came from and, if it is Pixabay or similar, update that file
(`licence`, `verified_at`, `blocks_public_release: false`). **Do not publish a
video using this bed until then.** A copyright claim on a channel with thirty
videos is not worth saving twenty minutes.

---

## 5. Optional — a second channel

The thirty shorts are vertical and work anywhere.

- **TikTok** needs no Facebook Page and is the better fit. Be aware its posting
  API is restrictive for unaudited apps and may only leave a draft you tap to
  publish.
- **Instagram** does need a linked Facebook Page. Lower priority.

YouTube is the one that can be fully automated.

---

## Recurring commitment

One email a week — the report files itself as a GitHub issue every Monday and
leads with anything that needs a person.

Everything else runs on its own: nightly price refresh, rebuild, redeploy and a
smoke test of the live site, twenty-two consecutive days so far.

---

## Still unmeasured

Traffic. Search Console is verified but has no data yet, so Gates 2 and 3 in the
plan cannot be evaluated. Until then the machine runs perfectly and is flying
blind — that is the honest state.
