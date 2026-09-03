# Exit Cost

The real, fully-loaded cost of escaping a subscription.

For each SaaS subscription people resent paying for, this computes what it actually
costs to leave — including the parts self-hosting advocates skip: your time, backups,
maintenance, and migration effort.

## The number that matters

Every comparison publishes a **break-even hourly rate**: the value of your own time at
which the verdict flips. "Self-hosting Keycloak beats Auth0 Essentials only if your time
is worth less than $6.86/hour" is a more useful answer than a savings figure, and it is
the one number nobody else publishes.

## Integrity rules

These are enforced by tests, not by good intentions:

- **Never fabricate a number.** Every price carries a `verified_at` and the exact sentence
  from the vendor's page that justifies it. A collector that fails keeps the last known
  value and marks it stale; it never guesses.
- **Stale data does not publish.** A page is only as fresh as its stalest input.
- **Never claim self-hosting is always cheaper.** Half the current comparisons conclude
  "stay". Those are the ones that make the other half worth reading.
- **Never recommend dead software.** A dormant or archived upstream project blocks
  publication regardless of how good the price looks.

## Layout

```
data/escapes/*.json     one comparison each — the dataset
data/saas.json          human-verified SaaS list prices, each with a source quote
data/storage.json       object-storage rates
data/sources/           collector output (VPS catalogue, project health)
pipeline/collect/       fetchers — no business logic
pipeline/compute/       tco.js is the arithmetic core; resolve.js joins it to live data
pipeline/render/        build.js produces the page models everything else renders
site/                   static site generator
ops/                    scheduled jobs and the weekly report
```

## Running it

```sh
nvm use                 # Node 22, see .nvmrc
npm test                # the arithmetic and every integrity rule
npm run collect         # refresh live pricing (add --dry-run to inspect first)
npm run build:data      # resolve every escape into a page model
```

## Data sources

Vultr and Linode publish plan catalogues with no authentication. Hetzner and
DigitalOcean need a free read-only API token (`HETZNER_API_TOKEN`, `DO_API_TOKEN`);
without one they are skipped cleanly rather than faked. GitHub project health uses
`GITHUB_TOKEN`, falling back to the local `gh` CLI token.
