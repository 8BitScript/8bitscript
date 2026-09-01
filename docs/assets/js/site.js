// Progressive enhancement for the doc shell in site/layout.mjs: mobile nav
// toggle, the Ctrl/Cmd-K search dialog, code-block copy buttons, and
// scroll-spy highlighting in the "on this page" rail. Every feature here
// degrades to nothing if it fails — the site is fully readable and
// navigable without JavaScript, this file only makes it nicer to use.

function initNavToggle() {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('is-open')) {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }
  });
}

function initSearch() {
  const trigger = document.getElementById('search-trigger');
  const dialog = document.getElementById('search-dialog');
  const closeButton = document.getElementById('search-close');
  const mount = document.getElementById('search-mount');
  if (!trigger || !dialog || !mount || typeof HTMLDialogElement === 'undefined') return;

  let ui = null;

  function open() {
    if (!ui && window.PagefindUI) {
      ui = new window.PagefindUI({
        element: mount,
        showSubResults: true,
        showImages: false,
        excerptLength: 20,
      });
    }
    if (typeof dialog.showModal === 'function') dialog.showModal();
    const input = mount.querySelector('input');
    if (input) input.focus();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  trigger.addEventListener('click', open);
  closeButton?.addEventListener('click', close);

  // Pagefind emits result links from the file paths it walked in dist/site,
  // so every non-index page comes back as `/page.html`. site/build.mjs
  // publishes those pages at the extensionless URL (`/page`) and Cloudflare's
  // `auto-trailing-slash` handling would 307-redirect the `.html` form to it
  // — harmless, but an extra round trip this site otherwise avoids (see the
  // URL scheme note in docs/project/deployment.md). Normalize on click.
  mount.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[href$=".html"], a[href*=".html#"]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    event.preventDefault();
    window.location.href = href.replace('.html', '');
  });

  // Clicking the dialog's own backdrop (the ::backdrop pseudo-element counts
  // as a click on the dialog itself, outside search-dialog-inner) closes it.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  document.addEventListener('keydown', (event) => {
    const isSearchShortcut = (event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey);
    if (isSearchShortcut) {
      event.preventDefault();
      dialog.open ? close() : open();
    } else if (event.key === '/' && document.activeElement === document.body) {
      event.preventDefault();
      open();
    }
  });
}

function initCodeCopyButtons() {
  const blocks = document.querySelectorAll('.content pre');
  for (const pre of blocks) {
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    pre.replaceWith(wrapper);
    wrapper.append(pre);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent ?? '');
        button.textContent = 'Copied';
        button.classList.add('is-copied');
      } catch {
        button.textContent = 'Copy failed';
      } finally {
        setTimeout(() => {
          button.textContent = 'Copy';
          button.classList.remove('is-copied');
        }, 1800);
      }
    });
    wrapper.append(button);
  }
}

function initTocScrollSpy() {
  const links = document.querySelectorAll('.page-toc a');
  if (links.length === 0 || !('IntersectionObserver' in window)) return;

  const linkByHref = new Map([...links].map((link) => [link.getAttribute('href'), link]));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const link = linkByHref.get(`#${entry.target.id}`);
        if (!link) continue;
        link.classList.toggle('is-current', entry.isIntersecting);
      }
    },
    { rootMargin: '-15% 0px -70% 0px' },
  );

  for (const href of linkByHref.keys()) {
    const heading = document.getElementById(href.slice(1));
    if (heading) observer.observe(heading);
  }
}

initNavToggle();
initSearch();
initCodeCopyButtons();
initTocScrollSpy();
