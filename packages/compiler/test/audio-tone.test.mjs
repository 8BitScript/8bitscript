// The portable tone surface of @8bitscript/audio (packages/audio/src/index.8bs
// and its machine twins): audio.tone(note, frames), audio.silence(), and the
// two constants audio.NOTE_LOW / audio.NOTE_HIGH that say which notes the
// machine can play. It lives in the compiler's tests because the machine
// packages' own tests are not part of the CI gate
// (scripts/ci-excluded-packages.mjs); the emulator tests that measure the
// pitch a machine actually plays (packages/audio/test/tone.test.mjs) skip
// when the emulator is not installed.
//
// Three things are checked, none of them a sound:
//   1. a probe that reads both constants and calls tone / silence / update
//      links on all thirty-two targets with no diagnostics, and each
//      constant folds to a literal;
//   2. the range each target answers is the one this table records, also the
//      table in packages/audio/AGENTS.md;
//   3. the pitch tables in the twins say what the chip formulas say: each
//      entry is within a stated number of cents of the note it is indexed by,
//      using the formula that was measured on the emulator (comments in the
//      twins give the measurement).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');
const SRC = join(CHECKOUT, 'packages', 'audio', 'src');
const CX16_PSG = join(CHECKOUT, 'packages', 'cx16', 'src', 'psg.8bs');

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web', 'plus4', 'oric', 'apple2', 'bbc', 'atari5200', 'lynx', 'pce', 'supervision', 'atari2600', 'atari7800', 'gb', 'gbc', 'sms', 'gamegear', 'sg1000', 'msx', 'coleco', 'spectrum', 'cpc', 'coco', 'vectrex', 'odyssey2', 'channelf'];

// The notes each machine with its own twin can play: the .8ba index,
// octave * 12 + semitone, C0 = 0, A4 = 57. A machine with no driver answers
// 0 and 0, which a program folds its sounds away on.
const RANGES = {
  pet: { file: 'index.pet.8bs', low: 48, high: 71, levelMax: 1 },
  vic20: { file: 'index.vic20.8bs', low: 36, high: 71, levelMax: 15 },
  c64: { file: 'index.c64.8bs', low: 0, high: 83, levelMax: 15 },
  cx16: { file: 'index.cx16.8bs', low: 36, high: 95, levelMax: 15 },
  web: { file: 'index.web.8bs', low: 24, high: 95, levelMax: 15 },
  nes: { file: 'index.nes.8bs', low: 0, high: 0, levelMax: 0 },
  atari8: { file: 'index.atari8.8bs', low: 0, high: 0, levelMax: 0 },
};
const GENERIC = { file: 'index.8bs', low: 0, high: 0, levelMax: 0 };

const PROBE = `import { audio } from "@8bitscript/audio";
export function main(): void {
    let low: utinyint = audio.NOTE_LOW;
    let high: utinyint = audio.NOTE_HIGH;
    let loud: utinyint = audio.LEVEL_MAX;
    audio.setLevel(loud);
    audio.tone(low, 10);
    audio.tone(high, 0);
    audio.blip(low, 3);
    audio.silence();
    audio.update();
    return;
}
`;

function expectedFor(target) {
  return RANGES[target] ?? GENERIC;
}

function probe(target) {
  const entry = join(HERE, 'audio-tone-consumer.8bs');
  const { ir, diagnostics } = link(PROBE, entry, { machine: target, facts: stockFacts(target), checkout: CHECKOUT });
  assert.deepEqual(diagnostics, [], target);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.ok(main, `${target}: main is in the linked program`);
  // Reading a constant into a local keeps its folded value in the linked
  // program: the local's initialiser is a constant node, not a read.
  const values = {};
  for (const stmt of main.body.filter((s) => s.kind === 'local')) {
    assert.equal(stmt.init.kind, 'const', `${target}: audio.NOTE_${stmt.name.toUpperCase()} folds to a literal`);
    values[stmt.name] = stmt.init.value;
  }
  const called = main.body.filter((s) => s.kind === 'call').map((s) => s.name);
  return { values, called };
}

for (const target of TARGETS) {
  test(`${target}: audio.tone, blip, setLevel, silence and the constants link, and the constants fold`, () => {
    const { values, called } = probe(target);
    const want = expectedFor(target);
    assert.equal(values.low, want.low, `${target}: audio.NOTE_LOW`);
    assert.equal(values.high, want.high, `${target}: audio.NOTE_HIGH`);
    assert.equal(values.loud, want.levelMax, `${target}: audio.LEVEL_MAX`);
    for (const call of ['setLevel', 'tone', 'blip', 'silence', 'update']) {
      assert.ok(called.includes(`audio_${call}`), `${target}: audio.${call} is called in the linked program (saw ${called})`);
    }
  });
}

