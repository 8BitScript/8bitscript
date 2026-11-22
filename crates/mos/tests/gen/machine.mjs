// Regenerates fixtures/machine.json: what `mos/index.ts` computes for the PR-G
// helpers. Run from the repo root:
//   node crates/mos/tests/gen/machine.mjs
// Most helpers are module-private in index.ts, so the script copies the file
// next to the original with an `export` line appended, imports the copy and
// deletes it. index.ts itself is never edited. The copy carries the export
// line because these functions are not exported by index.ts.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mosDir = join(here, '..', '..', '..', '..', 'packages', 'compiler', 'src', 'mos');
const copy = join(mosDir, '.index-export-for-fixtures.ts');
const names = [
  'ZP_BUDGETS', 'BORROWS_ZERO_PAGE', 'RASTER_MACHINES', 'chrgetZpHoles',
  'collectCallNames', 'findCallCycle', 'clearRam', 'copyToRam', 'directiveBytes', 'functionSizeEntries',
  'collectStringIndexes',
];
writeFileSync(copy, `${readFileSync(join(mosDir, 'index.ts'), 'utf8')}\nexport { ${names.join(', ')} };\n`);
let m;
try {
  m = await import(pathToFileURL(copy).href);
} finally {
  rmSync(copy, { force: true });
}

const machines = Object.keys(m.CPU);
const call = (name, args = []) => ({ kind: 'call', name, args });
const ref = (name) => ({ kind: 'ref', name });
const konst = (value) => ({ kind: 'const', value });
const fn = (name, body) => ({ name, body });
const set = (xs) => [...xs];

const out = {};
out.cpu = machines.map((name) => [name, m.CPU[name]]);
out.zpBudgets = Object.keys(m.ZP_BUDGETS).map((name) => [name, m.ZP_BUDGETS[name]]);
out.missingBudget = machines.filter((n) => !m.ZP_BUDGETS[n]);
out.borrows = set(m.BORROWS_ZERO_PAGE);
out.raster = set(m.RASTER_MACHINES);

// chrgetZpHoles: inside, outside and straddling the budget, plus a non-number.
const budget = { zpOrigin: 0x02, zpCeiling: 0x100 };
out.chrget = [
  { facts: {}, budget },
  { facts: { 'memory.chrget': 0x70 }, budget },
  { facts: { 'memory.chrget': 0xc2 }, budget },
  { facts: { 'memory.chrget': 0xf0 }, budget }, // straddles the ceiling: end $108
  { facts: { 'memory.chrget': 0x100 }, budget }, // starts at the ceiling
  { facts: { 'memory.chrget': 0xe8 }, budget }, // ends exactly at the ceiling
  { facts: { 'memory.chrget': 0x02 - 24 }, budget }, // ends at the origin
  { facts: { 'memory.chrget': 0x02 - 23 }, budget }, // straddles the origin
  { facts: { 'memory.chrget': '0x70' }, budget },
  { facts: { 'memory.chrget': null }, budget },
  { facts: { 'memory.chrget': 0x70 }, budget: { zpOrigin: 0x80, zpCeiling: 0xfd } },
  { facts: { 'memory.chrget': 0x70, 'other': 1 }, budget: { zpOrigin: 0x22, zpCeiling: 0x80 } },
].map((c) => ({ ...c, result: m.chrgetZpHoles(c.facts, c.budget) }));

// outputExtension.
const outputs = [undefined, { build: {} }, { build: { output: '' } }, { build: { output: 'bin' } }];
out.outputExtension = [];
for (const machine of machines) {
  for (const hardware of outputs) {
    out.outputExtension.push({ machine, hardware: hardware ?? null, result: m.outputExtension(machine, hardware) });
  }
}

// clearRam / copyToRam at the sizes the spec names, at two origins.
const sizes = [0, 1, 255, 256, 257, 1000];
out.clearRam = [];
out.copyToRam = [];
for (const origin of [0x200, 0x6000]) {
  for (const size of sizes) {
    out.clearRam.push({ origin, end: origin + size, result: m.clearRam(origin, origin + size) });
    out.copyToRam.push({ from: 'data_arr', to: origin, size, tag: '__8bs_ram_copy', result: m.copyToRam('data_arr', origin, size, '__8bs_ram_copy') });
  }
}
out.clearRam.push({ origin: 0x300, end: 0x2ff, result: m.clearRam(0x300, 0x2ff) });

