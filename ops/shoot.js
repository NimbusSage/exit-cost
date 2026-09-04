#!/usr/bin/env node
/**
 * ops/shoot.js — drive headless Chrome over the DevTools Protocol.
 *
 * Node 22 ships a WebSocket client, and CDP is just JSON over a socket, so this
 * needs no Playwright or Puppeteer install. Used to eyeball the site and to
 * verify that the hourly-rate control actually recomputes the page.
 *
 *   node ops/shoot.js <url> <out.png> [--eval "js"] [--w 1100] [--h 1600] [--full]
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch Chrome on an OS-assigned port.
 *
 * A fixed port collides whenever two launches overlap — including consecutive
 * ones, because a killed Chrome does not release its port instantly. Passing
 * port 0 makes the OS choose, and Chrome writes the chosen port into
 * DevToolsActivePort in its profile directory.
 */
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcost-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--force-color-profile=srgb',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' });

  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 80; i++) {
    try {
      const port = parseInt(fs.readFileSync(portFile, 'utf8').split('\n')[0], 10);
      if (port > 0) {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) return { proc, port, profile };
      }
    } catch {}
    await sleep(200);
  }
  proc.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  throw new Error('Chrome did not open a debugging port');
}

function cleanup(session) {
  try { session.proc.kill(); } catch {}
  try { fs.rmSync(session.profile, { recursive: true, force: true }); } catch {}
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(new Error('ws error')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const send = async (method, params = {}) => {
    await ready;
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  };
  return { send, close: () => ws.close(), ready };
}

async function shoot({ url, out, evaluate, width = 1100, height = 1600, full = false }) {
  const session = await launch();
  const { port } = session;
  try {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    const cdp = connect(target.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    await cdp.send('Page.navigate', { url });
    await sleep(1400);

    const errors = [];
    if (evaluate) {
      const r = await cdp.send('Runtime.evaluate', { expression: evaluate, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) errors.push(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
      else if (r.result && r.result.value !== undefined) console.log(JSON.stringify(r.result.value, null, 2));
      await sleep(500);
    }

    const shotArgs = { format: 'png' };
    if (full) shotArgs.captureBeyondViewport = true;
    const { data } = await cdp.send('Page.captureScreenshot', shotArgs);
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    cdp.close();
    if (errors.length) { console.error('PAGE ERROR:', errors.join('\n')); process.exitCode = 1; }
    return out;
  } finally {
    cleanup(session);
  }
}

/**
 * Rendered HTML for a page whose pricing is built by JavaScript. Plenty of
 * vendors ship an empty pricing table in the initial response; reading the page
 * as a browser does is the only honest way to see what they publish.
 */
async function renderHtml(url, { waitMs = 2500 } = {}) {
  const session = await launch();
  const { port } = session;
  try {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    const cdp = connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url });
    await sleep(waitMs);
    const r = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
    cdp.close();
    return r.result.value;
  } finally {
    cleanup(session);
  }
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const flag = (n, d) => { const i = a.indexOf(`--${n}`); return i === -1 ? d : a[i + 1]; };
  const url = a[0], out = a[1];
  if (!url || !out) { console.error('usage: shoot.js <url> <out.png> [--eval js] [--w n] [--h n] [--full]'); process.exit(2); }
  shoot({ url, out, evaluate: flag('eval', null), width: +flag('w', 1100), height: +flag('h', 1600), full: a.includes('--full') })
    .then((f) => console.log('wrote', f))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { shoot, renderHtml };
