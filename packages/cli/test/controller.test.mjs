// `8bs controller` — the terminal-side controller mapper.
//
// Nothing here opens a browser, binds a port or waits for a human. The
// command is split so it does not have to: argument parsing is a pure
// function, the request handler is a pure function of (method, path, body)
// against a session, and the session is a plain object over a temporary
// directory. What is left — `listen`, `open`, Ctrl+C — is the part a test
// could only fake anyway.
//
// That split is not tidiness. The CLI suite runs in about three seconds,
// and it once took thirty minutes because a test started a GUI emulator
// and waited for somebody to close the window. A test that serves this
// page and waits for a pad would be the same mistake with a joystick in
// it.
//
// The two browser halves that *can* be checked here are checked here: the
// page's script is evaluated in a `vm` context with a fake DOM, and the
// served profile module is evaluated the same way, so "the shim works in a
// browser" is not left to be discovered in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIRRORED,
  PAGE_DIR,
  controller,
  createSession,
  listLines,
  pageAssets,
  parseControllerArgs,
  renderPage,
  respond,
  summaryLines,
} from '../src/controller.mjs';
import { CONTROLLERS_FILE, controllerPlayers } from '../src/controllers.mjs';

const CLI_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTENSION_DIR = join(CLI_DIR, '..', '..', 'editors', 'vscode');

const TOKEN = 'test-token';

/**
 * A temp project, removed when `run` is done with it — which for an async
 * `run` is when its promise settles, not when it returns one.
 */
function project(run) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-controller-'));
  const clean = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = run(dir);
  } catch (error) {
    clean();
    throw error;
  }
  if (result instanceof Promise) return result.finally(clean);
  clean();
  return result;
}

const stored = (dir) => JSON.parse(readFileSync(join(dir, CONTROLLERS_FILE), 'utf8'));

/** One pad, in the shape the page reports it. */
const SN30 = { id: '8BitDo SN30 Pro (Vendor: 2dc8)', mapping: 'standard', buttons: 16, axes: 4 };

// ---- arguments -----------------------------------------------------------

test('the default is: map, and open a browser', () => {
  assert.deepEqual(parseControllerArgs([]), { mode: 'map', open: true, dir: null, error: null });
});

test('--no-open maps without spawning a window, as `8bs run web --no-open` does', () => {
  assert.deepEqual(parseControllerArgs(['--no-open']), { mode: 'map', open: false, dir: null, error: null });
});

test('--list and --print select the modes that need no browser', () => {
  assert.equal(parseControllerArgs(['--list']).mode, 'list');
  assert.equal(parseControllerArgs(['--print']).mode, 'print');
});

test('--dir takes the project directory, and says so when it is missing', () => {
  assert.equal(parseControllerArgs(['--dir', '/tmp/game']).dir, '/tmp/game');
  assert.match(parseControllerArgs(['--dir']).error, /--dir expects a directory/);
  // A flag after --dir is a forgotten path, not a directory called --list.
  assert.match(parseControllerArgs(['--dir', '--list']).error, /--dir expects a directory/);
  // An empty --dir is a shell variable that expanded to nothing, not the
  // current directory: it is refused the same way a missing one is.
  assert.match(parseControllerArgs(['--dir', '']).error, /--dir expects a directory/);
});

test('an unknown option is refused by name rather than ignored', () => {
  assert.match(parseControllerArgs(['--player', '2']).error, /unknown option '--player'/);
});

// ---- the session: the profile round trip ---------------------------------

test('a pad the page reports is written down at once, unassigned', () => {
  project((dir) => {
    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [SN30], blocked: false, silenced: false });

    const devices = stored(dir).controllers.devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, SN30.id);
    // "Plugged in" and "playing" are different facts and the file keeps
    // them apart: an unassigned device is player 0 and a launch skips it.
    assert.equal(devices[0].player, 0);
    assert.deepEqual(controllerPlayers(stored(dir)), { ok: true, players: [] });
    // One pad and no choice to make: it is selected for the mapper.
    assert.equal(session.selected, devices[0].id);
  });
});

test('assign, bind and forget each land in the file immediately', () => {
  project((dir) => {
    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [SN30], blocked: false, silenced: false });
    const id = stored(dir).controllers.devices[0].id;

    session.apply({ type: 'assign', id, player: 2 });
    assert.equal(stored(dir).controllers.devices[0].player, 2);

    session.apply({ type: 'bind', id, control: 'a', binding: 'button:1' });
    const device = stored(dir).controllers.devices[0];
    assert.equal(device.mapping.a, 'button:1');
    // A mapping somebody corrected by hand is no longer the driver's.
    assert.equal(device.mode, 'custom');

    session.apply({ type: 'bind', id, control: 'a', binding: null });
    assert.equal(stored(dir).controllers.devices[0].mapping.a, undefined);

    session.apply({ type: 'forget', id });
    assert.deepEqual(stored(dir).controllers.devices, []);
    assert.equal(session.selected, null);
  });
});

