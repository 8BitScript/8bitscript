// @8bitscript/c64: the picture in VIC bank 3 (screen.8bs/text.8bs over
// geometry.8bs), the registers index.8bs names, and the C64-only subpaths —
// sprites, keyboard + keys, joystick, sid — each linked through the real
// package the way a program resolves it. The layout numbers here were
// checked on screen under x64sc (packages/c64/AGENTS.md); this file holds
// them consistent with each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link, narrowestIntegerType } from '../index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const C64_SRC = join(HERE, '..', '..', 'c64', 'src');
const VICE_C64 = '/opt/homebrew/share/vice/C64';

// A program in the package's own directory, so relative imports resolve
// the way the package's files import each other.
const ENTRY = join(C64_SRC, 'phantom-entry.8bs');
const linked = (src, entry = ENTRY) => {
  const { ir, diagnostics } = link(src, entry, { machine: 'c64' });
  assert.deepEqual(diagnostics, []);
  return ir;
};

const fn = (ir, name) => {
  const f = ir.functions.find((x) => x.name === name);
  assert.ok(f, `${name} is defined`);
  return f;
};

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const v of Object.values(node)) walk(v, visit);
};

const has = (node, pred) => {
  let found = false;
  walk(node, (n) => { if (pred(n)) found = true; });
  return found;
};

const assignsTo = (node, name) => {
  const found = [];
  walk(node, (n) => { if (n.kind === 'assign' && n.target === name) found.push(n); });
  return found;
};

const calls = (node, name) => {
  const found = [];
  walk(node, (n) => { if (n.kind === 'call' && n.name === name) found.push(n); });
  return found;
};

const isAsm = (node, snippet) => node.kind === 'asm' && node.text.includes(snippet);

const literalAssigns = (node, name) => assignsTo(node, name).filter((a) => a.value.kind === 'const');

// The consts of a namespace in a package file, by name — a member that
// names one of the file's own module-level consts (`SCREEN_ADDRESS`, which
// `@address` needs beside it) is resolved to that const's value.
const namespaceConsts = (file, name) => {
  const text = readFileSync(join(C64_SRC, file), 'utf8');
  const start = text.indexOf(`export namespace ${name}`);
  assert.ok(start >= 0, `${file}: has a ${name} namespace`);
  const moduleConsts = Object.fromEntries([...text.matchAll(/^const (\w+): \w+ = (0x[0-9A-Fa-f]+|\d+);/gm)].map(([, n, v]) => [n, Number(v)]));
  const body = text.slice(start, text.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/const (\w+): \w+ = (0x[0-9A-Fa-f]+|\d+|\w+);/g)].map(([, n, v]) => {
    const value = /^(0x|\d)/.test(v) ? Number(v) : moduleConsts[v];
    assert.ok(Number.isInteger(value), `${file}: ${name}.${n} = ${v} resolves`);
    return [n, value];
  }));
};


// ---- geometry: one bank, everything the VIC reads inside it ------------------

const VIDEO = namespaceConsts('geometry.8bs', 'Video');

test('the screen, the character set, the sprite pointers and the shapes are all in VIC bank 3, and $D018 says where', () => {
  const bankOf = (address) => address & 0xC000;
  assert.equal(VIDEO.BANK, 0xC000);
  for (const name of ['SCREEN', 'CHARSET', 'SPRITE_POINTERS', 'SHAPES']) {
    assert.equal(bankOf(VIDEO[name]), VIDEO.BANK, `${name} is in the bank`);
  }
  // $D018: bits 4-7 the screen in 1K steps, bits 1-3 the charset in 2K steps.
  const pointer = VIDEO.MEMORY_POINTER_UPPERCASE;
  assert.equal(VIDEO.BANK + (pointer >> 4) * 0x400, VIDEO.SCREEN);
  assert.equal(VIDEO.BANK + ((pointer >> 1) & 7) * 0x800, VIDEO.CHARSET);
  assert.equal(VIDEO.MEMORY_POINTER_LOWERCASE, pointer + 2, 'the lower-case set is the next 2K');
  // The VIC's own rules: pointers at screen + $3F8, a shape block is 64 bytes.
  assert.equal(VIDEO.SPRITE_POINTERS, VIDEO.SCREEN + 0x3F8);
  assert.equal(VIDEO.SHAPES, VIDEO.BANK + VIDEO.SHAPE_BLOCK_FIRST * 64);
  assert.equal(VIDEO.SHAPES, VIDEO.SCREEN + 0x400, 'the first shape block follows the screen');
  // Blocks 144-254: the last, under the CPU vectors at $FFFA, is left alone.
  assert.equal(VIDEO.SHAPE_BLOCK_FIRST + VIDEO.SHAPE_COUNT, 255);
  assert.equal(VIDEO.SHAPES + 64 * VIDEO.SHAPE_COUNT, 0xFFC0);
  // The character ROM's copy and colour RAM are where the CPU sees the I/O area.
  assert.equal(VIDEO.CHARSET, 0xD000);
  assert.equal(VIDEO.COLOR, 0xD800);
  assert.equal(VIDEO.CELL_COUNT, VIDEO.COLUMNS * VIDEO.ROWS);
  assert.deepEqual([VIDEO.COLUMNS, VIDEO.ROWS], [40, 25]);
});

test('the arrays over the bank are declared at the addresses Video names, with the sizes the layout gives', () => {
  const ir = linked('import { screenRam, colorRam, spritePointers, spriteShapes } from "./geometry.8bs";\nexport function main(): void { screenRam[0] = 1; colorRam[0] = 1; spritePointers[0] = 1; spriteShapes[0] = 1; }');
  const global = (name) => ir.globals.find((g) => g.name === name);
  assert.deepEqual([global('screenRam').address, global('screenRam').array], [VIDEO.SCREEN, VIDEO.CELL_COUNT]);
  assert.deepEqual([global('colorRam').address, global('colorRam').array], [VIDEO.COLOR, VIDEO.CELL_COUNT]);
  assert.deepEqual([global('spritePointers').address, global('spritePointers').array], [VIDEO.SPRITE_POINTERS, 8]);
  assert.deepEqual([global('spriteShapes').address, global('spriteShapes').array], [VIDEO.SHAPES, 64 * VIDEO.SHAPE_COUNT]);
});

