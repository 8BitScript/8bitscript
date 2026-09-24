import { releaseTargets } from '../shared-release-targets.ts';

export default {
  entry: 'src/hello-bx.8bs',
  targets: {
    pet: releaseTargets.pet,
    c64: releaseTargets.c64,
    vic20: releaseTargets.vic20,
    cx16: releaseTargets.cx16,
    web: releaseTargets.web,
  },
};
