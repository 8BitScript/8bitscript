// Regenerates fixtures/image.json: the image table, `prelude` and `file` for every
// machine at its sheet load address and at 3 bodies, `basicStub`, and
// `buildDataSection`. Run from the repo root:
//   node crates/mos/tests/gen/image.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { imageFor } from '../../../../packages/compiler/src/mos/image.ts';
import { basicStub } from '../../../../packages/compiler/src/mos/basic-stub.ts';
import { buildDataSection } from '../../../../packages/compiler/src/mos/data.ts';

const machines = [
  'vic20', 'c64', 'pet', 'c128', 'mega65', 'cx16', 'nes', 'atari8', 'plus4', 'oric', 'apple2',
  'bbc', 'atari5200', 'lynx', 'pce', 'supervision', 'atari2600', 'atari7800',
];
const root = fileURLToPath(new URL('../../../../', import.meta.url));
function sheetLoad(machine) {
  const path = `${root}packages/${machine}/package.json`;
  if (!existsSync(path)) return 0x8000;
  const found = [...readFileSync(path, 'utf8').matchAll(/"__load_address":\s*(\d+)/g)];
  return found.length ? Number(found[0][1]) : 0x8000;
}
const bodies = [[], [0xa9], Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) & 0xff)];
// FNV-1a over the bytes, so a 32 KiB ROM costs one number in the fixture.
const fnv = (bytes) => {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
};
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const images = machines.map((machine) => {
  const image = imageFor(machine);
  const load = sheetLoad(machine);
  const p = image.prelude(load);
  const row = {
    machine,
    load,
    entryIsVectored: image.entryIsVectored,
    writableImage: image.writableImage ?? null,
    endsByHalting: image.endsByHalting ?? null,
    prelude: { bytes: hex(p.bytes), codeStart: p.codeStart },
    files: [],
  };
  if (machine !== 'nes') {
    for (const body of bodies) {
      const b = Uint8Array.from(body);
      const full = new Uint8Array(p.bytes.length + b.length);
      full.set(p.bytes, 0);
      full.set(b, p.bytes.length);
      const out = image.file(load, full, p.codeStart, { nativeSources: [] });
      row.files.push({ body: hex(full), fileLen: out.length, fileFnv: fnv(out), fileHead: hex(out.subarray(0, 16)), fileTail: hex(out.subarray(-16)) });
    }
  }
  return row;
});

const stubs = [0x0401, 0x0801, 0x1001, 0x1201, 0x9999, 0xfff0].map((load) => {
  const s = basicStub(load);
  return { load, bytes: hex(s.bytes), codeStart: s.codeStart };
});

const strings = [
  { text: 'Hi', bytes: [72, 105] },
  { text: '', bytes: [] },
  { text: 'A!', bytes: [65, 33] },
];
const arrays = [
  { name: 'bytes', type: 'utinyint', array: 3, init: [1, 2, 255] },
  { name: 'words', type: 'usmallint', array: 2, init: [0x1234, 0xffff] },
  { name: 'wide', type: 'umediumint', array: 2, init: [0x123456, 0xabcdef] },
];
const strip = (list) => JSON.parse(JSON.stringify(list));
const dataCases = [
  { strings, arrays, usedIndexes: null },
  { strings, arrays: [], usedIndexes: [0, 2] },
  { strings: [], arrays, usedIndexes: [] },
].map((c) => ({
  ...c,
  result: strip(buildDataSection(c.strings, c.arrays, c.usedIndexes ? new Set(c.usedIndexes) : undefined)),
}));

const target = fileURLToPath(new URL('../fixtures/image.json', import.meta.url));
writeFileSync(target, JSON.stringify({ images, stubs, dataCases }) + '\n');
console.log(`images ${images.length}, stubs ${stubs.length}, data ${dataCases.length}`);
