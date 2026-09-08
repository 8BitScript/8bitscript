// Build the documentation site once as the latest release at `/` and once
// as a frozen snapshot at `/<version>/`, then write versions.json for the
// header dropdown. Pagefind indexes the latest tree before version
// snapshots are added, so `/` search stays on the current release.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { build } from './build.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'dist', 'site');

function majorOf(version) {
  return version.split('.')[0] ?? '0';
}

function snapshotPath(version) {
  return version === 'dev' ? '/dev' : `/${version}`;
}

async function gitTags() {
  try {
    const { stdout } = await exec('git', ['tag', '-l', 'v*'], { cwd: ROOT });
    return stdout
      .split(/\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.replace(/^v/, ''))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

async function pagefind(dir) {
  await exec('pnpm', ['exec', 'pagefind', '--site', dir], { cwd: ROOT });
}

async function buildTree({ version, base, out }) {
  process.env.DOCS_VERSION = version;
  process.env.DOCS_BASE = base;
  process.env.DOCS_OUT = out;
  await build();
  await pagefind(resolve(ROOT, out));
}

const pkg = JSON.parse(await readFile(join(ROOT, 'packages/cli/package.json'), 'utf8'));
const current = pkg.version;
const tagged = await gitTags();
const versions = tagged.includes(current) ? tagged : [...tagged, current];

await rm(SITE, { recursive: true, force: true });
await buildTree({ version: current, base: '', out: 'dist/site' });

for (const version of versions) {
  await buildTree({
    version,
    base: snapshotPath(version),
    out: join('dist', 'site', version),
  });
}

const manifest = {
  current,
  versions: versions
    .slice()
    .reverse()
    .map((version) => ({
      version,
      label: version,
      major: majorOf(version),
      path: snapshotPath(version),
      latest: version === current,
    })),
};

await writeFile(join(SITE, 'versions.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.versions.length} version(s); latest is ${current}.`);
