# Releasing 8BitScript

How a version actually ships, and how to recover when one of the
stores fails. The design (changesets, lockstep versions, human-only
Version Packages merge) is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#changesets-versioning). This
file is the runbook.

## What a release is

One number, four stores:

| Store | How it publishes | 0.1.1 |
| --- | --- | --- |
| npm `@8bitscript/*` | `scripts/release.mjs` via Trusted Publishing | shipped |
| Visual Studio Marketplace | `scripts/publish-marketplace.mjs` | vsce's client dies at 180s; we wait 10 minutes |
| Open VSX | `ovsx publish` | same VSIX; must not wait on Marketplace |
| GitHub Release | `gh release create vX.Y.Z` | waits on the jobs above |

The GitHub Release for 0.1.1 was deleted (the tag `v0.1.1` stays so
npm's provenance still points at a real commit). Marketplace and Open
VSX already have 0.1.1. The next GitHub Release is 0.1.2.

The Version Packages PR is what bumps every `package.json`. The
changesets `fixed` group does not list every machine package; `pnpm run
changeset:version` runs `scripts/sync-lockstep-versions.mjs` after
`changeset version` so all of `packages/*` still match
`packages/cli` before `release.mjs` runs. Merging it is a human
decision — see the root
[`AGENTS.md`](../AGENTS.md#version-bumps-are-a-human-decision). After
that merge, `tag-release.yml` tags `vX.Y.Z` and dispatches
`release.yml`.

A pull request that changes `packages/` or `editors/` and does not add
a `.changeset/*.md` file fails the `Changeset` check (`CI` workflow,
`scripts/require-changeset.mjs`). That is what stops a package change
from merging with nothing for the version bot to release. Docs, the
site, and CI are not published packages and do not need one. An empty
changeset (`pnpm changeset --empty`) is the opt-out, and it has to be
committed. This pull request's own branch, `changeset-release/*`, is
exempt because it is the consumption of those files. Trunk's branch
protection has to require the `Changeset` check or a red run can still
be merged.

## The editor VSIX

`editors/vscode` is a thin client: syntax, the launcher, and a small
stdio JSON-RPC speaker (`src/lspClient.cjs`) for `8bs lsp`. The
language server and the compiler are **not** in the VSIX. Do not add
`vscode-languageclient` back — that library is the rest of the LSP
spec and is why 0.1.1's first VSIX was a megabyte. Do not download
code from npm at activation.

Do not use `vsce publish` in CI. Its Azure client gives up at 180
seconds while the gallery is still processing a tiny VSIX. Package
with `vsce package`, then `scripts/publish-marketplace.mjs`, which
hits the same `/_apis/gallery` endpoints and waits ten minutes.

Jobs already run the toolchain on Node 26 (`node-version: 26`). The
"Node.js 20 is deprecated" annotation is GitHub's own actions
(`checkout`, `setup-node`, `cache`) declaring their *action* runtime,
not the version `pnpm` and tests use. Keep those actions on a Node 24
major (`@v5`).

## The `release` branch

The `pin-release` job (`scripts/release.mjs --pin-release`)
points `release` at the tagged commit **after** npm has that version
(fast-forward when it can, force when `release` still names rewritten
history). It is a different job from publish on purpose: v0.6.2's first
run 403'd the git push inside the npm job and skipped Marketplace,
docs, and the GitHub Release; the trunk re-run (34766752093) then
failed npm because a depth-1 checkout of `trunk` has no tags. Publish
staying green is what lets the other stores run.

The tag is written when Version Packages merges; this branch is the
answer to "what is actually downloadable," which a tag alone is not
(v0.6.0 was tagged and never published).

Two settings have to stay true or the pin 403s as
`github-actions[bot]`:

1. The **pin-release job** needs `contents: write`. The npm job stays
   `contents: read` plus `id-token: write`.
2. Branch protection on `release` must **not** "Restrict who can push"
   to a human. `GITHUB_TOKEN` authenticates as `github-actions[bot]`,
   which cannot be added to that allow list. Linear history still
   belongs there. Force-push must stay allowed: after a `trunk` rewrite
   the pin is not a fast-forward (v0.23.0), and a rejected push is a
   red Release even though npm already shipped.

`--pin-release` fetches `refs/tags/vX.Y.Z` if the clone does not have
it. Do not rely on `actions/checkout` to have brought tags along.

## Recovering a half-finished release

If npm is already at this version and a marketplace timed out
(or `release` was not fast-forwarded):

1. Do **not** add a changeset or merge Version Packages.
2. Do **not** run `vsce` / `ovsx` / `scripts/release.mjs` on a laptop.
3. Land any packaging or workflow fix on `trunk`.
4. Re-run the same version:

```bash
gh workflow run release.yml --ref trunk
```

`release.mjs` skips packages already on npm. `release.yml` reads the
version from `packages/cli/package.json`, so dispatching from `trunk`
still creates `vX.Y.Z`. Marketplace and Open VSX publish independently;
`--skip-duplicate` is safe if a timed-out request actually landed.

```bash
gh run watch
```

Check the stores before calling it done: `npm view @8bitscript/cli version`,
the Marketplace item `8bitscript.8bitscript-lang`, and
`https://open-vsx.org/api/8bitscript/8bitscript-lang`.

## A brand-new package's first publish

npm Trusted Publishing (OIDC) and the `NODE_AUTH_TOKEN` fallback both
assume the package already exists. A name that has never been claimed
has nothing to attach a trust relationship to, so CI cannot create it.
0.2.0 hit this for real with `@8bitscript/examples`: `release.mjs`
reached it 15 packages into the batch and both auth paths 404'd
(`ERR_PNPM_AUTH_TOKEN_EXCHANGE` on OIDC, plain `Not found` on the
token), stranding everything after it and skipping
`docs`/`extension`/`github-release`.

`release.mjs` now checks existence (`npm view <name>`, no version)
before publishing anything and, if it finds a new name, publishes
just that package first. That makes a first-publish failure immediate
and cheap — but the fix is still a human with an npm account, because
only an account can bootstrap a name that's never existed.

Do this **once, before (or as part of) the PR that adds the
package**, not as a surprise in the middle of a release. After the
name exists and OIDC is attached, every later version ships through
the Version Packages PR like everything else. Do **not** publish later
versions from a laptop.

The trusted-publisher config on an existing package (e.g.
`@8bitscript/c64`) is the template: GitHub Actions, this repo, the
`release.yml` workflow, `npm publish` allowed. `release.yml`'s npm job
already has `id-token: write`; nothing in GitHub changes per package.

### 0. `package.json` before it can ship

Copy these from an existing `packages/*/package.json` (updating
`directory` / `name`):

- `"name": "@8bitscript/<name>"`
- `"version"` matching `packages/cli/package.json` (lockstep — every
  `@8bitscript/*` package is the same number)
- `"repository": { "type": "git", "url": "https://github.com/8BitScript/8bitscript.git", "directory": "packages/<name>" }`
  — `scripts/release.mjs` fails fast if this is missing or wrong.
  npm's provenance check (from Trusted Publishing) verifies it against
  the OIDC-issued workflow identity and rejects the publish without it.
- `"publishConfig": { "access": "public" }`
- `"files"` listing what should actually be in the tarball
- not `"private": true`

Copy the root `LICENSE` into `packages/<name>/` as well.
`scripts/release.mjs` does that for CI publishes; a laptop bootstrap
has to do it by hand or the tarball ships without one.

### 1. Auth

`whoami` succeeding is not enough. Creating a package and attaching
OIDC both need a fresh 2FA web session (`npm trust` and `pnpm publish`
error `EOTP` / `ERR_PNPM_OTP_NON_INTERACTIVE` otherwise):

```bash
npm whoami                  # must be an @8bitscript org owner or
npm org ls 8bitscript       # a member with publish rights
npm login --auth-type=web   # opens a browser; complete 2FA there
```

A non-interactive agent terminal cannot type an OTP. The human has to
finish the browser login (or pass `--otp` on the publish command).

### 2. Claim the name

From the repository root, with the working tree at the version you
mean to put on npm (usually the current lockstep, even if that
version is not yet the tagged release — the next Version Packages
merge will catch the rest of the packages up):

```bash
git pull
cp LICENSE packages/<name>/LICENSE
pnpm --filter ./packages/<name> publish --access public --no-git-checks
```

`--no-git-checks` is required when the package is not yet on `trunk`.
Use `pnpm publish`, not `npm publish`: any workspace package this one
depends on is `workspace:*` in package.json, and only `pnpm publish`
rewrites that to a real version at publish time — plain `npm publish`
ships the literal string, and a dependency resolving `workspace:*`
outside this workspace hard fails. This is not hypothetical: it is
exactly how `@8bitscript/raster@0.10.0` first shipped broken and
needed a `0.10.1` just to fix its own dependencies.

Several new packages at once:

```bash
pnpm -r publish \
  --filter ./packages/<a> --filter ./packages/<b> \
  --access public --no-git-checks
```

Confirm with `npm view @8bitscript/<name> version`. A brand-new name
can 404 on that replica for a few minutes after a successful publish
(`npm access get status` and `npm trust list` already see it; a
republish of the same version 403s "cannot publish over previously
published versions"). Wait and retry rather than bumping.

### 3. Attach OIDC (Trusted Publishing)

This is the same `npm trust` every existing `@8bitscript/*` package
already has. The package must exist on npm first (step 2) or the
command 404s. The first call in a session opens a 2FA browser
approval; later calls in the same session do not re-challenge.

```bash
npm trust github @8bitscript/<name> \
  --file release.yml \
  --repo 8BitScript/8bitscript \
  --allow-publish --yes
```

`--file` is the **filename only** (`release.yml`), not a path. It has
to match `.github/workflows/release.yml` exactly. `--allow-publish` is
required on configs created after May 2026; without it the trust
relationship exists but CI still cannot publish.

Verify against a package that was already wired (the expected shape):

```bash
npm trust list @8bitscript/c64
npm trust list @8bitscript/<name>
```

Both should show GitHub, `8BitScript/8bitscript`, workflow
`release.yml`, publish allowed. `release.yml` already requests
`id-token: write` on the npm job; do not add a second workflow or a
per-package GitHub environment for this.

If `npm trust` says a configuration already exists, leave it —
npm currently allows one trust relationship per package. Revoke
(`npm trust revoke @8bitscript/<name> --id=<trust-id>`) only to
replace a wrong repo or workflow name.

### 4. If this happened mid-release

Re-dispatch after the name exists (OIDC can wait until after the
re-dispatch if the token fallback is still in `release.yml`; attach
it anyway so the *next* release is OIDC-only):

```bash
gh workflow run release.yml --ref trunk
```

See "Recovering a half-finished release" above. `alreadyOnNpm()`
skips the package you just published by hand.

## Open VSX namespace

`publisher` in `editors/vscode/package.json` is the Open VSX namespace
(`8bitscript`). Publishing creates you as a **contributor**, not an
owner, so the listing shows *“not a verified publisher of the
namespace”* until ownership is granted.

That is a one-time public claim: an issue on
[EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org)
with the *Claim namespace ownership* template (Option 1 — we are the
same VS Code Marketplace publisher and the repo is in the `8BitScript`
org). The claim for this namespace is
[#13097](https://github.com/EclipseFdn/open-vsx.org/issues/13097).
Eclipse staff flip the namespace to verified; do not republish to
clear the banner.

The GitHub user who holds `OVSX_PAT` must stay a namespace member
(owner or contributor). After you are owner, add any extra PAT
accounts as contributors on
https://open-vsx.org/user-settings/namespaces — not by changing
`publisher`.
