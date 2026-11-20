// Regenerates fixtures/facts.json: the fact table and every export of
// packages/compiler/src/fold/facts.mjs over fixed inputs, from the JS.
// Run from the repo root: node crates/fold/tests/gen/facts.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTROLLER_KINDS,
  FACTS,
  LOGICAL_CONTROLS,
  PROGRAM_FACTS,
  controllerKind,
  factConstName,
  factPlaceholder,
  factProblems,
  requiresProblems,
  shortOfBaseline,
  unmetRequirements,
} from '../../../../packages/compiler/src/fold/facts.mjs';

const rows = [];
const add = (fn, args, result) => rows.push({ fn, args, result });

add('FACTS', [], [...FACTS]);
add('LOGICAL_CONTROLS', [], LOGICAL_CONTROLS);
add('CONTROLLER_KINDS', [], CONTROLLER_KINDS);
add('PROGRAM_FACTS', [], PROGRAM_FACTS);

const keys = [...FACTS.keys(), 'nope', 'video', '', 'a.b.c', 'x.fooBarBaz', 'x.aBC', 'x.ABc'];
for (const key of keys) {
  if (key !== '') add('factConstName', [key], factConstName(key));
  add('factPlaceholder', [key], factPlaceholder(key));
}

const controls = [
  [], ['up'], ['up', 'down', 'left', 'right', 'a'], ['a', 'right', 'left', 'down', 'up'],
  ['up', 'up', 'down', 'left', 'right', 'a'], ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start'],
  ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'],
  [...LOGICAL_CONTROLS], [...LOGICAL_CONTROLS].reverse(), ['up', 'down', 'left', 'right', 'b'],
  ['up', 'down', 'left', 'right', 'a', 'b'], 'up', null, { up: 1 }, [1, 2, 3, 4, 5], [['up']],
];
for (const c of controls) add('controllerKind', [c], controllerKind(c));

const requires = [
  undefined, null, {}, { 'video.columns': 40 }, { 'video.sprites': 8, 'storage.save': true },
  { 'nope': 1 }, { 'video.frameRate': 50 }, { 'input.controls': ['a'] }, { 'input.mouse': true },
  { 'memory.bankedKib': 512 }, { 'storage.save': false }, { 'storage.save': 1 },
  { 'storage.save': 'yes' }, { 'storage.save': null }, { 'storage.save': { a: [1, 'x\n"q"'] } },
  { 'video.columns': 0 }, { 'video.columns': -3 }, { 'video.columns': 1.5 }, { 'video.columns': '40' },
  { 'video.columns': null }, { 'video.columns': true }, { 'video.columns': [1, 2] },
  { 'video.columns': { b: 1, a: 2 } }, { 'video.columns': 1e21 }, { 'video.columns': 1e300 },
  { 'video.columns': 0.000001 }, { 'video.columns': 1e-7 },
  { 7: 1, 'video.rows': 25, 3: 'x', 'audio.voices': 0 },
  { 'audio.noise': true, 'audio.pcm': false, 'nope.too': 1, 'memory.ram': 65536, 'video.layers': 2 },
];
for (const r of requires) {
  add('requiresProblems', [r ?? null], requiresProblems(r));
}

const sheets = [
  undefined, null, {}, { 'video.columns': 40, 'video.rows': 25 },
  { 'video.columns': 40, 'storage.save': true, 'video.sprites': 8, 'video.spritesPerLine': 8 },
  { 'video.columns': 20, 'storage.save': false, 'memory.ram': 3583, 'video.layers': 0, 'audio.noise': true },
  { 'input.mouse': true, 'memory.banked': true, 'memory.bankedKib': 512, 'input.controls': ['a'] },
  { 'video.columns': null, 'storage.save': null }, { 'video.columns': 80, 'storage.save': true },
  { 'video.columns': '80', 'video.rows': '25' }, { 'video.columns': true, 'video.rows': [] },
  { 'video.colorPerCell': true, 'video.scroll': true, 'video.raster': 1, 'video.bitmap': true },
  { 'video.frameRate': 60, 'video.spriteWidth': 24, 'video.spriteHeight': 21, 'audio.voices': 3 },
];
for (const need of requires) {
  for (const have of sheets) {
    if (need === undefined || need === null) continue;
    add('unmetRequirements', [need, have ?? null], unmetRequirements(need, have));
  }
}
add('unmetRequirements', [null, null], unmetRequirements(undefined, undefined));
for (const base of sheets) {
  for (const have of sheets) add('shortOfBaseline', [base ?? null, have ?? null], shortOfBaseline(base, have));
}

const problems = [
  undefined, null, {}, { 'video.columns': 40 }, { 'nope': 1 }, { 'storage.save': 1 }, { 'storage.save': true },
  { 'video.columns': -1 }, { 'video.columns': 1.5 }, { 'video.columns': '1' }, { 'video.columns': null },
  { 'video.columns': 0 }, { 'input.controls': ['up', 'a'] }, { 'input.controls': [] },
  { 'input.controls': 'up' }, { 'input.controls': ['up', 'jump', 3, null, { a: 1 }] },
  { 'input.controls': null }, { 'video.columns': 1e21, 'storage.save': 'x', 'memory.ram': [1] },
  { 12: true, 'video.rows': 1.25, 2: 1 }, { 'input.mouse': 1, 'memory.banked': 'yes' },
  Object.fromEntries([...FACTS.keys()].map((k) => [k, 1])),
  Object.fromEntries([...FACTS.keys()].map((k) => [k, true])),
];
for (const p of problems) add('factProblems', [p ?? null], factProblems(p));

const out = fileURLToPath(new URL('../fixtures/facts.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`${rows.length} rows -> ${out}`);
