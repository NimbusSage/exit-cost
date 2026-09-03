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

const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(port) {
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--force-color-profile=srgb',
    `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return proc;
    } catch {}
    await sleep(250);
  }
  proc.kill();
  throw new Error('Chrome did not open a debugging port');
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

async function shoot({ url, out, evaluate, width = 1100, height = 1600, full = false, port = 9333 }) {
  const proc = await launch(port);
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
    proc.kill();
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

module.exports = { shoot };