// directiveBytes and functionSizeEntries.
const ins = (mnemonic, mode, operand) => ({ kind: 'instruction', mnemonic, mode, ...(operand ? { operand } : {}) });
const program = [
  { kind: 'label', name: 'a' }, ins('LDA', 'immediate', { kind: 'value', value: 1 }),
  ins('STA', 'absolute', { kind: 'value', value: 0x400 }), ins('NOP', 'implied'),
  { kind: 'byte', values: [1, 2, 3] }, { kind: 'byte', values: [] }, { kind: 'equate', name: 'X', value: 1 },
  ins('BNE', 'relative', { kind: 'label', name: 'a' }), ins('JMP', 'indirect', { kind: 'label', name: 'a' }),
];
out.directiveBytes = [[], program, program.slice(0, 3)].map((p) => ({ program: p, result: m.directiveBytes(p) }));
const part = (origin, p) => ({ origin, program: p });
const sizeCases = [
  { name: 'main', parts: [part(null, program)], isEntry: true },
  { name: 'main', parts: [part(null, program)], isEntry: false },
  { name: 'f', parts: [part(null, program.slice(0, 2)), part('g', program.slice(2, 4)), part(null, program.slice(4)), part('g', program.slice(0, 1)), part('h', [])], isEntry: false },
  { name: 'f', parts: [part('f', program.slice(0, 2)), part(null, program.slice(2, 3))], isEntry: false },
  { name: 'f', parts: [], isEntry: false },
  { name: 'f', parts: [], isEntry: true },
  { name: 'f', parts: [part('', program.slice(0, 1))], isEntry: true },
];
out.functionSizeEntries = sizeCases.map((c) => ({ ...c, result: m.functionSizeEntries(c) }));

// collectCallNames, collectStringIndexes, findCallCycle.
const str = (index) => ({ kind: 'string', index, type: 'string' });
const loc = { start: 0, length: 0 };
const walkBody = [
  call('b', [str(3), call('c', [str(1)])]),
  { kind: 'if', test: call('d'), then: [{ kind: 'assign', target: 'x', value: str(2) }], else: [call('b')], ...loc },
  { kind: 'for', init: { kind: 'local', name: 'i', type: 'u8', init: call('e') }, test: call('f', [str(1)]), update: { kind: 'assign', target: 'i', value: konst(1) }, body: [call('a')] },
  { kind: 'while', test: ref('q'), body: [{ kind: 'block', origin: 'z', body: [call('g', [{ kind: 'binop', operator: '+', left: str(7), right: call('h'), type: 'u8' }])] }], ...loc },
  { kind: 'storeIndex', array: ref('arr'), index: call('i'), value: str(0), elementType: 'u8', ...loc },
  { kind: 'return', value: { kind: 'stringByte', string: str(9), index: call('j'), type: 'u8' }, ...loc },
];
out.walks = [[], walkBody, [call('only')]].map((body) => {
  const names = new Set();
  m.collectCallNames(body, names);
  const idx = new Set();
  m.collectStringIndexes(body, idx);
  return { body, calls: set(names), strings: set(idx) };
});
const cycleCases = [
  [],
  [fn('main', [call('a')]), fn('a', [call('b')]), fn('b', [])],
  [fn('main', [call('a'), call('b')]), fn('a', [call('c')]), fn('b', [call('c')]), fn('c', [])],
  [fn('main', [call('a')]), fn('a', [call('b')]), fn('b', [call('c')]), fn('c', [call('a')])],
  [fn('main', [call('main')])],
  [fn('main', [call('a')]), fn('a', [call('a')])],
  [fn('main', [call('ext'), call('a')]), fn('a', [call('main')])],
  [fn('x', [call('y')]), fn('y', [call('x')]), fn('z', [call('z')])],
  [fn('main', [{ kind: 'if', test: call('a'), then: [], else: [call('b')], ...loc }]), fn('a', []), fn('b', [{ kind: 'while', test: konst(1), body: [call('main')], ...loc }])],
  [fn('main', [call('a', [konst(1), call('b')])]), fn('a', []), fn('b', [call('a')])],
  [fn('p', [call('q')]), fn('q', [call('r')]), fn('r', [call('p'), call('q')])],
];
out.callCycles = cycleCases.map((functions) => ({ functions, result: m.findCallCycle(functions) }));

mkdirSync(join(here, '..', 'fixtures'), { recursive: true });
writeFileSync(join(here, '..', 'fixtures', 'machine.json'), `${JSON.stringify(out, null, 1)}\n`);
