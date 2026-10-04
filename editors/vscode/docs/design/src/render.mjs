// Headless rendering of the static prototypes. One Chromium-family browser
// (Brave by default) is started with its own throw-away profile and driven over
// the DevTools protocol: each page is opened in its own tab, we wait for the
// icon font, measure the side bar, and capture exactly that rectangle at 2x.
// `sharp`, when installed, palette-quantises the PNG (flat UI colours, several
// times smaller). Only a browser is launched here — never an emulator — and a
// running browser session is never touched (separate profile, separate port).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BROWSER = process.env.DESIGN_BROWSER
  ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.waiters = [];
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
      } else if (msg.method) {
        this.waiters = this.waiters.filter((w) => !(w.method === msg.method && w.session === msg.sessionId && (w.resolve(msg.params), true)));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method, session) { return new Promise((resolve) => this.waiters.push({ method, session, resolve })); }
}

export async function openRenderer() {
  const profile = mkdtempSync(join(tmpdir(), '8bs-design-'));
  const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('browser did not start')), 30000);
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    child.on('exit', () => reject(new Error('browser exited early')));
  });
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const cdp = new Cdp(ws);

  async function shoot({ file, query = '', width, out }) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    try {
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: false }, sessionId);
      const loaded = cdp.once('Page.loadEventFired', sessionId);
      await cdp.send('Page.navigate', { url: pathToFileURL(file).href + query }, sessionId);
      await loaded;
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: 'document.fonts.ready.then(() => Math.ceil(document.getElementById("sb").getBoundingClientRect().height))',
        awaitPromise: true, returnByValue: true }, sessionId);
      const height = result.value;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      writeFileSync(out, Buffer.from(data, 'base64'));
      try {
        const { default: sharp } = await import(process.env.DESIGN_SHARP ?? 'sharp');
        await sharp(out).png({ palette: true, quality: 95, effort: 8, colours: 256 }).toFile(`${out}.tmp`);
        renameSync(`${out}.tmp`, out);
      } catch { /* sharp is optional */ }
      return height;
    } finally {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  async function close() {
    try { await cdp.send('Browser.close'); } catch { /* already gone */ }
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
  return { shoot, close };
}
