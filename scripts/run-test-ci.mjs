#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ciTestFilters } from './ci-excluded-packages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm', ['--recursive', '--if-present', ...ciTestFilters(), 'test']);
run(process.execPath, [
  '--test',
  'site/test/build-all.test.mjs',
  'site/test/layout.test.mjs',
  'scripts/require-changeset.test.mjs',
]);
