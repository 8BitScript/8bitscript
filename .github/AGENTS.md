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
