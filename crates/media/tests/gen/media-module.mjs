// Regenerates fixtures/media-module.json. Run from the repo root:
//   node crates/media/tests/gen/media-module.mjs
import { parseMediaModule, isMediaKind } from '../../../../packages/compiler/src/media/index.mjs';
import { write } from './util.mjs';

const rows = [];
const add = (name, file, text, sourceKind) => {
  const diagnostics = [];
  const mod = parseMediaModule(file, text, diagnostics, sourceKind);
  const { file: f, text: t, tokens, media } = mod;
  rows.push({
    fn: 'parseMediaModule',
    name,
    args: [file, text, [], sourceKind],
    // The tap encoder writes ast: null and the empty bound; `diagnostics` is the `after`.
    result: { file: f, text: t, tokens, media, diagnostics },
  });
};

add('graphics clean', 'hero.8bg', '// hero\nsprite hero { source "hero.png" size 16x16 animation walk { frames 0, 1 every 2 } }\n', '.8bg');
add('graphics with diagnostics', 'bad.8bg', 'sprite a { size 0x0 colour 1 } "open', '.8bg');
add('graphics empty', 'empty.8bg', '', '.8bg');
add('graphics non-ascii', 'u.8bg', '/* é😀 */ sprite é { source "x.png" size 4x4 } @', '.8bg');
add('audio clean', 'song.8ba', 'instrument lead { waveform pulse }\nsong s { tempo 120 pattern a length 4 { track t { row 0 { note C4 instrument lead } } } }\n', '.8ba');
add('audio with diagnostics', 'bad.8ba', 'instrument a { waveform sine } sample s { } song z { tempo 0 } "open', '.8ba');
add('audio empty', 'empty.8ba', '', '.8ba');
add('audio non-ascii', 'u.8ba', '/* é😀 */ instrument é { } @', '.8ba');

for (const k of ['.8bg', '.8ba', '.8bs', '.8bx', '', '.8bgx']) {
  rows.push({ fn: 'isMediaKind', name: `kind ${k}`, args: [k], result: isMediaKind(k) });
}
write('media-module', rows);