test('every twin source declares NOTE_LOW, NOTE_HIGH, LEVEL_MAX, tone, blip, setLevel and silence', () => {
  for (const { file } of [...Object.values(RANGES), GENERIC]) {
    const src = readFileSync(join(SRC, file), 'utf8');
    assert.match(src, /const NOTE_LOW: utinyint = \d+;/, file);
    assert.match(src, /const NOTE_HIGH: utinyint = \d+;/, file);
    assert.match(src, /function tone\(note: utinyint, frames: utinyint\): void/, file);
    assert.match(src, /function silence\(\): void/, file);
    assert.match(src, /const LEVEL_MAX: utinyint = \d+;/, file);
    assert.match(src, /function setLevel\(amount: utinyint\): void|function setLevel\(level: utinyint\): void/, file);
    assert.match(src, /function blip\(note: utinyint, frames: utinyint\): void/, file);
  }
});

test('the level each twin states is the one this table records', () => {
  for (const [target, { file, levelMax }] of Object.entries(RANGES)) {
    const src = readFileSync(join(SRC, file), 'utf8');
    assert.equal(Number(/const LEVEL_MAX: utinyint = (\d+);/.exec(src)[1]), levelMax, `${target} LEVEL_MAX`);
  }
});

// A plucked tone must be able to die away by itself or by the frame count, never by
// luck. These read the sources (the emulator tests in packages/audio/test measure it).
test('C64: blip is a plucked envelope with no sustain, and drops the gate first so a second note retriggers', () => {
  const src = readFileSync(join(SRC, 'index.c64.8bs'), 'utf8');
  const blip = /function blip\([^)]*\): void \{([\s\S]*?)\n    \}/.exec(src)[1];
  assert.match(blip, /sid\.setEnvelope\(0, 0, DECAY\[slow\], 0, 2\);/, 'attack 0, decay from the table, sustain 0, release 2');
  assert.ok(blip.indexOf('sid.release(0);') < blip.indexOf('sid.play(0, note);'), 'the gate drops before the new note');
  const tone = /function tone\([^)]*\): void \{([\s\S]*?)\n    \}/.exec(src)[1];
  assert.match(tone, /sid\.setEnvelope\(0, 0, 9, 8, 6\);/, 'a plain tone puts the sustained envelope back');
  assert.ok(tone.indexOf('sid.release(0);') < tone.indexOf('sid.play(0, note);'), 'a plain tone retriggers too');
  assert.match(src, /sid\.setVolume\(level\);/, 'the first ensure() uses the level, not a hard-coded 15');
  assert.doesNotMatch(src, /sid\.setVolume\(15\)/);
});

