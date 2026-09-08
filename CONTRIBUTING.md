# Contributing to 8BitScript

The compiler runs end to end for the milestone subset: lexer, parser,
checker, linker, IR, and two backends, with `8bs build` and `8bs run`
driving them. Imports, function calls, and locals compile. Contributions
are documentation, compiler, package, and editor work.

## Workflow

`trunk` is the default branch. New work lands through a short-lived pull
request into `trunk`. There are no long-lived feature branches and no
release branches. A version is a git tag `v0.1.0`, `v0.2.0`, … that
triggers npm publish, the editor extension, and a frozen docs snapshot.

```bash
git checkout -b describe-the-change
# make the change
pnpm test
git add -A
git commit -m "docs: describe the change"
git push -u origin HEAD
```

Open a pull request against `trunk`. The CI workflow runs `pnpm run
test:ci`, not `pnpm test`: it excludes `atari8`, `c128`, `c64`, `cx16`,
`pet`, and `pointer`, whose tests boot a real emulator (VICE, atari800,
Xemu) and assert on what it does. GitHub's hosted runners cannot legally
carry Commodore ROMs — Debian's own `vice` package ships without them,
for exactly that reason — so those packages' tests hard-fail there with
nothing wrong in the code. `pnpm test` (no `:ci`) runs everything,
including that suite, and needs the emulators from
[docs/setup](docs/setup/index.md) installed locally. `@8bitscript/cli`'s
own emulator tests (`screenshot.test.mjs`, `emulator-smoke.test.mjs`)
already skip rather than fail when a target's toolchain is missing,
which is why `cli` stays in `test:ci` while the six machine packages
above do not.

**Before tagging a release, run the full suite locally:**

```bash
pnpm test
```

This is the real release gate — CI's `pnpm run test:ci` is a cheap
sanity check, not a substitute for it. Do not tag on `test:ci` alone.

Releases are tagged from `trunk`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

`scripts/release.mjs` is what the tag workflow runs: it checks every
`packages/*` version matches, copies `LICENSE` into each package, and
publishes `@8bitscript/*` publicly. Do not publish by hand unless you
are recovering a failed tag.

### First 0.1.0 publish (one-time)

These are interactive and need a human:

1. Create the npm organisation `8bitscript` and run `npm login`.
2. Create the Visual Studio Marketplace publisher `8bitscript` and an
   Open VSX personal access token.
3. Store `NPM_TOKEN`, `VSCE_PAT`, `OVSX_PAT`, and `CLOUDFLARE_API_TOKEN`
   as GitHub org secrets.
4. Add the `8bitscript.com` zone to the same Cloudflare account as
   `8bitscript.org` (needed for `2048.8bitscript.com`).
5. Create an empty `8BitScript/2048` repository, push `trunk`, set it as
   the default branch.
6. Tag from `trunk`: `git tag v0.1.0 && git push origin v0.1.0`.

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
