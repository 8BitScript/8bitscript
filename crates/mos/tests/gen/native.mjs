// Regenerates fixtures/native.json from mos/native.ts. From the repo root:
//   node crates/mos/tests/gen/native.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleNative, referencedLabels } from '../../../../packages/compiler/src/mos/native.ts';
import { parseAsm } from '../../../../packages/compiler/src/mos/asm/parse.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const real = [
  'packages/c64/native/6502/raster.s', 'packages/c64/native/6502/text.s',
  'packages/c64/native/6502/multiplex.s', 'packages/nes/native/6502/font.s',
];
// Inputs are stored once under `files` and named by path in the cases. Real paths stand in
// for the pilot's tokenized ones (the error text prints whichever path it is given).
const files = {};
for (const p of real) files[p] = readFileSync(root + p, 'utf8');
const sec = (name) => `.section ${name},"ax",@progbits`;
const small = {
  'ok.s': [sec('.init.5'), 'sei', 'jsr helper', 'rts', sec('.init.2'), 'nop', sec('.text.helper'), '.global helper', 'helper: rts', sec('.text.unused'), 'unused: rts'].join('\n'),
  'order.s': [sec('.init.10'), 'a1: nop', sec('.init.9'), 'a2: nop', sec('.init.10'), 'a3: nop', sec('.init.010'), 'a4: nop'].join('\n'),
  'crlf.s': ['; head', sec('.init.1') + '\r', 'lda #1\r', '1: dex\r', 'bne 1b\r', 'rts'].join('\n'),
  'locals.s': [sec('.init.1'), '1: dex', 'bne 1b', sec('.init.2'), '1: dex', 'bne 1b'].join('\n'),
  'chain.s': [sec('.text.top'), 'top: jsr mid', 'rts', sec('.text.mid'), 'mid: jsr leaf', 'rts', sec('.text.leaf'), 'leaf: rts', sec('.text.dead'), 'dead: rts'].join('\n'),
  'suffix.s': [sec('.text.sym'), 'sym: rts'].join('\n'),
  'other.s': [sec('.init.1'), 'other_label: rts'].join('\n'),
  'bytes.s': [sec('.init.1'), 'lda #<tbl', 'sta tbl+1', 'tbl: rts'].join('\n'),
  'err-parse.s': [sec('.init.1'), 'nop', 'frob'].join('\n'),
  'err-dup-in.s': [sec('.init.1'), 'a: nop', 'a: nop'].join('\n'),
  'err-global-undef.s': [sec('.text.x'), '.global x', 'y: nop'].join('\n'),
  'err-suffix.s': [sec('.text.nope'), 'other: nop'].join('\n'),
  'err-dup-across.s': [sec('.init.1'), 'shared: nop', sec('.init.2'), 'shared: nop'].join('\n'),
  'err-unknown-section.s': [sec('.data.foo'), 'x: nop'].join('\n'),
  'err-bad-section.s': ['.section .init.1', 'nop'].join('\n'),
  'err-bad-section2.s': ['.section .init.1,"aw",@progbits', 'nop'].join('\n'),
  'err-outside.s': ['nop', sec('.init.1'), 'nop'].join('\n'),
  'err-global-late.s': [sec('.text.x'), 'x: nop', '.global x'].join('\n'),
  'err-global-twice.s': [sec('.text.x'), '.global x', '.global x', 'x: nop'].join('\n'),
  'err-global-bad.s': [sec('.text.x'), '.global 9x', 'x: nop'].join('\n'),
  'err-global-none.s': ['.global x', sec('.init.1'), 'nop'].join('\n'),
  'err-dangling.s': [sec('.init.1'), 'jsr nowhere', 'rts'].join('\n'),
  'err-dangling-text.s': [sec('.text.t'), 't: jsr gone', 'rts'].join('\n'),
  'empty.s': '',
  'comments.s': ['// x', '; y', ''].join('\n'),
};
Object.assign(files, small);

const cases = [];
const run = (paths, referenced) => {
  const sources = paths.map((path) => ({ path, text: files[path] }));
  const result = assembleNative(sources, new Set(referenced));
  cases.push({ fn: 'assembleNative', args: [paths, referenced], result });
};
const c64 = real.slice(0, 3);
// The 4 in-repo files under 3 referenced sets: none, one symbol, every symbol in the file.
for (const p of real) {
  const all = [...referencedLabels(parseAsm(files[p].split('\n').filter((l) => !/^\s*\.(section|global)/.test(l)).join('\n'), 'x').directives ?? [])];
  const labels = [...files[p].matchAll(/^\.global\s+(\S+)/gm)].map((m) => m[1]);
  run([p], []);
  run([p], labels.slice(0, 1));
  if (labels.length > 1) run([p], labels);
  void all;
}
run(c64, ['__8bs_c64_raster_install', '__8bs_c64_text_print']);
run([c64[1], c64[0]], ['__8bs_c64_text_fill']);
for (const name of Object.keys(small)) {
  run([name], []);
  if (name === 'ok.s' || name === 'chain.s' || name === 'suffix.s') run([name], ['helper', 'top', 'sym']);
}
run(['chain.s'], ['mid']);
run(['ok.s', 'other.s'], ['helper']);
run(['other.s', 'ok.s', 'bytes.s'], ['unused']);
run(['err-dup-in.s', 'ok.s'], []);
run(['ok.s', 'err-parse.s'], []);
run(['locals.s', 'locals.s'], []);
run(['order.s', 'ok.s'], []);

// referencedLabels over hand-made directive lists.
const refs = [
  [],
  [{ kind: 'label', name: 'a' }, { kind: 'byte', values: [1] }, { kind: 'equate', name: 'e', value: 1 }],
  [
    { kind: 'instruction', mnemonic: 'NOP', mode: 'implied' },
    { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 1 } },
    { kind: 'instruction', mnemonic: 'JSR', mode: 'absolute', operand: { kind: 'label', name: 'z' } },
    { kind: 'instruction', mnemonic: 'JSR', mode: 'absolute', operand: { kind: 'label', name: 'a' } },
    { kind: 'instruction', mnemonic: 'JSR', mode: 'absolute', operand: { kind: 'label', name: 'z' } },
  ],
];
const refCases = refs.map((d) => ({ fn: 'referencedLabels', args: [d], result: [...referencedLabels(d)] }));

const out = fileURLToPath(new URL('../fixtures/native.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../fixtures/', import.meta.url)), { recursive: true });
writeFileSync(out, JSON.stringify({ files, cases, refCases }));
console.log(cases.length, 'cases', refCases.length, 'refCases');
