// The song language of `.8ba` — instrument volume and decay, a note's length and volume, a song's
// loop — and the bytes it becomes (packages/compiler/src/media/audio/song.mjs). No filesystem and no
// chip: the drivers' own behaviour is tested where they run (packages/cli/test/web-audio.test.mjs on
// the web host, packages/audio/test/songs.test.mjs on the emulators).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze, analyzeMedia, Codes } from '../index.mjs';
import { encodeSong, songEvents, SONG_HEADER, EVENT_BYTES } from '../src/media/audio/song.mjs';

const SOURCE = `instrument click {
  waveform pulse
  volume 12
  decay 2
}

instrument chime {
  waveform triangle
  volume 9
}

song win {
  speed 3
  loop false
  order { main }
  pattern main length 8 {
    track lead {
      row 0 { note C4; instrument chime; length 2; }
      row 2 { note E4; }
      row 4 { note G4; instrument click; volume 6; length 3; }
    }
  }
}
`;

const air = (text) => analyzeMedia(text, 's.8ba', { sourceKind: '.8ba' }).air;

test('instrument volume and decay, a row\'s length and volume, and a song\'s loop all parse', () => {
  const { air: a, diagnostics } = analyzeMedia(SOURCE, 's.8ba', { sourceKind: '.8ba' });
  assert.deepEqual(diagnostics, []);
  assert.equal(a.instruments[0].volume, 12);
  assert.equal(a.instruments[0].decay, 2);
  assert.equal(a.instruments[1].volume, 9);
  assert.equal(a.instruments[1].decay, 0, 'no decay means the note holds');
  assert.equal(a.songs[0].loop, false);
  assert.equal(a.songs[0].speed, 3);
  const rows = a.songs[0].patterns[0].tracks[0].rows;
  assert.equal(rows[0].noteLength, 2);
  assert.equal(rows[1].noteLength, null);
  assert.equal(rows[2].volume, 6);
  assert.equal(rows[2].noteLength, 3);
});

test('an instrument with no volume is at 15 with no decay, and a song loops unless it says not to', () => {
  const a = air('instrument lead { waveform pulse }\nsong s { speed 1 pattern p length 1 { track t { row 0 { note C4; instrument lead; } } } }\n');
  assert.equal(a.instruments[0].volume, 15);
  assert.equal(a.instruments[0].decay, 0);
  assert.equal(a.songs[0].loop, true);
});

test('loop wants true or false, and the new fields are checked: volume 0..15, decay 0..255, length 1..255', () => {
  const syntax = analyze('song s { speed 1 loop maybe pattern p length 1 { track t { row 0 { note C4; } } } }\n', 't.8ba');
  assert.ok(syntax.some((d) => d.code === Codes.AUD_SYNTAX && /true' or 'false/.test(d.message)));
  const loud = analyze('instrument a { volume 16 }\n', 't.8ba');
  assert.ok(loud.some((d) => d.code === Codes.AUD_SYNTAX && /volume is 0\.\.15/.test(d.message)));
  const slow = analyze('instrument a { decay 300 }\n', 't.8ba');
  assert.ok(slow.some((d) => d.code === Codes.AUD_SYNTAX && /decay is 0\.\.255/.test(d.message)));
  const none = analyze('song s { speed 1 pattern p length 4 { track t { row 0 { note C4; length 0; } } } }\n', 't.8ba');
  assert.ok(none.some((d) => d.code === Codes.AUD_SYNTAX && /length is 1\.\.255/.test(d.message)));
  const rowLoud = analyze('song s { speed 1 pattern p length 4 { track t { row 0 { note C4; volume 99; } } } }\n', 't.8ba');
  assert.ok(rowLoud.some((d) => d.code === Codes.AUD_SYNTAX && /volume is 0\.\.15/.test(d.message)));
});

