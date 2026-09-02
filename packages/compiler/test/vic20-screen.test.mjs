// The VIC-20 screen colour abstraction in packages/vic20/src/index.8bs: the
// first proof of "friendly API -> library code -> memory.read/write" this
// milestone establishes. See docs/compiler.md and the package source itself
// for the register bit layout this is built on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link, tokenize, parse, lower } from '../index.mjs';
import { emitC } from '../../backend-6502/src/index.mjs';
import { buildWasm } from '../../backend-web/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// hello-vic already depends on @8bitscript/vic20 with workspace:*, so this
// resolves through a real pnpm-linked node_modules, not a hand-rolled
// fixture — the entry text is passed directly; only its directory needs to
// exist for the resolver to walk up from.
const HELLO_VIC_SRC = join(HERE, '..', '..', '..', 'examples', 'hello-vic', 'src');
const VIC20_SOURCE_FILE = join(HERE, '..', '..', 'vic20', 'src', 'index.8bs');

// ---- the real package: BorderColor/BackgroundColor have the sizes the VIC-20 actually supports ----

const vic20Ir = () => {
  const src = readFileSync(VIC20_SOURCE_FILE, 'utf8');
  const { tokens } = tokenize(src, VIC20_SOURCE_FILE);
  const { ast } = parse(tokens, src, VIC20_SOURCE_FILE);
  return lower(ast, VIC20_SOURCE_FILE).ir;
};

test('BorderColor has exactly the 8 colours the border field can hold', () => {
  const ir = vic20Ir();
  const border = ir.namespaces.find((ns) => ns.name === 'BorderColor');
  assert.equal(border.consts.size, 8);
  assert.deepEqual([...border.consts.keys()], [
    'Black', 'White', 'Red', 'Cyan', 'Purple', 'Green', 'Blue', 'Yellow',
  ]);
  assert.deepEqual([...border.consts.values()], [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('BackgroundColor has all 16 colours the background field can hold', () => {
  const ir = vic20Ir();
  const background = ir.namespaces.find((ns) => ns.name === 'BackgroundColor');
  assert.equal(background.consts.size, 16);
  assert.deepEqual([...background.consts.values()], [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  ]);
});

// ---- a real consumer, linked against the real package -------------------

test('a program using screen.setBorderColor/setBackgroundColor links against the real vic20 package', () => {
  const consumer = [
    'import { screen, BorderColor, BackgroundColor } from "@8bitscript/vic20";',
    'export function main(): void {',
    '    screen.setBackgroundColor(BackgroundColor.Black);',
    '    screen.setBorderColor(BorderColor.Blue);',
    '}',
  ].join('\n');
  const entryFile = join(HELLO_VIC_SRC, 'screen-consumer.8bs');
  const { ir, diagnostics } = link(consumer, entryFile);
  assert.deepEqual(diagnostics, []);

  const c = emitC(ir);
  assert.match(c, /screen_setBackgroundColor\(0\);/);
  assert.match(c, /screen_setBorderColor\(6\);/); // BorderColor.Blue inlined
  // The $900F register address never appears as a symbol name — only as the
  // literal address both functions read/write, exactly once each, named
  // nowhere but inside the (unexported) VicRegisters namespace.
  assert.match(c, /\*\(volatile uint8_t \*\)36879/);
});

test('referencing a colour name a namespace does not have is a compile error', () => {
  // BorderColor has no Orange member — only BackgroundColor does, because
  // the border field is only 3 bits wide. The 8 real border colours are the
  // only names BorderColor exposes, which is what makes a value like this
  // unrepresentable at all rather than merely unwise.
  const consumer = [
    'import { screen, BorderColor } from "@8bitscript/vic20";',
    'export function main(): void { screen.setBorderColor(BorderColor.Orange); }',
  ].join('\n');
  const entryFile = join(HELLO_VIC_SRC, 'screen-consumer-bad.8bs');
  const { ir, diagnostics } = link(consumer, entryFile);
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2005']);
});

// ---- runtime correctness of the read-modify-write masking ----------------
//
// packages/vic20 itself cannot build for the web target — it also exports
// vicColor, an `@address` hardware global, and the web backend correctly
// refuses any module that maps hardware (see backend-web's own tests). So
// this mirrors the exact expressions setBorderColor/setBackgroundColor use,
// against a plain scratch address instead of the real $900F, and runs the
// compiled wasm for real — proving the masking arithmetic itself, not just
// what the generated code looks like.
const MASKING_SOURCE = [
  'export function setBorderColor(color: utinyint): void {',
  '    memory.write(0x1000, (memory.read(0x1000) & 0xF8) | (color & 0x07));',
  '}',
  'export function setBackgroundColor(color: utinyint): void {',
  '    memory.write(0x1000, (memory.read(0x1000) & 0x0F) | ((color & 0x0F) << 4));',
  '}',
  'export function readRegister(): utinyint {',
  '    return memory.read(0x1000);',
  '}',
].join('\n');

async function instantiateMaskingModule() {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), '8bs-vic20-mask-'));
  try {
    const { ir } = link(MASKING_SOURCE, join(dir, 'main.8bs'));
    const outFile = join(dir, 'm.wasm');
    const result = await buildWasm(ir, { outFile });
    assert.ok(result.ok, result.error);
    const { readFile } = await import('node:fs/promises');
    const { instance } = await WebAssembly.instantiate(await readFile(outFile));
    return instance.exports;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('changing the border colour preserves the background and reverse-video bits', async () => {
  const exports = await instantiateMaskingModule();
  exports.setBackgroundColor(13); // an arbitrary non-zero background
  exports.setBorderColor(6);
  const register = exports.readRegister();
  assert.equal(register & 0x07, 6, 'border bits');
  assert.equal((register >> 4) & 0x0F, 13, 'background bits must survive');
});

test('changing the background colour preserves the border', async () => {
  const exports = await instantiateMaskingModule();
  exports.setBorderColor(3);
  exports.setBackgroundColor(9);
  const register = exports.readRegister();
  assert.equal(register & 0x07, 3, 'border bits must survive');
  assert.equal((register >> 4) & 0x0F, 9, 'background bits');
});

test('every border colour (0..7) encodes to exactly its own 3 bits', async () => {
  const exports = await instantiateMaskingModule();
  exports.setBackgroundColor(15); // fixed, to prove it is never disturbed
  for (let color = 0; color <= 7; color += 1) {
    exports.setBorderColor(color);
    const register = exports.readRegister();
    assert.equal(register & 0x07, color, `border=${color}`);
    assert.equal((register >> 4) & 0x0F, 15, `background must stay 15 while border=${color}`);
  }
});

test('every background colour (0..15) encodes to exactly its own 4 bits', async () => {
  const exports = await instantiateMaskingModule();
  exports.setBorderColor(5); // fixed, to prove it is never disturbed
  for (let color = 0; color <= 15; color += 1) {
    exports.setBackgroundColor(color);
    const register = exports.readRegister();
    assert.equal((register >> 4) & 0x0F, color, `background=${color}`);
    assert.equal(register & 0x07, 5, `border must stay 5 while background=${color}`);
  }
});