test('VIC-20, X16 and web: blip walks the volume down a step a frame and puts the level back when it ends', () => {
  for (const file of ['index.vic20.8bs', 'index.cx16.8bs', 'index.web.8bs']) {
    const src = readFileSync(join(SRC, file), 'utf8');
    assert.match(src, /let rest: utinyint = (level|volume);/, `${file}: the step is worked out from the level`);
    assert.match(src, /if \(shown > fade\) \{\s*shown = shown - fade;\s*\} else \{\s*shown = 0;/, `${file}: update lowers the volume, never below 0`);
    assert.match(src, /fade = 0;/, `${file}: a plain tone and the end of a blip clear the fade`);
  }
  assert.match(readFileSync(join(SRC, 'index.vic20.8bs'), 'utf8'), /sound\.volume\(level\);\s*\}\s*\n\s*\/\/ A plucked tone|shown = level;\s*sound\.volume\(level\);/, 'the VIC puts the volume back');
  assert.match(readFileSync(CX16_PSG, 'utf8'), /function setVolume\(voice: utinyint, volume: utinyint\): void \{\s*writePsg\(voice \* 4 \+ 2, 0xC0 \| \(\(volume & 15\) \* 4\)\);/, 'the PSG can change a voice volume without touching its pitch');
});

test('PET: one bit has two levels, and level 0 mutes tone and blip', () => {
  const src = readFileSync(join(SRC, 'index.pet.8bs'), 'utf8');
  assert.match(src, /const LEVEL_MAX: utinyint = 1;/);
  assert.match(src, /muted = amount == 0;/);
  assert.match(src, /function tone\(note: utinyint, frames: utinyint\): void \{\s*songs\.stop\(\);\s*decayLeft = 0;\s*if \(muted\) \{\s*return;/);
  assert.match(src, /function blip\([^)]*\): void \{\s*audio\.tone\(note, frames\);/);
});

test('the range in each twin source is the one this table records', () => {
  for (const [target, { file, low, high }] of Object.entries(RANGES)) {
    const src = readFileSync(join(SRC, file), 'utf8');
    assert.equal(Number(/const NOTE_LOW: utinyint = (\d+);/.exec(src)[1]), low, `${target} low`);
    assert.equal(Number(/const NOTE_HIGH: utinyint = (\d+);/.exec(src)[1]), high, `${target} high`);
  }
});

// A table is indexed from its first note, and a note outside the range is
// moved by whole octaves into it: both use the same two numbers the
// constants state, so a range edited in one place and not the other is
// caught here and not by an ear.
test('each twin folds and indexes its pitch table with the range its constants state', () => {
  const folds = [
    { file: join(SRC, 'index.pet.8bs'), table: 'T2', low: 48, high: 71 },
    { file: join(SRC, 'index.vic20.8bs'), table: 'DIVISOR', low: 36, high: 71 },
  ];
  for (const { file, table: name, low, high } of folds) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, new RegExp(`while \\(n < ${low}\\) \\{\\s*n = n \\+ 12;`), `${file}: folds up from ${low}`);
    assert.match(src, new RegExp(`while \\(n > ${high}\\) \\{\\s*n = n - 12;`), `${file}: folds down from ${high}`);
    assert.match(src, new RegExp(`return ${name}\\[n - ${low}\\];`), `${file}: indexes ${name} from ${low}`);
  }
  // The X16 states its range by the NOTE_FIRST / NOTE_LAST consts of its PSG module.
  const psg = readFileSync(CX16_PSG, 'utf8');
  assert.match(psg, /const NOTE_FIRST: utinyint = 36;/);
  assert.match(psg, /const NOTE_LAST: utinyint = 95;/);
  assert.match(psg, /while \(n < NOTE_FIRST\) \{\s*n = n \+ 12;/);
  assert.match(psg, /while \(n > NOTE_LAST\) \{\s*n = n - 12;/);
  assert.match(psg, /return FREQUENCY\[n - NOTE_FIRST\];/);
});

// ---- the pitch tables --------------------------------------------------------

const hz = (note) => 440 * 2 ** ((note - 57) / 12);
const cents = (a, b) => 1200 * Math.log2(a / b);

function table(file, name) {
  const src = readFileSync(file, 'utf8');
  const match = new RegExp(`const ${name}: array<\\w+, (\\d+)> = \\[([^\\]]*)\\];`).exec(src);
  assert.ok(match, `${name} in ${file}`);
  const values = match[2].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  assert.equal(values.length, Number(match[1]), `${name} has the length it declares`);
  return values;
}

test('PET: each T2 byte is the note it is indexed by, to within 20 cents (1,000,000 / (16 (T2 + 2)) Hz)', () => {
  const t2 = table(join(SRC, 'index.pet.8bs'), 'T2');
  assert.equal(t2.length, 24);
  t2.forEach((n, i) => {
    const played = 1_000_000 / (16 * (n + 2));
    assert.ok(Math.abs(cents(played, hz(48 + i))) <= 20, `note ${48 + i}: T2 ${n} plays ${played.toFixed(1)} Hz, wants ${hz(48 + i).toFixed(1)}`);
  });
});

test('VIC-20: each soprano divisor is the note it is indexed by, to within 50 cents (1,022,727 / (64 a) Hz)', () => {
  const div = table(join(SRC, 'index.vic20.8bs'), 'DIVISOR');
  assert.equal(div.length, 36);
  div.forEach((a, i) => {
    const played = 1_022_727 / (64 * a);
    assert.ok(a >= 1 && a <= 127, `divisor ${a} fits seven bits`);
    assert.ok(Math.abs(cents(played, hz(36 + i))) <= 50, `note ${36 + i}: divisor ${a} plays ${played.toFixed(1)} Hz, wants ${hz(36 + i).toFixed(1)}`);
  });
});

test('X16: each VERA frequency word is the note it is indexed by, to within a cent (Hz x 2^17 / 48828.125)', () => {
  const words = table(CX16_PSG, 'FREQUENCY');
  assert.equal(words.length, 60);
  words.forEach((w, i) => {
    const played = (w * 48828.125) / 131072;
    assert.ok(Math.abs(cents(played, hz(36 + i))) <= 5, `note ${36 + i}: word ${w} plays ${played.toFixed(1)} Hz, wants ${hz(36 + i).toFixed(1)}`);
  });
});

test('X16: the PSG voice writes the channel-enable bits and a waveform (the old module wrote neither, and played nothing)', () => {
  const src = readFileSync(CX16_PSG, 'utf8');
  assert.match(src, /writePsg\(base \+ 2, 0xC0 \| \(\(volume & 15\) \* 4\)\);/, 'volume with both channel bits');
  assert.match(src, /writePsg\(base \+ 3, \(\(wave & 3\) << 6\) \| 63\);/, 'waveform in bits 7:6');
});
