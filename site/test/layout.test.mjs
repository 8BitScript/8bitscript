// The development notice is chrome, not page content: every rendered page
// carries it, and Pagefind's body (the <main>) does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPage } from '../layout.mjs';

test('every page carries the development-status notice outside the indexed body', () => {
  const html = renderPage({ title: 'Hello', url: '/', content: '<p>Body</p>' });
  const mainStart = html.indexOf('<main');
  const mainEnd = html.indexOf('</main>');
  const main = html.slice(mainStart, mainEnd);

  assert.equal(main.includes('Development version'), false);
  assert.match(html, /role="region" aria-label="Project status"/);
  assert.match(html, /id="dev-notice-dismiss"/);
  assert.match(html, /Development version\./);
  assert.match(html, /8bitscript\.notice/);
  assert.match(html, /development-v1/);
});
