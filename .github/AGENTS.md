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
| Visual Studio Marketplace | `vsce publish` | often times out at `/_apis/gallery` |
| Open VSX | `ovsx publish` | same VSIX; must not wait on Marketplace |
| GitHub Release | `gh release create vX.Y.Z` | waits on the jobs above |

The Version Packages PR is what bumps every `package.json`. Merging
it is a human decision — see the root
[`AGENTS.md`](../AGENTS.md#version-bumps-are-a-human-decision). After
that merge, `tag-release.yml` tags `vX.Y.Z` and dispatches
`release.yml`.

## The editor VSIX

`editors/vscode` is a thin client: syntax, the launcher, and
`vscode-languageclient` talking to `8bs lsp`. The language server is
**not** in the VSIX. The hundreds of KB in `dist/extension.cjs` are
Microsoft's LSP client, bundled and minified, because a VSIX installs
offline. Do not move that library to `dependencies` and stop
bundling — vsce would pack `node_modules` unminified and the VSIX
would grow. Do not download it at runtime.

A Marketplace timeout is the Azure gallery hanging for ~180 seconds,
not the VSIX being "too big." Still minify. Still retry. Still
`--skip-duplicate`.

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
