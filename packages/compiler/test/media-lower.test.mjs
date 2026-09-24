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
    assert.ok(gfx.init.length === 4 || gfx.init.length === 1);
  });
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

test('VIC-20 lowers four RAM glyphs and a VIC song; Odyssey 2 omits audio with no driver', () => {
  withProject((dir) => {
    const vic = linked(dir, 'vic20');
    assert.deepEqual(vic.diagnostics.filter((d) => d.severity !== 'warning'), []);
    assert.ok(vic.diagnostics.some((d) => d.code === Codes.GFX_ADAPTED || d.code === '8BS2111'));
    const gfx = vic.ir.globals.find((g) => g.name.includes('8bg') && Array.isArray(g.init));
    assert.equal(gfx.init.length, 36);
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
