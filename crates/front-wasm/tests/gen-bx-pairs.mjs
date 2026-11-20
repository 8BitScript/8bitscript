// One-time generator for the in-repo `.8bx` pairs: copies each file to
// `pairs/<n>-<name>.old.8bx` and writes its conversion to `<n>-<name>.8bx`, the
// way `8bs migrate` writes it (same-stem imports keep the string path).
// Run from the repo root: node crates/front-wasm/tests/gen-bx-pairs.mjs
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateText, sameStemIn } from '../../../packages/cli/src/migrate/index.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'pairs');
const sources = [
  'packages/examples/hello-8bx/src/Hello.8bx',
  'packages/examples/fancy/src/Mark.8bx',
  'packages/examples/joystick/src/Mark.8bx',
  'packages/examples/media-walk/src/Walk.8bx',
  'packages/examples/swarm/src/Scene.8bx',
  'packages/studio/src/daw/MenuBar.8bx',
  'packages/studio/src/daw/StatusBar.8bx',
  'packages/ui/src/menubar.8bx',
  'packages/ui/test/menubar-probe.8bx',
];
sources.forEach((path, i) => {
  const stem = `${String(9 + i).padStart(2, '0')}-${basename(path, '.8bx').toLowerCase()}`;
  const text = readFileSync(path, 'utf8');
  const { text: converted } = migrateText(text, { file: path, sourceKind: '.8bx', sameStem: sameStemIn(path) });
  copyFileSync(path, join(dir, `${stem}.old.8bx`));
  writeFileSync(join(dir, `${stem}.8bx`), converted);
});
