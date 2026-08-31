// The page shell. This is the whole design: one layout function and the
// stylesheet in docs/assets/css/main.css. There is no theme and no component
// library, and this is documentation for a library — keep it plain.
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
        ? `\n        <ul class="nav-sublist">\n${item.children
            .map(
              (child) =>
                `          <li class="nav-item">${navLink(child, currentUrl)}</li>`,
            )
            .join('\n')}\n        </ul>`
        : '';
      return `      <li class="nav-item">${navLink(item, currentUrl)}${sublist}</li>`;
    })
    .join('\n');

  return `<nav class="site-nav" aria-label="Documentation">\n    <ul class="nav-list">\n${items}\n    </ul>\n  </nav>`;
}

/**
 * Render a full HTML document.
 *
 * @param {{ title: string, url: string, content: string }} page
 * @returns {string}
 */
export function renderPage(page) {
  return `<!doctype html>
<html lang="en-US">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(page.title)} · ${SITE_TITLE}</title>
    <meta name="description" content="${escapeHtml(SITE_DESCRIPTION)}">
    <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
    <link rel="stylesheet" href="/assets/css/main.css">
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>

    <header class="site-header">
      <a class="wordmark" href="/">${SITE_TITLE}</a>
      <p class="tagline">Documentation</p>
    </header>

    <div class="layout">
      ${renderNav(page.url)}

      <main id="main" class="content">
${page.content.trimEnd()}
      </main>
    </div>

    <footer class="site-footer">
      <p>
        <a href="${REPO_URL}">8BitScript on GitHub</a>
        ·
        <a href="${REPO_URL}/blob/trunk/LICENSE">MIT licensed</a>
      </p>
    </footer>
  </body>
</html>
`;
}
