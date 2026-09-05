// VICE model flags `8bs run` passes. The PET used to sit in VICE_MODEL_ARGS
// as an NTSC/PAL pair (3032/4032) — a missing entry once left xpet on its
// 50Hz default during an NTSC run. It is no longer keyed by region at all:
// the PET's refresh is the model's, the model is the build's `--profile`
// (PET_PROFILES in backend-6502), and `--pal` prints a note instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VICE_MODEL_ARGS, PET_MODEL_ARGS, PET_PROFILE_FPS, PET_REGION_NOTE,
} from '../src/run.mjs';

test('the PET is not a region-keyed VICE model: the profile is the xpet -model, with no -ntsc/-pal beside it', async () => {
  assert.equal(VICE_MODEL_ARGS.pet, undefined);
  const { PET_PROFILES, PET_DEFAULT_PROFILE } = await import('@8bitscript/backend-6502');
  for (const profile of PET_PROFILES) {
    assert.deepEqual(PET_MODEL_ARGS(profile), ['-model', profile]);
    assert.ok(PET_PROFILE_FPS[profile] === 50 || PET_PROFILE_FPS[profile] === 60, profile);
  }
  // The default is the one model VICE autostarts at ~60Hz; the CRTC models
  // run their 50Hz editor ROMs.
  assert.equal(PET_DEFAULT_PROFILE, '3032');
  assert.equal(PET_PROFILE_FPS['3032'], 60);
  assert.equal(PET_PROFILE_FPS['4032'], 50);
  assert.equal(PET_PROFILE_FPS['8032'], 50);
  assert.match(PET_REGION_NOTE, /no --pal\/--ntsc/);
});

test('the other VICE machines still name a whole model per region', () => {
  assert.deepEqual(VICE_MODEL_ARGS.vic20.ntsc, ['-model', 'vic20ntsc']);
  assert.deepEqual(VICE_MODEL_ARGS.c64.pal, ['-model', 'c64']);
  assert.deepEqual(VICE_MODEL_ARGS.c128.ntsc, ['-model', 'ntsc']);
});
