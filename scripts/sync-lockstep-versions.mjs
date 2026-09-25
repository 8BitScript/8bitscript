#!/usr/bin/env node
// Changesets' `fixed` group lists the packages that share a changelog bump;
// new machine packages are easy to add without updating that list. Release
// still requires every packages/* version to match packages/cli — see
// scripts/release.mjs. After `changeset version`, align any stragglers.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const cli = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8'));
const target = cli.version;

const dirs = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const mismatches = [];
for (const name of dirs) {
  const pkgPath = join(ROOT, 'packages', name, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.version === target) continue;
  mismatches.push({ name, was: pkg.version });
  if (!checkOnly) {
    pkg.version = target;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

if (checkOnly) {
  if (mismatches.length > 0) {
    for (const { name, was } of mismatches) {
      process.stderr.write(`${name} is ${was}, expected ${target}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`All packages/* are ${target}.\n`);
  process.exit(0);
}

if (mismatches.length === 0) {
  process.stdout.write(`packages/* already ${target}.\n`);
} else {
  for (const { name, was } of mismatches) {
    process.stdout.write(`${name} ${was} -> ${target}\n`);
  }
}
