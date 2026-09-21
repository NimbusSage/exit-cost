# Exit Cost brand assets

The mark is the two cost lines crossing on an axis — the moment self-hosting
overtakes the subscription. It is the one original idea the site has, so it is
the mark.

The axis is not decoration. Without it the crossing reads as a propeller rather
than a chart; with it the shape is legible at 32px, which is the size that
actually matters in a feed.

Two variants, because a border that looks right in a square slices visibly
through a circular crop:

| File | Use |
|---|---|
| `mark.svg` | **Circle crops** — avatars. No frame. Composition sits inside the circle-safe radius. |
| `mark-framed.svg` | **Square placements** — favicon, Google Cloud branding, app icons. Adds a plate so it holds its own on another light surface. |
| `mark-dark.svg`, `mark-framed-dark.svg` | The same, for dark surfaces. |
| `avatar-800.png`, `avatar-98.png` | YouTube / TikTok / Instagram avatar. 98 is YouTube's stated minimum. |
| `avatar-dark-800.png` | Where a light ground would glare. |
| `icon-512.png`, `icon-192.png`, `icon-48.png` | Square icon placements, including Google Cloud OAuth branding. |
| `banner-2048x1152.png` | YouTube banner. Readable content sits inside the centre 1235×338, all that survives on a phone. |

Ticks, not numerals: digits are illegible below 48px while tick marks still read
as measurement. Square line caps, not round: a rounded end reads as a brush
stroke, a square one as an instrument.

The site favicon is `mark.svg` inlined as a data URI, so it needs no request and
cannot 404.

## Palette

Taken from the site, which takes it from a ledger: black ink, debits in red,
credits in green, on cool grey stock.

| Token | Light | Dark |
|---|---|---|
| ground | `#edeef0` | `#14161a` |
| ink | `#000000` | `#e9eaec` |
| debit — what you pay now | `#a81e27` | `#e8737a` |
| credit — what you save | `#0b5137` | `#57c295` |
| rule / axis | `#8b919b` | `#565c66` |

Type: Newsreader for prose, DM Mono for figures. Never a figure in the serif —
money columns have to line up.