test('a player number the page could not have sent is clamped to unassigned', () => {
  project((dir) => {
    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [SN30] });
    const id = stored(dir).controllers.devices[0].id;
    session.apply({ type: 'assign', id, player: 9 });
    assert.equal(stored(dir).controllers.devices[0].player, 0);
  });
});

test('the standard preset writes a mapping `8bs run` can read back', () => {
  project((dir) => {
    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [SN30] });
    const id = stored(dir).controllers.devices[0].id;
    session.apply({ type: 'assign', id, player: 1 });
    session.apply({ type: 'preset', id, preset: 'standard' });

    // The whole point of the command, asserted through the function the
    // emulator adapters actually use rather than through the file's shape:
    // what the page wrote is what a launch will read.
    const result = controllerPlayers(stored(dir));
    assert.equal(result.ok, true);
    assert.equal(result.players.length, 1);
    const [player] = result.players;
    assert.equal(player.player, 1);
    // Player 1 drives host joystick 0 — the one number nothing in the file
    // carries, because a Gamepad id has no relationship to an SDL index.
    assert.equal(player.pad, 0);
    for (const control of ['up', 'down', 'left', 'right', 'a', 'b', 'start']) {
      assert.ok(player.controls[control], `standard layout left ${control} unbound`);
    }
    assert.deepEqual(player.controls.a, { kind: 'button', index: 0 });

    session.apply({ type: 'preset', id, preset: 'none' });
    assert.deepEqual(stored(dir).controllers.devices[0].mapping, {});
  });
});

test('a keyboard binding survives the round trip — an Atari stick is a keyboard stick', () => {
  project((dir) => {
    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [SN30] });
    const id = stored(dir).controllers.devices[0].id;
    session.apply({ type: 'assign', id, player: 1 });
    session.apply({ type: 'bind', id, control: 'up', binding: 'key:ArrowUp' });
    const result = controllerPlayers(stored(dir));
    assert.deepEqual(result.players[0].controls.up, { kind: 'key', key: 'ArrowUp' });
  });
});

test('two identical pads are told apart, so player 2 is not player 1 again', () => {
  project((dir) => {
    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [SN30, { ...SN30 }] });
    const devices = stored(dir).controllers.devices;
    assert.equal(devices.length, 2);
    assert.notEqual(devices[0].id, devices[1].id);
    // Two pads is a choice, and the session does not make it.
    assert.equal(session.selected, null);
  });
});

test('an edit to a device that is not on record changes nothing', () => {
  project((dir) => {
    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [SN30] });
    const before = readFileSync(join(dir, CONTROLLERS_FILE), 'utf8');
    session.apply({ type: 'bind', id: 'nothing like it', control: 'a', binding: 'button:0' });
    assert.equal(readFileSync(join(dir, CONTROLLERS_FILE), 'utf8'), before);
  });
});

test('a hand-written file is read, edited and written back rather than replaced', () => {
  project((dir) => {
    // Somebody wrote this by hand, which the file is meant to allow.
    writeFileSync(join(dir, CONTROLLERS_FILE), `${JSON.stringify({
      version: 1,
      controllers: { devices: [{ id: 'keys', name: 'Keyboard', player: 1, mode: 'custom', mapping: { up: 'key:KeyW' } }] },
    }, null, 2)}\n`);
    const session = createSession(dir);
    session.apply({ type: 'bind', id: 'keys', control: 'down', binding: 'key:KeyS' });
    const [device] = stored(dir).controllers.devices;
    assert.deepEqual(device.mapping, { up: 'key:KeyW', down: 'key:KeyS' });
  });
});

