# Contributing to 8BitScript

The compiler runs end to end for the first-milestone subset: lexer, parser,
checker, IR, and two backends, with `8bs build` and `8bs run` driving them.
There is no binder yet, so imports and function calls do not compile.
Contributions today are documentation and compiler work, and the notes below
describe how to make one that fits.

## Trunk-only workflow

This project is trunk-only. All work lands directly on `trunk`. There are no
long-lived feature branches, no release branches, and no `gh-pages` branch —
the documentation site is built from the `docs/` directory of `trunk` itself.

Keep changes small enough to commit directly:

```bash
git pull --rebase
# make the change
git add -A
git commit -m "docs: describe the change"
git push
```

Run the tests before pushing:

```bash
pnpm test
```

The compiler's suite is mostly shipped bugs kept as regressions; when a fix
lands, its reproduction lands in the suite in the same change.

Pushing does not publish the site: deploying is a separate, deliberate step,
`pnpm run docs:deploy`, described in
[docs/project/deployment.md](docs/project/deployment.md). There is no staging
environment, so preview locally before you deploy:

```bash
pnpm run docs:dev
```

That builds `docs/` and serves it with the same runtime Cloudflare uses, so the
URLs you click locally are the ones that get published.

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
  `8bs doctor`, `8bs build`, and `8bs run` work for the milestone subset;
  imports, calls, and locals do not compile yet. A feature the compiler cannot
  lower must be described as such, and any mention of `8bs dev` must be
  labelled **planned and not yet implemented**.

## Site styling

`docs/assets/css/main.css` is the whole of the site's styling, and it is
deliberately plain — this is a library's documentation, not a design project.
Keep it that way: a rule that is not earning its place in legibility or
navigation does not belong in it. Any colour change must stay readable in both
the light and dark schemes.

## Licensing

Contributions are accepted under the MIT license in [LICENSE](LICENSE). By
submitting a change you agree it may be distributed under those terms.
