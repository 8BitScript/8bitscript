// A 2-byte-element array of more than 128 elements, read and written under
// xpet. The 6502 backend used to double the index in A (ASL) and hand the
// result to Y, so element 128 and up lost the carry and landed 256 bytes
// short: on the 80-column PET 8032 a 185-place marquee ring wrote its places
// 128..184 over places 0..56 (vegas-nights, src/shared/fx.pet.8bs). The fix
// computes the byte offset in 16 bits whenever the array can reach past byte
// 255 (packages/compiler/src/mos/lower/index.ts, arrayPointer16).
//
// The probe (packages/compiler/test/fixtures/wide-array-probe.mjs) lights one
// screen cell for every check that passes, so a failure names the element.
// packages/compiler/src/mos/lower/index.test.ts pins the emitted code in CI,
// where no emulator runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BYTES, BYTES_AT, RING_AT, SPECIAL, SPECIAL_AT, TABLE_AT, WIDE, widePointerProbe } from '../../compiler/test/fixtures/wide-array-probe.mjs';
import { GEOMETRY, SKIP, isLit, shoot } from './graphics-helpers.mjs';

for (const [model, columns, hardware] of [['4032', 40, 'model=4032,ram=32'], ['8032', 80, 'model=8032,ram=32,speaker=attached']]) {
  test(`a ${WIDE}-element usmallint array and a ${BYTES}-element byte array read back exactly on the PET ${model}`, { skip: SKIP, timeout: 240_000 }, async () => {
    const scratch = mkdtempSync(join(tmpdir(), '8bs-array-wide-'));
    try {
      const file = join(scratch, 'array-wide.8bs');
      writeFileSync(file, widePointerProbe(0x8000));
      const geometry = GEOMETRY[model];
      const image = await shoot(scratch, { file }, hardware, 600, 'wide');
      const lit = (cell) => {
        const col = cell % columns;
        const row = Math.floor(cell / columns);
        return isLit(image, geometry.x0 + col * 8 + 4, geometry.y0 + row * geometry.pitch + 4);
      };
      const wrong = [];
      for (let i = 0; i < WIDE; i += 1) if (!lit(RING_AT + i)) wrong.push(`ring[${i}]`);
      for (let i = 0; i < WIDE; i += 1) if (!lit(TABLE_AT + i)) wrong.push(`TABLE[${i}]`);
      for (let i = 0; i < BYTES; i += 1) if (!lit(BYTES_AT + i)) wrong.push(`bytes[${i}]`);
      SPECIAL.forEach((name, i) => { if (!lit(SPECIAL_AT + i)) wrong.push(name); });
      assert.deepEqual(wrong, [], `${wrong.length} wrong, first: ${wrong.slice(0, 8).join(', ')}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