test('index.8bs names the VIC-II, SID, CIA and processor-port registers at their addresses', () => {
  const names = {
    processorPort: 0x0001, spritePositions: 0xD000, spriteXHigh: 0xD010, control1: 0xD011, raster: 0xD012,
    spriteEnable: 0xD015, control2: 0xD016, spriteExpandY: 0xD017, memoryPointer: 0xD018,
    interruptStatus: 0xD019, interruptMask: 0xD01A, spritePriority: 0xD01B, spriteMulticolor: 0xD01C,
    spriteExpandX: 0xD01D, spriteCollision: 0xD01E, spriteBackgroundCollision: 0xD01F,
    borderColor: 0xD020, backgroundColor: 0xD021, backgroundColor1: 0xD022, backgroundColor2: 0xD023,
    backgroundColor3: 0xD024, spriteSharedColor0: 0xD025, spriteSharedColor1: 0xD026, spriteColors: 0xD027,
    sidRegisters: 0xD400, paddleX: 0xD419, paddleY: 0xD41A, voice3Oscillator: 0xD41B, voice3Envelope: 0xD41C,
    cia1PortA: 0xDC00, cia1PortB: 0xDC01, cia1DirectionA: 0xDC02, cia1DirectionB: 0xDC03, cia1InterruptControl: 0xDC0D,
    cia2PortA: 0xDD00, cia2DirectionA: 0xDD02, reuStatus: 0xDF00, reuAddressControl: 0xDF0A,
  };
  const program = `import { ${Object.keys(names).join(', ')} } from "./index.8bs";\nexport function main(): void { borderColor = 0; }`;
  const ir = linked(program);
  for (const [name, address] of Object.entries(names)) {
    const g = ir.globals.find((x) => x.name === name);
    assert.ok(g, `${name} exists`);
    assert.equal(g.address, address, `${name} is at $${address.toString(16).toUpperCase()}`);
  }
  assert.equal(ir.globals.find((g) => g.name === 'spritePositions').array, 16);
  assert.equal(ir.globals.find((g) => g.name === 'spriteColors').array, 8);
  assert.equal(ir.globals.find((g) => g.name === 'sidRegisters').array, 25);
});

// ---- the portable surface, through the bank ---------------------------------

test('the c64 screen draws at $E000 with colour at $D800, sets $D018 to $84', () => {
  const src = 'import { screen } from "@8bitscript/screen";\nexport function main(): void { screen.blank(); }';
  const ir = linked(src, join(HERE, '..', '..', 'studio', 'src', 'main.8bs'));
  assert.equal(ir.globals.find((g) => g.name === 'screenRam').address, 0xE000);
  assert.equal(ir.globals.find((g) => g.name === 'colorRam').address, 0xD800);
  const setup = fn(ir, 'setupVideo');
  assert.ok(assignsTo(setup.body, 'memoryPointer').some((a) => a.value.value === 132));
  const blank = fn(ir, 'screen_blank');
  const loop = blank.body.find((s) => s.kind === 'for');
  assert.deepEqual(loop.test.right, { kind: 'const', value: 250, type: 'utinyint' });
  const offsets = loop.body.filter((s) => s.kind === 'storeIndex').map((s) => (
    s.index.kind === 'ref' ? 0 : s.index.right.value
  ));
  assert.deepEqual(offsets, [0, 250, 500, 750]);
  assert.ok(!has(ir, (n) => n.kind === 'storeIndex' && n.array?.name === 'screenRam' && n.index?.value === 1024));
});

test('setupVideo copies the character ROM in place with HIRAM set and CHAREN clear, banks the KERNAL out, selects bank 3 by masking, and runs once', () => {
  const ir = linked('import { setupVideo } from "./index.8bs";\nexport function main(): void { setupVideo(); setupVideo(); }');
  const setup = fn(ir, 'setupVideo');
  assert.equal(setup.body[0].kind, 'if');
  assert.equal(setup.body[0].test.name, 'videoReady');
  assert.equal(setup.body[0].then[0].kind, 'return');
  assert.deepEqual(assignsTo(setup.body, 'videoReady')[0].value, { kind: 'const', value: 1, type: 'bool' });
  assert.ok(setup.body.some((s) => isAsm(s, 'sei')));
  assert.ok(calls(setup.body, 'copyCharacterRom').length === 1);
  const cia2Dir = assignsTo(setup.body, 'cia2DirectionA')[0].value;
  assert.equal(cia2Dir.operator, '|');
  assert.deepEqual(cia2Dir.right, { kind: 'const', value: 3, type: 'utinyint' });
  const cia2Port = assignsTo(setup.body, 'cia2PortA')[0].value;
  assert.equal(cia2Port.operator, '&');
  assert.deepEqual(cia2Port.right, { kind: 'const', value: 252, type: 'utinyint' });
  assert.equal(literalAssigns(setup.body, 'cia2PortA').length, 0, 'never a literal into $DD00');
  const copy = fn(ir, 'copyCharacterRom');
  assert.ok(copy.body.some((s) => isAsm(s, 'sei')));
  const portAssigns = assignsTo(copy.body, 'processorPort');
  assert.equal(portAssigns[0].value.operator, '|');
  assert.equal(portAssigns[0].value.left.operator, '&');
  assert.deepEqual(portAssigns[0].value.left.right, { kind: 'const', value: 248, type: 'utinyint' });
  assert.deepEqual(portAssigns[0].value.right, { kind: 'const', value: 2, type: 'utinyint' });
  const loop = copy.body.find((s) => s.kind === 'for');
  assert.deepEqual(loop.test.right, { kind: 'const', value: 4096, type: 'usmallint' });
  const write = loop.body.find((s) => s.kind === 'memoryWrite');
  assert.deepEqual(write.address.left, { kind: 'const', type: 'usmallint', value: 53248 });
  assert.equal(write.value.kind, 'memoryRead');
  assert.deepEqual(write.value.address.left, { kind: 'const', type: 'usmallint', value: 53248 });
  assert.equal(portAssigns[1].value.operator, '|');
  assert.deepEqual(portAssigns[1].value.left.right, { kind: 'const', value: 248, type: 'utinyint' });
  assert.deepEqual(portAssigns[1].value.right, { kind: 'const', value: 5, type: 'utinyint' });
  const copyCli = copy.body.find((s) => s.kind === 'if' && s.test.name === 'interruptsOn');
  assert.ok(copyCli.then.some((s) => isAsm(s, 'cli')));
  assert.equal(literalAssigns(ir, 'processorPort').length, 0, 'never a literal into $01');
  const out = fn(ir, 'bankIoOut');
  assert.ok(out.body.some((s) => isAsm(s, 'sei')));
  const outPort = assignsTo(out.body, 'processorPort')[0].value;
  assert.equal(outPort.operator, '&');
  assert.deepEqual(outPort.right, { kind: 'const', value: 251, type: 'utinyint' });
  const back = fn(ir, 'bankIoIn');
  const backPort = assignsTo(back.body, 'processorPort')[0].value;
  assert.equal(backPort.operator, '|');
  assert.deepEqual(backPort.right, { kind: 'const', value: 4, type: 'utinyint' });
  const backCli = back.body.find((s) => s.kind === 'if' && s.test.name === 'interruptsOn');
  assert.ok(backCli.then.some((s) => isAsm(s, 'cli')));
});

