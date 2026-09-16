// The zero-cost-abstraction benchmark the 8BX spec names (§69): a menu
// bar written as elements must build to the same bytes as the same bar
// written as the calls it wraps. A slotted component is two functions
// around its children; with every prop compile-time, the linker's inliner
// folds both halves and each item away, and what reaches the machine is
// the hand-written program. This is that claim, measured, on the two
// machines with the least and the most room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

// Keep the CLI's own "built …" / "memory: …" lines out of the test
// output, and nothing else: the test reporter writes to the same stream,
// and a previous test's result line can land while this one is building.
const CLI_LINE = /^(built |memory: |size breakdown|web bundle: |8bs build: )/;
function silently(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : out(chunk, ...rest));
  process.stderr.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : err(chunk, ...rest));
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  });
}

/** Build `files` (a config is written for them) for `target`, resolving packages from this checkout. */
async function buildProject(files, target) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-menubar-bx-'));
  const prev = process.cwd();
  try {
    mkdirSync(join(dir, 'src'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'src', name), text);
    writeFileSync(join(dir, '8bitscript.config.ts'), "export default { entry: 'src/main.8bs', targets: ['pet', 'c64', 'web'] };\n");
    process.chdir(dir);
    const result = await silently(() => compile(target, undefined, { checkout: REPO }));
    assert.equal(result.ok, true, `builds for ${target}`);
    return await readFile(result.outFile);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

// A bar with the menu bar's call shape — begin(row, width), item(label),
// end() — with bodies the native backend lowers today. The real
// @8bitscript/ui/menubar's item() stores into a usmallint array, which
// the 6502 backend does not write yet ("a 2-byte array element isn't
// written yet"), so the real bar cannot be built for the PET by hand
// either; when it can, swap this for the package and the assertion is the
// same.
const BAR = `export namespace bar {
    function begin(row: utinyint, width: utinyint): void {
        memory.write(0x8000, row);
        memory.write(0x8001, width);
    }
    function item(label: string): void {
        memory.write(0x8002, label.length);
    }
    function end(): void {
        memory.write(0x8003, 1);
    }
}
`;

const HAND = {
  'bar.8bs': BAR,
  'main.8bs': `import { bar } from "./bar.8bs";
export function main(): void {
    bar.begin(0, 40);
    bar.item("FILE");
    bar.item("EDIT");
    bar.end();
}
`,
};

const BX = {
  'bar.8bs': BAR,
  'Bar.8bx': `import { bar } from "./bar.8bs";
export component MenuBar(row: utinyint, width: utinyint) {
    bar.begin(row, width);
    <slot />;
    bar.end();
}
export component MenuItem(label: string) {
    bar.item(label);
}
export function draw(): void {
    <MenuBar row={0} width={40}>
        <MenuItem label="FILE" />
        <MenuItem label="EDIT" />
    </MenuBar>;
}
`,
  'main.8bs': `import { draw } from "./Bar.8bx";
export function main(): void {
    draw();
}
`,
};

for (const target of ['pet', 'c64']) {
  test(`the menu bar as elements builds to the same bytes as the calls it wraps, on the ${target} (§69)`, async () => {
    const hand = await buildProject(HAND, target);
    const bx = await buildProject(BX, target);
    assert.equal(bx.length, hand.length, `${target}: same size (${bx.length} vs ${hand.length} bytes)`);
    assert.deepEqual([...bx], [...hand], `${target}: same bytes`);
  });
}
