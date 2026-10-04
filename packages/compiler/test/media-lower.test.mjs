// Machine-owned media lowering: a fixed PNG and WAV, the four stress
// machines, and the glyph / no-driver fallback everywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '@8bitscript/graphics-tools';
import { encodeWav, ffmpegAvailable } from '@8bitscript/audio-tools';
import { Codes, link } from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);
const c64Media = require('../../c64/media/index.cjs');
const nesMedia = require('../../nes/media/index.cjs');
const petMedia = require('../../pet/media/index.cjs');
const atariMedia = require('../../atari8/media/index.cjs');

const SPRITE = `sprite player {
  source "./player.png"
  size 16x16
  transparent auto
  animation walk {
    frames 0, 1, 2, 3
    every 8
  }
}
`;

const AUDIO = `instrument lead {
  waveform pulse
  polyphony 1
}

sample blip {
  source "./blip.wav"
  fallback { synth noise }
}

song theme {
  tempo 120
  speed 6
  order { main }
  pattern main length 16 {
    track lead {
      row 0 { note C4; instrument lead; }
      row 8 { note G4; }
    }
  }
}
`;

const PROGRAM = `import { player } from "./player.8bg";
import { blip, theme } from "./theme.8ba";
import { graphics } from "@8bitscript/graphics";
import { audio } from "@8bitscript/audio";

export function main(): void {
    graphics.place(player, 40, 40);
    audio.play(blip);
    audio.music(theme);
    graphics.update();
    audio.update();
}
`;

function solidSheet() {
  const width = 64;
  const height = 16;
  const rgba = new Uint8Array(width * height * 4);
  for (let f = 0; f < 4; f += 1) {
    for (let y = 2; y < 14; y += 1) {
      for (let x = 3; x < 13; x += 1) {
        const px = f * 16 + x;
        const o = (y * width + px) * 4;
        rgba[o] = 0;
        rgba[o + 1] = 0;
        rgba[o + 2] = 0;
        rgba[o + 3] = 255;
      }
    }
  }
  return encodePng(width, height, rgba);
}

function beepWav() {
  const samples = new Float32Array(400);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 6);
  return encodeWav(samples, 8000);
}

function withProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-media-'));
  try {
    writeFileSync(join(dir, 'player.png'), solidSheet());
    writeFileSync(join(dir, 'blip.wav'), beepWav());
    writeFileSync(join(dir, 'player.8bg'), SPRITE);
    writeFileSync(join(dir, 'theme.8ba'), AUDIO);
    writeFileSync(join(dir, 'main.8bs'), PROGRAM);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function wrap(code, message, file, start, length, severity = 'error') {
  return { code, message, file, start, length, severity };
}

function linked(dir, machine) {
  return link(PROGRAM, join(dir, 'main.8bs'), {
    machine,
    facts: stockFacts(machine),
    checkout: CHECKOUT,
  });
}

test('C64 lowering packs 24×21 sprite bytes and a SID event list', () => {
  withProject((dir) => {
    const { ir, diagnostics } = linked(dir, 'c64');
    const errors = diagnostics.filter((d) => d.severity !== 'warning');
    assert.deepEqual(errors, []);
    assert.ok(diagnostics.some((d) => d.code === Codes.AUD_PCM_FALLBACK || d.code === '8BS2210'));
    const sprite = ir.globals.find((g) => g.name.includes('__8bg_player') || g.name.endsWith('player') && g.constant);
    const data = ir.globals.find((g) => Array.isArray(g.init) && g.init.length === 252);
    assert.ok(data, 'four 63-byte VIC-II frames');
    assert.equal(data.init.length, 63 * 4);
    assert.ok(data.init.some((b) => b !== 0), 'sprite bytes are not all empty');
    const song = ir.globals.find((g) => Array.isArray(g.init) && g.init[0] === 120 && g.init[1] === 6);
    assert.ok(song, 'SID song bytes');
    assert.equal(song.init[2], 16);
    assert.equal(song.init[3], 2);
    assert.equal(song.init[5], 48); // C4
    assert.equal(song.init[9], 55); // G4
    assert.ok((ir.functions ?? []).some((f) => f.mediaBind));
  });
});

test('NES lowering writes CHR patches from tile $E0 and a pulse song', () => {
  withProject((dir) => {
    const { ir, diagnostics } = linked(dir, 'nes');
    assert.deepEqual(diagnostics.filter((d) => d.severity !== 'warning'), []);
    assert.ok((ir.chrPatches ?? []).length >= 4);
    assert.equal(ir.chrPatches[0].tile, 0xe0);
    assert.equal(ir.chrPatches[0].bytes.length, 16);
    const song = ir.globals.find((g) => Array.isArray(g.init) && g.init[0] === 120);
    assert.ok(song);
    assert.equal(song.init[5], 48);
  });
});

test('PET lowering picks a 4×4 quadrant-block for a solid picture', () => {
  withProject((dir) => {
    const { ir, diagnostics } = linked(dir, 'pet');
    assert.deepEqual(diagnostics.filter((d) => d.severity !== 'warning'), []);
    assert.ok(diagnostics.some((d) => d.code === Codes.GFX_ADAPTED || d.code === '8BS2111'));
    const gfx = ir.globals.find((g) => g.name.includes('8bg') && Array.isArray(g.init));
    assert.ok(gfx);
    // Four animation frames, four row nibbles each; the driver turns each
    // into its own shape.
    assert.equal(gfx.init.length, 16);
  });
});

test('two .8bg files each hold one sprite: their slots are 0 and 1, not both 0', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-media-slots-'));
  try {
    writeFileSync(join(dir, 'player.png'), solidSheet());
    writeFileSync(join(dir, 'player.8bg'), SPRITE);
    writeFileSync(join(dir, 'enemy.png'), solidSheet());
    writeFileSync(join(dir, 'enemy.8bg'), SPRITE.replace('sprite player', 'sprite enemy').replace('./player.png', './enemy.png'));
    const text = `import { player } from "./player.8bg";
import { enemy } from "./enemy.8bg";
import { graphics } from "@8bitscript/graphics";

export function main(): void {
    graphics.place(player, 8, 8);
    graphics.place(enemy, 40, 8);
}
`;
    for (const machine of ['pet', 'c64']) {
      const { ir, diagnostics } = link(text, join(dir, 'main.8bs'), { machine, facts: stockFacts(machine), checkout: CHECKOUT });
      assert.deepEqual(diagnostics.filter((d) => d.severity !== 'warning'), [], machine);
      const entry = ir.functions.find((f) => f.name === ir.entry);
      // The sprite names are consts folded into each call: the slot is the first argument.
      const placed = entry.body.filter((s) => s.kind === 'call' && /graphics_place$/.test(s.name)).map((s) => s.args[0].value);
      assert.deepEqual(placed, [0, 1], `${machine}: player then enemy`);
      // The binds run in declaration order, ahead of anything main() does.
      const calls = entry.body.filter((s) => s.kind === 'call' && /__8bs_media_bind_/.test(s.name)).map((s) => s.name.replace(/^.*__8bs_media_bind_/, ''));
      assert.deepEqual(calls, ['player', 'enemy'], machine);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Atari 8-bit lowering reports a glyph and a POKEY song', () => {
  withProject((dir) => {
    const { ir, diagnostics } = linked(dir, 'atari8');
    assert.deepEqual(diagnostics.filter((d) => d.severity !== 'warning'), []);
    assert.ok(diagnostics.some((d) => d.code === Codes.GFX_ADAPTED || d.code === '8BS2111'));
    assert.ok(diagnostics.some((d) => d.code === Codes.AUD_PCM_FALLBACK || d.code === '8BS2210'));
    const song = ir.globals.find((g) => Array.isArray(g.init) && g.init[0] === 120);
    assert.ok(song);
    assert.equal(song.init[5], 48);
  });
});

test('VIC-20 lowers four frames of quadrant-block codes and a VIC song; Odyssey 2 omits audio with no driver', () => {
  withProject((dir) => {
    const vic = linked(dir, 'vic20');
    assert.deepEqual(vic.diagnostics.filter((d) => d.severity !== 'warning'), []);
    assert.ok(vic.diagnostics.some((d) => d.code === Codes.GFX_ADAPTED || d.code === '8BS2111'));
    const gfx = vic.ir.globals.find((g) => g.name.includes('8bg') && Array.isArray(g.init));
    // Four frames of a 2×2-cell object: one screen code a cell, nothing else.
    assert.equal(gfx.init.length, 16);
    const song = vic.ir.globals.find((g) => Array.isArray(g.init) && g.init[0] === 120);
    assert.ok(song);
    assert.equal(song.init[5], 48);

    const cx = linked(dir, 'cx16');
    assert.deepEqual(cx.diagnostics.filter((d) => d.severity !== 'warning'), []);
    assert.ok(cx.diagnostics.some((d) => d.code === '8BS2111'));
    const cxGfx = cx.ir.globals.find((g) => g.name.includes('8bg') && Array.isArray(g.init));
    assert.ok(cxGfx.init.length >= 132);

    const o2 = linked(dir, 'odyssey2');
    assert.deepEqual(o2.diagnostics.filter((d) => d.severity !== 'warning'), []);
    assert.ok(o2.diagnostics.some((d) => d.code === Codes.AUD_NO_DRIVER && /odyssey2/.test(d.message)));
    const o2Song = o2.ir.globals.find((g) => g.name.includes('8ba_song'));
    assert.ok(!o2Song || !o2Song.init || o2Song.init.length <= 1);
  });
});

test('a missing PNG is 8BS2104; a missing fallback was already a checker error', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-media-miss-'));
  try {
    writeFileSync(join(dir, 'player.8bg'), 'sprite player { source "./nope.png" size 16x16 }\n');
    writeFileSync(join(dir, 'main.8bs'), 'import { player } from "./player.8bg";\nexport function main(): void { }\n');
    const { diagnostics } = link(
      'import { player } from "./player.8bg";\nexport function main(): void { }\n',
      join(dir, 'main.8bs'),
      { machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT },
    );
    assert.ok(diagnostics.some((d) => d.code === Codes.GFX_MISSING_SOURCE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('direct C64 pack of a 16×16 opaque block is 63 bytes, padded to 24×21', () => {
  const width = 16;
  const height = 16;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4 + 3] = 255;
  }
  const result = c64Media.lowerGraphics(
    { name: 'p', width, height, animations: [], start: 0, length: 1 },
    [{ rgba, width, height }],
    {},
    't.8bg',
    wrap,
  );
  assert.equal(result.kind, 1);
  assert.equal(result.data.length, 63);
  assert.equal(result.width, 24);
  assert.equal(result.height, 21);
  // Row 0: 16 set pixels, then 8 pad zeros → 0xFF, 0xFF, 0x00
  assert.equal(result.data[0], 0xff);
  assert.equal(result.data[1], 0xff);
  assert.equal(result.data[2], 0x00);
});

// --- C64 graphics: the sprite's colour and its frame budget ---------------

function solidFrame(width, height, [r, g, b]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set([r, g, b, 255], i * 4);
  return { rgba, width, height };
}

function c64Lower(name, frames, animation = []) {
  return c64Media.lowerGraphics(
    { name, width: 16, height: 16, animations: animation, start: 0, length: 1 },
    frames,
    {},
    't.8bg',
    wrap,
  );
}

test('C64 graphics: the kind byte carries the VIC-II colour nearest the PNG, in its high nibble', () => {
  // Pepto palette entries: 2 red, 5 green, 7 yellow, 14 light blue, and the
  // rest by nearest distance. A black sprite stays kind 1 (colour 0).
  for (const [rgb, color] of [[[0x81, 0x33, 0x38], 2], [[0x56, 0xac, 0x4d], 5], [[0xed, 0xf1, 0x71], 7], [[0x70, 0x6d, 0xeb], 14], [[255, 255, 255], 1], [[0, 0, 0], 0], [[250, 250, 240], 1]]) {
    const result = c64Lower('p', [solidFrame(16, 16, rgb)]);
    assert.equal(result.kind & 15, 1, 'the low nibble is still the C64 kind');
    assert.equal(result.kind >> 4, color, `rgb ${rgb} → colour ${color}`);
  }
});

test('C64 graphics: the colour is the one most opaque pixels have, over the kept frames', () => {
  const frame = solidFrame(16, 16, [0x56, 0xac, 0x4d]); // green
  for (let i = 0; i < 20; i += 1) frame.rgba.set([0x81, 0x33, 0x38, 255], i * 4); // a few red pixels
  for (let i = 100; i < 110; i += 1) frame.rgba[i * 4 + 3] = 0; // and transparent ones, which vote for nothing
  const result = c64Lower('p', [frame]);
  assert.equal(result.kind >> 4, 5);
  assert.ok(result.diagnostics.some((d) => d.code === '8BS2110'), 'the second colour is still reported as quantized');
});

test('C64 graphics: an animation keeps at most 4 frames — what the driver\'s 4 shape blocks and a byte index hold — and says so', () => {
  const frames = [0, 1, 2, 3, 4, 5].map(() => solidFrame(16, 16, [255, 255, 255]));
  const result = c64Lower('walker', frames, [{ frames: [0, 1, 2, 3, 4, 5], every: 2 }]);
  assert.equal(result.frames, 4);
  assert.equal(result.data.length, 4 * 63);
  assert.ok(result.data.length <= 255, 'graphics.bind takes the byte index as a utinyint');
  assert.ok(result.diagnostics.some((d) => d.code === '8BS2111' && /6 animation frames/.test(d.message) && /frames collapsed/.test(d.message)));
  const four = c64Lower('walker', frames.slice(0, 4), [{ frames: [0, 1, 2, 3], every: 2 }]);
  assert.equal(four.frames, 4);
  assert.deepEqual(four.diagnostics, [], 'four frames fit without a word');
});

test('direct NES lowering emits four CHR tiles for 16×16', () => {
  const width = 16;
  const height = 16;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba[i * 4 + 3] = 255;
  const result = nesMedia.lowerGraphics(
    { name: 'p', width, height, animations: [], start: 0, length: 1 },
    [{ rgba, width, height }],
    {},
    't.8bg',
    wrap,
  );
  assert.equal(result.kind, 2);
  assert.equal(result.chrPatches.length, 4);
  assert.equal(result.chrPatches[0].tile, 0xe0);
});

test('saw on the NES is 8BS2212', () => {
  const air = {
    instruments: [{ name: 'lead', waveform: 'saw', start: 0, length: 4 }],
    samples: [],
    songs: [{
      name: 'theme', tempo: 120, speed: 6, order: ['main'], start: 0, length: 5,
      patterns: [{
        name: 'main', length: 16, tracks: [{
          name: 'lead', rows: [{ row: 0, note: 48, instrument: 'lead' }],
        }],
      }],
    }],
  };
  const result = nesMedia.lowerAudio(air, new Map(), {}, 't.8ba', wrap);
  assert.ok(result.diagnostics.some((d) => d.code === '8BS2212'));
});

test('PET audio is omitted when audio.voices is 0', () => {
  const air = {
    instruments: [],
    samples: [{ name: 'blip', fallback: { synth: 'noise' }, start: 0, length: 4 }],
    songs: [{ name: 'theme', tempo: 120, speed: 6, order: [], patterns: [], start: 0, length: 5 }],
  };
  const none = petMedia.lowerAudio(air, new Map(), { 'audio.voices': 0 }, 't.8ba', wrap);
  assert.ok(none.diagnostics.some((d) => d.code === '8BS2211'));
  assert.equal(none.songs[0].data.length, 0);
  const yes = petMedia.lowerAudio(air, new Map(), { 'audio.voices': 1 }, 't.8ba', wrap);
  assert.equal(yes.samples[0].data.length, 0, 'noise cannot play on the VIA square wave');
});

test('a .flac sample elaborates through FFmpeg, or 8BS2213 without it', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-media-flac-'));
  try {
    writeFileSync(join(dir, 'player.png'), solidSheet());
    writeFileSync(join(dir, 'player.8bg'), SPRITE);
    writeFileSync(join(dir, 'theme.8ba'), `sample blip {
  source "./blip.flac"
  fallback { synth noise }
}
`);
    writeFileSync(join(dir, 'main.8bs'), 'import { blip } from "./theme.8ba";\nexport function main(): void { }\n');
    if (!ffmpegAvailable()) {
      writeFileSync(join(dir, 'blip.flac'), 'not flac');
      const { diagnostics } = link(
        'import { blip } from "./theme.8ba";\nexport function main(): void { }\n',
        join(dir, 'main.8bs'),
        { machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT },
      );
      assert.ok(diagnostics.some((d) => d.code === Codes.AUD_FLAC_NEEDS_FFMPEG));
      return;
    }
    const wavPath = join(dir, 'blip.wav');
    const flacPath = join(dir, 'blip.flac');
    writeFileSync(wavPath, beepWav());
    const conv = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', wavPath, flacPath], { encoding: 'utf8' });
    assert.equal(conv.status, 0, conv.stderr);
    const { diagnostics } = link(
      'import { blip } from "./theme.8ba";\nexport function main(): void { }\n',
      join(dir, 'main.8bs'),
      { machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT },
    );
    const errors = diagnostics.filter((d) => d.severity !== 'warning');
    assert.deepEqual(errors, []);
    assert.ok(diagnostics.some((d) => d.code === Codes.AUD_PCM_FALLBACK || d.code === '8BS2210'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Atari graphics is the glyph path', () => {
  const rgba = new Uint8Array(16 * 16 * 4);
  const result = atariMedia.lowerGraphics(
    { name: 'p', width: 16, height: 16, animations: [{ frames: [0, 1], every: 8 }], start: 0, length: 1 },
    [{ rgba, width: 16, height: 16 }],
    {},
    't.8bg',
    wrap,
  );
  assert.equal(result.kind, 0);
  assert.equal(result.data.length, 1);
  assert.ok(result.diagnostics.some((d) => d.code === '8BS2111' && /frames collapsed/.test(d.message)));
});
// ---- PET graphics: animation frames, the seven-shape budget, slots ------------
//
// packages/pet/test/graphics.test.mjs runs the same pictures under xpet. These
// are here because the machine packages' own tests are not part of the CI gate
// (scripts/ci-excluded-packages.mjs): compiler, cli and examples tests cover them.
// The fixtures are written to a scratch directory at run time.

// The four pictures of the animation, as 4×4 pseudo-pixel rows (bit 3 the left
// pixel): a left bar, a right bar, a top bar, a bottom bar. Each is drawn into
// the PNG as 16×16 so the lowering's downsample gets them back exactly.
const PET_WALK = [
  [12, 12, 12, 12],
  [3, 3, 3, 3],
  [15, 15, 0, 0],
  [0, 0, 15, 15],
];
const PET_RING = [6, 9, 9, 6];

function petSheet(frames) {
  const width = 16 * frames.length;
  const rgba = new Uint8Array(width * 16 * 4);
  frames.forEach((rows, f) => {
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        if ((rows[y >> 2] >> (3 - (x >> 2))) & 1) rgba[(y * width + f * 16 + x) * 4 + 3] = 255;
      }
    }
  });
  return encodePng(width, 16, rgba);
}

function petEightBg(name, animated) {
  return `sprite ${name} {\n  source "./${name}.png"\n  size 16x16\n  transparent auto\n${animated
    ? '  animation go {\n    frames 0, 1, 2, 3\n    every 4\n  }\n' : ''}}\n`;
}

/** Write the pictures and a program into `dir`; `layout` is [name, frames, x, y] for each. */
function petWriteProgram(dir, layout) {
  const imports = [];
  const places = [];
  for (const [name, frames, x, y] of layout) {
    writeFileSync(join(dir, `${name}.png`), petSheet(frames));
    writeFileSync(join(dir, `${name}.8bg`), petEightBg(name, frames.length > 1));
    imports.push(`import { ${name} } from "./${name}.8bg";`);
    places.push(`    graphics.place(${name}, sprites.ORIGIN_X + ${x}, sprites.ORIGIN_Y + ${y});`);
  }
  const text = `import { screen } from "@8bitscript/screen";
import { graphics } from "@8bitscript/graphics";
import { sprites } from "@8bitscript/sprites";
${imports.join('\n')}

export function main(): void {
    screen.blank();
${places.join('\n')}
    while (true) {
        waitFrame();
        graphics.update();
    }
}
`;
  const file = join(dir, 'main.8bs');
  writeFileSync(file, text);
  return { file, text };
}

function petLink(program, model = '3032') {
  return link(program.text, program.file, {
    machine: 'pet', facts: stockFacts('pet'), tags: [model], checkout: CHECKOUT,
  });
}


function petFrameOf(rows) {
  const width = 16;
  const rgba = new Uint8Array(width * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      if ((rows[y >> 2] >> (3 - (x >> 2))) & 1) rgba[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { rgba, width, height: 16 };
}

const petSprite = (name, animation) => ({
  name, width: 16, height: 16, start: 0, length: 1, animations: animation ? [animation] : [],
});

test('every animation frame is lowered, four row nibbles each, in the order the animation names them', () => {
  const frames = PET_WALK.map(petFrameOf);
  const walk = petMedia.lowerGraphics(petSprite('walk', { name: 'go', frames: [0, 1, 2, 3], every: 6 }), frames, {}, 't.8bg', wrap);
  assert.equal(walk.kind, 3);
  assert.equal(walk.frames, 4);
  assert.equal(walk.every, 6);
  assert.deepEqual(walk.data, PET_WALK.flat());
  assert.deepEqual(walk.diagnostics.map((d) => d.code), ['8BS2111']);
  assert.match(walk.diagnostics[0].message, /4 frames/);

  // The animation picks and orders the sheet's frames: 2 then 0 is two frames.
  const picked = petMedia.lowerGraphics(petSprite('pick', { name: 'go', frames: [2, 0], every: 8 }), frames, {}, 't.8bg', wrap);
  assert.equal(picked.frames, 2);
  assert.deepEqual(picked.data, [...PET_WALK[2], ...PET_WALK[0]]);

  // No animation: one frame, the sheet's first.
  const still = petMedia.lowerGraphics(petSprite('ring'), [petFrameOf(PET_RING)], {}, 't.8bg', wrap);
  assert.equal(still.frames, 1);
  assert.deepEqual(still.data, PET_RING);
  assert.doesNotMatch(still.diagnostics[0].message, /frames/);
});

test('a picture holds at most seven frames — the sprite layer has seven shapes — and says which it dropped', () => {
  const frames = Array.from({ length: 9 }, (_, i) => petFrameOf(PET_WALK[i % 4]));
  const long = petMedia.lowerGraphics(petSprite('long', { name: 'go', frames: [0, 1, 2, 3, 0, 1, 2, 3, 0], every: 4 }), frames, {}, 't.8bg', wrap);
  assert.equal(long.frames, 7);
  assert.equal(long.data.length, 28);
  assert.match(long.diagnostics[0].message, /last 2 frames dropped/);
});

test('the shapes are one budget for the whole program: a later picture gets what is left, then nothing', () => {
  const shared = {};
  const frames = PET_WALK.map(petFrameOf);
  const go = { name: 'go', frames: [0, 1, 2, 3], every: 4 };
  const first = petMedia.lowerGraphics(petSprite('a', go), frames, {}, 't.8bg', wrap, shared);
  const second = petMedia.lowerGraphics(petSprite('b', go), frames, {}, 't.8bg', wrap, shared);
  const third = petMedia.lowerGraphics(petSprite('c'), [petFrameOf(PET_RING)], {}, 't.8bg', wrap, shared);
  assert.equal(first.frames, 4);
  assert.equal(second.frames, 3, 'seven shapes minus the four the first took');
  assert.match(second.diagnostics[0].message, /last 1 frame dropped/);
  assert.equal(third.frames, 0, 'nothing left');
  assert.deepEqual(third.data, []);
  assert.match(third.diagnostics[0].message, /not drawn/);
  assert.equal(third.diagnostics[0].severity, 'warning');
  assert.equal(shared.petShapes, 7);
});

test('what is the shape: transparency when the picture has any, brightness only when it is fully opaque', () => {
  const paint = (rows, ink, paper) => {
    const rgba = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const on = (rows[y >> 2] >> (3 - (x >> 2))) & 1;
        const colour = on ? ink : paper;
        rgba.set(colour, (y * 16 + x) * 4);
      }
    }
    return { rgba, width: 16, height: 16 };
  };
  const WHITE = [255, 255, 255, 255];
  const BLACK = [0, 0, 0, 255];
  const CLEAR = [0, 0, 0, 0];
  const lower = (frame) => petMedia.lowerGraphics(petSprite('p'), [frame], {}, 't.8bg', wrap);

  // White pixel art on a clear background is a white shape, as on the C64.
  assert.deepEqual(lower(paint(PET_RING, WHITE, CLEAR)).data, PET_RING);
  // Black ink on opaque white paper: the colours are all there is to go on.
  assert.deepEqual(lower(paint(PET_RING, BLACK, WHITE)).data, PET_RING);
  // Dark ink on a clear background, the case the examples draw.
  assert.deepEqual(lower(paint(PET_RING, BLACK, CLEAR)).data, PET_RING);
});

test('a PNG that could not be read lowers to nothing but a placeholder, and an animation naming a frame the sheet lacks falls back to the first', () => {
  // The unreadable-source diagnostic is the compiler's; the lowering is
  // handed no frames and must not throw.
  const none = petMedia.lowerGraphics(petSprite('gone'), [], {}, 't.8bg', wrap);
  assert.equal(none.kind, 0);
  assert.equal(none.frames, 1);
  assert.deepEqual(none.diagnostics, []);

  const frames = [petFrameOf(PET_RING)];
  const stray = petMedia.lowerGraphics(petSprite('stray', { name: 'go', frames: [0, 9], every: 8 }), frames, {}, 't.8bg', wrap);
  assert.equal(stray.frames, 2);
  assert.deepEqual(stray.data, [...PET_RING, ...PET_RING], 'frame 9 does not exist; the first stands in');
});

test('a picture too faint to survive the downsample becomes a small centre block, one shape, and says so', () => {
  const blank = petFrameOf([0, 0, 0, 0]);
  const dot = petMedia.lowerGraphics(petSprite('dot'), [blank], {}, 't.8bg', wrap);
  assert.equal(dot.kind, 3);
  assert.equal(dot.frames, 1);
  assert.deepEqual(dot.data, [0, 6, 6, 0]);
  assert.match(dot.diagnostics[0].message, /centre block/);
  assert.equal(dot.diagnostics[0].severity, 'warning');
});


test('two .8bg files get slots 0 and 1 and are bound in the order they are declared; the budget warnings reach the build', () => {
  const scratch = mkdtempSync(join(tmpdir(), '8bs-pet-gfx-link-'));
  try {
    const program = petWriteProgram(scratch, [['alpha', PET_WALK, 16, 16], ['beta', PET_WALK, 120, 16], ['gamma', [PET_RING], 224, 16]]);
    const { ir, diagnostics } = petLink(program);
    assert.deepEqual(diagnostics.filter((d) => d.severity !== 'warning'), []);

    const entry = ir.functions.find((f) => f.name === ir.entry);
    const binds = entry.body.filter((s) => s.kind === 'call' && /__8bs_media_bind_/.test(s.name)).map((s) => s.name.replace(/^.*__8bs_media_bind_/, ''));
    assert.deepEqual(binds, ['alpha', 'beta', 'gamma']);
    const slots = entry.body.filter((s) => s.kind === 'call' && /graphics_place$/.test(s.name)).map((s) => s.args[0].value);
    assert.deepEqual(slots, [0, 1, 2]);

    const messages = diagnostics.filter((d) => d.code === '8BS2111').map((d) => d.message);
    assert.equal(messages.length, 3);
    assert.match(messages[0], /alpha.*4 frames/);
    assert.match(messages[1], /beta.*last 1 frame dropped/);
    assert.match(messages[2], /gamma.*not drawn/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});


test('web lowering keeps all four animation steps as drawable quadrant-block codes; its audio stays silent', () => {
  withProject((dir) => {
    const { ir, diagnostics } = linked(dir, 'web');
    assert.deepEqual(diagnostics.filter((d) => d.severity !== 'warning'), []);
    assert.ok(diagnostics.some((d) => d.code === '8BS2111' && /quadrant-block glyph on the web.*4 animation steps kept/.test(d.message)));
    const gfx = ir.globals.find((g) => g.name.includes('8bg') && Array.isArray(g.init));
    // The picture is a 10×12 block centred in each 16×16 frame: all four
    // quadrants are lit, which is block 15, code 143 — a code the web draws
    // (the default lowering's 0xA0 is not one).
    assert.deepEqual(gfx.init, [143, 143, 143, 143]);
    assert.ok(diagnostics.some((d) => d.code === Codes.AUD_NO_DRIVER && /web/.test(d.message)));
  });
});