test('the state the page is sent carries the controls, the thresholds and the file', () => {
  project((dir) => {
    const session = createSession(dir, {
      targets: [{ id: 'c64', title: 'Commodore 64', primaryPort: 2, facts: { 'input.joysticks': 2 } }],
    });
    session.apply({ type: 'detected', devices: [SN30], blocked: false, silenced: false });
    const state = session.state();
    assert.equal(state.type, 'state');
    assert.equal(state.file, join(dir, CONTROLLERS_FILE));
    assert.equal(state.fileName, CONTROLLERS_FILE);
    assert.equal(state.controls.length, 18);
    assert.ok(state.controls.every((control) => control.label && control.kind));
    assert.ok(state.walkthrough.length > 0);
    assert.equal(typeof state.deadzone, 'number');
    assert.equal(state.devices[0].present, true);
    assert.equal(state.devices[0].buttons, 16);
    assert.equal(state.devices[0].standard, true);
    // The preview is the toolchain's answer, not this command's: the port
    // number comes from `8bs targets`, which is why a C64 reads port 2.
    assert.equal(state.preview[0].title, 'Commodore 64');
    assert.equal(state.preview[0].firstPort, 2);
    assert.equal(state.preview[0].ports, 2);
  });
});

test('a device that is on record but unplugged is shown as remembered, not connected', () => {
  project((dir) => {
    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [SN30] });
    session.apply({ type: 'detected', devices: [] });
    const state = session.state();
    assert.equal(state.devices.length, 1);
    assert.equal(state.devices[0].present, false);
    assert.equal(state.devices[0].buttons, null);
  });
});

test('a window that refuses the Gamepad API is reported as refusing it', () => {
  project((dir) => {
    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [], blocked: true, silenced: false });
    assert.equal(session.state().blocked, true);
    session.apply({ type: 'detected', devices: [], blocked: false, silenced: true });
    assert.equal(session.state().silenced, true);
  });
});

// ---- the request handler -------------------------------------------------

const context = (dir) => {
  const session = createSession(dir);
  return { session, assets: pageAssets(TOKEN), token: TOKEN };
};

test('GET / serves the page, and every file it names is served too', () => {
  project((dir) => {
    const ctx = context(dir);
    const page = respond({ method: 'GET', pathname: '/' }, ctx);
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    for (const [, src] of page.body.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
      const asset = respond({ method: 'GET', pathname: src }, ctx);
      assert.equal(asset.status, 200, `${src} is named by the page and not served`);
      assert.ok(asset.body.length > 0, `${src} is served empty`);
    }
  });
});

test('anything else is a 404, and a GET cannot change the profile', () => {
  project((dir) => {
    const ctx = context(dir);
    assert.equal(respond({ method: 'GET', pathname: '/../package.json' }, ctx).status, 404);
    assert.equal(respond({ method: 'GET', pathname: '/message' }, ctx).status, 404);
    assert.equal(respond({ method: 'PUT', pathname: '/message' }, ctx).status, 405);
    assert.equal(respond({ method: 'POST', pathname: '/elsewhere', body: { token: TOKEN } }, ctx).status, 404);
  });
});

test('a POST without the page\'s token is refused', () => {
  project((dir) => {
    const ctx = context(dir);
    // Any page in any browser can reach a loopback port and guess the
    // number; none of them can read what this server sent to another
    // origin, which is what the token is.
    for (const body of [undefined, null, {}, { token: 'guess' }, 'not json']) {
      const answer = respond({ method: 'POST', pathname: '/message', body }, ctx);
      assert.equal(answer.status, 403, `${JSON.stringify(body)} was accepted`);
    }
    assert.equal(existsSync(join(dir, CONTROLLERS_FILE)), false);
  });
});

test('a POST with the token applies the message and answers with the whole state', () => {
  project((dir) => {
    const ctx = context(dir);
    const answer = respond({
      method: 'POST',
      pathname: '/message',
      body: { token: TOKEN, message: { type: 'detected', devices: [SN30] } },
    }, ctx);
    assert.equal(answer.status, 200);
    assert.match(answer.type, /application\/json/);
    const state = JSON.parse(answer.body);
    assert.equal(state.type, 'state');
    assert.equal(state.devices.length, 1);
    // A new pad is worth a line in the terminal; the handler returns it
    // rather than printing, so this can read it.
    assert.deepEqual(answer.notices, [`detected ${SN30.id}`]);
  });
});

test('the Open button answers with the path, because there is no editor to open it in', () => {
  project((dir) => {
    const ctx = context(dir);
    const answer = respond({
      method: 'POST', pathname: '/message', body: { token: TOKEN, message: { type: 'open' } },
    }, ctx);
    assert.deepEqual(answer.notices, [join(dir, CONTROLLERS_FILE)]);
  });
});

test('POST /done finishes the session and closes the connection', () => {
  project((dir) => {
    const ctx = context(dir);
    const answer = respond({ method: 'POST', pathname: '/done', body: { token: TOKEN } }, ctx);
    assert.equal(answer.status, 200);
    assert.equal(ctx.session.finished, true);
    // Without this the command waits on a keep-alive socket the tab is
    // still holding, and "Done" takes five seconds to do anything.
    assert.equal(answer.close, true);
  });
});

