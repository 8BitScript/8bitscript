// Regenerates fixtures/chr_nes.json: `assembleChrRom` over font.s and hand-made
// sources (macros, operators, division by zero, every error). Run from the repo root:
//   node crates/mos/tests/gen/chr-nes.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleChrRom } from '../../../../packages/compiler/src/mos/chr-nes.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fontPath = 'packages/nes/native/6502/font.s';
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const chr = (body) => `.section .chr_rom,"a"\n${body}`;

/** [name, sources, size]; a source with `file` is read from the repo, the rest carry text. */
const cases = [
  ['font.s', [{ path: fontPath, file: fontPath }], 8192],
  ['font.s small size', [{ path: fontPath, file: fontPath }], 100],
  ['byte list and padding', [{ path: 'a.s', text: chr('.byte 1, 2, 3') }], 16],
  ['empty source', [{ path: 'a.s', text: '' }], 8],
  ['no sources', [], 8],
  ['other section dropped', [{ path: 'a.s', text: '.section .text\n.byte 1\n.section .chr_rom\n.byte 2' }], 4],
  ['no section at all', [{ path: 'a.s', text: '.byte 1, 2' }], 4],
  ['two sources', [{ path: 'a.s', text: chr('.byte 1') }, { path: 'b.s', text: chr('.byte 2') }], 4],
  ['macros are per source', [{ path: 'a.s', text: '.macro m\n.byte 7\n.endm' }, { path: 'b.s', text: chr('m') }], 4],
  ['comments', [{ path: 'a.s', text: chr('.byte 1 ; two\n.byte 3 // four\n// whole line') }], 4],
  ['directives are case blind', [{ path: 'a.s', text: chr('.BYTE 5\n.Space 2') }], 4],
  ['skip and space', [{ path: 'a.s', text: chr('.skip 2\n.space 1+1\n.byte 9') }], 8],
  ['negative space', [{ path: 'a.s', text: chr('.space -3\n.byte 1') }], 4],
  ['space in other section writes nothing', [{ path: 'a.s', text: '.section .data\n.space 5\n.section .chr_rom\n.byte 1' }], 8],
  ['literals', [{ path: 'a.s', text: chr('.byte 42, 0x1F, 0XfF, 0b0110, 0B11, 007') }], 8],
  ['arith', [{ path: 'a.s', text: chr('.byte 2+3*4, (2+3)*4, 10-3-2, 7/2, -7/2, 0-1, - 3, --3, 1 + (2) * 3') }], 16],
  ['bitwise', [{ path: 'a.s', text: chr('.byte 0xf0|0x0f, 0xff^0x0f, 0xf0&0x3c, 1|2&3, 6^3|8, 1+2&3') }], 8],
  ['wide values wrap', [{ path: 'a.s', text: chr('.byte 0x1ff, -1, 0x100000000, 0x123456789, 0xFFFFFFFFFFFFFFFFFF, 3000000000|0, 4294967296|1, 2*2147483648') }], 16],
  ['division by zero', [{ path: 'a.s', text: chr('.byte 1/0, 0/0, -1/0, 5, (1/0)|3, 1/0+1') }], 8],
  ['spaces in expressions', [{ path: 'a.s', text: chr('.byte  ( 1 + 2 ) , 3\t*\t4') }], 4],
  ['rept', [{ path: 'a.s', text: chr('.rept 3\n.byte 1\n.byte 2\n.endr\n.rept 0\n.byte 9\n.endr\n.rept -2\n.byte 9\n.endr') }], 8],
  ['nested rept and macro', [{ path: 'a.s', text: chr('.macro two a\n.byte \\a, \\a+1\n.endm\n.rept 2\ntwo 5\n.rept 2\n.byte 0\n.endr\n.endr') }], 12],
  ['macro, comma params', [{ path: 'a.s', text: chr('.macro m a, b\n.byte \\a, \\b\n.endm\nm 1, 2\nm 3') }], 4],
  ['macro, space params', [{ path: 'a.s', text: chr('.macro m a\n.byte \\a\n.endm\nm 8') }], 4],
  ['macro, prefix names long first', [{ path: 'a.s', text: chr('.macro m r, r1, r10\n.byte \\r, \\r1, \\r10\n.endm\nm 1, 2, 3') }], 4],
  ['macro, prefix names short first', [{ path: 'a.s', text: chr('.macro m r10, r1, r\n.byte \\r, \\r1, \\r10\n.endm\nm 1, 2, 3') }], 4],
  ['macro, equal length names', [{ path: 'a.s', text: chr('.macro m ab, cd\n.byte \\ab, \\cd, \\ab\\cd\n.endm\nm 1, 2') }], 4],
  ['macro name is case sensitive', [{ path: 'a.s', text: chr('.macro Foo\n.byte 1\n.endm\nFoo\nFoo') }], 4],
  ['macro redefined', [{ path: 'a.s', text: chr('.macro m\n.byte 1\n.endm\nm\n.macro m\n.byte 2\n.endm\nm') }], 4],
  ['macro arg with parens', [{ path: 'a.s', text: chr('.macro m a, b\n.byte \\a, \\b\n.endm\nm (1+2), 4') }], 4],
  ['macro arg missing', [{ path: 'a.s', text: chr('.macro m a, b\n.byte \\a, \\b\n.endm\nm 1') }], 4],
  ['ENDM in caps', [{ path: 'a.s', text: chr('.macro m\n.byte 1\n.ENDM\nm') }], 4],
  ['CRLF lines', [{ path: 'a.s', text: chr('.byte 1\r\n.byte 2\r\n') }], 4],
  ['err: unknown line', [{ path: 'a.s', text: 'lda #1' }], 4],
  ['err: label', [{ path: 'a.s', text: 'start:' }], 4],
  ['err: byte operand', [{ path: 'a.s', text: chr('.byte foo') }], 4],
  ['err: percent', [{ path: 'a.s', text: chr('.byte 5 % 2') }], 4],
  ['err: shift', [{ path: 'a.s', text: chr('.byte 1 << 2') }], 4],
  ['err: trailing', [{ path: 'a.s', text: chr('.byte 1 2') }], 4],
  ['err: unclosed paren', [{ path: 'a.s', text: chr('.byte (1+2') }], 4],
  ['err: empty byte arg', [{ path: 'a.s', text: chr('.byte 1,,2') }], 4],
  ['err: space operand', [{ path: 'a.s', text: chr('.space') }], 4],
  ['err: space symbol', [{ path: 'a.s', text: chr('.space n') }], 4],
  ['err: rept count', [{ path: 'a.s', text: chr('.rept x\n.endr') }], 4],
  ['err: rept no endr', [{ path: 'a.s', text: chr('.rept 2\n.byte 1') }], 4],
  ['err: macro no endm', [{ path: 'a.s', text: chr('.macro m\n.byte 1') }], 4],
  ['err: macro no name', [{ path: 'a.s', text: '.macro' }], 4],
  ['err: recursion', [{ path: 'a.s', text: chr('.macro m\nm\n.endm\nm') }], 4],
  ['nested macros expand', [{ path: 'a.s', text: chr('.macro a\n.byte 1\n.endm\n.macro b\na\n.endm\n.macro c\nb\n.endm\nc') }], 4],
  ['err: oversize', [{ path: 'a.s', text: chr('.space 5') }], 4],
  ['oversize boundary: exact size fits', [{ path: 'a.s', text: chr('.space 4') }], 4],
  ['err: negative size, no bytes defined', [{ path: 'a.s', text: chr('') }], -1],
  ['err: negative size, bytes defined', [{ path: 'a.s', text: chr('.byte 1') }], -1],
  ['err: first source wins', [{ path: 'a.s', text: 'bad' }, { path: 'b.s', text: 'worse' }], 4],
];

function textOf(source) {
  return source.file ? readFileSync(root + source.file, 'utf8') : source.text;
}

const rows = cases.map(([name, sources, size]) => {
  const input = sources.map((s) => ({ path: s.path, text: textOf(s) }));
  const row = { name, size, sources: sources.map((s) => ({ path: s.path, ...(s.file ? { file: s.file } : { text: s.text }) })) };
  try {
    const r = assembleChrRom(input, size);
    row.result = r.ok ? { ok: true, bytes: hex(r.bytes), defined: r.defined } : { ok: false, error: r.error };
  } catch (e) {
    row.result = { threw: e.constructor.name };
  }
  return row;
});

const target = fileURLToPath(new URL('../fixtures/chr_nes.json', import.meta.url));
writeFileSync(target, JSON.stringify(rows) + '\n');
console.log(`chr_nes: ${rows.length} rows`);
