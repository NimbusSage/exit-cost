# Root-level static files

Anything here is copied verbatim to the root of the built site, untouched by the
generator. It exists for files that must live at a specific path and must survive
a rebuild — search-engine verification tokens, and anything similar.

`site/build.js` clears `dist/` on every run, so a file dropped there by hand
disappears on the next build. That is how a verified property quietly becomes
unverified weeks later. Put it here instead; a test asserts it reaches the output.