test('the package ships the vector stub as native assembly, and only the raster module names the handler', () => {
  const pkg = JSON.parse(readFileSync(join(C64_SRC, '..', 'package.json'), 'utf8'));
  assert.deepEqual(pkg['8bitscript'].native, ['./native/6502/raster.s']);
  const asm = readFileSync(join(C64_SRC, '..', 'native', '6502', 'raster.s'), 'utf8');
  // The .init section points both vectors at the rti; only the install routine names the handler.
  const init = asm.slice(asm.indexOf('.section .init.250'), asm.indexOf('.section .text.__8bs_c64_rti'));
  assert.match(init, /lda #<__8bs_c64_rti[\s\S]*sta 0xFFFA[\s\S]*sta 0xFFFE/);
  assert.doesNotMatch(init, /raster_irq/);
  const install = asm.slice(asm.indexOf('__8bs_c64_raster_install:'), asm.indexOf('.section .text.__8bs_c64_raster_irq'));
  assert.match(install, /pha[\s\S]*lda #<__8bs_c64_raster_irq[\s\S]*sta 0xFFFE[\s\S]*lda #>__8bs_c64_raster_irq[\s\S]*sta 0xFFFF[\s\S]*pla[\s\S]*rts/);
  // The handler: acknowledge $D019, walk the list at $0200, set $D012, save and restore A and X, no zero page.
  const irq = asm.slice(asm.indexOf('__8bs_c64_raster_irq:'));
  assert.match(irq, /lda #0x01\s*\n\s*sta 0xD019/);
  assert.match(irq, /ldx 0x0301/);
  assert.match(irq, /cpx 0x0300/);
  assert.match(irq, /lda 0x0201,x[\s\S]*lda 0x0202,x[\s\S]*lda 0x0203,x/);
  assert.match(irq, /sta 0xD012/);
  assert.doesNotMatch(irq, /\bsta 0x[0-9A-F]{2}\b/, 'no zero page');
  assert.doesNotMatch(irq, /\b(tya|ldy|sty)\b/, 'Y is not touched');
  // A relative import of a file inside the package carries the package's
  // native sources, as a subpath import does — the package's own probe
  // programs under test/ build with the vector stub this way.
  const ir = linked('import { setupVideo } from "./index.8bs";\nexport function main(): void { setupVideo(); }');
  assert.equal(ir.nativeSources.length, 1);
  assert.match(ir.nativeSources[0], /native\/6502\/raster\.s$/);
});

// ---- raster ---------------------------------------------------------------------

const RASTER_SRC = readFileSync(join(C64_SRC, 'raster.8bs'), 'utf8');

test('the raster list lives at $0200 with its state at $0300, the numbers the handler in raster.s reads', () => {
  const list = Object.fromEntries([...RASTER_SRC.matchAll(/^const (\w+): usmallint = (0x[0-9A-F]+);/gm)].map(([, n, v]) => [n, Number(v)]));
  assert.deepEqual(list, { LIST_ADDRESS: 0x0200, END_ADDRESS: 0x0300, INDEX_ADDRESS: 0x0301 });
  assert.match(RASTER_SRC, /@address\(LIST_ADDRESS\)\nlet rasterList: array<u8, 252>;/);
  const R = namespaceConsts('raster.8bs', 'Register');
  assert.deepEqual([R.BORDER, R.BACKGROUND, R.CONTROL_1, R.CONTROL_2, R.MEMORY_POINTER], [0xD020, 0xD021, 0xD011, 0xD016, 0xD018]);
  assert.equal(R.SPRITE_POINTERS, VIDEO.SPRITE_POINTERS);
  assert.equal(namespaceConsts('raster.8bs', 'raster').MAX, 63);
});

test('raster.at writes the four bytes before it counts the entry and refuses a line below the last; enable silences the CIAs, acknowledges the VIC, installs the handler, then cli', () => {
  const src = [
    'import { raster, Register } from "./raster.8bs";',
    'export function main(): void { raster.clear(); raster.at(100, Register.BORDER, 2); raster.at(200, raster.spriteY(1), 60); raster.enable(); while (true) { waitFrame(); } }',
  ].join('\n');
  const ir = linked(src);
  assert.ok(calls(fn(ir, 'main').body, 'raster_at').some((c) => (
    c.args[0].value === 100 && c.args[1].value === 53280 && c.args[2].value === 2
  )));
  const at = fn(ir, 'raster_at');
  const refuse = at.body.find((s) => s.kind === 'if');
  assert.equal(refuse.test.operator, '||');
  assert.equal(refuse.test.left.operator, '>=');
  assert.deepEqual(refuse.test.left.right, { kind: 'const', value: 252, type: 'utinyint' });
  assert.equal(refuse.test.right.operator, '<');
  assert.equal(refuse.test.right.right.name, 'lastLine');
  const stores = at.body.filter((s) => s.kind === 'storeIndex');
  assert.equal(stores[0].array.name, 'rasterList');
  assert.equal(stores[0].value.name, 'line');
  assert.equal(stores[3].index.right.value, 3);
  assert.equal(stores[3].value.name, 'value');
  assert.ok(assignsTo(at.body, 'rasterEnd').some((a) => a.value.operator === '+' && a.value.right.value === 4));
  const enable = fn(ir, 'raster_enable').body;
  const order = [
    (s) => s.kind === 'call' && s.name === 'setupVideo',
    (s) => s.kind === 'assign' && s.target === 'rasterIndex' && s.value.value === 0,
    (s) => s.kind === 'assign' && s.target === 'control1' && s.value.operator === '&' && s.value.right.value === 127,
    (s) => s.kind === 'assign' && s.target === 'raster' && s.value.array?.name === 'rasterList',
    (s) => s.kind === 'assign' && s.target === 'cia1InterruptControl' && s.value.value === 127,
    (s) => s.kind === 'assign' && s.target === 'cia2InterruptControl' && s.value.value === 127,
    (s) => s.kind === 'assign' && s.target === 'interruptStatus' && s.value.value === 15,
    (s) => s.kind === 'assign' && s.target === 'interruptMask' && s.value.value === 1,
    (s) => isAsm(s, 'jsr __8bs_c64_raster_install'),
    (s) => s.kind === 'assign' && s.target === 'interruptsOn' && s.value.value === 1,
    (s) => isAsm(s, 'cli'),
  ];
  let from = 0;
  for (const step of order) {
    const found = enable.findIndex((s, i) => i >= from && step(s));
    assert.ok(found >= 0, `enable: step after index ${from}`);
    from = found + 1;
  }
  assert.ok(has(fn(ir, 'main').body, (n) => n.kind === 'waitFrame'));
});

// ---- bitmap -------------------------------------------------------------------

test('bitmap mode: the matrix under I/O at $DC00 leaves the upper-case set intact, and $D018 = $78 names both halves', () => {
  const B = namespaceConsts('geometry.8bs', 'Bitmap');
  assert.equal(B.ADDRESS, 0xE000);
  assert.equal(VIDEO.BANK + (B.MEMORY_POINTER >> 4) * 0x400, B.MATRIX, 'bits 4-7 name the matrix');
  assert.equal(VIDEO.BANK + ((B.MEMORY_POINTER >> 1) & 4) * 0x800, B.ADDRESS, 'bit 3 names the bitmap');
  assert.equal(B.SPRITE_POINTERS, B.MATRIX + 0x3F8);
  assert.ok(B.MATRIX >= VIDEO.CHARSET + 0x800, 'the matrix is in the lower-case half, not the upper-case set');
  assert.ok(B.MATRIX + 1000 <= 0xE000);
  assert.equal(B.SHAPES, VIDEO.BANK + B.SHAPE_BLOCK_FIRST * 64);
  assert.equal(B.SHAPES + B.SHAPE_COUNT * 64, B.MATRIX);
  assert.deepEqual([B.BYTES, B.WIDTH, B.HEIGHT], [8000, 320, 200]);
});

test('bitmap: enter sets BMM with the raster bit clear, plot computes the VIC layout, colours go under I/O, and setShape routes by mode', () => {
  const src = [
    'import { bitmap } from "./bitmap.8bs";',
    'import { sprites } from "./sprites.8bs";',
    'export function main(): void { bitmap.enter(true); bitmap.plot(319, 199); bitmap.plotColor(159, 199, 3); bitmap.setCellColors(0, 1, 2); bitmap.fillColors(1, 0); sprites.setShape(0, 96); sprites.setShapeByte(96, 0, 255); bitmap.leave(); }',
  ].join('\n');
  const ir = linked(src);
  const enter = fn(ir, 'bitmap_enter');
  assert.deepEqual(assignsTo(enter.body, 'videoMode')[0].value, { kind: 'const', type: 'utinyint', value: 1 });
  const control1 = assignsTo(enter.body, 'control1')[0].value;
  assert.equal(control1.operator, '|');
  assert.equal(control1.left.operator, '&');
  assert.deepEqual(control1.left.right, { kind: 'const', value: 31, type: 'utinyint' });
  assert.deepEqual(control1.right, { kind: 'const', value: 32, type: 'utinyint' });
  assert.deepEqual(assignsTo(enter.body, 'memoryPointer')[0].value, { kind: 'const', type: 'utinyint', value: 120 });
  const offset = fn(ir, 'bitmap_offset').body[0].value;
  assert.equal(offset.operator, '+');
  assert.equal(offset.left.operator, '+');
  assert.equal(offset.left.left.array.name, 'ROW_OFFSET');
  assert.equal(offset.left.left.index.operator, '>>');
  assert.deepEqual(offset.left.left.index.right, { kind: 'const', value: 3, type: 'utinyint' });
  assert.equal(offset.left.right.operator, '&');
  assert.deepEqual(offset.left.right.right, { kind: 'const', value: 504, type: 'usmallint' });
  assert.equal(offset.right.operator, '&');
  assert.deepEqual(offset.right.right, { kind: 'const', value: 7, type: 'utinyint' });
  const setColors = fn(ir, 'bitmap_setCellColors');
  const underIo = calls(setColors.body, 'writeUnderIo')[0];
  assert.equal(underIo.args[0].operator, '+');
  assert.deepEqual(underIo.args[0].left, { kind: 'const', type: 'usmallint', value: 56320 });
  assert.equal(underIo.args[1].operator, '|');
  assert.equal(underIo.args[1].left.operator, '<<');
  assert.deepEqual(underIo.args[1].left.right, { kind: 'const', value: 4, type: 'utinyint' });
  assert.equal(underIo.args[1].right.operator, '&');
  assert.deepEqual(underIo.args[1].right.right, { kind: 'const', value: 15, type: 'utinyint' });
  const fill = fn(ir, 'bitmap_fillColors');
  assert.ok(calls(fill.body, 'bankIoOut').length === 1);
  const fillLoop = fill.body.find((s) => s.kind === 'for');
  assert.deepEqual(fillLoop.test.right, { kind: 'const', type: 'usmallint', value: 1000 });
  const fillWrite = fillLoop.body.find((s) => s.kind === 'memoryWrite');
  assert.deepEqual(fillWrite.address.left, { kind: 'const', value: 56320, type: 'usmallint' });
  assert.equal(fillWrite.value.name, 'pair');
  assert.ok(calls(fill.body, 'bankIoIn').length === 1);
  const setShape = fn(ir, 'sprites_setShape');
  const mode = setShape.body.find((s) => s.kind === 'if');
  assert.equal(mode.test.operator, '==');
  assert.equal(mode.test.left.name, 'videoMode');
  assert.deepEqual(mode.test.right, { kind: 'const', value: 1, type: 'utinyint' });
  const bitmapPtr = calls(mode.then, 'writeUnderIo')[0];
  assert.deepEqual(bitmapPtr.args[0].left, { kind: 'const', value: 57336, type: 'usmallint' });
  assert.equal(mode.else[0].kind, 'storeIndex');
  assert.equal(mode.else[0].array.name, 'spritePointers');
  const leave = fn(ir, 'bitmap_leave');
  const leaveControl = assignsTo(leave.body, 'control1')[0].value;
  assert.equal(leaveControl.operator, '&');
  assert.deepEqual(leaveControl.right, { kind: 'const', value: 31, type: 'utinyint' });
  assert.deepEqual(assignsTo(leave.body, 'memoryPointer')[0].value, { kind: 'const', value: 132, type: 'utinyint' });
  assert.deepEqual(assignsTo(leave.body, 'videoMode')[0].value, { kind: 'const', value: 0, type: 'utinyint' });
});

// ---- charset and scroll -----------------------------------------------------------

test('charset.define writes eight rows at $D000 + 8 * code in one window; restore is the ROM copy again', () => {
  const src = [
    'import { charset } from "./charset.8bs";',
    'export function main(): void { charset.define(1, 255, 129, 129, 129, 129, 129, 129, 255); charset.copy(2, 1); charset.restore(); }',
  ].join('\n');
  const ir = linked(src);
  const offset = fn(ir, 'charset_offset').body[0].value;
  assert.equal(offset.operator, '+');
  assert.deepEqual(offset.left, { kind: 'const', type: 'usmallint', value: 53248 });
  assert.equal(offset.right.operator, '*');
  assert.deepEqual(offset.right.right, { kind: 'const', value: 8, type: 'utinyint' });
  const define = fn(ir, 'charset_define');
  assert.ok(calls(define.body, 'bankIoOut').length === 1);
  const writes = define.body.filter((s) => s.kind === 'memoryWrite');
  assert.equal(writes[0].address.name, 'at');
  assert.equal(writes[0].value.name, 'row0');
  assert.equal(writes[7].address.right.value, 7);
  assert.equal(writes[7].value.name, 'row7');
  assert.ok(calls(define.body, 'bankIoIn').length === 1);
  assert.ok(calls(fn(ir, 'charset_restore').body, 'copyCharacterRom').length === 1);
});

test('scroll: fine scroll masks the low three bits and keeps $D011 bit 7 clear; a coarse shift copies screen and colour RAM together', () => {
  const src = [
    'import { scroll } from "./scroll.8bs";',
    'export function main(): void { scroll.setX(5); scroll.setY(3); scroll.setNarrow(true); scroll.shiftLeft(32, 1); scroll.shiftUp(32, 1); }',
  ].join('\n');
  const ir = linked(src);
  const setX = assignsTo(fn(ir, 'scroll_setX').body, 'control2')[0].value;
  assert.equal(setX.operator, '|');
  assert.equal(setX.left.operator, '&');
  assert.deepEqual(setX.left.right, { kind: 'const', value: 248, type: 'utinyint' });
  assert.equal(setX.right.operator, '&');
  assert.deepEqual(setX.right.right, { kind: 'const', value: 7, type: 'utinyint' });
  const setY = assignsTo(fn(ir, 'scroll_setY').body, 'control1')[0].value;
  assert.equal(setY.operator, '|');
  assert.equal(setY.left.operator, '&');
  assert.deepEqual(setY.left.right, { kind: 'const', value: 120, type: 'utinyint' });
  assert.equal(setY.right.operator, '&');
  assert.deepEqual(setY.right.right, { kind: 'const', value: 7, type: 'utinyint' });
  const narrowThen = fn(ir, 'scroll_setNarrow').body.find((s) => s.kind === 'if').then;
  const narrow = assignsTo(narrowThen, 'control2')[0].value;
  assert.equal(narrow.operator, '&');
  assert.deepEqual(narrow.right, { kind: 'const', value: 247, type: 'utinyint' });
  const left = fn(ir, 'scroll_shiftLeft');
  assert.ok(has(left.body, (n) => (
    n.kind === 'storeIndex' && n.array?.name === 'screenRam' && n.value?.array?.name === 'screenRam'
    && n.value.index?.operator === '+' && n.value.index.right.value === 1
  )));
  assert.ok(has(left.body, (n) => (
    n.kind === 'storeIndex' && n.array?.name === 'colorRam' && n.value?.array?.name === 'colorRam'
    && n.value.index?.operator === '+' && n.value.index.right.value === 1
  )));
  const up = fn(ir, 'scroll_shiftUp');
  const upLoop = up.body.find((s) => s.kind === 'for');
  assert.deepEqual(upLoop.test.right, { kind: 'const', value: 960, type: 'usmallint' });
  assert.ok(has(upLoop.body, (n) => (
    n.kind === 'storeIndex' && n.array?.name === 'screenRam'
    && n.value.index?.operator === '+' && n.value.index.right.value === 40
  )));
});

// ---- reu transfers -------------------------------------------------------------

test('reu transfers set every register then the command: $90 plus the direction, the fault bit answers verify, fillReu fixes the C64 address', () => {
  const src = [
    'import { reu } from "./reu.8bs";',
    'let ok: bool = false;',
    'export function main(): void { reu.stash(0xE000, 1, 0x1000, 1000); reu.fetch(0xE000, 1, 0x1000, 1000); reu.swap(0xE000, 1, 0x1000, 0); ok = reu.verify(0xE000, 1, 0x1000, 1000); reu.fillReu(1, 0, 0, 32); }',
  ].join('\n');
  const ir = linked(src);
  const transfer = fn(ir, 'transfer');
  const steps = [
    ['reuC64AddressLow', '&', 255],
    ['reuC64AddressHigh', '>>', 8],
    ['reuAddressLow', '&', 255],
    ['reuAddressHigh', '>>', 8],
  ];
  for (const [target, op, n] of steps) {
    const a = assignsTo(transfer.body, target)[0];
    assert.equal(a.value.operator, op, target);
    assert.deepEqual(a.value.right, { kind: 'const', value: n, type: narrowestIntegerType(n) }, target);
  }
  assert.equal(assignsTo(transfer.body, 'reuBank')[0].value.name, 'bank');
  const lengthLow = assignsTo(transfer.body, 'reuLengthLow')[0].value;
  assert.equal(lengthLow.operator, '&');
  assert.deepEqual(lengthLow.right, { kind: 'const', value: 255, type: 'utinyint' });
  const lengthHigh = assignsTo(transfer.body, 'reuLengthHigh')[0].value;
  assert.equal(lengthHigh.operator, '>>');
  assert.deepEqual(lengthHigh.right, { kind: 'const', value: 8, type: 'utinyint' });
  assert.equal(assignsTo(transfer.body, 'reuAddressControl')[0].value.name, 'control');
  const command = assignsTo(transfer.body, 'reuCommand')[0].value;
  assert.equal(command.operator, '|');
  assert.deepEqual(command.left, { kind: 'const', type: 'utinyint', value: 144 });
  assert.equal(command.right.name, 'direction');
  const dir = (name, n) => {
    const call = calls(fn(ir, name).body, 'transfer')[0];
    assert.deepEqual(call.args[0], { kind: 'const', value: n, type: 'utinyint' });
    assert.deepEqual(call.args[1], { kind: 'const', type: 'utinyint', value: 0 });
  };
  dir('reu_stash', 0);
  dir('reu_fetch', 1);
  dir('reu_swap', 2);
  const verify = fn(ir, 'reu_verify');
  const verifyCall = calls(verify.body, 'transfer')[0];
  assert.deepEqual(verifyCall.args[0], { kind: 'const', value: 3, type: 'utinyint' });
  const ret = verify.body.find((s) => s.kind === 'return').value;
  assert.equal(ret.operator, '==');
  assert.equal(ret.left.operator, '&');
  assert.equal(ret.left.left.name, 'reuStatus');
  assert.deepEqual(ret.left.right, { kind: 'const', value: 32, type: 'utinyint' });
  assert.deepEqual(ret.right, { kind: 'const', type: 'utinyint', value: 0 });
  const fill = fn(ir, 'reu_fillReu');
  assert.equal(assignsTo(fill.body, 'probe')[0].value.name, 'value');
  const fillCall = calls(fill.body, 'transfer')[0];
  assert.deepEqual(fillCall.args[0], { kind: 'const', type: 'utinyint', value: 0 });
  assert.deepEqual(fillCall.args[1], { kind: 'const', value: 128, type: 'utinyint' });
  assert.deepEqual(fillCall.args[2], { kind: 'const', value: 828, type: 'usmallint' });
});

// ---- the region ------------------------------------------------------------------

test('detectRegion is the frame driver\'s probe in 8bitscript: $D012 before $D011, a whole frame watched for line 288', () => {
  const ir = linked('import { detectRegion, Region } from "./index.8bs";\nlet r: u8 = 0;\nexport function main(): void { r = detectRegion(); if (r == Region.PAL) { memory.write(0xD020, 5); } }');
  const top = fn(ir, 'rasterInTopHalf').body[0].value;
  assert.equal(top.operator, '&&');
  assert.equal(top.left.operator, '<');
  assert.equal(top.left.left.name, 'raster');
  assert.deepEqual(top.left.right, { kind: 'const', value: 128, type: 'utinyint' });
  assert.equal(top.right.operator, '==');
  assert.equal(top.right.left.operator, '&');
  assert.equal(top.right.left.left.name, 'control1');
  assert.deepEqual(top.right.left.right, { kind: 'const', value: 128, type: 'utinyint' });
  const probe = fn(ir, 'detectRegion').body.filter((s) => s.kind === 'while');
  assert.equal(probe.length, 4);
  assert.equal(probe[0].test.kind, 'call');
  assert.equal(probe[0].test.name, 'rasterInTopHalf');
  assert.equal(probe[1].test.operator, '!');
  assert.equal(probe[1].test.argument.name, 'rasterInTopHalf');
  assert.equal(probe[2].test.name, 'rasterInTopHalf');
  assert.equal(probe[3].test.operator, '!');
  const watch = probe[3].body.find((s) => s.kind === 'if').test;
  assert.equal(watch.operator, '&&');
  assert.equal(watch.left.operator, '!=');
  assert.equal(watch.left.left.operator, '&');
  assert.equal(watch.left.left.left.name, 'control1');
  assert.deepEqual(watch.left.left.right, { kind: 'const', value: 128, type: 'utinyint' });
  assert.equal(watch.right.operator, '>=');
  assert.equal(watch.right.left.name, 'raster');
  assert.deepEqual(watch.right.right, { kind: 'const', value: 32, type: 'utinyint' });
  const palCheck = fn(ir, 'main').body.find((s) => s.kind === 'if').test;
  assert.equal(palCheck.operator, '==');
  assert.deepEqual(palCheck.right, { kind: 'const', type: 'utinyint', value: 0 }, 'Region.PAL is 0');
});

// ---- sprites ---------------------------------------------------------------

test('sprites: place splits a 9-bit X across $D000 and $D010; show sets the picture up; the collision registers are read once', () => {
  const src = [
    'import { sprites } from "./sprites.8bs";',
    'let hits: u8 = 0;',
    'export function main(): void { sprites.setShape(0, sprites.FIRST_BLOCK); sprites.place(0, 300, 100); sprites.show(0); hits = sprites.collisions(); }',
  ].join('\n');
  const ir = linked(src);
  const setShape = calls(fn(ir, 'main').body, 'sprites_setShape')[0];
  assert.deepEqual(setShape.args[0], { kind: 'const', value: 0, type: 'utinyint' });
  assert.deepEqual(setShape.args[1], { kind: 'const', type: 'utinyint', value: 144 });
  const place = fn(ir, 'sprites_place');
  const stores = place.body.filter((s) => s.kind === 'storeIndex');
  assert.equal(stores[0].array.name, 'spritePositions');
  assert.equal(stores[0].index.operator, '*');
  assert.deepEqual(stores[0].index.right, { kind: 'const', value: 2, type: 'utinyint' });
  assert.equal(stores[0].value.name, 'x');
  assert.equal(stores[1].index.operator, '+');
  assert.deepEqual(stores[1].index.right, { kind: 'const', value: 1, type: 'utinyint' });
  assert.equal(stores[1].value.name, 'y');
  const high = place.body.find((s) => s.kind === 'if');
  assert.equal(high.test.operator, '>=');
  assert.equal(high.test.left.name, 'x');
  assert.deepEqual(high.test.right, { kind: 'const', value: 256, type: 'usmallint' });
  const orBit = assignsTo(high.then, 'spriteXHigh')[0].value;
  assert.equal(orBit.operator, '|');
  assert.equal(orBit.right.array.name, 'BIT');
  const show = fn(ir, 'sprites_show');
  assert.ok(calls(show.body, 'setupVideo').length === 1);
  const enable = assignsTo(show.body, 'spriteEnable')[0].value;
  assert.equal(enable.operator, '|');
  assert.equal(enable.right.array.name, 'BIT');
  assert.equal(fn(ir, 'sprites_collisions').body[0].value.name, 'spriteCollision');
});

test('sprites: the namespace\'s numbers are the VIC-II\'s and the layout\'s', () => {
  const S = namespaceConsts('sprites.8bs', 'sprites');
  assert.deepEqual([S.COUNT, S.WIDTH, S.HEIGHT, S.BYTES], [8, 24, 21, 63]);
  assert.deepEqual([S.LEFT, S.TOP, S.VISIBLE_WIDTH, S.VISIBLE_HEIGHT], [24, 50, 320, 200]);
});

// ---- keyboard and keys ----------------------------------------------------------

const tableOf = (file) => {
  const text = readFileSync(join(C64_SRC, file), 'utf8');
  const body = text.slice(text.indexOf('export namespace Key'));
  return new Map([...body.matchAll(/const (\w+): utinyint = (\d+);/g)].map(([, name, v]) => [name, Number(v)]));
};
const KEYS = tableOf('keys.8bs');

// The names a program may share with the PET's keyboard layer.
const SHARED_WITH_PET = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...[...Array(10).keys()].map((d) => `DIGIT_${d}`),
  'SPACE', 'RETURN', 'STOP', 'HOME', 'DELETE', 'CURSOR_RIGHT', 'CURSOR_DOWN',
  'SHIFT_LEFT', 'SHIFT_RIGHT', 'LEFT_ARROW', 'UP_ARROW',
  'COMMA', 'PERIOD', 'COLON', 'SEMICOLON', 'SLASH', 'MINUS', 'AT',
];

test('the Key table is the whole 8 x 8 matrix, one name per position, sharing the PET layer\'s names', () => {
  assert.equal(KEYS.size, 64);
  const values = [...KEYS.values()].sort((a, b) => a - b);
  assert.deepEqual(values, [...Array(64).keys()], 'every position 0-63 exactly once');
  for (const name of SHARED_WITH_PET) assert.ok(KEYS.has(name), `has ${name}`);
  // Two spot checks every reference gives: RETURN is column 0 row 1, SPACE column 7 row 4.
  assert.equal(KEYS.get('RETURN'), 0 * 8 + 1);
  assert.equal(KEYS.get('SPACE'), 7 * 8 + 4);
  assert.equal(KEYS.get('STOP'), 7 * 8 + 7);
});

// VICE's positional map: `keysym column row shiftflag` per line, in this
// file's numbering (its first number is the $DC00 bit, its second the
// $DC01 bit: `Return 0 1`, `space 7 4`). Host keysyms whose C64 key is
// unambiguous in the positional layout.
const viceMap = () => {
  const path = join(VICE_C64, 'gtk3_pos.vkm');
  if (!existsSync(path)) return null;
  const map = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([^\s#!]\S*)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m && !map.has(m[1])) map.set(m[1], Number(m[2]) * 8 + Number(m[3]));
  }
  return map;
};
const HOST = {
  ...Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c) => [c, c.toUpperCase()])),
  ...Object.fromEntries([...Array(10).keys()].map((d) => [String(d), `DIGIT_${d}`])),
  space: 'SPACE', Return: 'RETURN', BackSpace: 'DELETE', Home: 'HOME', Escape: 'STOP',
  F1: 'F1', F3: 'F3', F5: 'F5', F7: 'F7', Down: 'CURSOR_DOWN', Right: 'CURSOR_RIGHT',
  Shift_L: 'SHIFT_LEFT', Shift_R: 'SHIFT_RIGHT', Control_L: 'COMMODORE', Tab: 'CONTROL',
  comma: 'COMMA', period: 'PERIOD', slash: 'SLASH', sterling: 'POUND', End: 'POUND',
  colon: 'COLON', semicolon: 'COLON', apostrophe: 'SEMICOLON', bracketleft: 'AT',
  bracketright: 'ASTERISK', backslash: 'UP_ARROW', minus: 'PLUS', equal: 'MINUS',
  plus: 'MINUS', grave: 'LEFT_ARROW', Page_Down: 'EQUALS',
};

