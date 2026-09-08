#!/usr/bin/env node
// packages/studio's VERSION literal is compiled into every 8BitScript
// build (it's what Studio prints on screen), so it can't read
// package.json at build time — it has to be a literal. Changesets bumps
// package.json but has no idea this literal exists, so this keeps them
// in sync as part of the version-bump step. See
// packages/studio/test/studio.test.mjs for the check this satisfies.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/studio/package.json'), 'utf8'));
const sourcePath = join(ROOT, 'packages/studio/src/studio.8bs');
const source = readFileSync(sourcePath, 'utf8');

const pattern = /const VERSION: string = "[^"]*";/;
if (!pattern.test(source)) {
  process.stderr.write('Could not find the VERSION literal in packages/studio/src/studio.8bs\n');
  process.exit(1);
}

writeFileSync(sourcePath, source.replace(pattern, `const VERSION: string = "${pkg.version}";`));
process.stdout.write(`packages/studio/src/studio.8bs VERSION -> ${pkg.version}\n`);
