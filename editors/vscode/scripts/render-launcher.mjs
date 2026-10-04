#!/usr/bin/env node
// Renders the REAL launcher page (media/launcher.{css,js}) — not the design
// prototype — against the states in test/support/launcherFixtures.cjs, in
// Dark Modern and Light Modern, to docs/design/wired/<theme>/<state>-<width>.png,
// so the built thing can be set beside docs/design/shots/ and judged by eye.
//
//   node scripts/render-launcher.mjs                 every state, both themes
//   node scripts/render-launcher.mjs --only=running  states whose id contains the text
//   node scripts/render-launcher.mjs --theme=light
//
// Needs a Chromium-family browser (DESIGN_BROWSER, default Brave). Only a
// browser is launched — never an emulator, never the editor.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openRenderer } from '../docs/design/src/render.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { vegas, single, RUNNING, HISTORY } = require('../test/support/launcherFixtures.cjs');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = arg('only');
const themes = arg('theme') ? [arg('theme')] : ['dark', 'light'];

const css = readFileSync(join(root, 'media', 'launcher.css'), 'utf8')
  .replace('{{CODICON}}', pathToFileURL(join(root, 'media', 'codicon.woff2')).href);
const js = readFileSync(join(root, 'media', 'launcher.js'), 'utf8');
const logo = pathToFileURL(join(root, 'media', '8bitscript-icon.svg')).href;

// state id -> [state, ui (the page's own open disclosures and menu), widths]
const STATES = {
  '01-program-3x3': [vegas(), {}, [300, 420, 260]],
  '02-program-5x5-inputs': [vegas({ program: 'slot5x5', values: { slot5x5: { SEED: 10, FORCE_BONUS: true, START_CREDITS: 5000 } } }), { open: { 'inputs:slot5x5': true, 'command:slot5x5': true } }, [300, 420]],
  '03-runtime-disabled': [vegas({ system: 'vic20', program: 'tile-test' }), {}, [300]],
  '03b-runtime-disabled-web': [vegas({ system: 'web', program: 'slot3x3' }), {}, [300]],
  '04-running': [vegas({ program: 'slot5x5', running: RUNNING, history: HISTORY, live: { slot5x5: ['editor', 'native'] } }), { open: { 'rm:r1': true } }, [300, 260]],
  '05-single-program': [single(), {}, [300]],
  '06-empty': [{ phase: 'empty' }, {}, [300]],
  '07-missing-emulator': [vegas({ missing: ['x64sc'], notices: [{ id: 'pkg', kind: 'warn', icon: 'package', title: 'Packages need installing.', text: 'Vegas Nights is missing node_modules.', actions: [{ label: 'Install packages', icon: 'package', msg: { type: 'fix', kind: 'packages' } }] }] }), {}, [300]],
  '08-system-menu': [vegas(), { menu: 'system' }, [300]],
  '09-loading': [{ phase: 'loading' }, {}, [300]],
};

function pageFor({ state, ui, width }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>launcher</title>
<script>document.write('<link rel="stylesheet" href="${pathToFileURL(join(root, 'docs', 'design', 'themes')).href}/' + (new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark') + '-modern.css">');</script>
<style>${css}
.vsc-title{height:35px;padding:0 8px 0 20px;display:flex;align-items:center;font-size:11px;text-transform:uppercase;color:var(--vscode-sideBarTitle-foreground)}
#sb{width:${width}px;background:var(--vscode-sideBar-background)}</style></head>
<body><div id="sb"><div class="vsc-title">8BitScript</div><main id="app" data-logo="${logo}" aria-label="8BitScript launcher"></main></div>
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => (${JSON.stringify(ui)}), setState() {} });</script>
<script>${js}</script>
<script>{ const e = new Event('message'); e.data = { type: 'state', state: ${JSON.stringify(state)} }; window.dispatchEvent(e); }</script>
</body></html>`;
}

const out = join(root, 'docs', 'design', 'wired');
const tmp = mkdtempSync(join(tmpdir(), '8bs-wired-'));
const jobs = [];
const { normalizeState } = require('../src/launcherState.cjs');
for (const [id, [state, ui, widths]] of Object.entries(STATES)) {
  if (only && !id.includes(only)) continue;
  for (const width of widths) {
    const file = join(tmp, `${id}-${width}.html`);
    writeFileSync(file, pageFor({ state: normalizeState(state), ui, width }));
    for (const kind of themes) jobs.push({ id, file, width, kind, out: join(out, kind, `${id}-${width}.png`) });
  }
}

const renderer = await openRenderer();
let done = 0;
try {
  for (const j of jobs) {
    mkdirSync(dirname(j.out), { recursive: true });
    const h = await renderer.shoot({ file: j.file, query: `?theme=${j.kind}`, width: j.width, out: j.out });
    console.log(`[${++done}/${jobs.length}] ${j.kind}/${j.id}-${j.width} ${j.width}x${h}`);
  }
} finally {
  await renderer.close();
  rmSync(tmp, { recursive: true, force: true });
}
