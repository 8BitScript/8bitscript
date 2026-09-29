import { releaseTargets } from '../shared-release-targets.ts';

export default {
  // hbx.8bs, not hello-bx.8bs: this file's own basename is the artifact
  // stem (programStem() in packages/cli/src/programs.mjs), and CBM DOS
  // only holds sixteen characters. "hello-bx-pet-4032-32" (the release
  // PET's tagged name) was already twenty; the shorter file keeps the
  // release hardware this example is meant to test and still fits.
  entry: 'src/hbx.8bs',
  targets: {
    pet: releaseTargets.pet,
    c64: releaseTargets.c64,
    vic20: releaseTargets.vic20,
    cx16: releaseTargets.cx16,
    web: releaseTargets.web,
  },
};