test('a row outside its pattern, two tracks on one row (one voice) and a song past 255 rows are errors', () => {
  const outside = analyze('song s { speed 1 pattern p length 4 { track t { row 9 { note C4; } } } }\n', 't.8ba');
  assert.ok(outside.some((d) => d.code === Codes.AUD_SYNTAX && /outside pattern 'p'/.test(d.message)));
  const clash = analyze('song s { speed 1 pattern p length 4 { track a { row 1 { note C4; } } track b { row 1 { note E4; } } } }\n', 't.8ba');
  assert.ok(clash.some((d) => d.code === Codes.AUD_SYNTAX && /has one voice/.test(d.message)));
  const huge = analyze('song s { speed 1 order { p, p } pattern p length 200 { track t { row 0 { note C4; } } } }\n', 't.8ba');
  assert.ok(huge.some((d) => d.code === Codes.AUD_SYNTAX && /400 rows/.test(d.message)));
});

test('a song becomes [flags, speed, rows, count] and five bytes an event: row, note, waveform | volume << 2, length, decay', () => {
  const a = air(SOURCE);
  const { data, rows } = encodeSong(a, a.songs[0]);
  assert.equal(rows, 8);
  assert.deepEqual(data.slice(0, SONG_HEADER), [0, 3, 8, 3], 'a one-shot (loop false), 3 frames a row, 8 rows, 3 notes');
  assert.equal(data.length, SONG_HEADER + 3 * EVENT_BYTES);
  // C4 (48) on the triangle (2) at the chime's volume 9, 2 rows, held:
  assert.deepEqual(data.slice(4, 9), [0, 48, 2 | (9 << 2), 2, 0]);
  // E4 (52): the instrument carries over, one row by default:
  assert.deepEqual(data.slice(9, 14), [2, 52, 2 | (9 << 2), 1, 0]);
  // G4 (55) on the click: pulse (0), the row's volume 6 over the instrument's 12, 3 rows, decay 2 frames:
  assert.deepEqual(data.slice(14, 19), [4, 55, 0 | (6 << 2), 3, 2]);
});

test('a song that loops says so in its flags, and an order of patterns plays end to end', () => {
  const a = air(`song s {
  speed 2
  order { intro, main }
  pattern intro length 4 { track t { row 0 { note C4; } } }
  pattern main length 4 { track t { row 1 { note G4; } } }
}
`);
  const { data, rows } = encodeSong(a, a.songs[0]);
  assert.equal(rows, 8);
  assert.equal(data[0], 1, 'loop is the default');
  assert.deepEqual(songEvents(a, a.songs[0]).map((e) => [e.row, e.note]), [[0, 48], [5, 55]], 'main starts after intro\'s four rows');
});

test('events come out in row order whichever track wrote them', () => {
  const a = air('song s { speed 1 pattern p length 8 { track a { row 5 { note E4; } } track b { row 1 { note C4; } } } }\n');
  assert.deepEqual(songEvents(a, a.songs[0]).map((e) => e.row), [1, 5]);
});

// ---- the program: handles across files, the bank, every target ---------------------------

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { link } from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const FILE_A = `sample zap { source "./zap.wav" fallback { synth pulse } }
song first { speed 2 loop false pattern p length 2 { track t { row 0 { note C4; } } } }
`;
const FILE_B = `song second { speed 2 pattern p length 2 { track t { row 0 { note E4; } } } }
song third { speed 2 pattern p length 2 { track t { row 0 { note G4; } } } }
`;
const MAIN = `import { zap, first } from "./a.8ba";
import { second, third } from "./b.8ba";
import { audio } from "@8bitscript/audio";

export function main(): void {
    audio.play(zap);
    audio.play(first);
    audio.play(second);
    audio.music(third);
    audio.update();
    let busy: bool = audio.busy();
    audio.silence();
}
`;

