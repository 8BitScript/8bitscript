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

import { link } from '../index.mjs';
import { emitC } from '../../backend-6502/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BORDERS_MAIN = join(HERE, '..', '..', '..', 'examples', 'proof-of-concept', 'borders', 'src', 'main.8bs');
const C64_SRC = join(HERE, '..', '..', 'c64', 'src');
const VICE_C64 = '/opt/homebrew/share/vice/C64';

// A program in the package's own directory, so relative imports resolve
// the way the package's files import each other.
const ENTRY = join(C64_SRC, 'phantom-entry.8bs');
const linked = (src, entry = ENTRY) => {
  const { ir, diagnostics } = link(src, entry, { machine: 'c64' });
  assert.deepEqual(diagnostics, []);
  return { ir, c: emitC(ir, { machine: 'c64' }) };
};

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
  const { ir } = linked('import { screenRam, colorRam, spritePointers, spriteShapes } from "./geometry.8bs";\nexport function main(): void { screenRam[0] = 1; colorRam[0] = 1; spritePointers[0] = 1; spriteShapes[0] = 1; }');
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
  const { ir } = linked(program);
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

test('borders on the c64 draws at $E000 with colour at $D800, sets $D018 to $84, and runs under sei', () => {
  const src = readFileSync(BORDERS_MAIN, 'utf8');
  const { c } = linked(src, BORDERS_MAIN);
  assert.match(c, /#define screenRam \(\(volatile uint8_t \*\)0xE000\)/);
  assert.match(c, /#define colorRam \(\(volatile uint8_t \*\)0xD800\)/);
  assert.match(c, /memoryPointer = 132;/);
  assert.match(c, /cell < 1000/);
  assert.doesNotMatch(c, /\(1024 \+ /, 'nothing writes the KERNAL\'s screen at $0400');
  assert.match(c, /"sei"/, 'the frame prologue disables interrupts');
});

test('setupVideo copies the character ROM in place with CHAREN clear, selects bank 3 by masking, and runs once', () => {
  const { c } = linked('import { setupVideo } from "./index.8bs";\nexport function main(): void { setupVideo(); setupVideo(); }');
  const body = c.slice(c.indexOf('static void setupVideo(void) {'));
  assert.match(body, /if \(videoReady\)/);
  assert.match(body, /__asm__ volatile\(\s*"sei/);
  assert.match(body, /processorPort = \(port & 251\);/); // bit 2 clear: character ROM readable
  assert.match(body, /i < 4096/);
  assert.match(body, /\*\(volatile uint8_t \*\)\(53248 \+ i\) = \(\*\(volatile uint8_t \*\)\(53248 \+ i\)\);/); // read the ROM at $D000+i, store to the RAM under it
  assert.match(body, /processorPort = port;/);
  assert.match(body, /cia2DirectionA = \(cia2DirectionA \| 3\);/);
  assert.match(body, /cia2PortA = \(cia2PortA & 252\);/); // %00 = bank 3, serial-bus bits kept
  assert.doesNotMatch(body, /processorPort = \d+;/, 'never a literal into $01');
  assert.doesNotMatch(body, /cia2PortA = \d+;/, 'never a literal into $DD00');
});

// ---- sprites ---------------------------------------------------------------

test('sprites: place splits a 9-bit X across $D000 and $D010; show sets the picture up; the collision registers are read once', () => {
  const src = [
    'import { sprites } from "./sprites.8bs";',
    'let hits: u8 = 0;',
    'export function main(): void { sprites.setShape(0, sprites.FIRST_BLOCK); sprites.place(0, 300, 100); sprites.show(0); hits = sprites.collisions(); }',
  ].join('\n');
  const { c } = linked(src);
  assert.match(c, /sprites_setShape\(0, 144\)/);
  const place = c.slice(c.indexOf('static void sprites_place(uint8_t index, uint16_t x, uint8_t y) {'));
  assert.match(place, /spritePositions\[\(index \* 2\)\] = x;/);
  assert.match(place, /spritePositions\[\(\(index \* 2\) \+ 1\)\] = y;/);
  assert.match(place, /if \(\(x >= 256\)\)[\s\S]*spriteXHigh = \(spriteXHigh \| BIT\[index\]\)/);
  const show = c.slice(c.indexOf('static void sprites_show(uint8_t index) {'));
  assert.match(show, /setupVideo\(\);[\s\S]*spriteEnable = \(spriteEnable \| BIT\[index\]\)/);
  assert.match(c, /return spriteCollision;/);
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
  const { c } = linked(src);
  assert.match(c, /keyboard_pressed\(60\)/);
  const scan = c.slice(c.indexOf('static void keyboard_scan(void) {'), c.indexOf('static uint8_t keyboard_pressed(uint8_t key) {'));
  assert.match(scan, /cia1DirectionA = 255;/);
  assert.match(scan, /cia1DirectionB = 0;/);
  assert.match(scan, /cia1PortA = COLUMN_SELECT\[column\];/);
  assert.match(scan, /state\[column\] = \(cia1PortB \^ 255\);/);
  assert.match(scan, /cia1PortA = 255;\n\}/);
  const joy = c.slice(c.indexOf('static void joystick_scan(void) {'), c.indexOf('static uint8_t joystick_bits(uint8_t port) {'));
  assert.match(joy, /cia1PortA = 255;[\s\S]*\(cia1PortB \^ 255\) & 31\)[\s\S]*\(cia1PortA \^ 255\) & 31\)/);
  assert.match(c, /joystick_fire\(1\)/); // PORT_2 is index 1
});

// ---- sid ----------------------------------------------------------------------

test('the PAL note table is Fn = round(f * 2^24 / 985248) for C0-B6 at A4 = 440 Hz, and fits the register', () => {
  const text = readFileSync(join(C64_SRC, 'sid.8bs'), 'utf8');
  const start = text.indexOf('const NOTE_PAL');
  const body = text.slice(start, text.indexOf('];', start));
  // The array's literal values: every number followed by a comma (the `84`
  // in its type is followed by `>`).
  const values = [...body.matchAll(/\b(\d+)\b(?=\s*,)/g)].map((m) => Number(m[1]));
  assert.equal(values.length, 84);
  for (let n = 0; n < 84; n++) {
    const f = 440 * 2 ** ((n - 57) / 12);
    assert.equal(values[n], Math.round((f * 16777216) / 985248), `note ${n}`);
  }
  assert.ok(values[83] < 65536);
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
  const { c } = linked(src);
  assert.match(c, /sid_setWaveform\(0, 64\)/);
  assert.match(c, /sid_play\(0, 57\)/);
  assert.match(c, /sidRegisters\[VOICE_BASE\[voice\]\] = \(frequency & 255\);/);
  assert.match(c, /sidRegisters\[\(VOICE_BASE\[voice\] \+ 1\)\] = \(frequency >> 8\);/);
  assert.match(c, /control\[voice\] = \(control\[voice\] \| 1\);/);
  assert.match(c, /control\[voice\] = \(control\[voice\] & 254\);/);
  assert.match(c, /control\[voice\] = \(\(control\[voice\] & 1\) \| \(waveform & 246\)\);/);
});
