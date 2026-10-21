// Studio is an ordinary 8BitScript app. This release builds for five
// machines — the same set as packages/examples/shared-release-targets.mjs.
import { releaseTargets } from '@8bitscript/examples/shared-release-targets.mjs';

// The X16 is the baseline: keyboard, mouse, VERA, and room to grow the
// full editor. `8bs run` with no target starts there; `8bs build --release`
// measures every other machine's Studio against it.
export default {
  entry: 'src/main.8bs',
  baseline: 'cx16',
  input: { primary: 'mouse', also: ['keyboard', 'stick', 'pad'] },
  // The browser build is the high-resolution Modern host: native text size,
  // the window decides how many cells fit (see packages/web/AGENTS.md).
  targets: { ...releaseTargets, web: { hardware: { machine: 'hifi-hires' } } },
  systems: {
    'Commander X16': { target: 'cx16' },
    'Commodore 64': { target: 'c64' },
    'VIC-20, expanded to 8K': { target: 'vic20', profile: '8k' },
    'PET 4032': { target: 'pet', profile: '4032' },
    'The browser': { target: 'web', hardware: { machine: 'hifi-hires' } },
  },
};
