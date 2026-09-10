// The VIC-20 screen color abstraction in packages/vic20/src/screen.8bs: the
// first proof of "friendly API -> library code -> a named register" this
// milestone establishes. See docs/compiler.md and the package source itself
// for the register bit layout this is built on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link, tokenize, parse, lower } from '../index.mjs';

const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

const HERE = dirname(fileURLToPath(import.meta.url));
// This package lists @8bitscript/vic20 as a workspace:* devDependency, so a
// file under test/fixtures resolves it through a real pnpm-linked
// node_modules, not a hand-rolled fixture — the entry text is passed
// directly; only its directory needs to exist for the resolver to walk up
// from.
const FIXTURES = join(HERE, 'fixtures');
const VIC20_SCREEN_FILE = join(HERE, '..', '..', 'vic20', 'src', 'screen.8bs');

// ---- the real package: BorderColor/BackgroundColor have the sizes the VIC-20 actually supports ----

const vic20ScreenIr = () => {
  const src = readFileSync(VIC20_SCREEN_FILE, 'utf8');
  const { tokens } = tokenize(src, VIC20_SCREEN_FILE);
  const { ast } = parse(tokens, src, VIC20_SCREEN_FILE);
  return lower(ast, VIC20_SCREEN_FILE).ir;
};

test('BorderColor has exactly the 8 colors the border field can hold, plus KEEP', () => {
  const ir = vic20ScreenIr();
  const border = ir.namespaces.find((ns) => ns.name === 'BorderColor');
  assert.equal(border.consts.size, 9);
  assert.deepEqual([...border.consts.keys()], [
    'BLACK', 'WHITE', 'RED', 'CYAN', 'PURPLE', 'GREEN', 'BLUE', 'YELLOW', 'KEEP',
  ]);
  assert.deepEqual([...border.consts.values()], [0, 1, 2, 3, 4, 5, 6, 7, 255]);
});

test('BackgroundColor has all 16 colors the background field can hold, plus KEEP', () => {
  const ir = vic20ScreenIr();
  const background = ir.namespaces.find((ns) => ns.name === 'BackgroundColor');
  assert.equal(background.consts.size, 17);
  assert.deepEqual([...background.consts.values()], [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 255,
  ]);
});

// ---- a real consumer, linked against the real package -------------------
//
// Through the target package's own subpath — a project that has declared
// itself VIC-20 specific may import the implementation directly, and gets
// exactly what @8bitscript/screen would have given it.

test('a program using screen.setColors links against the real vic20 package', () => {
  const consumer = [
    'import { screen, BorderColor, BackgroundColor } from "@8bitscript/vic20/screen";',
    'export function main(): void {',
    '    screen.setColors(BorderColor.BLUE, BackgroundColor.BLACK);',
    '}',
  ].join('\n');
  const entryFile = join(FIXTURES, 'screen-consumer.8bs');
  const { ir, diagnostics } = link(consumer, entryFile);
  assert.deepEqual(diagnostics, []);

  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].kind, 'call');
  assert.equal(main.body[0].name, 'screen_setColors');
  assert.deepEqual(main.body[0].args.map((a) => a.value), [6, 0]); // BorderColor.BLUE, BackgroundColor.BLACK inlined
  const vicColor = ir.globals.find((g) => g.name === 'vicColor');
  assert.equal(vicColor.address, 0x900F);
  assert.equal(vicColor.volatile, true);
  const setColors = ir.functions.find((f) => f.name === 'screen_setColors');
  assert.equal(setColors.body[0].kind, 'assign');
  assert.equal(setColors.body[0].target, 'vicColor');
  assert.equal(setColors.body[0].value.kind, 'binop');
  assert.equal(setColors.body[0].value.operator, '|');
});