// ---- the page, evaluated -------------------------------------------------

/** A DOM stub: enough of one for the shim, and nothing that pretends to render. */
function fakeDom() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
    return elements.get(id);
  };
  return { elements, element };
}

test('the served profile module loads as a browser gets it: a `Profile` global', () => {
  const source = pageAssets(TOKEN).get('/profile.js').body;
  const sandbox = createContext({});
  runInContext(source, sandbox);
  // If controllerProfile.cjs ever grows a `require`, a `process` or
  // anything else only Node has, this is where it is caught — the
  // extension's own test makes the same demand of it from its side.
  assert.equal(typeof sandbox.Profile.parseBinding, 'function');
  assert.equal(typeof sandbox.Profile.DEADZONE, 'number');
  assert.equal(sandbox.Profile.LOGICAL_CONTROLS.length, 18);
  // Same trap as the editor's panel: a classic script that is not wrapped
  // leaks `function heldKeys` and the page's `const heldKeys` then fails
  // to parse. The IIFE is what makes this a Profile global and nothing else.
  assert.equal(sandbox.heldKeys, undefined);
  runInContext('const heldKeys = new Set();', sandbox);
});

test('the host shim turns the page\'s postMessage into a token-carrying POST', async () => {
  const dom = fakeDom();
  const sent = [];
  const posted = [];
  const sandbox = createContext({
    window: { __8BS_TOKEN: TOKEN, postMessage: (message) => posted.push(message) },
    document: { getElementById: dom.element },
    fetch: (url, options) => {
      sent.push({ url, options });
      return Promise.resolve({ json: () => Promise.resolve({ type: 'state', devices: [] }) });
    },
  });
  sandbox.window.window = sandbox.window;
  runInContext(pageAssets(TOKEN).get('/host.js').body, sandbox);

  const api = sandbox.window.acquireVsCodeApi();
  api.postMessage({ type: 'ready' });
  // The chain is promises; let it settle.
  await new Promise((done) => setTimeout(done, 0));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/message');
  assert.equal(sent[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(sent[0].options.body), { token: TOKEN, message: { type: 'ready' } });
  // The reply arrives as the `message` event the page already listens for,
  // which is the whole of the adaptation.
  assert.deepEqual(posted, [{ type: 'state', devices: [] }]);

  // Done posts to the other route and says so in the page.
  dom.element('cli-done').listeners.click();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(sent[1].url, '/done');
  assert.deepEqual(JSON.parse(sent[1].options.body), { token: TOKEN });
  assert.match(dom.element('cli-note').textContent, /finished/);
});

test('every element the mirrored page script reaches for is on the page', () => {
  const script = readFileSync(join(PAGE_DIR, 'controller.js'), 'utf8');
  const page = renderPage(TOKEN);
  const ids = new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map((match) => match[1]));
  assert.ok(ids.size > 10, 'the id scan found nothing — has the page script changed shape?');
  for (const id of ids) {
    assert.match(page, new RegExp(`id="${id}"`), `the page has no #${id}, which the script reads`);
  }
  // The silhouette is queried rather than fetched by id, and every shape
  // on it is clicked and lit by `data-control`.
  assert.match(page, /id="pad"/);
  assert.ok(/data-control="/.test(page), 'the pad silhouette is missing from the page');
  assert.ok(/data-knob="/.test(page), 'the stick knobs are missing from the page');
});

test('the page defines every editor theme variable its stylesheet reads', () => {
  const css = readFileSync(join(PAGE_DIR, 'controller.css'), 'utf8');
  const page = renderPage(TOKEN);
  const used = new Set([...css.matchAll(/var\((--vscode-[\w-]+)/g)].map((match) => match[1]));
  assert.ok(used.size > 20, 'the variable scan found nothing — has the stylesheet changed shape?');
  for (const name of used) {
    // A webview is handed these by the workbench. A browser tab is handed
    // nothing, and an undefined variable is an invisible page.
    assert.ok(page.includes(`${name}:`), `${name} is read by the stylesheet and never defined`);
  }
});

// ---- the mirror ----------------------------------------------------------

test('the mirrored page is byte-for-byte the editor\'s', { skip: !existsSync(EXTENSION_DIR) && 'the extension is not next door' }, () => {
  for (const [name, from] of MIRRORED) {
    const mine = readFileSync(join(PAGE_DIR, name));
    const theirs = readFileSync(join(EXTENSION_DIR, from));
    assert.ok(
      mine.equals(theirs),
      `src/controller-page/${name} has drifted from editors/vscode/${from}.\n`
      + 'The extension is the original; this is a mirror, because an installed\n'
      + '@8bitscript/cli cannot reach editors/vscode (it is private and outside packages/).\n'
      + `Fix it with:\n  cp editors/vscode/${from} packages/cli/src/controller-page/${name}\n`,
    );
  }
});

test('the mirrored page ships in the published package', () => {
  // The bet this whole design rests on: `files` decides what npm puts in
  // the tarball, and a page that is not in it is a command that works in
  // this repository and nowhere else. That is exactly how 0.2.0-0.2.4
  // shipped backends nobody could run.
  const manifest = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8'));
  assert.ok(
    manifest.files.includes('src'),
    "package.json's `files` no longer covers src/, so src/controller-page/ would not be published",
  );
  for (const [name] of MIRRORED) {
    assert.ok(existsSync(join(PAGE_DIR, name)), `src/controller-page/${name} is missing`);
  }
});

// ---- what the terminal prints --------------------------------------------

test('--list says what is on record, and what each device answers to', () => {
  project((dir) => {
    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [SN30] });
    const id = stored(dir).controllers.devices[0].id;
    session.apply({ type: 'assign', id, player: 1 });
    session.apply({ type: 'preset', id, preset: 'standard' });
    const [line] = listLines(stored(dir));
    assert.match(line, /8BitDo SN30 Pro/);
    assert.match(line, /player 1/);
    assert.match(line, /\d+ of 18 bound/);
  });
});

test('--list on a project with nothing on record says so rather than printing a header', () => {
  assert.deepEqual(listLines({ controllers: { devices: [] } }), ['nothing on record yet.']);
});

test('the summary is computed with the same function a launch uses', () => {
  const one = summaryLines({
    controllers: {
      devices: [{ id: 'a', name: 'SN30 Pro', player: 1, mode: 'standard', mapping: { a: 'button:0' } }],
    },
  });
  assert.match(one[0], /player 1 \(host joystick 0\): SN30 Pro, 1 controls bound/);

  // Nothing assigned is not an error, but it is the one thing worth
  // warning about: a profile a run will find nothing in.
  assert.match(summaryLines({ controllers: { devices: [] } })[0], /no device is assigned/);

  // And a file hand-edited into a state the page cannot produce is
  // reported as the launch would report it, rather than summarized past.
  const clash = summaryLines({
    controllers: {
      devices: [
        { id: 'a', name: 'One', player: 1, mapping: {} },
        { id: 'b', name: 'Two', player: 1, mapping: {} },
      ],
    },
  });
  assert.match(clash[0], /both player 1/);
});

// ---- the command's two headless modes ------------------------------------

/**
 * Run the command and collect what it printed.
 *
 * Only ever called with `--list` or `--print`: the mapping mode binds a
 * port and waits for a browser, which is the one thing this file will not
 * do. `process.stdout.write` is swapped rather than the process being
 * spawned so a failure points at a line rather than at a child.
 */
async function capture(args) {
  const out = [];
  const err = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    const code = await controller(args);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test('--print writes the profile to stdout, and says why it cannot when there is none', async () => {
  await project(async (dir) => {
    const missing = await capture(['--print', '--dir', dir]);
    // A script that pipes this into jq must be able to tell "no profile"
    // from "an empty one", and an exit code is how.
    assert.equal(missing.code, 1);
    assert.match(missing.err, /no 8bitscript\.controllers\.json/);
    assert.equal(missing.out, '');

    createSession(dir).apply({ type: 'detected', devices: [SN30] });
    const found = await capture(['--print', '--dir', dir]);
    assert.equal(found.code, 0);
    assert.equal(JSON.parse(found.out).controllers.devices.length, 1);
  });
});

test('--list names the file it read and what is in it', async () => {
  await project(async (dir) => {
    const empty = await capture(['--list', '--dir', dir]);
    assert.equal(empty.code, 0);
    assert.match(empty.out, /no 8bitscript\.controllers\.json/);
    assert.match(empty.out, /nothing on record yet/);

    const session = createSession(dir);
    session.apply({ type: 'detected', devices: [SN30] });
    const listed = await capture(['--list', '--dir', dir]);
    assert.match(listed.out, new RegExp(CONTROLLERS_FILE));
    assert.match(listed.out, /8BitDo SN30 Pro/);
    assert.match(listed.out, /unassigned/);
  });
});

test('a bad argument is a usage error, not an empty run', async () => {
  const { code, err } = await capture(['--dir']);
  assert.equal(code, 2);
  assert.match(err, /--dir expects a directory/);
  assert.match(err, /Usage: 8bs controller/);
});
