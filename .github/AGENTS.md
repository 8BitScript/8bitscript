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

The Version Packages PR is what bumps every `package.json`. Merging
it is a human decision — see the root
[`AGENTS.md`](../AGENTS.md#version-bumps-are-a-human-decision). After
that merge, `tag-release.yml` tags `vX.Y.Z` and dispatches
`release.yml`.

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

## Recovering a half-finished release

If npm is already at this version and a marketplace timed out:

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

0.2.0 added `@8bitscript/examples` — the first new package since 0.1.0.
`release.mjs` (already dependency-ordered) reached it 15 packages into
the batch and both auth paths refused it:

```
[WARN] Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE: Failed token exchange
request with body message: Unknown error (status code 404)
Error: Failed to publish package @8bitscript/examples@0.2.0
(status 404 Not Found): {"error":"Not found"}
```

Both failures have the same root cause: npm Trusted Publishing and the
`NODE_AUTH_TOKEN` fallback both assume the package already exists —
Trusted Publishing has no trust relationship to attach to a name
nothing has ever claimed, and the token's own publish grant appears to
cover updating an existing package, not creating a new one. Everything
downstream of the new package in the dependency graph never got
attempted, and `docs`/`extension`/`github-release` (`needs: npm`) were
skipped.

`release.mjs` now checks for this before publishing anything (a bare
`npm view <name>`, not `<name>@<version>` — existence, not this
version) and, if it finds one, publishes just the new package(s) first,
in their own isolated `pnpm -r publish`, before touching the other 20.
A first-publish failure is now immediate and cheap, not discovered
partway through a full batch — but it still needs the same manual fix,
since only an npm account can bootstrap a name that's never existed:

1. `npm login` as an `@8bitscript` org owner or member with publish
   rights (`npm org ls 8bitscript` shows your role).
2. `git pull` — the working tree needs the same version `release.mjs`
   was running with, or the manual publish and the automated one
   disagree on what "this version" means.
3. `cd packages/<name> && npm publish --access public` — a one-time
   bootstrap, the same way every other package's first publish, long
   before Trusted Publishing existed, must have happened once too.
4. Re-dispatch: `gh workflow run release.yml --ref trunk` (see
   "Recovering a half-finished release" above). `alreadyOnNpm()` skips
   the package you just published by hand and picks up wherever the
   batch actually stopped.

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
