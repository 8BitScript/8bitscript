// media/project.js is the Project details page: no state of its own, the
// host posts the whole model on every change. Run for real against a
// stub DOM and vscode API, not just parsed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runWebviewScripts } = require('./support/runWebview.cjs');

const PROJECT_JS = path.join(__dirname, '..', 'media', 'project.js');
const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  return runWebviewScripts([PROJECT_JS]);
}

test('an empty state clears the page and hides the project-only buttons', () => {
  const { dom, sandbox } = load();
  sandbox.window.dispatch('message', {
    data: {
      type: 'state',
      empty: true,
      name: '',
      where: '',
      installed: false,
      dir: '', config: '', entry: '', targets: [],
      systems: [],
      packageManager: '', lockfile: '', toolchain: '', versions: {},
      checkout: '',
    },
  });
  assert.equal(dom.getElementById('title').textContent, 'Project');
  assert.match(dom.getElementById('lede').textContent, /No 8BitScript project here yet/);
  assert.equal(dom.getElementById('install').hidden, true);
  assert.equal(dom.getElementById('meta').children.length, 0);
  assert.equal(dom.getElementById('systems').children.length, 1, 'the "no named systems" notice');
});

test('a real project fills in meta, systems, packages, and the checkout toggle', () => {
  const { dom, sandbox } = load();
  sandbox.window.dispatch('message', {
    data: {
      type: 'state',
      empty: false,
      name: 'my-game',
      where: 'projects/my-game',
      installed: false,
      dir: '/home/user/my-game',
      config: '8bitscript.config.ts',
      entry: 'src/main.8bs',
      targets: ['c64', 'vic20'],
      systems: [
        { name: 'C64 with a mouse', target: 'c64', label: 'mouse', origin: 'advertised' },
        { name: 'Stock VIC', target: 'vic20', label: 'stock', origin: 'project' },
      ],
      packageManager: 'pnpm',
      lockfile: 'pnpm-lock.yaml',
      toolchain: '/home/user/my-game/node_modules/.bin/8bs',
      versions: { '@8bitscript/cli': '^0.7.0' },
      checkout: '',
    },
  });
  assert.equal(dom.getElementById('title').textContent, 'my-game');
  assert.equal(dom.getElementById('lede').textContent, 'projects/my-game');
  assert.equal(dom.getElementById('notice').hidden, false, 'not installed, not empty');
  assert.match(dom.getElementById('notice').textContent, /has dependencies that are not installed/);
  assert.equal(dom.getElementById('meta').children.length, 4);
  assert.equal(dom.getElementById('systems').children.length, 2);
  assert.equal(dom.getElementById('packages').children.length, 3, '2 fixed rows + one version');
  assert.equal(dom.getElementById('install').textContent, 'Run pnpm install');
  assert.equal(dom.getElementById('use-local').hidden, false, 'no checkout yet, so "use local" is offered');
  assert.equal(dom.getElementById('use-published').hidden, true);
});

test('a checkout in use flips which toggle button shows, and installed hides the notice', () => {
  const { dom, sandbox } = load();
  sandbox.window.dispatch('message', {
    data: {
      type: 'state',
      empty: false,
      name: 'my-game',
      where: 'projects/my-game',
      installed: true,
      dir: '/home/user/my-game', config: '', entry: '', targets: [],
      systems: [],
      packageManager: 'npm', lockfile: '', toolchain: '', versions: {},
      checkout: '/home/user/8bitscript',
    },
  });
  assert.equal(dom.getElementById('notice').hidden, true);
  assert.equal(dom.getElementById('use-local').hidden, true);
  assert.equal(dom.getElementById('use-published').hidden, false);
});

test('every button posts its command', () => {
  const { dom, posted } = load();
  const clicks = [
    ['install', '8bitscript.install'],
    ['refresh', '8bitscript.refresh'],
    ['use-local', '8bitscript.useLocal'],
    ['use-published', '8bitscript.usePublished'],
    ['open-config', '8bitscript.openConfig'],
    ['open-entry', '8bitscript.openEntry'],
    ['configure', '8bitscript.configureSystem'],
  ];
  for (const [id] of clicks) dom.getElementById(id).dispatch('click');
  assert.deepEqual(
    posted.slice(1).map(plain),
    clicks.map(([, id]) => ({ type: 'command', id })),
  );
  assert.deepEqual(plain(posted[0]), { type: 'ready' }, 'the page asks for state once loaded');
});

test('a non-state message is ignored', () => {
  const { dom, sandbox } = load();
  dom.getElementById('title').textContent = 'unchanged';
  sandbox.window.dispatch('message', { data: { type: 'other' } });
  assert.equal(dom.getElementById('title').textContent, 'unchanged');
});
