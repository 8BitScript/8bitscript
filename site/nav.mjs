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
// One level of `children` nests a group's pages under it in the sidebar
// (layout.mjs renderNav); breadcrumbs and prev/next read the same tree.
export const nav = [
  {
    title: 'Home',
    url: '/',
  },
  {
    title: 'The language, by task',
    url: '/language/',
    children: [
      { title: 'Core language — .8bs', url: '/language/core' },
      { title: 'Composition — .8bx', url: '/language/composition' },
      { title: 'The .8bs ↔ .8bx boundary', url: '/language/boundary' },
      { title: 'Project & CLI', url: '/language/project' },
      { title: 'Editor & diagnostics', url: '/language/editor' },
      { title: 'Standard packages', url: '/language/packages' },
      { title: 'Worked examples', url: '/language/examples' },
      { title: 'Not yet available', url: '/language/not-yet' },
    ],
  },
  {
    title: 'Project config',
    url: '/config',
  },
  {
    title: 'Putting a program in a web page',
    url: '/web-embedding',
  },
  {
    title: 'Compiler',
    url: '/compiler',
  },
  {
    title: '8BX specification',
    url: '/spec/8bx',
  },
  {
    title: '8BX: composition for 8BitScript',
    url: '/project/8bx',
  },
  {
    title: 'Controllers, across nine machines',
    url: '/project/input',
  },
  {
    title: 'Machines on the roadmap',
    url: '/project/machines/',
  },
];
