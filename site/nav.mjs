// Site navigation, rendered by the sidebar in layout.mjs.
//
// `url` values are root-absolute site paths: the site is served from the root
// of 8bitscript.org, so there is no base path to prepend. The builder compares
// these against each page's own URL to mark the current page, which is why the
// shapes below matter — a directory's `index.md` becomes a directory URL
// (`/project/machines/`) and every other page becomes an extensionless URL.
// Keep an entry's `url` identical to the URL the builder generates for that
// page, or the entry never highlights.
//
// The documentation was wiped ahead of 0.2.0 (the native-backend rewrite).
// Pages come back here as the code they describe lands; until then the
// working roadmap and command reference is linked from the home page.
export const nav = [
  {
    title: 'Home',
    url: '/',
  },
  {
    title: 'Putting a program in a web page',
    url: '/web-embedding',
  },
  {
    title: 'Machines on the roadmap',
    url: '/project/machines/',
  },
  {
    title: 'Controllers, across nine machines',
    url: '/project/input',
  },
];
