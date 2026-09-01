// Builds docs/ into a directory of static HTML for Cloudflare Workers to serve.
//
// The contract with the authoring conventions in docs/index.md:
//
//   * every page is Markdown with a `title` / `nav_order` front-matter block;
//   * pages link to each other with relative `.md` paths, so the sources read
//     correctly on GitHub;
//   * a directory's landing page is `index.md`.
//
// This script is what makes the second point work in the browser: it rewrites
// every relative `.md` link to the URL the page is published at. `index.md`
// becomes a directory URL (`/setup/`) and every other page becomes an
// extensionless URL (`/setup/vice`).
import { readdir, readFile, mkdir, writeFile, rm, cp, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';

import { renderPage } from './layout.mjs';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(ROOT, 'docs');
const ASSETS_DIR = join(DOCS_DIR, 'assets');
const OUT_DIR = join(ROOT, 'dist', 'site');

/**
 * Split a `---`-delimited YAML front-matter block off the top of a document.
 *
 * The convention allows exactly two scalar keys, `title` and `nav_order`, so
 * this parser handles exactly that rather than pulling in a YAML dependency.
 */
function parseFrontMatter(source, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) {
    throw new Error(
      `${file}: no front matter. Every page under docs/ must start with a ` +
        '`title` / `nav_order` block.',
    );
  }

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`${file}: cannot parse front-matter line: ${line}`);
    data[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
  }

  if (!data.title) throw new Error(`${file}: front matter has no \`title\`.`);

  return { data, body: source.slice(match[0].length) };
}

/** Every `.md` file under docs/, as paths relative to docs/. */
async function findPages(dir = DOCS_DIR) {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'assets') continue;
      found.push(...(await findPages(full)));
    } else if (entry.name.endsWith('.md')) {
      found.push(relative(DOCS_DIR, full));
    }
  }
  return found.sort();
}

/**
 * The published URL for a source path relative to docs/.
 *
 * `index.md` → `/`, `setup/index.md` → `/setup/`, `setup/vice.md` →
 * `/setup/vice`. The extensionless form is what Cloudflare's
 * `html_handling: "auto-trailing-slash"` setting serves directly; a `.html` URL
 * is redirected to it, so emitting `.html` here would put a 307 in front of
 * every link on the site. Keep this in step with the `url` values in nav.mjs.
 */
function urlForSource(source) {
  const path = source.split(/[\\/]/).join('/');
  if (path === 'index.md') return '/';
  if (path.endsWith('/index.md')) return `/${path.slice(0, -'index.md'.length)}`;
  return `/${path.slice(0, -'.md'.length)}`;
}

/**
 * Where that URL is written on disk, relative to the output directory.
 *
 * The inverse of urlForSource: a directory URL becomes that directory's
 * `index.html`, and an extensionless page URL gets its `.html` back.
 */
function outputPathForUrl(url) {
  return url.endsWith('/') ? `${url.slice(1)}index.html` : `${url.slice(1)}.html`;
}

/**
 * The `id` given to a heading, so that `[text](page.md#heading-text)` links
 * work. Markdown-it does not generate heading ids; this rule matches the
 * familiar GitHub/kramdown slug so the anchors already written in the sources
 * keep resolving.
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Resolve a relative `.md` link written on `fromUrl` to its published URL.
 *
 * Returns the href unchanged when it is external, a bare fragment, or already
 * root-absolute — none of those are affected by the source layout.
 */
function rewriteHref(href, fromUrl, fromSource) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return { href };

  const hashAt = href.indexOf('#');
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : href.slice(hashAt + 1);

  // A bare `#anchor` points at a heading on the page it is written on.
  if (path === '') return { href, target: fromSource, hash };
  if (path.startsWith('/') || !path.endsWith('.md')) return { href };

  // A directory URL is itself the directory relative links resolve against; a
  // page URL resolves against its parent.
  const base = fromUrl.endsWith('/') ? fromUrl : `${posix.dirname(fromUrl)}/`;
  const target = posix.normalize(base + path).replace(/^\//, '');
  return { href: urlForSource(target) + (hash ? `#${hash}` : ''), target, hash };
}

