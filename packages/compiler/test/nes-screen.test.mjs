// The NES target package and the mechanism it needed: a package's
// "8bitscript".native files (packages/nes/native/6502/font.s, the CHR-ROM
// character set) riding through resolver and linker to the 6502 backend.
// See packages/nes/src/index.8bs for why the NES, alone among the targets,
// has to ship its own letters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link, resolveSpecifier } from '../index.mjs';
import { emitC } from '../../backend-6502/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// examples/borders depends on @8bitscript/screen and @8bitscript/text,
// whose nes branches delegate to @8bitscript/nes/screen and
// @8bitscript/nes/text — the real pnpm-linked graph, not a fixture.
const BORDERS_SRC = join(HERE, '..', '..', '..', 'examples', 'borders', 'src');
const ENTRY = join(BORDERS_SRC, 'nes-consumer.8bs');

test('resolving @8bitscript/text for nes carries the CHR-ROM font as a native source', () => {
  // The font is the package's, so it rides along with either subpath.
  for (const [pkg, file] of [['@8bitscript/text', 'text.8bs'], ['@8bitscript/screen', 'screen.8bs']]) {
    const resolved = resolveSpecifier(pkg, ENTRY, { machine: 'nes' });
    assert.ok(resolved.path.endsWith(join('nes', 'src', file)), resolved.path);
    assert.equal(resolved.native.length, 1);
    assert.ok(resolved.native[0].endsWith(join('nes', 'native', '6502', 'font.s')), resolved.native[0]);
  }
});

test('a target with no native files resolves with an empty list, not a missing field', () => {
  const resolved = resolveSpecifier('@8bitscript/text', ENTRY, { machine: 'web' });
  assert.ok(resolved.path.endsWith(join('web', 'src', 'text.8bs')));
  assert.deepEqual(resolved.native, []);
});

test('a screen and text consumer links for nes with the font in ir.nativeSources', () => {
  const consumer = [
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    'export function main(): void {',
    '    text.putChar(99, 84);',
    '    screen.setColors(0x2C, 0x01);',
    '    text.showDigit(104, 3);',
    '}',
  ].join('\n');
  // (The 99 and 104 are cells of the 28x26 grid inside the frame — the
  // package maps them to nametable addresses; see the parity test for the
  // arithmetic.)
  const { ir, diagnostics } = link(consumer, ENTRY, { machine: 'nes' });
  assert.deepEqual(diagnostics, []);
  // The two subpaths share the package's PPU helpers through its index, so
  // the font is collected once, not twice.
  assert.equal(ir.nativeSources.length, 1);
  assert.ok(ir.nativeSources[0].endsWith('font.s'));
  assert.equal(ir.functions.filter((f) => f.name === 'setVramAddress').length, 1);

  const c = emitC(ir, { machine: 'nes' });
  // Tile index == ASCII: the 'T' goes into the nametable as 84, unmapped.
  assert.match(c, /text_putChar\(99, 84\);/);
  // The PPU port protocol, by address: PPUADDR ($2006 = 8198) twice, then
  // PPUDATA ($2007 = 8199); and the scroll reset after every write
  // (PPUCTRL $2000 = 8192, PPUSCROLL $2005 = 8197).
  assert.match(c, /\*\(volatile uint8_t \*\)8198 = \(address \/ 256\);/);
  assert.match(c, /\*\(volatile uint8_t \*\)8199 = code;/);
  assert.match(c, /\*\(volatile uint8_t \*\)8197 = 0;/);
  // Palette entries in order: backdrop, text (white, $30 = 48), frame —
  // from setColors's two parameters.
  assert.match(c, /void screen_setColors\(uint8_t border, uint8_t background\)/);
  assert.match(c, /8199 = background;\n\s+\*\(volatile uint8_t \*\)8199 = 48;\n\s+\*\(volatile uint8_t \*\)8199 = border;/);
});

test('the same graph linked for web carries no native sources', () => {
  const { ir, diagnostics } = link(
    'import { text } from "@8bitscript/text";\nexport function main(): void { text.putChar(0, 65); }',
    ENTRY, { machine: 'web' },
  );
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.nativeSources, []);
});

test('examples/borders main.8bs links clean for nes', () => {
  const file = join(BORDERS_SRC, 'main.8bs');
  const { ir, diagnostics } = link(readFileSync(file, 'utf8'), file, { machine: 'nes' });
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.nativeSources.length, 1);
  assert.equal(ir.entry, 'main');
});

// ---- a manifest naming a native file it does not ship -------------------

const scratchPackage = (manifest8bitscript) => {
  const root = mkdtempSync(join(tmpdir(), '8bs-native-'));
  const pkg = join(root, 'node_modules', '@t', 'p');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'src', 'index.8bs'), 'export let x: u8 = 1;\n');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@t/p', '8bitscript': manifest8bitscript }));
  return { root, entry: join(root, 'main.8bs') };
};

test('a native file the package does not ship is 8BS2008, at resolution time', () => {
  const { root, entry } = scratchPackage({ entry: './src/index.8bs', native: ['./native/missing.s'] });
  try {
    const resolved = resolveSpecifier('@t/p', entry);
    assert.equal(resolved.code, '8BS2008');
    assert.match(resolved.message, /native source '\.\/native\/missing\.s', which does not exist/);
    // And through the linker, on the import's span, so `8bs build` names it.
    const { ir, diagnostics } = link('import { x } from "@t/p";\nexport function main(): void { x = 2; }', entry);
    assert.equal(ir, null);
    assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2008']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed native list is 8BS2002, like any other malformed manifest', () => {
  const { root, entry } = scratchPackage({ entry: './src/index.8bs', native: './native/font.s' });
  try {
    assert.equal(resolveSpecifier('@t/p', entry).code, '8BS2002');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a package with no native field resolves exactly as before', () => {
  const { root, entry } = scratchPackage({ entry: './src/index.8bs' });
  try {
    const resolved = resolveSpecifier('@t/p', entry);
    assert.ok(resolved.path.endsWith(join('src', 'index.8bs')));
    assert.deepEqual(resolved.native, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
