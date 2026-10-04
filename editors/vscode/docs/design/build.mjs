#!/usr/bin/env node
// Builds the launcher design prototypes.
//
//   node build.mjs                 themes + every page + every screenshot
//   node build.mjs --no-shots      themes + pages only
//   node build.mjs --only=a/01     pages whose id contains the text
//   node build.mjs --theme=light   one theme only
//
// Needs a Chromium-family browser for the screenshots (DESIGN_BROWSER, default
// Brave) and the codicon font in .cache/ (copied from an editor install; see
// README.md). Only a browser is launched — never an emulator.
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeThemes } from './src/themes.mjs';
import { openRenderer } from './src/render.mjs';
import { page } from './src/page.mjs';
import { A, A_WIDTHS } from './src/direction-a.mjs';
import { B, B_WIDTHS } from './src/direction-b.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = arg('only');
const themes = arg('theme') ? [arg('theme')] : ['dark', 'light'];
const noShots = process.argv.includes('--no-shots');

const DIRECTIONS = [
  { id: 'a', name: 'Direction A — launch card', states: A, widths: A_WIDTHS },
  { id: 'b', name: 'Direction B — program list', states: B, widths: B_WIDTHS },
];

mkdirSync(join(here, 'themes'), { recursive: true });
mkdirSync(join(here, 'html'), { recursive: true });
writeThemes(join(here, 'themes'));

// The codicon font is not committed (it is the editor's, under its own licence).
const font = join(here, '.cache', 'codicon.ttf');
if (!existsSync(font)) {
  const src = process.env.DESIGN_CODICON ?? '/Applications/Cursor.app/Contents/Resources/app/out/media/codicon.ttf';
  mkdirSync(join(here, '.cache'), { recursive: true });
  copyFileSync(src, font);
}

const jobs = [];
for (const d of DIRECTIONS) {
  for (const [state, render] of Object.entries(d.states)) {
    for (const width of d.widths[state] ?? [300]) {
      const id = `${d.id}/${state}-${width}`;
      if (only && !id.includes(only)) continue;
      const file = join(here, 'html', `${d.id}-${state}-${width}.html`);
      writeFileSync(file, page({ width, title: `${d.name} · ${state} · ${width}px`, body: render() }));
      for (const kind of themes) jobs.push({ id, file, width, kind, out: join(here, 'shots', kind, d.id, `${state}-${width}.png`) });
    }
  }
}
console.log(`${new Set(jobs.map((j) => j.file)).size} pages written`);
if (noShots) process.exit(0);

const renderer = await openRenderer();
let done = 0;
const queue = [...jobs];
async function worker() {
  for (let j = queue.shift(); j; j = queue.shift()) {
    mkdirSync(dirname(j.out), { recursive: true });
    const h = await renderer.shoot({ file: j.file, query: `?theme=${j.kind}`, width: j.width, out: j.out });
    console.log(`[${++done}/${jobs.length}] ${j.kind}/${j.id} ${j.width}x${h}`);
  }
}
try { await Promise.all([worker(), worker(), worker()]); } finally { await renderer.close(); }
