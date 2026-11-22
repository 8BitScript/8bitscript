// Regenerates fixtures/link-diagnostics/golden from the JS oracle (packages/compiler link()).
// Run from the repo root: node crates/front/tests/gen/link-diagnostics.mjs
//
// The entry imports a path no resolver knows ('./thing.txt'), so the link's third pass reports
// 8BS3001 (NOT_COMPILABLE) with its fixed message. The file is written with the project root
// as `<project>`.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../../../packages/compiler/index.mjs';
import { canonicalJson } from '../../../../packages/cli/src/stage-dump.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'link-diagnostics');
const golden = join(fixture, 'golden');

const scratch = mkdtempSync(join(tmpdir(), 'link-diagnostics-gen-'));
try {
  cpSync(join(fixture, 'src'), scratch, { recursive: true });
  const roots = { project: [scratch] };
  const entry = join(scratch, 'main.8bs');
  const result = link(readFileSync(entry, 'utf8'), entry, { machine: 'pet', frameRate: 60, facts: {} });
  rmSync(golden, { recursive: true, force: true });
  mkdirSync(golden, { recursive: true });
  writeFileSync(join(golden, 'diagnostics.json'), canonicalJson(result.diagnostics, roots));
  process.stdout.write(`link-diagnostics fixture: ${result.diagnostics.length} diagnostics\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
