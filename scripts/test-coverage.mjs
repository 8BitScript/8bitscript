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
// and function across every package before writing one clean SF: block per
// file.
//
// Branches cannot be unioned the same way. Node numbers each BRDA `block`
// sequentially per file per run, and V8 only reports a block range whose
// count differs from its enclosing range, so which entries exist (and their
// indices) depends on what that run executed. The same source branch gets a
// different `line,block,branch` key in each package's run, and a package that
// imports a file but never takes a branch in it adds phantom never-taken
// entries for that line (this is how `if (dump) {` in linker/index.mjs
// reported 1 of 10 conditions covered). So per (file, line) mergeLcov keeps
// the BRDA set of a single run: the one with the most taken branches, then
// the one with more entries. Runs whose sets have identical keys describe the
// same branches, so their hit counts are summed instead. Line coverage is
// unaffected.
//
// Excludes the same packages test:ci does (packages/package.json) — they
// boot emulators, which a coverage pass here does not need.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CI_EXCLUDED_PACKAGE_DIRS } from './ci-excluded-packages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_GLOBS = ['packages', 'editors'];
const EXCLUDE_DIR_NAMES = CI_EXCLUDED_PACKAGE_DIRS;

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

const takenCount = (set) => {
  let n = 0;
  for (const hits of set.values()) if (hits !== '-' && Number(hits) > 0) n++;
  return n;
};

const sameKeys = (a, b) => a.size === b.size && [...a.keys()].every((k) => b.has(k));

const hitCount = (hits) => (hits === '-' ? 0 : Number(hits));

// Same branches seen by two runs: add the hit counts (`-` stays `-` only if
// both runs left it unreported).
function sumInto(kept, incoming) {
  for (const [key, hits] of incoming) {
    const prev = kept.get(key);
    kept.set(key, prev === '-' && hits === '-' ? '-' : hitCount(prev) + hitCount(hits));
  }
  return kept;
}

// Different shapes: keep the set with more taken branches, then more entries.
function pickBetter(kept, incoming) {
  const keptTaken = takenCount(kept);
  const incomingTaken = takenCount(incoming);
  if (incomingTaken !== keptTaken) return incomingTaken > keptTaken ? incoming : kept;
  return incoming.size > kept.size ? incoming : kept;
}

// Folds one run's BRDA entries for a line (`incoming`: Map<"block,branch",
// hits | '-'>) into the set kept so far (`kept`, or undefined).
function mergeBranchSet(kept, incoming) {
  if (!kept) return incoming;
  return sameKeys(kept, incoming) ? sumInto(kept, incoming) : pickBetter(kept, incoming);
}

// files: Map<repoRelativePath, { functions: Map<name, startLine>,
//   functionHits: Map<name, hits>, lines: Map<lineNo, hits>,
//   branches: Map<lineNo, Map<"block,branch", hits | '-'>> }>
const newRecord = () => ({ functions: new Map(), functionHits: new Map(), lines: new Map(), branches: new Map() });

// Applies one non-SF lcov row to the file record being built. `runBranches`
// collects this run's BRDA rows by line until the record ends.
function applyRow(rec, runBranches, line) {
  if (line.startsWith('FN:')) {
    const [startLine, name] = line.slice(3).split(',');
    rec.functions.set(name, startLine);
  } else if (line.startsWith('FNDA:')) {
    const [hits, name] = line.slice(5).split(',');
    rec.functionHits.set(name, (rec.functionHits.get(name) ?? 0) + Number(hits));
  } else if (line.startsWith('DA:')) {
    const [lineNo, hits] = line.slice(3).split(',');
    rec.lines.set(Number(lineNo), (rec.lines.get(Number(lineNo)) ?? 0) + Number(hits));
  } else if (line.startsWith('BRDA:')) {
    const [lineNo, block, branch, hits] = line.slice(5).split(',');
    const lineKey = Number(lineNo);
    if (!runBranches.has(lineKey)) runBranches.set(lineKey, new Map());
    runBranches.get(lineKey).set(`${block},${branch}`, hits === '-' ? '-' : Number(hits));
  }
  // FNF/FNH/LF/LH/BRF/BRH/end_of_record/TN are recomputed on write.
}

function flushBranches(rec, runBranches) {
  if (!rec) return;
  for (const [lineNo, set] of runBranches) {
    rec.branches.set(lineNo, mergeBranchSet(rec.branches.get(lineNo), set));
  }
}

export function mergeLcov(pkgDir, content, files) {
  const relDir = relative(ROOT, pkgDir);
  let current = null;
  let runBranches = new Map(); // this run's BRDA rows for `current`, by line
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      flushBranches(current, runBranches);
      runBranches = new Map();
      const path = join(relDir, line.slice(3));
      if (!files.has(path)) files.set(path, newRecord());
      current = files.get(path);
    } else if (current) {
      applyRow(current, runBranches, line);
    }
  }
  flushBranches(current, runBranches);
}

export function writeLcov(files, outFile) {
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

    const branchLines = [...rec.branches.keys()].sort((a, b) => a - b);
    if (branchLines.length) {
      let brf = 0;
      let brh = 0;
      for (const lineNo of branchLines) {
        const entries = [...rec.branches.get(lineNo)].map(([key, hits]) => [...key.split(',').map(Number), hits]);
        entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        for (const [block, branch, hits] of entries) {
          parts.push(`BRDA:${lineNo},${block},${branch},${hits}`);
          brf++;
          if (hits !== '-' && hits > 0) brh++;
        }
      }
      parts.push(`BRF:${brf}`, `BRH:${brh}`);
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

function main() {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
