// The icon set. Every icon is a codicon — the same glyphs native VS Code views
// use — so the launcher looks like it belongs. One icon means one thing:
//
//   play           run (the primary action)         open-preview   Editor runtime
//   globe          Browser runtime                  device-desktop Native runtime
//   tools          Build                            debug-stop     Stop
//   go-to-file     open the source file             info           project details
//   settings-gear  system options                   debug-restart  run again
//
// Codepoints are decimal, read from the codicon font that ships with the editor.
export const CP = {
  play: 60204, 'open-preview': 60200, globe: 60161, 'device-desktop': 60026, tools: 60269,
  'debug-stop': 60119, 'go-to-file': 60052, info: 60020, 'settings-gear': 60241,
  'debug-restart': 60114, 'chevron-down': 60084, 'chevron-right': 60086, 'chevron-up': 60087,
  ellipsis: 60028, refresh: 60215, pulse: 60209, rocket: 60228, check: 60082, close: 60022,
  warning: 60012, error: 60039, copy: 60364, folder: 60035, 'folder-opened': 60151,
  'link-external': 60180, search: 60013, filter: 60145, 'circle-filled': 60017,
  'circle-outline': 60092, 'file-code': 60137, 'file-binary': 60136, package: 60201,
  beaker: 60025, terminal: 60037, history: 60034, 'circle-slash': 60093, lock: 60021,
  question: 60210, 'symbol-event': 60038, add: 60000, edit: 60019, 'layout-sidebar-left': 60403,
  'debug-start': 60115, record: 60327, 'versions': 60280, 'target': 60408, 'chip': 60441,
};

export const ic = (name, cls = '') => {
  if (!(name in CP)) throw new Error(`unknown icon ${name}`);
  return `<i class="codicon${cls ? ` ${cls}` : ''}" aria-hidden="true">&#${CP[name]};</i>`;
};

// The three places a program can run, in the order they are always shown.
export const RUNTIMES = [
  { id: 'editor', label: 'Editor', icon: 'open-preview', long: 'Editor tab',
    what: 'Runs the WASM build in a tab inside the editor.' },
  { id: 'browser', label: 'Browser', icon: 'globe', long: 'Web browser',
    what: 'Runs the WASM build in your web browser.' },
  { id: 'native', label: 'Native', icon: 'device-desktop', long: 'Native emulator',
    what: 'Runs the real emulator for this machine.' },
];
