#!/usr/bin/env node
// Runs every workspace package's tests under node's built-in coverage
// collector, then merges the per-package lcov.info files into one
// repo-relative coverage/lcov.info for SonarCloud (sonar.javascript.lcov.reportPaths).
//
// Node's test runner only reports the files *it* touched, and each run's
// coverage/lcov.info paths are relative to that package's own directory, so
// a straight concatenation would produce `SF:index.mjs` from a dozen
// different packages pointing at the same nonexistent root-level file. This
// rewrites each SF: line to be relative to the repo root before merging.
//
// Excludes the same packages test:ci does (packages/package.json) — they
// boot emulators, which a coverage pass here does not need.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_GLOBS = ['packages', 'editors'];
const EXCLUDE_DIR_NAMES = new Set(['atari8', 'c128', 'c64', 'cx16', 'pet', 'pointer']);

function discoverPackageDirs() {
  const dirs = [];
  for (const group of WORKSPACE_GLOBS) {
    const groupPath = join(ROOT, group);
    if (!existsSync(groupPath)) continue;
    for (const name of readdirSync(groupPath)) {
      if (group === 'packages' && EXCLUDE_DIR_NAMES.has(name)) continue;
      const pkgDir = join(groupPath, name);
      const pkgJsonPath = join(pkgDir, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      if (pkgJson.scripts && pkgJson.scripts.test) dirs.push(pkgDir);
    }
  }
  return dirs;
}

function runPackageCoverage(pkgDir) {
  const coverageDir = join(pkgDir, 'coverage');
  rmSync(coverageDir, { recursive: true, force: true });
  mkdirSync(coverageDir, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=lcov',
      '--test-reporter-destination=coverage/lcov.info',
    ],
    { cwd: pkgDir, stdio: 'inherit' },
  );
  return result.status === 0;
}

function mergeCoverage(pkgDir, outFile) {
  const lcovPath = join(pkgDir, 'coverage', 'lcov.info');
  if (!existsSync(lcovPath)) return;
  const relDir = relative(ROOT, pkgDir);
  const rewritten = readFileSync(lcovPath, 'utf8')
    .split('\n')
    .map((line) => (line.startsWith('SF:') ? `SF:${join(relDir, line.slice(3))}` : line))
    .join('\n');
  appendFileSync(outFile, rewritten);
}

const pkgDirs = discoverPackageDirs();
const outDir = join(ROOT, 'coverage');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'lcov.info');

let failed = false;
for (const pkgDir of pkgDirs) {
  console.log(`\n> coverage: ${relative(ROOT, pkgDir)}`);
  const ok = runPackageCoverage(pkgDir);
  if (!ok) failed = true;
  mergeCoverage(pkgDir, outFile);
}

console.log(`\nMerged coverage from ${pkgDirs.length} packages into coverage/lcov.info`);
if (failed) {
  console.error('\nOne or more packages had failing tests.');
  process.exit(1);
}
