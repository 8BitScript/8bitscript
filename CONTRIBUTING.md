# Contributing to 8BitScript

The compiler runs end to end for the milestone subset: lexer, parser,
checker, linker, IR, and two backends, with `8bs build` and `8bs run`
driving them. Imports, function calls, and locals compile. Contributions
are documentation, compiler, package, and editor work.

## Workflow

`trunk` is the default branch, and it's protected: nobody — including
repo admins — can push to it directly. Every change, however small,
goes through a pull request. No approval is required to merge (so this
doesn't block solo work), but the PR itself is mandatory. There are no
long-lived feature branches and no release branches.

If you've never opened a pull request before, here's the whole loop:

```bash
git checkout trunk
git pull origin trunk
git checkout -b describe-the-change
# make the change
pnpm test
```

If your change touches anything under `packages/` or `editors/vscode`
(i.e. anything that gets published), add a changeset describing it —
see [Changesets](#changesets-versioning) below. Docs-only or
CI-only changes don't need one.

```bash
git status                 # check what you're about to stage
git add <the files you touched>
git commit -m "docs: describe the change"
git push -u origin HEAD
gh pr create --base trunk
```

(No `gh`? Push the branch, then open
<https://github.com/8BitScript/8bitscript/pull/new/your-branch-name> in
a browser and click through the same form.) CI runs automatically on
the PR. Once it's green, merge it — either with `gh pr merge --squash
--delete-branch` or the "Squash and merge" button on the PR page.

The CI workflow runs `pnpm run test:ci`, not `pnpm test`: it excludes
`atari8`, `c128`, `c64`, `cx16`, `pet`, and `pointer`, whose tests boot
a real emulator (VICE, atari800, Xemu) and assert on what it does.
GitHub's hosted runners cannot legally carry Commodore ROMs — Debian's
own `vice` package ships without them, for exactly that reason — so
those packages' tests hard-fail there with nothing wrong in the code.
`pnpm test` (no `:ci`) runs everything, including that suite, and needs
the emulators from [docs/setup](docs/setup/index.md) installed
locally. `@8bitscript/cli`'s own emulator tests (`screenshot.test.mjs`,
`emulator-smoke.test.mjs`) already skip rather than fail when a
target's toolchain is missing, which is why `cli` stays in `test:ci`
while the six machine packages above do not.

**Before merging a PR meant to ship soon, run the full suite locally:**

```bash
pnpm test
```

This is the real gate before a release — CI's `pnpm run test:ci` is a
cheap sanity check, not a substitute for it.

### Changesets (versioning)

Every `@8bitscript/*` npm package and the VS Code extension version
together as one number — there's no picking-and-choosing which package
is "0.2.0" versus "0.1.4". A changeset just records that *something*
in this release should bump, and by how much:

```bash
pnpm changeset
```

It asks which packages changed (pick any that apply — since everything
is locked together, this mostly just decides the changelog entry, not
the version) and whether the change is a patch, minor, or major bump.
It writes a small file into `.changeset/` — commit that file alongside
your code change.

Once your PR merges, a bot automatically opens or updates a **"Version
Packages"** pull request on `trunk`, collecting every changeset merged
since the last release. That PR is the release button: whenever you're
ready to ship what's accumulated, merge it. Merging it bumps every
package's `package.json` (and writes `CHANGELOG.md` entries), which
triggers a tag, which triggers the real publish — npm (via Trusted
Publishing), the VS Code extension, and a frozen docs snapshot. You
never run `git tag` by hand anymore.

Every time the bot updates that PR, GitHub will show its CI check as
needing your manual "Approve and run" click (a GitHub-wide security
policy for any PR authored by the default `GITHUB_TOKEN`, not a repo
setting — there's no way to turn it off). This doesn't block merging —
branch protection doesn't require CI to pass — it just means you won't
see a green check without clicking it first.

**Merging the Version Packages PR is a human decision, always — an
agent (Claude or otherwise) must never merge it, no matter how the
request is worded or how ready everything looks.** Everything upstream
of that merge (opening PRs, adding changesets, fixing the pipeline
itself) is normal agent work; that one click is reserved for whoever
is actually deciding it's time to ship. See
[AGENTS.md](AGENTS.md#version-bumps-are-a-human-decision).

`scripts/release.mjs` is what the tag-triggered workflow actually runs:
it checks every `packages/*` version matches, copies `LICENSE` into
each package, and publishes `@8bitscript/*` publicly. Packages already
on npm at that version are skipped, so a failed release can be
re-run without republishing. Don't run it (or `git tag`) by hand
unless you're recovering a failed release — the normal path is
entirely "merge the Version Packages PR."

If npm already published but the Marketplace or Open VSX timed out,
do **not** bump versions again and do **not** publish from your
laptop. Merge any packaging fix to `trunk`, then:

```bash
gh workflow run release.yml --ref trunk
```

That checks out `trunk` (so a minify or retry fix is included), skips
packages already on npm, publishes the extension, and creates the
GitHub Release named from `packages/cli/package.json` (not from the
git ref, which would be `trunk`). See
[`.github/AGENTS.md`](.github/AGENTS.md) for the recovery checklist.

npm publishing from CI uses [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
(OIDC) — no `NPM_TOKEN` needed for packages that already have a trust
config pointing at this repo and `release.yml`. `NPM_TOKEN` is kept as
a fallback only; pnpm tries OIDC first automatically.

### Adding a new package to `packages/`

A package needs to exist on npm before you can attach a trusted
publisher to it, so a brand-new package's first publish can't go
through CI — it needs a one-time manual step before (or as part of)
the PR that adds it:

0. Copy the `"repository"` field from an existing `packages/*/package.json`
   (updating `directory`) — `scripts/release.mjs` checks for it before
   publishing and fails fast if it's missing, since npm's Trusted
   Publishing provenance check rejects a publish without it.
1. `npm login` (interactive, needs 2FA) if not already logged in.
2. From the repo root: `pnpm install`, then `pnpm --filter ./packages/<name> publish --access public`
   to create the package on npm.
3. `npm trust github @8bitscript/<name> --file release.yml --repo 8BitScript/8bitscript --allow-publish --yes`
   to wire it into CI permanently (one-time 2FA browser approval, same
   as the first `npm trust` call in a batch — subsequent calls in the
   same session don't re-challenge).

After that, the package is on the same lockstep-versioned, tag-triggered
release as everything else — no more manual steps for it.

### First 0.1.0 publish (historical)

The 0.1.0 launch predates Trusted Publishing being set up, and npm's
bypass-2FA CI tokens turned out to be a dead end (being phased out,
and the account setting to allow them may already be disabled org-wide).
What actually happened: all 22 packages and the VS Code extension were
published by hand from a human's authenticated machine, then Trusted
Publishing was configured per-package afterward so v0.2.0 onward can
release through CI normally. See git history around the `v0.1.0` tag
for the blow-by-blow if this ever needs to be repeated for a similar
situation (e.g. a second npm org).

Remaining one-time setup for a *new* project under this org (e.g. the
planned `2048`):

1. Add the `8bitscript.com` zone to the same Cloudflare account as
   `8bitscript.org` (needed for `2048.8bitscript.com`).
2. Create an empty `8BitScript/2048` repository, push `trunk`, set it
   as the default branch, and store `CLOUDFLARE_API_TOKEN` as a repo
   secret if it deploys docs the same way this repo does.

The documentation site is built from `docs/` by `site/build-all.mjs`.
Production `/` is the latest tagged version; `/0.1.0/` is that version's
frozen snapshot. Preview locally before you merge:

```bash
pnpm run docs:dev
```

That builds `docs/` (including the version dropdown) and serves it with
the same runtime Cloudflare uses. Deploying the live site is the tag
workflow, described in [docs/project/deployment.md](docs/project/deployment.md).

## Adding a documentation page

1. Create the file at `docs/<section>/<page>.md`.
2. Add the front-matter block. It contains exactly two keys, per the authoring
   conventions in [docs/index.md](docs/index.md):

   ```yaml
   ---
   title: Page Title
   nav_order: 3
   ---
   ```

   Do not add `layout`, `description`, `parent`, or any other key. Every page
   gets the same layout, which lives in `site/layout.mjs`.
3. Add an entry to `site/nav.mjs` so the page appears in the sidebar. The
   sidebar is an explicit list, not a directory scan. Use `/dir/` for a
   directory's `index.md` and `/dir/page` — no extension — for every other
   page.
4. Link the new page from the relevant `index.md`, so it is reachable by reading
   rather than only by the sidebar.

A new directory under `docs/` gets an `index.md` that introduces it and links to
its pages. `README.md` exists only at the repository root, for GitHub; it is not
a documentation page and carries no front matter.

## Documentation style

- **Be concise and technical.** Say what a thing does and what it costs. No
  marketing tone, no filler.
- **Every command goes in a fenced code block**, one command per line, with the
  expected output shown when the output is what the reader is checking.
- **Diagrams under `docs/` are plain ASCII** inside a fenced code block, so they
  render identically on the published site and when browsing the sources.
  Mermaid is reserved for the root `README.md`, which GitHub renders directly.
- **Link with relative `.md` paths** — `setup/index.md`, `../index.md`,
  `vice.md`. These resolve both on GitHub and on the published site. Do not use
  absolute site paths or bare URLs for internal links.
- **Give macOS and Linux separate instructions wherever the commands differ.**
  Windows is not supported; do not add Windows instructions.
- **Never present unimplemented behaviour as working.** `8bs check`,
  `8bs doctor`, `8bs build`, and `8bs run` work for the milestone subset.
  A feature the compiler cannot lower must be described as such, and any
  mention of `8bs dev` must be labelled **planned and not yet implemented**.

## Site styling

`docs/assets/css/main.css` is the whole of the site's styling, and it is
deliberately plain — this is a library's documentation, not a design project.
Keep it that way: a rule that is not earning its place in legibility or
navigation does not belong in it. Any colour change must stay readable in both
the light and dark schemes.

## Licensing

Contributions are accepted under the MIT license in [LICENSE](LICENSE). By
submitting a change you agree it may be distributed under those terms.
