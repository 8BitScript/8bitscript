// Regenerates fixtures/link.json. Run from the repo root:
//   node crates/mos/tests/gen/link.mjs
import { link } from '../../../../packages/compiler/src/mos/link/index.ts';
import { resetLabels } from '../../../../packages/compiler/src/mos/asm/relax.ts';
import { bytes, equate, ins, lab, label, val, write } from './util.mjs';

const rows = [];
const bytesSection = (...b) => ({ kind: 'bytes', bytes: b });
const asm = (...program) => ({ kind: 'assembly', program });
const revive = (input) => ({
  ...input,
  code: input.code.kind === 'bytes' ? { kind: 'bytes', bytes: Uint8Array.from(input.code.bytes) } : input.code,
  ...(input.data ? { data: input.data.kind === 'bytes' ? { kind: 'bytes', bytes: Uint8Array.from(input.data.bytes) } : input.data } : {}),
});
const pad = (n) => bytes(...new Array(n).fill(0xea));

const add = (name, input) => {
  resetLabels();
  const r = link(revive(input));
  const result = r.ok
    ? {
        ok: true,
        bytes: [...r.bytes],
        symbols: [...r.symbols],
        layout: r.layout,
        memory: r.memory,
        listing: r.listing.map(({ prov, ...rest }) => rest),
      }
    : { ok: false, error: r.error };
  rows.push({ fn: 'link', name, args: [input], result });
};

add('everything', {
  codeOrigin: 0x0801, ramCeiling: 0xa000,
  code: asm(label('main'), ins('LDA', 'immediate', val(1)), ins('JSR', 'absolute', lab('helper')), ins('RTS', 'implied'), label('helper'), ins('RTS', 'implied')),
  data: asm(label('table'), bytes(1, 2, 3), equate('SCREEN', 0x0400)),
  bss: 16, zpOrigin: 0xfb, zp: 4, zpCeiling: 0x100,
  pinned: [{ name: 'CHROUT', address: 0xffd2 }],
});
add('bytes only', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: bytesSection(0x0b, 0x08, 0x0a, 0x00), data: bytesSection(9, 9) });
add('defaults', { codeOrigin: 0x0401, ramCeiling: 0x8000, code: bytesSection(1, 2, 3) });
add('relaxed branch inside code', {
  codeOrigin: 0x0801, ramCeiling: 0xa000,
  code: asm(ins('BNE', 'relative', lab('e')), pad(200), label('e'), ins('RTS', 'implied')),
  data: asm(ins('BEQ', 'relative', lab('d')), pad(200), label('d')),
});
add('code error is prefixed', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: asm(ins('FOO', 'implied')) });
add('data error is prefixed', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: bytesSection(1), data: asm(label('a'), label('a')) });
add('code over ceiling', { codeOrigin: 0x0801, ramCeiling: 0x0803, code: bytesSection(1, 2, 3) });
add('data over ceiling', { codeOrigin: 0x0801, ramCeiling: 0x0803, code: bytesSection(1), data: bytesSection(1, 2) });
add('bss over ceiling', { codeOrigin: 0x0801, ramCeiling: 0x0803, code: bytesSection(1), bss: 5 });
add('zp over ceiling', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: bytesSection(1), zpOrigin: 0xf0, zp: 0x20 });
add('zp over custom ceiling', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: bytesSection(1), zp: 0x10, zpCeiling: 0x08 });
add('label in code and data', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: asm(label('x')), data: asm(label('x')) });
add('pinned inside code', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: bytesSection(1, 2, 3, 4), pinned: [{ name: 'P', address: 0x0803 }] });
add('pinned inside data', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: bytesSection(1), data: bytesSection(1, 2), pinned: [{ name: 'P', address: 0x0803 }] });
add('pinned inside bss', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: bytesSection(1), bss: 4, pinned: [{ name: 'P', address: 0x0803 }] });
add('pinned inside zp', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: bytesSection(1), zp: 4, pinned: [{ name: 'P', address: 0x03 }] });
add('pinned in empty section is fine', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: bytesSection(1), pinned: [{ name: 'P', address: 0x0802 }] });
add('pinned collides with label', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: asm(label('P'), ins('RTS', 'implied')), pinned: [{ name: 'P', address: 0xffd2 }] });
add('two pinned', { codeOrigin: 0x0801, ramCeiling: 0xa000, code: bytesSection(1), pinned: [{ name: 'A', address: 0xffd2 }, { name: 'B', address: 0xffe4 }] });
write('link', rows);
