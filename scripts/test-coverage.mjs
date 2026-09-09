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
// A shared module like the compiler's linker or IR pass is imported (and so
// instrumented) by every package that depends on it, not just the compiler's
// own tests — the PET keyboard tests exercise it one way, the CLI's build
// tests another. Each package's lcov.info therefore carries its own partial
// SF: block for that file, hit-counting only the lines *that run* touched.
// A straight concatenation leaves those as separate duplicate SF: blocks for
// the same path; most lcov consumers (SonarCloud's JS/TS analyzer included)
// don't union those, they just keep one — so the reported coverage for a
// shared file becomes whichever single package's partial run happened to
// win, not the real total. (This is what made `linker/index.mjs` show 18.5%
// coverage on 2026-09-09 when the true union across every package that
// exercises it was 98.9%.) mergeLcov below unions hit counts per line,
// function, and branch across every package before writing one clean SF:
// block per file.
//
// Excludes the same packages test:ci does (packages/package.json) — they
// boot emulators, which a coverage pass here does not need.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

// files: Map<repoRelativePath, { functions: Map<name, startLine>,
//   functionHits: Map<name, hits>, lines: Map<lineNo, hits>,
//   branches: Map<"line,block,branch", hits | '-'> }>
function mergeLcov(pkgDir, content, files) {
  const relDir = relative(ROOT, pkgDir);
  let current = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const path = join(relDir, line.slice(3));
      current = files.get(path);
      if (!current) {
        current = { functions: new Map(), functionHits: new Map(), lines: new Map(), branches: new Map() };
        files.set(path, current);
      }
    } else if (!current) {
      continue;
    } else if (line.startsWith('FN:')) {
      const [startLine, name] = line.slice(3).split(',');
      current.functions.set(name, startLine);
    } else if (line.startsWith('FNDA:')) {
      const [hits, name] = line.slice(5).split(',');
      current.functionHits.set(name, (current.functionHits.get(name) ?? 0) + Number(hits));
    } else if (line.startsWith('DA:')) {
      const [lineNo, hits] = line.slice(3).split(',');
      current.lines.set(Number(lineNo), (current.lines.get(Number(lineNo)) ?? 0) + Number(hits));
    } else if (line.startsWith('BRDA:')) {
      const [lineNo, block, branch, hits] = line.slice(5).split(',');
      const key = `${lineNo},${block},${branch}`;
      const addend = hits === '-' ? 0 : Number(hits);
      const prev = current.branches.get(key);
      current.branches.set(key, prev === undefined ? hits : (prev === '-' ? hits : prev + addend));
    }
    // FNF/FNH/LF/LH/BRF/BRH/end_of_record/TN are recomputed on write.
  }
}

function writeLcov(files, outFile) {
  const parts = [];
  for (const [path, rec] of files) {
    parts.push(`SF:${path}`);
    for (const [name, startLine] of rec.functions) parts.push(`FN:${startLine},${name}`);
    let fnh = 0;
    for (const name of rec.functions.keys()) {
      const hits = rec.functionHits.get(name) ?? 0;
      parts.push(`FNDA:${hits},${name}`);
      if (hits > 0) fnh++;
    }
    parts.push(`FNF:${rec.functions.size}`, `FNH:${fnh}`);

    if (rec.branches.size) {
      const branchKeys = [...rec.branches.keys()].sort((a, b) => {
        const [al, ab, ar] = a.split(',').map(Number);
        const [bl, bb, br] = b.split(',').map(Number);
        return al - bl || ab - bb || ar - br;
      });
      let brh = 0;
      for (const key of branchKeys) {
        const [lineNo, block, branch] = key.split(',');
        const hits = rec.branches.get(key);
        parts.push(`BRDA:${lineNo},${block},${branch},${hits}`);
        if (hits !== '-' && Number(hits) > 0) brh++;
      }
      parts.push(`BRF:${branchKeys.length}`, `BRH:${brh}`);
    }

    const lineNos = [...rec.lines.keys()].sort((a, b) => a - b);
    let lh = 0;
    for (const lineNo of lineNos) {
      const hits = rec.lines.get(lineNo);
      parts.push(`DA:${lineNo},${hits}`);
      if (hits > 0) lh++;
    }
    parts.push(`LF:${lineNos.length}`, `LH:${lh}`, 'end_of_record');
  }
  writeFileSync(outFile, parts.join('\n') + '\n');
}

const pkgDirs = discoverPackageDirs();
const outDir = join(ROOT, 'coverage');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'lcov.info');
const mergedFiles = new Map();

let failed = false;
for (const pkgDir of pkgDirs) {
  console.log(`\n> coverage: ${relative(ROOT, pkgDir)}`);
  const ok = runPackageCoverage(pkgDir);
  if (!ok) failed = true;
  const lcovPath = join(pkgDir, 'coverage', 'lcov.info');
  if (existsSync(lcovPath)) mergeLcov(pkgDir, readFileSync(lcovPath, 'utf8'), mergedFiles);
}

writeLcov(mergedFiles, outFile);
console.log(`\nMerged coverage from ${pkgDirs.length} packages into coverage/lcov.info`);
if (failed) {
  console.error('\nOne or more packages had failing tests.');
  process.exit(1);
}
