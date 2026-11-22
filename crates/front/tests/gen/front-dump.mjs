// Regenerates fixtures/front-dump/golden from the JS oracle (packages/compiler linker).
// Run from the repo root: node crates/front/tests/gen/front-dump.mjs
//
// The fixture is a slotted component whose two `let`s before `<slot />` and whose parameter
// default hold folds that report: the JS reports each `let` once and the default three times
// (the whole, `__open` and `__close`). The module dumps of the link are written with the
// project root as `<project>`, so the files do not depend on where the checkout is.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../../../packages/compiler/index.mjs';
import { canonicalJson, stageFile } from '../../../../packages/cli/src/stage-dump.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'front-dump');
const golden = join(fixture, 'golden');

const scratch = mkdtempSync(join(tmpdir(), 'front-dump-gen-'));
try {
  cpSync(join(fixture, 'src'), scratch, { recursive: true });
  const roots = { project: [scratch] };
  const files = new Map();
  const dump = (stage, value, key) => {
    if (stage === 'diagnostics' || !key) return;
    files.set(stageFile(stage, key, roots), canonicalJson(value, roots));
  };
  const entry = join(scratch, 'main.8bs');
  const result = link(readFileSync(entry, 'utf8'), entry, { machine: 'pet', frameRate: 60, facts: {}, dump });
  rmSync(golden, { recursive: true, force: true });
  for (const [rel, text] of files) {
    mkdirSync(dirname(join(golden, rel)), { recursive: true });
    writeFileSync(join(golden, rel), text);
  }
  const fold = result.diagnostics.filter((d) => d.file?.endsWith('Window.8bx'));
  writeFileSync(join(golden, 'diagnostics.json'), canonicalJson(fold, roots));
  process.stdout.write(`front-dump fixture: ${files.size} files, ${fold.length} diagnostics of Window.8bx\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
