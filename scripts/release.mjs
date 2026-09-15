#!/usr/bin/env node
// Lockstep release: every packages/* version is the toolchain's version.
// Copies the root LICENSE into each package (pnpm pack from a workspace
// finds it; an isolated npm publish would not), then publishes with
// public access. Packages already on npm at this version are skipped so
// a failed release can be re-run without republishing. Run from the
// repository root after the version in every package.json is the one
// you mean to ship.
//
// Once every package is on npm, a separate `pin-release` job
// (`--pin-release`) fast-forwards `release` to the commit the tag
// names. That branch answers one question — what is actually
// downloadable right now — which a tag alone does not: a tag is
// written when the Version Packages PR merges, and publishing happens
// in this script, afterwards. v0.6.0 was tagged and never published.
// v0.6.2 published and then failed the git pin in the same job, which
// skipped Marketplace, docs, and the GitHub Release. Publishing and
// pinning are different jobs so a missing tag or a 403 cannot take
// the other stores down with it.
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

async function onNpmOnce(name, version) {
  try {
    const { stdout } = await exec('npm', ['view', `${name}@${version}`, 'version'], {
      cwd: ROOT,
    });
    return stdout.trim() === version;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How hard the PIN asks before it believes a "no". Named once so the message
// it prints on giving up cannot drift from what it actually did.
//
// 6 tries at 10s (50s total) was not enough: v0.7.0 and v0.8.0 both failed
// to pin on @8bitscript/atari8 specifically, and both times the package
// was readable within about a minute. 24 tries at 10s gives almost 4
// minutes of headroom over that observed worst case.
const PIN_RETRY = { attempts: 24, delayMs: 10000 };

// The registry does not answer for a version the instant it is published.
// `npm view` goes to a read replica, and for the first seconds after a
// publish that replica can still 404 — which `onNpmOnce` cannot tell apart
// from "never published", because npm exits non-zero either way.
//
// While publishing that is harmless: a false "not there" just means we try,
// and a republish of the same version fails loudly. While PINNING it is the
// whole job. v0.7.0 published all twenty packages and then failed to pin
// `release` because @8bitscript/atari8 had not surfaced yet; every package
// was readable a minute later. So the pin asks again before it believes a
// "no".
//
// Retrying costs nothing when the answer is already yes (one call), and when
// a package genuinely was not published it delays a failure that is still a
// failure. There is no case where waiting gives a wrong answer.
async function alreadyOnNpm(name, version, { attempts = 1, delayMs = 5000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    if (await onNpmOnce(name, version)) return true;
    if (attempt >= attempts) return false;
    process.stdout.write(
      `${name}@${version} not visible yet (attempt ${attempt}/${attempts}); waiting ${delayMs}ms\n`,
    );
    await sleep(delayMs);
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

// Confirms a package this script is *not* about to publish — because
// alreadyOnNpm() already found it there — doesn't have a workspace:*
// dependency baked into its published manifest. `npm view` reads the
// tarball's own package.json, the same thing a downstream `pnpm install`
// resolves against, so this is checking the real failure mode rather
// than a proxy for it.
async function assertNoWorkspaceDeps(name, version) {
  const { stdout } = await exec('npm', ['view', `${name}@${version}`, 'dependencies', '--json'], {
    cwd: ROOT,
  });
  const deps = stdout.trim() ? JSON.parse(stdout) : {};
  const bad = Object.entries(deps).filter(([, spec]) => String(spec).startsWith('workspace:'));
  if (bad.length > 0) {
    process.stderr.write(
      `${name}@${version} is already on npm with unresolved workspace: dependencies ` +
        `(${bad.map(([dep]) => dep).join(', ')}) — it was published outside \`pnpm publish\` ` +
        '(or its rewrite failed) and needs a patch release to fix.\n',
    );
    process.exit(1);
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
const pinOnly = process.argv.includes('--pin-release');
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
  // Pinning runs right after publishing, so it is the one that races the
  // registry; publishing wants the fast answer.
  if (await alreadyOnNpm(pkg.name, version, pinOnly ? PIN_RETRY : {})) {
    if (!pinOnly) {
      // package.json on disk is *supposed* to say workspace:* for a
      // sibling dependency — pnpm publish rewrites that to a real
      // version at publish time, so checking the source file (as this
      // once did) rejects every package with an internal dependency,
      // always. The only place a broken rewrite can be caught is the
      // registry, after the fact — which is also the only way to catch
      // a publish that happened outside pnpm entirely, since a package
      // already "on npm" here is trusted and never re-published. This
      // is exactly how @8bitscript/raster@0.10.0 shipped broken: a
      // manual `npm publish` bootstrap skipped the rewrite, and this
      // script saw it already on npm and moved on without looking.
      await assertNoWorkspaceDeps(pkg.name, version);
      process.stdout.write(`Already on npm: ${pkg.name}@${version}\n`);
    }
    continue;
  }
  if (pinOnly) {
    process.stderr.write(
      `Cannot pin \`release\` to v${version}: ${pkg.name}@${version} is not on npm, ` +
        `after ${PIN_RETRY.attempts} tries over ` +
        `${((PIN_RETRY.attempts - 1) * PIN_RETRY.delayMs) / 1000}s.\n`,
    );
    process.exit(1);
  }
  await cp(join(ROOT, 'LICENSE'), join(ROOT, 'packages', name, 'LICENSE'));
  pending.push(name);
}

if (pending.length === 0) {
  if (!pinOnly) process.stdout.write(`All @8bitscript/* ${version} packages are already on npm.\n`);
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

if (!pinOnly) process.exit(0);

// `--pin-release` is its own CI job, after npm. It is pushed to the commit
// the tag names rather than to HEAD: a release is built from the tag, so
// pointing the branch anywhere else would describe a different tree than
// the one that shipped. A trunk recovery clone has no tags (v0.6.2 run
// 34766752093), so fetch the one tag we need rather than refusing.
const tag = `v${version}`;
let hadTag = true;
try {
  await exec('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: ROOT });
} catch {
  hadTag = false;
}
if (!hadTag) {
  try {
    await exec('git', ['fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], { cwd: ROOT });
  } catch (err) {
    const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
    process.stderr.write(
      `Cannot pin \`release\`: ${tag} is not in this clone and fetching it from origin failed.\n${detail}\n`,
    );
    process.exit(1);
  }
}
const { stdout: tagged } = await exec('git', ['rev-list', '-n', '1', tag], { cwd: ROOT });
const sha = tagged.trim();
process.stdout.write(`Pinning release to ${sha.slice(0, 8)} (${tag})${hadTag ? '' : ', fetched tag'}.\n`);

// No --force: git refuses a push that is not a fast-forward, which is the
// check we want rather than something to work around. `release` trailing
// trunk is normal; `release` holding something trunk does not is a problem
// worth stopping for. A 403 is not that: it is the token or the branch
// protection refusing the actor, and the message has to say so — v0.6.2
// printed "diverged" over `Permission denied to github-actions[bot]`.
try {
  await exec('git', ['push', 'origin', `${sha}:refs/heads/release`], { cwd: ROOT });
  process.stdout.write(`release -> ${sha.slice(0, 8)} (${tag}).\n`);
} catch (err) {
  const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
  const denied = /403|Permission .* denied/i.test(detail);
  if (denied) {
    process.stderr.write(
      `Pushing \`release\` to ${tag} (${sha.slice(0, 8)}) was denied. ` +
        'The pin-release job needs contents: write, and `release` must not restrict pushes to a human — ' +
        'GITHUB_TOKEN authenticates as github-actions[bot]. npm is unaffected.\n' +
        `${detail}\n`,
    );
  } else {
    process.stderr.write(
      `\`release\` could not be fast-forwarded to ${tag}. ` +
        'It is behind or has diverged — inspect it; npm is unaffected.\n' +
        `${detail}\n`,
    );
  }
  process.exit(1);
}
