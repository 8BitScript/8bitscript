#!/usr/bin/env node
// Lockstep release: every packages/* version is the toolchain's version.
// Copies the root LICENSE into each package (pnpm pack from a workspace
// finds it; an isolated npm publish would not), then publishes with
// public access. Packages already on npm at this version are skipped so
// a failed release can be re-run without republishing. Run from the
// repository root after the version in every package.json is the one
// you mean to ship.
import { cp, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function alreadyOnNpm(name, version) {
  try {
    const { stdout } = await exec('npm', ['view', `${name}@${version}`, 'version'], {
      cwd: ROOT,
    });
    return stdout.trim() === version;
  } catch {
    return false;
  }
}

// A package npm has never seen at any version, not just missing this one —
// the real 0.2.0 release hit this for real: @8bitscript/examples 404'd on
// both OIDC Trusted Publishing (ERR_PNPM_AUTH_TOKEN_EXCHANGE — no trust
// relationship exists for a package with nothing to attach it to) and the
// NODE_AUTH_TOKEN fallback (ERR_PNPM_FAILED_TO_PUBLISH, plain 404 — the
// token can publish to a package that exists, not create one), 15 packages
// into the batch, stranding everything after it. `npm view <name>` (no
// version) is a clean existence check either way.
async function isNewToNpm(name) {
  try {
    await exec('npm', ['view', name], { cwd: ROOT });
    return false;
  } catch {
    return true;
  }
}

const { stdout: status } = await exec('git', ['status', '--porcelain'], { cwd: ROOT });
if (status.trim() && !process.argv.includes('--allow-dirty')) {
  process.stderr.write('Working tree is not clean. Commit, or pass --allow-dirty.\n');
  process.exit(1);
}

const cli = JSON.parse(await readFile(join(ROOT, 'packages/cli/package.json'), 'utf8'));
const version = cli.version;
const dirs = (await readdir(join(ROOT, 'packages'), { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const expectedRepoUrl = 'https://github.com/8BitScript/8bitscript.git';
const pending = [];

for (const name of dirs) {
  const pkg = JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
  if (pkg.version !== version) {
    process.stderr.write(`${name} is ${pkg.version}, expected ${version}\n`);
    process.exit(1);
  }
  // npm's sigstore provenance check (from Trusted Publishing) verifies
  // package.json's repository.url against the OIDC-issued workflow
  // identity and rejects the publish if it's missing or wrong — this
  // caught v0.1.1 with a real 422 mid-release, so check it up front.
  if (pkg.repository?.url !== expectedRepoUrl) {
    process.stderr.write(
      `${name}'s package.json is missing "repository": { "url": "${expectedRepoUrl}" } ` +
        '(or it doesn\'t match) — npm Trusted Publishing rejects the provenance check without it.\n',
    );
    process.exit(1);
  }
  if (await alreadyOnNpm(pkg.name, version)) {
    process.stdout.write(`Already on npm: ${pkg.name}@${version}\n`);
    continue;
  }
  await cp(join(ROOT, 'LICENSE'), join(ROOT, 'packages', name, 'LICENSE'));
  pending.push(name);
}

if (pending.length === 0) {
  process.stdout.write(`All @8bitscript/* ${version} packages are already on npm.\n`);
} else {
  // A brand-new package publishes on its own, first, before anything else
  // in this run is touched — so a failure there (npm Trusted Publishing
  // has no trust relationship to attach to a package that's never
  // existed; a classic token often can't create one either, only publish
  // to one that already exists) is cheap and immediate, not discovered
  // partway through a 21-package batch with everything after it stranded.
  // See .github/AGENTS.md's "A brand-new package's first publish" section
  // for the manual recovery this can still need — npm ownership and
  // trusted-publisher configuration are account-side, not something this
  // script can fix itself.
  const newPackages = [];
  for (const name of pending) {
    const pkg = JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
    if (await isNewToNpm(pkg.name)) newPackages.push(name);
  }
  if (newPackages.length > 0) {
    process.stdout.write(
      `\n⚠ ${newPackages.length} package(s) have never been published: ${newPackages.map((n) => `@8bitscript/${n}`).join(', ')}.\n` +
        'Publishing these first, in isolation — if this fails, see .github/AGENTS.md ' +
        '("A brand-new package\'s first publish"): npm login as an org owner/member with ' +
        'publish rights, `cd packages/<name> && npm publish --access public` once, then ' +
        're-dispatch this workflow. Nothing else in this run is touched until this succeeds.\n\n',
    );
    const newFilters = newPackages.flatMap((name) => ['--filter', `./packages/${name}`]);
    await run('pnpm', ['-r', 'publish', ...newFilters, '--access', 'public', '--no-git-checks']);
    process.stdout.write(`Published the new package(s). Continuing with the rest.\n\n`);
  }
  const rest = pending.filter((name) => !newPackages.includes(name));
  if (rest.length > 0) {
    process.stdout.write(`Publishing ${rest.length} @8bitscript/* ${version} package(s) from the workspace.\n`);
    const filters = rest.flatMap((name) => ['--filter', `./packages/${name}`]);
    await run('pnpm', ['-r', 'publish', ...filters, '--access', 'public', '--no-git-checks']);
  }
  process.stdout.write(`Published ${version}.\n`);
}
