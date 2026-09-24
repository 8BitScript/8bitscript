import { releaseTargets } from '../shared-release-targets.ts';

export default {
  entry: 'src/media-walk.8bs',
  targets: {
    pet: { hardware: { model: '4032', ram: '32', speaker: 'attached' } },
    c64: releaseTargets.c64,
    vic20: releaseTargets.vic20,
    cx16: releaseTargets.cx16,
    web: releaseTargets.web,
  },
};
