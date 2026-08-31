---
title: Publishing the docs
nav_order: 91
---

# Publishing the docs

This page is the runbook for putting this documentation set online. The site is
built from the Markdown in `docs/` by a small script in this repository and
served by [Cloudflare Workers](https://developers.cloudflare.com/workers/) at:

```
https://8bitscript.org/
```

Work through the one-time setup below when the project is first published;
after that, publishing a change is a build and a deploy.

## What builds the site

Three pieces, all in this repository:

| Path | Role |
| ---- | ---- |
| `docs/**/*.md` | The content. Markdown with a `title` / `nav_order` front-matter block |
| `site/build.mjs` | The generator. Renders the Markdown, applies the layout, writes `dist/site/` |
| `site/layout.mjs`, `site/nav.mjs` | The page shell and the sidebar entries |
| `wrangler.jsonc` | Tells Cloudflare to serve `dist/site/` as static assets on `8bitscript.org` |

The build has no framework behind it. `markdown-it` renders the Markdown and
`wrangler` uploads the result; between them is a single Node script.
`dist/site/` is generated output — it is covered by `dist/` in `.gitignore` and
is never committed.

### Why a build step at all

The sources link between pages with relative `.md` paths — `setup/vice.md`,
`../index.md` — so that browsing `docs/` on GitHub reads as well as the
published site. A browser cannot follow those. `site/build.mjs` rewrites every
one of them to the URL that page is published at, which is the job that makes
the authoring convention work in both places.

### The URL scheme

`docs/index.md` becomes `/`, a directory's `index.md` becomes a directory URL
(`docs/setup/index.md` → `/setup/`), and every other page becomes an
extensionless URL (`docs/setup/vice.md` → `/setup/vice`). On disk those are
`index.html` and `vice.html`; Cloudflare's `html_handling:
"auto-trailing-slash"` setting is what serves them without the extension, and
it redirects a `.html` URL to the extensionless one rather than serving both.

That setting is why `site/nav.mjs` lists extensionless URLs. Writing `.html`
there would still resolve, but every sidebar click would take a 307 redirect
first.

## One-time setup

### Repository

1. **Create the GitHub organisation.** From the account menu choose
   **Your organizations → New organization** and name it `8BitScript`. The
   organisation owns the project so the repository is not tied to a single
   personal account.
2. **Create one repository inside it — and create it empty.** Name it
   `8bitscript`. This project is a monorepo: the compiler, the tooling, the web
   runtime, and this documentation set all live in this one repository. Do not
   create a repository per package. On GitHub's **Create a new repository**
   form, leave every initialisation option off: do **not** tick **Add a README
   file**, leave **Add .gitignore** set to **None**, and leave **Choose a
   license** set to **None**. Any one of those makes GitHub write its own first
   commit on a `main` branch, and the push in the next step would then be
   rejected as a non-fast-forward update. An empty repository has no commits to
   conflict with, which is exactly what lets `git push -u origin trunk` land the
   existing local history cleanly.
3. **Push this repository.** Add the new remote and push the existing history:

   ```bash
   git remote add origin git@github.com:8BitScript/8bitscript.git
   git push -u origin trunk
   ```

4. **Make `trunk` the default branch.** GitHub's default branch name is normally
   `main`, and this project is trunk-only — no `main`, no feature branches, no
   `gh-pages` branch. Go to **Settings → General → Default branch**, switch it to
   `trunk`, and confirm. If GitHub created an empty `main` alongside it, delete
   `main` so there is exactly one long-lived branch.

> GitHub Pages is deliberately **not** enabled on this repository. The site is
> served by Cloudflare; leaving Pages off means there is only ever one live
> copy of the documentation.

> The matching npm `@8bitscript` organisation is a forward-looking step. Nothing
> is published to npm yet, so claiming the scope is optional at this stage; it
> only becomes necessary when the first package is ready to publish.

### Cloudflare

1. **Add `8bitscript.org` as a zone.** In the Cloudflare dashboard choose
   **Add a domain**, enter `8bitscript.org`, and follow the prompts. If the
   domain is registered elsewhere, point its nameservers at the two Cloudflare
   assigns; if it is registered through Cloudflare Registrar the zone already
   exists. The deploy in the next section cannot attach the domain until the
   zone is active in the same account.
2. **Authenticate wrangler.** From the repository root:

   ```bash
   npx wrangler login
   ```

   This opens a browser to authorise the CLI against your Cloudflare account. It
   is interactive and only needs doing once per machine. For a non-interactive
   environment, set `CLOUDFLARE_API_TOKEN` instead, using a token with the
   **Edit Cloudflare Workers** template.

3. **Deploy.** The first deploy creates the Worker, uploads the assets, and —
   because `wrangler.jsonc` marks the route as a custom domain — provisions the
   DNS record and TLS certificate for `8bitscript.org`:

   ```bash
   pnpm run docs:deploy
   ```

   Certificate issuance takes a few minutes on that first deploy. Until it
   finishes the domain may serve a TLS error; the `*.workers.dev` URL printed by
   wrangler works immediately and is the way to check the site meanwhile.

4. **Optional: redirect `www`.** `wrangler.jsonc` binds the apex domain only, so
   `www.8bitscript.org` does not resolve. If you want it to, add a **Redirect
   Rule** in the Cloudflare dashboard under **Rules → Redirect Rules** that
   sends `www.8bitscript.org/*` to `https://8bitscript.org/$1` with a 301. Do
   that rather than adding a second custom domain here: one canonical hostname
   serving the pages keeps the site out of duplicate-content territory.

## Publishing a change

```bash
pnpm run docs:deploy
```

That is `pnpm run docs:build` followed by `wrangler deploy`. The build is fast
enough that there is no reason to run them separately.

> There is intentionally no CI workflow that deploys the site. Nothing in
> `.github/workflows/` publishes anything, so there is no pipeline to break and
> no deploy credential stored in the repository. If that trade stops being worth
> it, Cloudflare's **Workers Builds** can watch `trunk` and run the same two
> commands on every push — configured in the dashboard, with no file added
> here.

## Previewing locally

```bash
pnpm run docs:dev
```

This builds the site and starts wrangler's local server, which runs the same
asset-serving behaviour as production — including the trailing-slash handling —
so the URLs you click locally are the URLs that get published. It prints a
`http://localhost:8787/` address.

`pnpm run docs:build` on its own writes `dist/site/` without starting a server.
The build is not a watcher: after editing a page, re-run it.

## Verification checklist

After the first deploy finishes, confirm each of these:

- [ ] `https://8bitscript.org/` loads and shows the documentation index.
- [ ] The page is styled — cream or dark background, monospace headings — which
      confirms the stylesheet at `/assets/css/main.css` is being served.
- [ ] `https://8bitscript.org/setup/` resolves to the setup guide, confirming
      directory `index.md` pages get directory URLs.
- [ ] Cross-page links work: from the setup guide open **LLVM-MOS**, then follow
      a link back to the index.
- [ ] The navigation sidebar lists every page and marks the current one.
- [ ] A page edit, rebuilt and redeployed, appears on the live site within
      seconds.

## Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| Build fails with *no front matter* | A page under `docs/` is missing its `title` / `nav_order` block | Add the front matter; the builder refuses to publish a page without a title |
| Build fails with *Broken internal links* | A relative `.md` link points at a file that does not exist | Fix the link, or add the page it points to. The builder resolves every internal link and fails rather than shipping a 404 |
| Page loads unstyled | `/assets/css/main.css` is missing from `dist/site/` | Re-run the build; `site/build.mjs` copies `docs/assets/` verbatim |
| Every sidebar click 307-redirects | A `url` in `site/nav.mjs` was written with a `.html` extension | Drop the extension — see [The URL scheme](#the-url-scheme) |
| Nav entry never highlights | The `url` in `site/nav.mjs` does not match the generated page URL | Use `/dir/` for an `index.md` and `/dir/page` for every other page |
| A new page is not in the sidebar | The sidebar is an explicit list, not a directory scan | Add the entry to `site/nav.mjs` |
| Deploy fails attaching the custom domain | `8bitscript.org` is not an active zone in the authenticated account | Add the domain in the Cloudflare dashboard, then redeploy |
| Deploy fails with an authentication error | wrangler is not logged in on this machine | Run `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN` |
