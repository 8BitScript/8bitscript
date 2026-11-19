// Regenerates fixtures/image_nes.json: `NES.file` with and without chrPatches,
// the two throws, and an oversize CHR. Run from the repo root:
//   node crates/mos/tests/gen/image-nes.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NES } from '../../../../packages/compiler/src/mos/image-nes.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const font = 'packages/nes/native/6502/font.s';
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fnv = (bytes) => {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
};
const chrText = (body) => `.section .chr_rom,"a"\n${body}`;
const small = chrText('.byte 1, 2, 3');
const big = Array.from({ length: 300 }, (_, i) => (i * 5 + 1) & 0xff);
const body4k = Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) & 0xff);
const full = Array.from({ length: 0x7ff9 }, (_, i) => i & 0xff);

/** [name, load, body, codeStart, nativeSources ({file}|{text}), chrPatches] */
const cases = [
  ['font, empty body', 0x8000, [], 0x8000, [{ file: font }], undefined],
  ['font, 1 byte', 0x8000, [0xa9], 0x8000, [{ file: font }], undefined],
  ['font, 4 KiB body', 0x8000, body4k, 0x8000, [{ file: font }], undefined],
  ['font, code start inside', 0x8000, [0xea, 0xea], 0x8123, [{ file: font }], undefined],
  ['font, patches', 0x8000, [0xa9], 0x8000, [{ file: font }], [{ tile: 1, bytes: [255, 254, 253] }, { tile: 511, bytes: [7] }]],
  ['font, patch wraps bytes', 0x8000, [], 0x8000, [{ file: font }], [{ tile: 0, bytes: [256, -1, 300, 1.5] }]],
  ['font, patch past the end is skipped', 0x8000, [], 0x8000, [{ file: font }], [{ tile: 511, bytes: new Array(17).fill(9) }, { tile: 600, bytes: [1] }]],
  ['font, patch fits exactly', 0x8000, [], 0x8000, [{ file: font }], [{ tile: 511, bytes: new Array(16).fill(9) }]],
  ['font, negative patch tile throws', 0x8000, [], 0x8000, [{ file: font }], [{ tile: -1, bytes: [1] }]],
  ['font, empty patch list', 0x8000, [], 0x8000, [{ file: font }], []],
  ['font, empty patch bytes at the end', 0x8000, [], 0x8000, [{ file: font }], [{ tile: 512, bytes: [] }]],
  ['small chr, patches later win', 0x8000, [0x60], 0x8000, [{ text: small }], [{ tile: 0, bytes: [9] }, { tile: 0, bytes: [8, 7] }]],
  ['two sources', 0x8000, [0x60], 0x8000, [{ text: small }, { text: chrText('.byte 4') }], undefined],
  ['body to the vector table limit', 0x8000, full, 0x8000, [{ text: small }], undefined],
  ['err: no native sources', 0x8000, [], 0x8000, [], undefined],
  ['err: sources define no chr', 0x8000, [], 0x8000, [{ text: '.section .text\n.byte 1' }], undefined],
  ['err: bad chr source', 0x8000, [], 0x8000, [{ text: 'lda #1' }], undefined],
  ['err: oversize chr', 0x8000, [], 0x8000, [{ text: chrText('.space 8193') }], undefined],
  ['chr exactly 8192', 0x8000, [], 0x8000, [{ text: chrText('.space 8191\n.byte 1') }], undefined],
  ['err: load address 0x4000', 0x4000, [], 0x4000, [{ file: font }], undefined],
  ['err: load address 0xC000', 0xc000, [1], 0xc000, [{ file: font }], undefined],
  ['err: load address 0', 0, [], 0, [{ file: font }], undefined],
  ['err: body one byte too long', 0x8000, [...full, 0], 0x8000, [{ text: small }], undefined],
  ['err: code start past the table', 0x8000, [1], 0xfff9, [{ text: small }], undefined],
  ['err: code start below 0x8000', 0x8000, [1], 0x7000, [{ text: small }], undefined],
];

const tmp = mkdtempSync(`${tmpdir()}/image-nes-`);
const rows = cases.map(([name, load, body, codeStart, sources, chrPatches]) => {
  const row = { name, load, body: hex(body), codeStart, sources: sources.map((s, i) => (s.file ? s : { ...s, path: `native-${i}.s` })), ...(chrPatches ? { chrPatches } : {}) };
  // The JS reads paths; the port gets texts, so point JS at real files.
  const paths = sources.map((s, i) => {
    if (s.file) return root + s.file;
    const path = `${tmp}/native-${i}.s`;
    writeFileSync(path, s.text);
    return path;
  });
  try {
    const out = NES.file(load, Uint8Array.from(body), codeStart, { nativeSources: paths, chrPatches });
    row.result = {
      ok: true,
      len: out.length,
      fnv: fnv(out),
      head: hex(out.subarray(0, 16)),
      prgTail: hex(out.subarray(16 + 32768 - 16, 16 + 32768)),
      chrHead: hex(out.subarray(16 + 32768, 16 + 32768 + 64)),
      chrTail: hex(out.subarray(-64)),
      codeHead: hex(out.subarray(16 + (codeStart - 0x8000 >= 0 ? codeStart - 0x8000 : 0), 16 + (codeStart - 0x8000 >= 0 ? codeStart - 0x8000 : 0) + 8)),
    };
  } catch (e) {
    row.result = e.constructor === Error ? { ok: false, error: e.message.replaceAll(`${tmp}/`, '') } : { threw: e.constructor.name };
  }
  return row;
});

const target = fileURLToPath(new URL('../fixtures/image_nes.json', import.meta.url));
writeFileSync(target, JSON.stringify(rows) + '\n');
console.log(`image_nes: ${rows.length} rows`);
