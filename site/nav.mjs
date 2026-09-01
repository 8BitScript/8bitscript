// Site navigation, rendered by the sidebar in layout.mjs.
//
// `url` values are root-absolute site paths: the site is served from the root
// of 8bitscript.org, so there is no base path to prepend. The builder compares
// these against each page's own URL to mark the current page, which is why the
// shapes below matter — a directory's `index.md` becomes a directory URL
// (`/setup/`) and every other page becomes an extensionless URL
// (`/setup/vice`). Keep an entry's `url` identical to the URL the builder
// generates for that page, or the entry never highlights.
export const nav = [
  {
    title: 'Home',
    url: '/',
  },
  {
    title: 'About 8BitScript',
    url: '/about',
  },
  {
    title: 'The package model',
    url: '/packages',
  },
  {
    title: 'The compiler',
    url: '/compiler',
  },
  {
    title: 'Editor support',
    url: '/language-server',
  },
  {
    title: 'Setup',
    url: '/setup/',
    children: [
      { title: 'Host toolchain', url: '/setup/host-toolchain' },
      { title: 'LLVM-MOS', url: '/setup/llvm-mos' },
      { title: 'VICE', url: '/setup/vice' },
      { title: 'Verify your setup', url: '/setup/verify' },
    ],
  },
  {
    title: 'Getting started',
    url: '/tutorial',
  },
  {
    title: 'Publishing the docs',
    url: '/project/deployment',
  },
];
