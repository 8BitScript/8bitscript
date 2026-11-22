// Regenerates fixtures/analyze/golden from the JS oracle (packages/compiler analyze()).
// Run from the repo root: node crates/front/tests/gen/analyze.mjs
//
// Each case is one analyze() call over a file of fixtures/analyze/src, with the options the case
// names (never a frame rate: the fold's default of 60 is part of what is checked). The files are
// written with the project root as `<project>`, so they do not depend on where the checkout is.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../../../../packages/compiler/index.mjs';
import { canonicalJson } from '../../../../packages/cli/src/stage-dump.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'analyze');
const golden = join(fixture, 'golden');

// name, file, options. `override` analyzes main.8bs's own name over Window.8bx's text.
const cases = [
  ['imports-off', 'main.8bs', {}],
  ['imports-on', 'main.8bs', { resolveImports: true }],
  ['media', 'sprite.8bg', {}],
  ['kind-override', 'Window.8bx', { sourceKind: '.8bs' }],
];

const scratch = mkdtempSync(join(tmpdir(), 'analyze-gen-'));
try {
  cpSync(join(fixture, 'src'), scratch, { recursive: true });
  const roots = { project: [scratch] };
  rmSync(golden, { recursive: true, force: true });
  mkdirSync(golden, { recursive: true });
  for (const [name, file, options] of cases) {
    const path = join(scratch, file);
    const found = analyze(readFileSync(path, 'utf8'), path, options);
    writeFileSync(join(golden, `${name}.json`), canonicalJson(found, roots));
    process.stdout.write(`${name}: ${found.length} diagnostics\n`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
