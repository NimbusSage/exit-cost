#!/usr/bin/env node
/**
 * youtube-auth.mjs — one-time YouTube consent, run on YOUR machine.
 *
 * Why not on the server: Google redirects a Desktop-app client to
 * http://127.0.0.1, which only works where a browser and the listener are the
 * same machine. Running it here also keeps the refresh token off the server and
 * out of any transcript — it is printed on your terminal, and you put it into
 * repository secrets yourself.
 *
 * Needs nothing installed beyond Node 18+.
 *
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node ops/youtube-auth.mjs
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 8765);
// upload is all we need: it can add videos and nothing else.
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`
Set both first, from the OAuth client you created (type: Desktop app):

  export GOOGLE_OAUTH_CLIENT_ID='...apps.googleusercontent.com'
  export GOOGLE_OAUTH_CLIENT_SECRET='...'
  node ops/youtube-auth.mjs
`);
  process.exit(2);
}

const redirect_uri = `http://127.0.0.1:${PORT}`;
const state = crypto.randomBytes(16).toString('hex');

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',        // without this there is no refresh token
  prompt: 'consent',             // force one, even if you have approved before
  state,
}).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirect_uri);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');

  const reply = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px/1.6 system-ui;padding:3rem;max-width:34rem">${msg}</body>`);
  };

  if (err) { reply(`<h2>Declined</h2><p>Google returned: <code>${err}</code></p>`); server.close(); process.exit(1); }
  if (!code) { reply('<p>Waiting for the consent redirect…</p>'); return; }
  if (url.searchParams.get('state') !== state) {
    reply('<h2>State mismatch</h2><p>Discarded. Run it again.</p>');
    server.close(); process.exit(1);
  }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri, grant_type: 'authorization_code' }),
  });
  const tok = await r.json();

  if (!tok.refresh_token) {
    reply(`<h2>No refresh token</h2><p>Google returned an access token but no refresh token. That happens when the app was already authorised; revoke it at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and run this again.</p>`);
    console.error('\nNo refresh_token returned:', JSON.stringify(tok, null, 2));
    server.close(); process.exit(1);
  }

  reply('<h2>Done</h2><p>Your refresh token is printed in the terminal. Close this tab.</p>');
  console.log(`
────────────────────────────────────────────────────────────────
Refresh token — treat it like a password. It does not expire.

${tok.refresh_token}

Add it as a repository secret named exactly:

  YOUTUBE_REFRESH_TOKEN

  https://github.com/NimbusSage/exit-cost/settings/secrets/actions

Do not paste it into a chat. Clear your terminal scrollback afterwards.
────────────────────────────────────────────────────────────────
`);
  server.close();
  setTimeout(() => process.exit(0), 250);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nOpen this and approve the Exit Cost channel:\n\n${authUrl}\n`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${opener} "${authUrl}"`, () => {});
  console.log(`(listening on ${redirect_uri} — leave this running)\n`);
});
