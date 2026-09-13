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
  if (await alreadyOnNpm(pkg.name, version)) {
    if (!pinOnly) process.stdout.write(`Already on npm: ${pkg.name}@${version}\n`);
    continue;
  }
  if (pinOnly) {
    process.stderr.write(
      `Cannot pin \`release\` to v${version}: ${pkg.name}@${version} is not on npm.\n`,
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
// #region agent log
fetch('http://127.0.0.1:7654/ingest/0e8448a8-aa1d-4d7c-8c13-fd00a086b724',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'49f08b'},body:JSON.stringify({sessionId:'49f08b',runId:process.env.GITHUB_RUN_ID||'local',hypothesisId:'F',location:'scripts/release.mjs:pin-tag',message:'pin-release tag check',data:{tag,hadTag,ref:process.env.GITHUB_REF||null,sha:process.env.GITHUB_SHA||null,actor:process.env.GITHUB_ACTOR||null},timestamp:Date.now()})}).catch(()=>{});
// #endregion
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
  // #region agent log
  fetch('http://127.0.0.1:7654/ingest/0e8448a8-aa1d-4d7c-8c13-fd00a086b724',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'49f08b'},body:JSON.stringify({sessionId:'49f08b',runId:process.env.GITHUB_RUN_ID||'local',hypothesisId:'A',location:'scripts/release.mjs:push',message:'about to push release',data:{tag,sha,hadTag,actor:process.env.GITHUB_ACTOR||null,hasGithubToken:Boolean(process.env.GITHUB_TOKEN),event:process.env.GITHUB_EVENT_NAME||null,ref:process.env.GITHUB_REF||null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  await exec('git', ['push', 'origin', `${sha}:refs/heads/release`], { cwd: ROOT });
  process.stdout.write(`release -> ${sha.slice(0, 8)} (${tag}).\n`);
} catch (err) {
  const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
  const denied = /403|Permission .* denied/i.test(detail);
  // #region agent log
  fetch('http://127.0.0.1:7654/ingest/0e8448a8-aa1d-4d7c-8c13-fd00a086b724',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'49f08b'},body:JSON.stringify({sessionId:'49f08b',runId:process.env.GITHUB_RUN_ID||'local',hypothesisId:denied?'A':'C',location:'scripts/release.mjs:push-catch',message:'git push origin sha:refs/heads/release failed',data:{tag,sha,denied,detail:detail.slice(0,500),actor:process.env.GITHUB_ACTOR||null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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
