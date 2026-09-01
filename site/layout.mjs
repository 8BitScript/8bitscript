// The page shell: header, sidebar, "on this page" rail, and prev/next footer
// nav around each page's rendered Markdown. Styling lives entirely in
// docs/assets/css/main.css; interactivity (search, mobile nav, copy buttons)
// in docs/assets/js/site.js. There is no component framework — this is one
// template function for a documentation site with a few dozen pages, and a
// framework would cost more than it buys.
import { nav } from './nav.mjs';

const SITE_TITLE = '8BitScript';
const SITE_DESCRIPTION =
  'A statically compiled programming language for classic 8-bit computers and ' +
  'the web, using TypeScript-inspired syntax without the managed runtime that ' +
  'normally comes with it.';

const REPO_URL = 'https://github.com/8BitScript/8bitscript';

/** Escape a string for interpolation into HTML text or a quoted attribute. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * `nav` as a flat reading order: every top-level entry, with a group's
 * children immediately after it. Used for breadcrumbs and prev/next — both
 * need "where does this page sit in the sidebar", not the tree shape.
 */
function flattenNav() {
  const flat = [];
  for (const item of nav) {
    flat.push({ title: item.title, url: item.url, parent: null });
    for (const child of item.children ?? []) {
      flat.push({ title: child.title, url: child.url, parent: item });
    }
  }
  return flat;
}

const FLAT_NAV = flattenNav();

/** One `<a>` in the sidebar, marked as current when it is the page being built. */
function navLink(item, currentUrl) {
  const isCurrent = item.url === currentUrl;
  const className = `nav-link${isCurrent ? ' is-current' : ''}`;
  const ariaCurrent = isCurrent ? ' aria-current="page"' : '';
  return `<a class="${className}" href="${escapeHtml(item.url)}"${ariaCurrent}>${escapeHtml(item.title)}</a>`;
}

function renderNav(currentUrl) {
  const items = nav
    .map((item) => {
      const sublist = item.children
        ? `\n          <ul class="nav-sublist">\n${item.children
            .map(
              (child) =>
                `            <li class="nav-item">${navLink(child, currentUrl)}</li>`,
            )
            .join('\n')}\n          </ul>`
        : '';
      return `        <li class="nav-item">${navLink(item, currentUrl)}${sublist}</li>`;
    })
    .join('\n');

  return `<nav class="site-nav" aria-label="Documentation" id="site-nav">
    <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="nav-list">
      <svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      Menu
    </button>
    <ul class="nav-list" id="nav-list">
${items}
    </ul>
  </nav>`;
}

/** "Setup / VICE" above the title on a child page; nothing on a top-level one. */
function renderBreadcrumb(entry) {
  if (!entry?.parent) return '';
  return `<p class="breadcrumb"><a href="${escapeHtml(entry.parent.url)}">${escapeHtml(entry.parent.title)}</a> <span aria-hidden="true">/</span> ${escapeHtml(entry.title)}</p>`;
}

/** The right-rail "On this page" list, built from that page's h2/h3s. */
function renderToc(headings) {
  if (!headings || headings.length < 2) return '';
  const items = headings
    .map(
      (h) =>
        `      <li class="toc-item toc-level-${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`,
    )
    .join('\n');
  return `<nav class="page-toc" aria-label="On this page">
    <p class="page-toc-heading">On this page</p>
    <ul class="toc-list">
${items}
    </ul>
  </nav>`;
}

/** Prev/next links from the page's position in the flattened nav order. */
function renderPrevNext(currentUrl) {
  const index = FLAT_NAV.findIndex((entry) => entry.url === currentUrl);
  if (index === -1) return '';
  const prev = index > 0 ? FLAT_NAV[index - 1] : null;
  const next = index < FLAT_NAV.length - 1 ? FLAT_NAV[index + 1] : null;
  if (!prev && !next) return '';

  const prevLink = prev
    ? `<a class="pager-link pager-prev" href="${escapeHtml(prev.url)}"><span class="pager-label">Previous</span><span class="pager-title">${escapeHtml(prev.title)}</span></a>`
    : '<span class="pager-link pager-empty"></span>';
  const nextLink = next
    ? `<a class="pager-link pager-next" href="${escapeHtml(next.url)}"><span class="pager-label">Next</span><span class="pager-title">${escapeHtml(next.title)}</span></a>`
    : '<span class="pager-link pager-empty"></span>';

  return `<nav class="page-pager" aria-label="Page navigation">
      ${prevLink}
      ${nextLink}
    </nav>`;
}

/**
 * Render a full HTML document.
 *
 * @param {{ title: string, url: string, content: string, headings?: { level: number, id: string, text: string }[] }} page
 * @returns {string}
 */
export function renderPage(page) {
  const entry = FLAT_NAV.find((item) => item.url === page.url);
  const toc = renderToc(page.headings);

  return `<!doctype html>
<html lang="en-US">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(page.title)} · ${SITE_TITLE}</title>
    <meta name="description" content="${escapeHtml(SITE_DESCRIPTION)}">
    <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
    <link rel="stylesheet" href="/assets/css/main.css">
    <link rel="stylesheet" href="/pagefind/pagefind-ui.css">
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>

    <header class="site-header">
      <div class="site-header-inner">
        <a class="wordmark" href="/">
          <img class="wordmark-icon" src="/assets/favicon.svg" alt="" width="22" height="22">
          ${SITE_TITLE}
        </a>
        <button type="button" class="search-trigger" id="search-trigger" aria-haspopup="dialog" aria-controls="search-dialog">
          <svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 13.5 18 18M15.5 9a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
          <span>Search docs</span>
          <kbd class="search-kbd">Ctrl K</kbd>
        </button>
      </div>
    </header>

    <dialog id="search-dialog" class="search-dialog" aria-label="Search documentation">
      <div class="search-dialog-inner">
        <button type="button" class="search-close" id="search-close" aria-label="Close search">×</button>
        <div id="search-mount"></div>
      </div>
    </dialog>

    <div class="layout">
      ${renderNav(page.url)}

      <main id="main" class="content" data-pagefind-body>
        <div data-pagefind-ignore>${renderBreadcrumb(entry)}</div>
${page.content.trimEnd()}
        <div data-pagefind-ignore>${renderPrevNext(page.url)}</div>
        <meta data-pagefind-meta="title[content]" content="${escapeHtml(page.title)}">
      </main>

      ${toc ? `<aside class="content-rail">\n      ${toc}\n      </aside>` : ''}
    </div>

    <footer class="site-footer">
      <p>
        <a href="${REPO_URL}">8BitScript on GitHub</a>
        ·
        <a href="${REPO_URL}/blob/trunk/LICENSE">MIT licensed</a>
      </p>
    </footer>

    <script src="/pagefind/pagefind-ui.js" defer></script>
    <script type="module" src="/assets/js/site.js"></script>
  </body>
</html>
`;
}
