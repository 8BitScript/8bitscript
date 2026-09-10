// VICE model flags `8bs run` passes. The PET used to sit in VICE_MODEL_ARGS
// as an NTSC/PAL pair (3032/4032) — a missing entry once left xpet on its
// 50Hz default during an NTSC run. It is no longer keyed by region at all:
// the PET's refresh is the model's, the model is a hardware option in
// packages/pet's catalog, and `--pal` prints a note instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VICE_MODEL_ARGS, PET_REGION_NOTE, DEFAULT_LOAD } from '../src/run.mjs';
import { loadCatalog, resolveHardware } from '../src/hardware.mjs';

test('the PET is not a region-keyed VICE model: the model option is the xpet -model, with no -ntsc/-pal beside it', () => {
  assert.equal(VICE_MODEL_ARGS.pet, undefined);
  const catalog = loadCatalog('pet');
  for (const model of Object.keys(catalog.options.model.values)) {
    const { hardware } = resolveHardware(catalog, { overrides: { model } });
    // RAM is its own option now (a real on-board upgrade path, independent
    // of which board is chosen — packages/pet/AGENTS.md), so every model
    // needs -ramsize spelled out beside -model, not just the 2001: leaving
    // `ram` unset here means it stays at its own default (4 KiB), `speaker`
    // at its own default (none, +sound), and `drive` at its own default
    // (none, -drive8type 0) — none of the three depends on which model
    // this loop is overriding.
    assert.deepEqual(hardware.run.xpet, ['-model', model, '-ramsize', '4', '+sound', '-drive8type', '0']);
    const fps = hardware.facts['video.frameRate'];
    assert.ok(fps === 50 || fps === 60, model);
  }
  // The default is the smallest real PET (2001, 4K) — the harshest machine
  // to test a program against, not the roomiest; the CRTC models run their
  // 50Hz editor ROMs regardless of which one BASIC autostarts fastest on.
  assert.equal(catalog.options.model.default, '2001');
  const fpsOf = (model) => resolveHardware(catalog, { overrides: { model } }).hardware.facts['video.frameRate'];
  assert.equal(fpsOf('3032'), 60);
  assert.equal(fpsOf('4032'), 50);
  assert.equal(fpsOf('8032'), 50);
  assert.match(PET_REGION_NOTE, /no --pal\/--ntsc/);
});

test('the other VICE machines still name a whole model per region', () => {
  assert.deepEqual(VICE_MODEL_ARGS.vic20.ntsc, ['-model', 'vic20ntsc']);
  assert.deepEqual(VICE_MODEL_ARGS.c64.pal, ['-model', 'c64']);
  assert.deepEqual(VICE_MODEL_ARGS.c128.ntsc, ['-model', 'ntsc']);
});

test('every emulator has a default way of taking the file', () => {
  assert.deepEqual(DEFAULT_LOAD.x64sc('/x/m.prg'), ['-autostart', '/x/m.prg']);
  assert.deepEqual(DEFAULT_LOAD.atari800('/x/m.xex'), ['-run', '/x/m.xex']);
  assert.deepEqual(DEFAULT_LOAD.x16emu('/x/m.prg'), ['-prg', '/x/m.prg', '-run']);
});