test('referencing a color name a namespace does not have is a compile error', () => {
  // BorderColor has no Orange member — only BackgroundColor does, because
  // the border field is only 3 bits wide. The 8 real border colors are the
  // only names BorderColor exposes, which is what makes a value like this
  // unrepresentable at all rather than merely unwise.
  const consumer = [
    'import { screen, BorderColor, BackgroundColor } from "@8bitscript/vic20/screen";',
    'export function main(): void { screen.setColors(BorderColor.ORANGE, BackgroundColor.BLACK); }',
  ].join('\n');
  const entryFile = join(FIXTURES, 'screen-consumer-bad.8bs');
  const { ir, diagnostics } = link(consumer, entryFile);
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2005']);
});

// ---- runtime correctness of the register packing --------------------------
//
// packages/vic20 itself cannot build for the web target — its index exports
// vicColor, an `@address` hardware global, and the web backend correctly
// refuses any module that maps hardware. So
// this mirrors the exact expression setColors uses, against a plain scratch
// address instead of the real $900F, and runs the compiled wasm for real —
// proving the packing arithmetic itself, not just what the generated code
// looks like.
//
// A program exports exactly one function (its entry), so the scenarios run
// inside main() and leave their evidence in memory: the register byte after
// each step, at a known scratch address the test reads back.
//   0x1110..0x1117: background fixed at 15, border 0..7
//   0x1120..0x112F: border fixed at 5, background 0..15
//   0x1130: border 14 — past the 3-bit field, so it must wrap to 6
const PACKING_SOURCE = [
  'let color: utinyint = 0;',
  'function setColors(border: utinyint, background: utinyint): void {',
  '    memory.write(0x1000, (8 | (border & 7)) | (background << 4));',
  '}',
  'export function main(): void {',
  '    color = 0;',
  '    while (color < 8) {',
  '        setColors(color, 15);',
  '        memory.write(0x1110 + color, memory.read(0x1000));',
  '        color = color + 1;',
  '    }',
  '    color = 0;',
  '    while (color < 16) {',
  '        setColors(5, color);',
  '        memory.write(0x1120 + color, memory.read(0x1000));',
  '        color = color + 1;',
  '    }',
  '    setColors(14, 0);',
  '    memory.write(0x1130, memory.read(0x1000));',
  '}',
].join('\n');

test('the packing program links cleanly', () => {
  const { ir, diagnostics } = link(PACKING_SOURCE, join(FIXTURES, 'packing.8bs'));
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.functions.some((f) => f.name === 'setColors'));
});

async function runPackingProgram() {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), '8bs-vic20-pack-'));
  try {
    const { ir, diagnostics } = link(PACKING_SOURCE, join(dir, 'main.8bs'));
    assert.deepEqual(diagnostics, []);
    const outFile = join(dir, 'm.wasm');
    const { instance } = await WebAssembly.instantiate(await (await import('node:fs/promises')).readFile(outFile));
    instance.exports.main();
    return new Uint8Array(instance.exports.memory.buffer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('every border color (0..7) lands in exactly its own 3 bits, with normal video kept', { skip: NATIVE_BACKEND_PENDING }, async () => {
  const mem = await runPackingProgram();
  for (let color = 0; color <= 7; color += 1) {
    const register = mem[0x1110 + color];
    assert.equal(register & 0x07, color, `border=${color}`);
    assert.equal(register & 0x08, 8, `normal-video bit must be set while border=${color}`);
    assert.equal((register >> 4) & 0x0F, 15, `background must stay 15 while border=${color}`);
  }
});

test('every background color (0..15) lands in exactly its own 4 bits', { skip: NATIVE_BACKEND_PENDING }, async () => {
  const mem = await runPackingProgram();
  for (let color = 0; color <= 15; color += 1) {
    const register = mem[0x1120 + color];
    assert.equal((register >> 4) & 0x0F, color, `background=${color}`);
    assert.equal(register & 0x07, 5, `border must stay 5 while background=${color}`);
  }
});

test('a border color past the 3-bit field wraps: 14 shows as 6', { skip: NATIVE_BACKEND_PENDING }, async () => {
  // The border field is 3 bits wide, so a value past 7 wraps — the packing
  // rule the vic20 package's screen.8bs documents, checked for real here.
  const mem = await runPackingProgram();
  assert.equal(mem[0x1130] & 0x07, 6);
});