function withAudioProject(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-songs-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const wav = () => {
  const bytes = Buffer.alloc(44 + 16);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + 16, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(16, 40);
  return bytes;
};

function linkProject(dir, machine, main = MAIN) {
  return link(main, join(dir, 'main.8bs'), { machine, facts: stockFacts(machine), checkout: CHECKOUT });
}

test('every sample and song in a program has its own handle, counted across files, not one per file', () => {
  withAudioProject({ 'a.8ba': FILE_A, 'b.8ba': FILE_B, 'main.8bs': MAIN, 'zap.wav': wav() }, (dir) => {
    const { ir, diagnostics } = linkProject(dir, 'c64');
    assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), []);
    // The handles are inlined into the calls: play(zap), play(first), play(second), music(third).
    const main = ir.functions.find((f) => f.name === 'main');
    const handles = main.body.filter((s) => s.kind === 'call' && (s.name === 'audio_play' || s.name === 'audio_music')).map((s) => s.args[0].value);
    assert.deepEqual(handles, [0, 1, 2, 3]);
    // And each bind function binds its asset to that handle.
    const slots = ir.functions.filter((f) => f.mediaBind).map((f) => {
      const meta = f.body.find((s) => s.kind === 'call' && s.name === 'audio_meta');
      return [meta.args[0].value, meta.args[1].value];
    });
    assert.deepEqual(slots.sort((a, b) => a[1] - b[1]), [[0, 0], [1, 1], [1, 2], [1, 3]]);
  });
});

test('a program whose samples and songs do not fit the 255-byte bank is 8BS2216, naming the asset that overflows', () => {
  const rows = Array.from({ length: 40 }, (_, i) => `row ${i} { note ${['C4', 'E4', 'G4', 'B4'][i % 4]}; }`).join(' ');
  const big = (name) => `song ${name} { speed 1 pattern p length 40 { track t { ${rows} } } }\n`;
  // 4 + 40 * 5 = 204 bytes a song: the first fits, the second does not.
  withAudioProject({ 'a.8ba': big('one'), 'b.8ba': big('two'), 'main.8bs': 'import { one } from "./a.8ba";\nimport { two } from "./b.8ba";\nimport { audio } from "@8bitscript/audio";\nexport function main(): void {\n    audio.play(one);\n    audio.play(two);\n}\n' }, (dir) => {
    const { diagnostics } = linkProject(dir, 'c64', 'import { one } from "./a.8ba";\nimport { two } from "./b.8ba";\nimport { audio } from "@8bitscript/audio";\nexport function main(): void {\n    audio.play(one);\n    audio.play(two);\n}\n');
    const full = diagnostics.filter((d) => d.code === Codes.AUD_BANK_FULL);
    assert.equal(full.length, 1);
    assert.match(full[0].message, /'two'/);
    assert.match(full[0].message, /255 bytes/);
    assert.equal(Codes.AUD_BANK_FULL, '8BS2216');
  });
});

const PLAYS = ['pet', 'vic20', 'c64', 'cx16', 'web'];

for (const machine of PLAYS) {
  test(`${machine}: a program that plays samples and songs links, with a driver that takes every call (play, music, busy, silence)`, () => {
    withAudioProject({ 'a.8ba': FILE_A, 'b.8ba': FILE_B, 'main.8bs': MAIN, 'zap.wav': wav() }, (dir) => {
      const { ir, diagnostics } = linkProject(dir, machine);
      assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [], machine);
      const main = ir.functions.find((f) => f.name === 'main');
      const called = main.body.filter((s) => s.kind === 'call').map((s) => s.name);
      for (const call of ['audio_play', 'audio_music', 'audio_update', 'audio_silence']) {
        assert.ok(called.includes(call), `${machine}: ${call} is in the linked program (saw ${called})`);
      }
      // The bytes are bound (the sample's two, each song's nine) for a machine with a driver.
      const bound = ir.functions.filter((f) => f.mediaBind).length;
      assert.equal(bound, machine === 'pet' && !stockFacts('pet')['audio.voices'] ? 0 : 4, machine);
    });
  });
}

test('every target links a program that plays songs; a machine with no driver answers busy() with false at no cost', () => {
  const targets = ['c128', 'atari8', 'nes', 'mega65', 'plus4', 'oric', 'apple2', 'bbc', 'atari5200', 'lynx', 'pce', 'supervision', 'atari2600', 'atari7800', 'gb', 'gbc', 'sms', 'gamegear', 'sg1000', 'msx', 'coleco', 'spectrum', 'cpc', 'coco', 'vectrex', 'odyssey2', 'channelf'];
  withAudioProject({ 'a.8ba': FILE_A, 'b.8ba': FILE_B, 'main.8bs': MAIN, 'zap.wav': wav() }, (dir) => {
    for (const machine of targets) {
      const { diagnostics } = linkProject(dir, machine);
      assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [], machine);
    }
  });
});
