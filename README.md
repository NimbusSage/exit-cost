# Exit Cost

**What it really costs to leave a SaaS subscription — including your own time.**

[nimbussage.github.io/exit-cost](https://nimbussage.github.io/exit-cost/) · [open data](https://nimbussage.github.io/exit-cost/data/) · [method](https://nimbussage.github.io/exit-cost/method/)

Most self-hosting comparisons come down to *"$240 a year versus $60 a year, so obviously
self-host"*. That is only true if your time is free. It is not, so this project charges it — the
hours to migrate, and the hours each month to keep the thing patched, backed up and running — and
then solves for the rate at which the two totals meet.

That rate is the number this exists to publish:

> Self-hosting Keycloak beats Auth0 Essentials **only if your hour is worth less than $6.86**.
>
> Self-hosting Outline instead of Notion Business, for ten people, is worth it **unless your hour is
> worth more than $262.79**.

Nobody else publishes it, and it is a more useful answer than a savings figure — because the honest
answer depends on who is asking.

## What makes it different

**It tells you to keep paying, often.** A third of the comparisons here conclude that the
subscription is the better deal. A site where every comparison recommends switching is not a
comparison site, it is an advert — there is a test that fails the build if that ever happens.

**It has a third column.** Keep paying, run a server yourself, or let somebody else run the same
open-source software. That middle option changes the verdict on four comparisons, and without it
those readers get told to keep paying when the honest answer is €3 a month to a managed host.

**Every price carries its provenance.** Not just a date — the exact sentence from the vendor's
pricing page that justifies the number. Hosting prices come from live provider catalogues, refreshed
nightly. Subscription prices are verified by hand; a nightly job re-reads the vendor's page and can
confirm a stored price, but it can never rewrite one.

**Stale data does not publish.** A page is only as fresh as its stalest number. If a price cannot be
confirmed, the comparison comes down rather than going out with a guess.

**The hours are stated, not hidden.** How big a box each application needs, how long the migration
takes, how much upkeep it wants — these are judgements, not measurements. They are printed on every
page so you can disagree with them, and both the hourly rate and the team size are sliders so you can
test how much they matter.

## Use the data

Free to use, including commercially, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Rebuilt nightly.

| | |
|---|---|
| [`dataset.json`](https://nimbussage.github.io/exit-cost/api/dataset.json) | Everything in one file, with provenance and assumptions |
| [`escapes.csv`](https://nimbussage.github.io/exit-cost/api/escapes.csv) | One flat row per comparison |
| [`index.json`](https://nimbussage.github.io/exit-cost/api/index.json) | Summary of each comparison |
| [`escapes/<slug>.json`](https://nimbussage.github.io/exit-cost/api/escapes/notion-to-outline.json) | One comparison in full, including its cost curve |

If a number here is wrong, [open an issue](https://github.com/NimbusSage/exit-cost/issues) — we would
rather hear it from you than keep publishing it.

## How it is built

```
data/escapes/*.json     one comparison each — the dataset
data/saas.json          human-verified subscription prices, each with a source quote
data/storage.json       object-storage rates
data/affiliates.json    referral links, applied to outbound links only
data/sources/           collector output: VPS catalogues, project health, managed hosting
pipeline/collect/       fetchers — no business logic
pipeline/compute/       tco.js is the arithmetic; linear.js is the same closed form, for the browser
pipeline/render/        produces the page models everything else renders
site/                   zero-dependency static generator
kits/                   Exit Kits — deployable stacks with a verified restore drill
ops/                    scheduled jobs, the weekly report, preflight, audit
```

```sh
nvm use              # Node 22
npm test             # the arithmetic and every integrity rule
npm run collect      # refresh live pricing
npm run build:data   # resolve every comparison
npm run site         # build the site
npm run verify       # preflight — refuses to publish stale or unverified data
```

The arithmetic is one module, `pipeline/compute/tco.js`. The browser recomputes each page as you move
the sliders using `linear.js`, which is the same closed form rather than a second implementation, and
a test cross-checks the two across a grid of hourly rates and team sizes. That test has already
caught a real bug in the server model.

## The rules, enforced by tests

- A collector that fails keeps the last known value and **never** advances `verified_at`.
- An unknown cost makes a comparison refuse to compute rather than approximate.
- A dormant or archived upstream project blocks publication regardless of price.
- Affiliate links never touch provider selection — that is a pure function of price and
  requirements, and a test asserts the published numbers are identical with and without one.
- If every comparison says switch, the build fails.

## Licence

Code MIT. Data CC BY 4.0. Not affiliated with any vendor compared here; some outbound hosting links
are referral links, disclosed on every page.