{
  const vice = viceMap();
  test('the Key table agrees with VICE\'s gtk3_pos.vkm', { skip: vice ? false : 'VICE C64 keymaps not installed' }, () => {
    let checked = 0;
    for (const [keysym, name] of Object.entries(HOST)) {
      assert.ok(vice.has(keysym), `gtk3_pos.vkm maps ${keysym}`);
      assert.equal(KEYS.get(name), vice.get(keysym), `Key.${name} is where VICE puts ${keysym}`);
      checked++;
    }
    assert.ok(checked >= 60, `${checked} keys checked`);
  });
}

test('keyboard.scan drives the eight columns through CIA1, inverts once, and leaves port A at $FF for the joysticks', () => {
  const src = [
    'import { keyboard } from "./keyboard.8bs";',
    'import { Key } from "./keys.8bs";',
    'import { joystick, Joystick } from "./joystick.8bs";',
    'export function main(): void { while (true) { waitFrame(); keyboard.scan(); joystick.scan(); if (keyboard.pressed(Key.SPACE) || joystick.fire(Joystick.PORT_2)) { memory.write(0xD020, 1); } } }',
  ].join('\n');
  const ir = linked(src);
  const pressed = calls(fn(ir, 'main').body, 'keyboard_pressed')[0];
  assert.deepEqual(pressed.args[0], { kind: 'const', type: 'utinyint', value: 60 });
  const scan = fn(ir, 'keyboard_scan');
  assert.deepEqual(assignsTo(scan.body, 'cia1DirectionA')[0].value, { kind: 'const', value: 255, type: 'utinyint' });
  assert.deepEqual(assignsTo(scan.body, 'cia1DirectionB')[0].value, { kind: 'const', value: 0, type: 'utinyint' });
  const loop = scan.body.find((s) => s.kind === 'for');
  const select = assignsTo(loop.body, 'cia1PortA')[0];
  assert.equal(select.value.array.name, 'COLUMN_SELECT');
  const store = loop.body.find((s) => s.kind === 'storeIndex');
  assert.equal(store.array.name, 'state');
  assert.equal(store.value.operator, '^');
  assert.equal(store.value.left.name, 'cia1PortB');
  assert.deepEqual(store.value.right, { kind: 'const', value: 255, type: 'utinyint' });
  const after = assignsTo(scan.body, 'cia1PortA').find((a) => a.value.kind === 'const');
  assert.deepEqual(after.value, { kind: 'const', value: 255, type: 'utinyint' });
  const joy = fn(ir, 'joystick_scan');
  assert.deepEqual(assignsTo(joy.body, 'cia1PortA')[0].value, { kind: 'const', value: 255, type: 'utinyint' });
  const joyStores = joy.body.filter((s) => s.kind === 'storeIndex');
  assert.equal(joyStores[0].value.operator, '&');
  assert.equal(joyStores[0].value.left.operator, '^');
  assert.equal(joyStores[0].value.left.left.name, 'cia1PortB');
  assert.deepEqual(joyStores[0].value.right, { kind: 'const', value: 31, type: 'utinyint' });
  assert.equal(joyStores[1].value.left.left.name, 'cia1PortA');
  const fire = calls(fn(ir, 'main').body, 'joystick_fire')[0];
  assert.deepEqual(fire.args[0], { kind: 'const', type: 'utinyint', value: 1 });
});

