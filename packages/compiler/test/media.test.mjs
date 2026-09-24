// Front-end tests for `.8bg` / `.8ba`: lexer, parser, checker. No filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze, Codes, analyzeMedia } from '../index.mjs';

const GFX = `sprite player {
  source "./player.png"
  size 16x16
  transparent auto
  animation walk {
    frames 0, 1, 2, 3
    every 8
  }
}
`;

const AUD = `instrument lead {
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

test('parses the first-slice sprite grammar and names the export', () => {
  const { gir, diagnostics } = analyzeMedia(GFX, 'player.8bg', { sourceKind: '.8bg' });
  assert.deepEqual(diagnostics, []);
  assert.equal(gir.sprites.length, 1);
  assert.equal(gir.sprites[0].name, 'player');
  assert.equal(gir.sprites[0].source, './player.png');
  assert.equal(gir.sprites[0].width, 16);
  assert.equal(gir.sprites[0].height, 16);
  assert.equal(gir.sprites[0].animations[0].name, 'walk');
  assert.deepEqual(gir.sprites[0].animations[0].frames, [0, 1, 2, 3]);
  assert.equal(gir.sprites[0].animations[0].every, 8);
  assert.deepEqual(gir.tiles, []);
  assert.deepEqual(gir.fonts, []);
});

test('parses the first-slice audio grammar, including an instrument-only file', () => {
  const full = analyzeMedia(AUD, 'theme.8ba', { sourceKind: '.8ba' });
  assert.deepEqual(full.diagnostics, []);
  assert.equal(full.air.instruments[0].name, 'lead');
  assert.equal(full.air.instruments[0].waveform, 'pulse');
  assert.equal(full.air.samples[0].name, 'blip');
  assert.equal(full.air.samples[0].fallback.synth, 'noise');
  assert.equal(full.air.songs[0].name, 'theme');
  assert.equal(full.air.songs[0].tempo, 120);
  assert.equal(full.air.songs[0].patterns[0].tracks[0].rows[0].note, 48);
  assert.equal(full.air.songs[0].patterns[0].tracks[0].rows[1].note, 55);
  assert.deepEqual(full.air.parts, []);
  assert.deepEqual(full.air.voiceGroups, []);

  const only = analyzeMedia('instrument lead { waveform pulse }\n', 'lead.8ba', { sourceKind: '.8ba' });
  assert.deepEqual(only.diagnostics, []);
  assert.equal(only.air.instruments.length, 1);
  assert.equal(only.air.samples.length, 0);
  assert.equal(only.air.songs.length, 0);
});

test('analyze() on a media file is the media front end, not the .8bs scanner', () => {
  const gfx = analyze('sprite player { source "./a.png" size 8x8 }\n', 't.8bg');
  assert.deepEqual(gfx.filter((d) => d.severity !== 'warning'), []);
  const aud = analyze('instrument lead { waveform pulse }\n', 't.8ba');
  assert.deepEqual(aud, []);
});

test('a missing sample fallback is 8BS2205', () => {
  const diags = analyze(`sample blip { source "./blip.wav" }\n`, 't.8ba');
  assert.ok(diags.some((d) => d.code === Codes.AUD_MISSING_FALLBACK));
});

test('a missing sprite source or size is 8BS2108', () => {
  const diags = analyze('sprite player { size 16x16 }\n', 't.8bg');
  assert.ok(diags.some((d) => d.code === Codes.GFX_MISSING_FIELD && /source/.test(d.message)));
  const size = analyze('sprite player { source "./a.png" }\n', 't.8bg');
  assert.ok(size.some((d) => d.code === Codes.GFX_MISSING_FIELD && /size/.test(d.message)));
});

test('a duplicate resource name is 8BS2107 / 8BS2207', () => {
  const gfx = analyze('sprite a { source "./a.png" size 8x8 }\nsprite a { source "./b.png" size 8x8 }\n', 't.8bg');
  assert.ok(gfx.some((d) => d.code === Codes.GFX_DUPLICATE_NAME));
  const aud = analyze('instrument lead { waveform pulse }\ninstrument lead { waveform noise }\n', 't.8ba');
  assert.ok(aud.some((d) => d.code === Codes.AUD_DUPLICATE_NAME));
});

test('a target block is not in this slice', () => {
  const diags = analyze('target nes { }\ninstrument lead { waveform pulse }\n', 't.8ba');
  assert.ok(diags.some((d) => d.code === Codes.AUD_UNKNOWN_FIELD && /target/.test(d.message)));
});

test('unknown note, unknown waveform, and unknown field are named codes', () => {
  const note = analyze('song s { tempo 120 speed 6 pattern p { track t { row 0 { note H4; } } } }\n', 't.8ba');
  assert.ok(note.some((d) => d.code === Codes.AUD_UNKNOWN_NOTE));
  const wave = analyze('instrument lead { waveform square }\n', 't.8ba');
  assert.ok(wave.some((d) => d.code === Codes.AUD_UNKNOWN_WAVEFORM));
  const field = analyze('sprite player { source "./a.png" size 8x8 hue 3 }\n', 't.8bg');
  assert.ok(field.some((d) => d.code === Codes.GFX_UNKNOWN_FIELD));
});

test('a song that names a missing instrument is 8BS2215', () => {
  const diags = analyze(`song s {
  tempo 120
  speed 6
  pattern p length 4 {
    track t { row 0 { note C4; instrument missing; } }
  }
}
`, 't.8ba');
  assert.ok(diags.some((d) => d.code === Codes.AUD_UNKNOWN_INSTRUMENT));
});

test('a sprite size outside 1x1..64x64 is 8BS2109', () => {
  const diags = analyze('sprite player { source "./a.png" size 0x8 }\n', 't.8bg');
  assert.ok(diags.some((d) => d.code === Codes.GFX_INVALID_SIZE));
});

test('resource names are asset ids: camelCase is allowed', () => {
  const gfx = analyzeMedia('sprite playerWalk { source "./a.png" size 8x8 }\n', 't.8bg', { sourceKind: '.8bg' });
  assert.deepEqual(gfx.diagnostics, []);
  assert.equal(gfx.gir.sprites[0].name, 'playerWalk');
});
