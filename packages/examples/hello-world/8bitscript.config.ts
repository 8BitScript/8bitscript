import { releaseTargets } from '../shared-release-targets.ts';

export default {
  entry: 'src/hello-world.8bs',
  targets: {
    // Not releaseTargets.pet (4032/32K, the common model release testing
    // wants) — the smallest whole program should show on the smallest real
    // PET, the 2001 with its stock 4K, which is also the catalog's own
    // default (packages/pet/package.json's model/ram options).
    pet: { hardware: { model: '2001', ram: '4' } },
    c64: releaseTargets.c64,
    vic20: releaseTargets.vic20,
    cx16: releaseTargets.cx16,
    web: releaseTargets.web,
  },
};
