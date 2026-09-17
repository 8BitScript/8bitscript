// The zero-cost gate for a forwarder (spec §30, §64): a component or
// function whose body is one call passing its own parameters through
// must build to the same bytes as the program that makes that call by
// hand — run-time arguments and all, at any number of sites, across an
// import boundary. hello-bx proves this for compile-time props; 2048 #49
// found the run-time case +36 bytes on the PET 2001, and #45 +53 bytes
// across a module — the three programs below are those cases, on the
// machine with the least to spare.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from '../src/mos/index.ts';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';
import { linkFiles } from './support/link-files.mjs';

const petHardware = () => {
  const resolved = resolveHardware(loadCatalog('pet'), {});
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  return resolved.hardware;
};

/** Link `files` from `entry` and build the PET image; the bytes of the program. */
async function petBytes(files, entry) {
  const { ir, diagnostics } = linkFiles(files, entry, { bx: { strict: false } });
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [], entry);
  const dir = mkdtempSync(join(tmpdir(), '8bs-forward-'));
  try {
    const result = await build(ir, { machine: 'pet', hardware: petHardware(), outFile: join(dir, 'out.prg'), frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    return [...result.bytes];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The callee: three run-time values into three cells, so the arguments are
// real loads and stores and nothing here folds to a constant.
const DRAW = `export let cursor: utinyint = 0;
export function drawTile(row: utinyint, col: utinyint, exponent: utinyint): void {
    memory.write(0x8000 + cursor, row);
    memory.write(0x8001 + cursor, col);
    memory.write(0x8002 + cursor, exponent);
    cursor = cursor + 3;
}
`;

// The program: three sites, each with the values a loop produces, one of
// them with the props spelled in a different order.
const DIRECT = `import { drawTile, cursor } from "./draw.8bs";
export function main(): void {
    for (let i: utinyint = 0; i < 16; i++) {
        drawTile(i >> 2, i & 3, cursor);
        drawTile(i, 1, cursor + 1);
    }
    drawTile(cursor, 2, 3);
}
`;

test('a component forwarding run-time props to a call costs nothing: the same bytes as calling it by hand, at three sites', async () => {
  const direct = await petBytes({ 'draw.8bs': DRAW, 'main.8bs': DIRECT }, 'main.8bs');
  const wrapped = await petBytes({
    'draw.8bs': DRAW,
    'main.8bx': `import { drawTile, cursor } from "./draw.8bs";
component Tile(row: utinyint, col: utinyint, exponent: utinyint) {
    drawTile(row, col, exponent);
}
export function main(): void {
    for (let i: utinyint = 0; i < 16; i++) {
        <Tile row={i >> 2} col={i & 3} exponent={cursor} />;
        <Tile exponent={cursor + 1} row={i} col={1} />;
    }
    <Tile row={cursor} col={2} exponent={3} />;
}
`,
  }, 'main.8bx');
  assert.equal(wrapped.length, direct.length, 'same size');
  assert.deepEqual(wrapped, direct, 'same bytes');
});

test('the same across an import boundary — the component in its own .8bx, the callee in a third module (2048 #45)', async () => {
  const direct = await petBytes({ 'draw.8bs': DRAW, 'main.8bs': DIRECT }, 'main.8bs');
  const wrapped = await petBytes({
    'draw.8bs': DRAW,
    'Tile.8bx': `import { drawTile } from "./draw.8bs";
export component Tile(row: utinyint, col: utinyint, exponent: utinyint) {
    drawTile(row, col, exponent);
}
`,
    'main.8bs': `import { cursor } from "./draw.8bs";
import { Tile } from "./Tile.8bx";
export function main(): void {
    for (let i: utinyint = 0; i < 16; i++) {
        Tile(i >> 2, i & 3, cursor);
        Tile(i, 1, cursor + 1);
    }
    Tile(cursor, 2, 3);
}
`,
  }, 'main.8bs');
  assert.equal(wrapped.length, direct.length, 'same size');
  assert.deepEqual(wrapped, direct, 'same bytes');
});

test('a `return f(x);` delegate in .8bs costs nothing either — the shape 2048\'s rng.range() warned was +8 bytes', async () => {
  const lib = `export let seed: utinyint = 7;
export function next(): utinyint {
    seed = seed * 5 + 1;
    return seed;
}
export function range(bound: utinyint): utinyint {
    return next() % bound;
}
`;
  const direct = await petBytes({
    'random.8bs': lib,
    'main.8bs': `import { range, seed } from "./random.8bs";
export function main(): void {
    for (let i: utinyint = 0; i < 16; i++) {
        memory.write(0x8000 + i, range(seed));
        memory.write(0x8100 + i, range(10));
    }
}
`,
  }, 'main.8bs');
  const delegated = await petBytes({
    'random.8bs': lib,
    'rng.8bs': `import { range as inner } from "./random.8bs";
export function range(bound: utinyint): utinyint {
    return inner(bound);
}
`,
    'main.8bs': `import { seed } from "./random.8bs";
import { range } from "./rng.8bs";
export function main(): void {
    for (let i: utinyint = 0; i < 16; i++) {
        memory.write(0x8000 + i, range(seed));
        memory.write(0x8100 + i, range(10));
    }
}
`,
  }, 'main.8bs');
  assert.equal(delegated.length, direct.length, 'same size');
  assert.deepEqual(delegated, direct, 'same bytes');
});

test('the wrapper was not free before: a forwarder that passes a global through is still a real function', async () => {
  // The control for the tests above — a body that is not a forwarder keeps
  // the wrapper, so "same bytes" above is the rule firing, not a program
  // too small to show the difference.
  const direct = await petBytes({ 'draw.8bs': DRAW, 'main.8bs': DIRECT }, 'main.8bs');
  const wrapped = await petBytes({
    'draw.8bs': DRAW,
    'main.8bx': `import { drawTile, cursor } from "./draw.8bs";
component Tile(row: utinyint, col: utinyint) {
    drawTile(row, col, cursor);
}
export function main(): void {
    for (let i: utinyint = 0; i < 16; i++) {
        <Tile row={i >> 2} col={i & 3} />;
        <Tile row={i} col={1} />;
    }
    <Tile row={cursor} col={2} />;
}
`,
  }, 'main.8bx');
  assert.notEqual(wrapped.length, direct.length, 'a different program, so a different size');
});