/**
 * Server-side syntax highlighting for fenced code blocks.
 *
 * Only the languages registered above are highlighted; every other info
 * string — including the 101 bare ``` fences that hold plain output or ASCII
 * diagrams — falls through to markdown-it's default escaped plain text. That
 * fallback is what returning an empty string does, so it must stay empty
 * rather than `undefined` for unrecognized langs.
 */
function highlight(code, lang) {
  if (!lang || !hljs.getLanguage(lang)) return '';
  return hljs.highlight(code, { language: lang }).value;
}

async function build() {
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false, highlight });

  const sources = await findPages();
  const pages = [];
  for (const source of sources) {
    const raw = await readFile(join(DOCS_DIR, source), 'utf8');
    const { data, body } = parseFrontMatter(raw, `docs/${source}`);
    pages.push({ source, url: urlForSource(source), title: data.title, body });
  }

  /** @type {Map<string, { ids: Set<string>, headings: { level: number, id: string, text: string }[] }>} */
  const headingsBySource = new Map(
    pages.map((page) => [page.source, { ids: new Set(), headings: [] }]),
  );
  /** @type {{ from: string, href: string, target: string, hash: string }[]} */
  const internalLinks = [];

  // Both rules run inside the renderer, so they see resolved hrefs and rendered
  // heading text rather than raw Markdown — which keeps fenced code blocks and
  // inline code untouched.
  const renderToken = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options);
  const defaultLinkOpen = md.renderer.rules.link_open ?? renderToken;
  const defaultHeadingOpen = md.renderer.rules.heading_open ?? renderToken;

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefIndex = token.attrIndex('href');
    if (hrefIndex >= 0) {
      const raw = token.attrs[hrefIndex][1];
      const { href, target, hash } = rewriteHref(raw, env.url, env.source);
      if (target) internalLinks.push({ from: env.source, href: raw, target, hash });
      token.attrs[hrefIndex][1] = href;
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const { ids, headings } = headingsBySource.get(env.source);
    const text = tokens[idx + 1].content;
    const base = slugify(text) || 'section';
    let id = base;
    for (let n = 1; ids.has(id); n += 1) id = `${base}-${n}`;
    ids.add(id);
    tokens[idx].attrSet('id', id);

    // Level 2 and 3 headings make up the "on this page" rail; h1 repeats the
    // page title and deeper levels are too fine-grained to be useful there.
    const level = Number(tokens[idx].tag.slice(1));
    if (level === 2 || level === 3) headings.push({ level, id, text });

    return defaultHeadingOpen(tokens, idx, options, env, self);
  };

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  for (const page of pages) {
    const content = md.render(page.body, { url: page.url, source: page.source });
    const headings = headingsBySource.get(page.source).headings;
    const html = renderPage({ title: page.title, url: page.url, content, headings });
    const outFile = join(OUT_DIR, outputPathForUrl(page.url));
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, html, 'utf8');
  }

  // Checked after every page has been rendered, because a link may point at a
  // heading on a page that had not been read yet when the link was rewritten.
  const broken = [];
  for (const link of internalLinks) {
    const anchors = headingsBySource.get(link.target);
    if (!anchors) {
      broken.push(`docs/${link.from} → ${link.href} (no such page)`);
    } else if (link.hash && !anchors.ids.has(link.hash)) {
      broken.push(`docs/${link.from} → ${link.href} (no such heading)`);
    }
  }
  if (broken.length > 0) {
    throw new Error(`Broken internal links:\n  ${broken.join('\n  ')}`);
  }

  await cp(ASSETS_DIR, join(OUT_DIR, 'assets'), { recursive: true });

  const assets = await readdir(join(OUT_DIR, 'assets'), { recursive: true });
  console.log(
    `Built ${pages.length} pages and checked ${internalLinks.length} internal ` +
      `links into ${relative(ROOT, OUT_DIR)}/ (plus ${assets.length} asset entries).`,
  );
}

await stat(DOCS_DIR).catch(() => {
  throw new Error('docs/ not found — run this from the repository root.');
});
await build();
