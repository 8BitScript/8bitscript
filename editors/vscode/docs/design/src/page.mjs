import { ic } from './icons.mjs';
import { esc } from './ui.mjs';

// The tiny bit of behaviour the static prototypes have: disclosures open, a
// chip or segment selects, the hint under the run buttons follows hover/focus.
// The real extension does this in media/launcher.js.
const SCRIPT = `
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle]');
  const el = t && document.getElementById(t.dataset.toggle);
  if (el) { const open = el.hasAttribute('hidden'); el.toggleAttribute('hidden', !open); t.setAttribute('aria-expanded', String(open)); }
  const r = e.target.closest('[role=radio]:not([disabled])');
  if (r) { r.parentElement.querySelectorAll('[role=radio]').forEach((x) => { x.setAttribute('aria-checked', String(x === r)); x.tabIndex = x === r ? 0 : -1; }); }
});
const hint = document.getElementById('hint');
document.querySelectorAll('[data-hint]').forEach((b) => {
  const set = () => { if (hint) hint.textContent = b.dataset.hint; };
  b.addEventListener('mouseenter', set); b.addEventListener('focus', set);
});
document.fonts.ready.then(() => { document.body.dataset.h = Math.ceil(document.getElementById('sb').getBoundingClientRect().height); });
`;

/** Wrap a launcher body in a page that looks like the side bar it lives in. */
export function page({ width, title, body }) {
  // The theme is a query string (?theme=light), so one file serves both and
  // opens fine straight from disk in any browser. Dark Modern by default.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<script>document.write('<link rel="stylesheet" href="../themes/' + (new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark') + '-modern.css">');</script>
<link rel="stylesheet" href="../src/design.css">
<style>:root { --w: ${width}px; }</style></head>
<body><div class="sidebar" id="sb">
  <div class="vsc-title"><span>8BitScript</span><span class="acts">${ic('refresh')}${ic('pulse')}${ic('ellipsis')}</span></div>
  <main class="view">${body}</main>
</div>
<script>${SCRIPT}</script></body></html>
`;
}