// ---- sid ----------------------------------------------------------------------

const noteTable = (name) => {
  const text = readFileSync(join(C64_SRC, 'sid.8bs'), 'utf8');
  const start = text.indexOf(`const ${name}`);
  const body = text.slice(start, text.indexOf('];', start));
  // The array's literal values: every number followed by a comma (the `84`
  // in its type is followed by `>`).
  return [...body.matchAll(/\b(\d+)\b(?=\s*,)/g)].map((m) => Number(m[1]));
};

test('the note tables are Fn = round(f * 2^24 / clock) for C0-B6 at A4 = 440 Hz, PAL at 985248 Hz and NTSC at 1022727, and fit the register', () => {
  const values = noteTable('NOTE_PAL');
  const ntsc = noteTable('NOTE_NTSC');
  assert.equal(values.length, 84);
  assert.equal(ntsc.length, 84);
  for (let n = 0; n < 84; n++) {
    const f = 440 * 2 ** ((n - 57) / 12);
    assert.equal(values[n], Math.round((f * 16777216) / 985248), `PAL note ${n}`);
    assert.equal(ntsc[n], Math.round((f * 16777216) / 1022727), `NTSC note ${n}`);
  }
  assert.ok(values[83] < 65536);
  assert.ok(ntsc[83] < 65536);
  assert.ok(Math.abs((ntsc[57] * 1022727) / 16777216 - 440) < 0.07);
  const NOTE = namespaceConsts('sid.8bs', 'Note');
  assert.equal(Object.keys(NOTE).length, 84);
  assert.equal(NOTE.A4, 57);
  assert.equal(NOTE.C0, 0);
  assert.equal(NOTE.B6, 83);
  // A4 through the formula comes back as 440 Hz to within the register's
  // own step (985248 / 2^24, about 0.06 Hz).
  assert.ok(Math.abs((values[57] * 985248) / 16777216 - 440) < 0.06);
});

