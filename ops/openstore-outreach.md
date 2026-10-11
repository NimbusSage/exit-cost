# Outreach to OpenStore

Send as an issue on https://github.com/dev-krish-xyz/OpenStore/issues when you
are ready (title below). Everything in this file is meant to be pasted, so it
avoids repo-specific paths beyond the two URLs the other side needs.

---

## Title

A free exit-cost feed your catalog can join against (rebuilds nightly, no upkeep on your side)

## Body

Hi. I run [Exit Cost](https://nimbussage.github.io/exit-cost/), an open dataset
that prices what it actually costs to leave a SaaS subscription for a
self-hosted alternative, including the operator's own hours. It publishes the
hourly rate at which staying becomes the better deal. Ten of its thirty
comparisons conclude you should keep paying, which is one reason I trust it.

I noticed OpenStore covers the same question from the other side: you catalog
what to leave proprietary software *for*, and it costs nothing to read. My side
answers "what will it cost me in money and hours", yours answers "what are my
options and who maintains them". Neither covers the other, and the people who
want one usually need both.

So I built a small bridge that requires no work from you and no further
commits from me:

**The feed:** `https://nimbussage.github.io/exit-cost/api/openstore.json`

It is a plain JSON file, regenerated every night by the same pipeline that
publishes the site. Each row is one comparison, keyed to the fields your
catalog already carries:

- `alternative_repo` joins directly onto your `repo` field (your AppFlowy and
  OpenSign entries already match two comparisons).
- `incumbent_vendor` matches against your `replaces` array at a fuzzy level,
  which links another ten comparisons to apps in your directory with no edit
  on your side.
- Every price carries `incumbent_price_verified_at`, plus the sentence from the
  vendor's own pricing page that justifies it. I pull numbers past their
  freshness window rather than publish them stale.
- Two fields matter if you ever want to publish cost figures without risking
  your editorial credibility: `break_even_hourly_rate` (what an hour of the
  reader's time would have to be worth before self-hosting stops paying) and
  `verdict`, which is `switch`, `marginal`, or `stay`.

For a concrete example, [leaving Notion](https://nimbussage.github.io/exit-cost/vs/notion/)
shows all five routes with every assumption printed, not hand-waved.

**If you ever want to wire it up**, the shape of a row is stable, and the URLs
point at live pages and deeper JSON. Very roughly, in your Vercel app, you
could load the feed at request time (it is a single ~30 KB file) and surface a
small "what leaving really costs" line on the matching app page, or filter
your catalog by a new "priced exit" flag.

**If you would rather not**, that is completely fine. Two things are useful on
their own: the comparison pages at my end already link back to your directory
entries for the projects that replace the same subscription, and the feed
serves as a browseable structure for anyone comparing the two directories.

**Corrections:** if any figure on a comparison page looks wrong, open an issue
[here](https://github.com/NimbusSage/exit-cost/issues) and it gets fixed
against the vendor's page before the next night's build. The data is CC BY 4.0,
free to use including commercially.

Thanks, either way, for building the thing.

---

## Notes for the owner (do not paste)

- Do not submit while your own pending items are still open: YouTube consent,
  BGM licence confirmation, and analytics have to be done first. The domain
  would also strengthen outreach, since `nimbussage.github.io` sits next to an
  openstore.site address.
- The feed refreshes on your nightly build, at no cost to OpenStore. The exact
  schema lives in `site/build.js::openstoreFeed` if they want to read the
  generator rather than a sample.
- If they ask why two fields are called `openstore_id` and `openstore_url`,
  that is for cross-linking to their own directory URLs, so nothing depends on
  scraping their site at runtime.
- Their catalog lives in three plain JS modules with a trailing re-export I
  had to strip. The join key is the `repo` field in both.