test('sid: play sets both frequency bytes then gates on, keeping the waveform; the registers are write-only so the control byte is shadowed', () => {
  const src = [
    'import { sid, Waveform, Note } from "./sid.8bs";',
    'export function main(): void { sid.setWaveform(0, Waveform.PULSE); sid.play(0, Note.A4); sid.release(0); }',
  ].join('\n');
  const ir = linked(src);
  const main = fn(ir, 'main');
  const wave = calls(main.body, 'sid_setWaveform')[0];
  assert.deepEqual(wave.args[0], { kind: 'const', value: 0, type: 'utinyint' });
  assert.deepEqual(wave.args[1], { kind: 'const', type: 'utinyint', value: 64 });
  const playCall = calls(main.body, 'sid_play')[0];
  assert.deepEqual(playCall.args[0], { kind: 'const', value: 0, type: 'utinyint' });
  assert.deepEqual(playCall.args[1], { kind: 'const', type: 'utinyint', value: 57 });
  const freqOf = fn(ir, 'sid_frequencyOf');
  const ntsc = freqOf.body.find((s) => s.kind === 'if');
  assert.equal(ntsc.test.operator, '==');
  assert.equal(ntsc.test.left.name, 'region');
  assert.deepEqual(ntsc.test.right, { kind: 'const', type: 'utinyint', value: 1 });
  assert.equal(ntsc.then[0].value.array.name, 'NOTE_NTSC');
  const pal = freqOf.body.find((s) => s.kind === 'return' && s.value.array?.name === 'NOTE_PAL');
  assert.ok(pal);
  const play = fn(ir, 'sid_play');
  const setFreq = calls(play.body, 'sid_setFrequency')[0];
  assert.equal(setFreq.args[1].kind, 'call');
  assert.equal(setFreq.args[1].name, 'sid_frequencyOf');
  assert.ok(calls(play.body, 'sid_gateOn').length === 1);
  const freq = fn(ir, 'sid_setFrequency').body.filter((s) => s.kind === 'storeIndex');
  assert.equal(freq[0].array.name, 'sidRegisters');
  assert.equal(freq[0].index.array.name, 'VOICE_BASE');
  assert.equal(freq[0].value.operator, '&');
  assert.deepEqual(freq[0].value.right, { kind: 'const', value: 255, type: 'utinyint' });
  assert.equal(freq[1].index.operator, '+');
  assert.deepEqual(freq[1].index.right, { kind: 'const', value: 1, type: 'utinyint' });
  assert.equal(freq[1].value.operator, '>>');
  assert.deepEqual(freq[1].value.right, { kind: 'const', value: 8, type: 'utinyint' });
  const gate = fn(ir, 'sid_gateOn').body.find((s) => s.kind === 'storeIndex' && s.array?.name === 'control');
  assert.equal(gate.value.operator, '|');
  assert.deepEqual(gate.value.right, { kind: 'const', value: 1, type: 'utinyint' });
  const release = fn(ir, 'sid_release').body.find((s) => s.kind === 'storeIndex' && s.array?.name === 'control');
  assert.equal(release.value.operator, '&');
  assert.deepEqual(release.value.right, { kind: 'const', value: 254, type: 'utinyint' });
  const waveform = fn(ir, 'sid_setWaveform').body.find((s) => s.kind === 'storeIndex' && s.array?.name === 'control');
  assert.equal(waveform.value.operator, '|');
  assert.equal(waveform.value.left.operator, '&');
  assert.deepEqual(waveform.value.left.right, { kind: 'const', value: 1, type: 'utinyint' });
  assert.equal(waveform.value.right.operator, '&');
  assert.deepEqual(waveform.value.right.right, { kind: 'const', value: 246, type: 'utinyint' });
});
