// `8bs controller` — find the pad plugged into this machine and write down
// what its buttons are called, from the terminal.
//
// ---- why this exists beside the editor's panel ---------------------------
//
// The Gamepad API belongs to a browsing context. Node has no HID, so the
// CLI cannot enumerate a controller however much it would like to; the
// editor's Controller Setup panel solved that by polling
// `navigator.getGamepads()` inside its webview, which is the right place
// *if* the editor grants the feature.
//
// It may not. Chromium gates `navigator.getGamepads()` behind the
// `gamepad` permission policy, whose default allowlist is `self`; a
// webview is a cross-origin `vscode-webview://` iframe, so the feature has
// to be named in the `allow` attribute of the iframe the *editor* creates,
// which no extension can set. Cursor's bundled workbench sets that list to
// cross-origin-isolated, autoplay and the two clipboard features — the
// string `gamepad` does not appear in it. That is static evidence rather
// than a measurement on a machine with a pad in it, and the panel is
// careful to tell "refused" from "nothing plugged in" rather than assume
// (see `media/controller.js`'s `blocked`/`silenced`), but it means the
// panel can be a dead end through no fault of the profile it writes.
//
// A real browser has no such question: it is the origin, the policy's
// default allowlist is itself, and every pad it can see it will list. So
// this command serves the same page to the browser the person already has,
// over loopback, and takes the finished profile back. The editor no longer
// needs a permission it cannot ask for; it can shell out to this.
//
// It also makes the mapping a terminal thing, which it should have been
// anyway: `8bs run` reads `8bitscript.controllers.json` (controllers.mjs's
// `controllerPlayers`) to aim an emulator's joystick ports, and everything
// else that file touches is already a command.
//
// ---- why the page is a copy, and what keeps it honest --------------------
//
// The page served here *is* the editor's page: `media/controller.js`, its
// stylesheet, the silhouette in `src/controllerPad.cjs`, and — the one
// that matters — `src/controllerProfile.cjs`, which is what a binding
// means. The panel already goes out of its way to hand that same module to
// its webview behind a three-line CommonJS shim rather than copy it,
// because a second deadzone constant would be a second profile. Two
// mapping UIs would be a worse version of the same bug.
//
// They are *copies* here rather than reads of `editors/vscode/**` for one
// packaging reason: this package publishes `files: ["bin", "src"]`, the
// extension is `private: true` and outside `packages/`, and nothing in an
// installed `@8bitscript/cli` can reach it. A runtime read would work in
// this repository and fail for everybody who installed from npm — the
// exact shape of the 0.2.x releases that shipped unrunnable backends.
// Adding a prepack copy step was not available either: this branch does
// not own `package.json`.
//
// So the files under src/controller-page/ are byte-for-byte mirrors, and
// test/controller.test.mjs asserts they are byte-for-byte mirrors whenever
// the extension is next door, printing the `cp` that fixes it. The mirror
// is checked in; the original stays in the extension. A soft check (same
// exports, same behaviour) would let them drift, which is the failure this
// whole comment is about.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { CONTROLLERS_FILE, controllerPlayers } from './controllers.mjs';
import { describeFacts } from './targets.mjs';
// The two things a command that serves a page in a browser needs, from the
// command that already serves a page in a browser.
import { openBrowser, readJsonBody } from './web-runtime.mjs';

const require = createRequire(import.meta.url);

/** Where the mirrored page lives. */
export const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'controller-page');

/**
 * Every file mirrored out of editors/vscode, and where it came from.
 * Exported so the drift test has one list to walk rather than its own.
 */
export const MIRRORED = [
  ['controller.js', 'media/controller.js'],
  ['controller.css', 'media/controller.css'],
  ['controllerPad.cjs', 'src/controllerPad.cjs'],
  ['controllerProfile.cjs', 'src/controllerProfile.cjs'],
  ['controllerStore.cjs', 'src/controllerStore.cjs'],
];

// The profile model and the store, loaded from the mirror: `require`
// rather than `import` because they are the extension's CommonJS, and
// loaded from the mirror rather than re-implemented because normalizing a
// device, keying two identical pads apart and deciding what counts as a
// press are all part of what the stored file *means*. This end reads the
// same implementation the page does.
const Profile = require('./controller-page/controllerProfile.cjs');
const Store = require('./controller-page/controllerStore.cjs');
const { PAD_SVG } = require('./controller-page/controllerPad.cjs');

const PAGE_JS = readFileSync(join(PAGE_DIR, 'controller.js'), 'utf8');
const PAGE_CSS = readFileSync(join(PAGE_DIR, 'controller.css'), 'utf8');
const PROFILE_JS = readFileSync(join(PAGE_DIR, 'controllerProfile.cjs'), 'utf8');

/**
 * The editor theme variables the stylesheet is written against, given
 * values so the page is legible in a plain browser tab.
 *
 * This is the whole of the adaptation — the stylesheet is mirrored
 * unedited, and a webview gets these same names from the workbench. The
 * numbers are VS Code's own Dark+ and Light+ palettes, so the page looks
 * like the panel it is rather than like a second product; `color-scheme`
 * is set alongside them so form controls and scrollbars follow.
 *
 * Light is a `prefers-color-scheme` override rather than the default
 * because the dark set is what the panel is drawn and tested in, and a
 * browser that reports no preference should get the picture that has been
 * looked at most.
 */
const THEME_CSS = `:root {
  color-scheme: dark;
  --vscode-font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1f1f1f;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-panel-border: #3c3c3c;
  --vscode-focusBorder: #0078d4;
  --vscode-errorForeground: #f85149;
  --vscode-sideBarSectionHeader-foreground: #cccccc;
  --vscode-textLink-foreground: #4daafc;
  --vscode-textLink-activeForeground: #6cb6ff;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-dropdown-background: #313131;
  --vscode-dropdown-border: #3c3c3c;
  --vscode-dropdown-foreground: #cccccc;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-inputValidation-warningBackground: #352a05;
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-inputValidation-warningForeground: #cccccc;
  --vscode-charts-blue: #4daafc;
  --vscode-charts-green: #89d185;
  --vscode-charts-red: #f14c4c;
  --vscode-testing-iconPassed: #89d185;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --vscode-foreground: #3b3b3b;
    --vscode-editor-background: #ffffff;
    --vscode-editorWidget-background: #f8f8f8;
    --vscode-editorWidget-border: #d4d4d4;
    --vscode-panel-border: #e5e5e5;
    --vscode-errorForeground: #cd3131;
    --vscode-sideBarSectionHeader-foreground: #3b3b3b;
    --vscode-textLink-foreground: #005fb8;
    --vscode-textLink-activeForeground: #004a9b;
    --vscode-button-secondaryBackground: #e5e5e5;
    --vscode-button-secondaryForeground: #3b3b3b;
    --vscode-button-secondaryHoverBackground: #dcdcdc;
    --vscode-dropdown-background: #ffffff;
    --vscode-dropdown-border: #cecece;
    --vscode-dropdown-foreground: #3b3b3b;
    --vscode-list-hoverBackground: #f0f0f0;
    --vscode-list-activeSelectionBackground: #0060c0;
    --vscode-inputValidation-warningBackground: #fdf7e2;
    --vscode-inputValidation-warningBorder: #b89500;
    --vscode-inputValidation-warningForeground: #3b3b3b;
    --vscode-charts-blue: #005fb8;
    --vscode-charts-green: #388a34;
    --vscode-charts-red: #cd3131;
    --vscode-testing-iconPassed: #388a34;
  }
}
/* The panel is a webview filling a tab; a browser tab is however wide the
   window is, and eighteen bindings stretched across 2000px are unreadable. */
body { max-width: 68rem; margin: 0 auto; }
`;

/**
 * The bar this end adds above the mirrored page: what it is, where it
 * writes, and the one control a browser tab needs that a webview does not
 * — a way to say "done" to a process waiting on the other end of the
 * socket. Everything below it is the panel's own markup.
 */
const TOOLBAR_CSS = `.cli-bar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin: 0 0 18px; padding: 10px 14px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background);
}
.cli-bar .cli-note { flex: 1 1 16rem; opacity: 0.85; }
.cli-bar .cli-note code { font-family: var(--vscode-editor-font-family); }
`;

/**
 * The page, assembled.
 *
 * The body is the panel's — same element ids, same order — because
 * `controller.js` reaches for them by name and a missing one is a page
 * that half-renders with nothing in the console. The test holds this to
 * every id the mirrored script asks for.
 *
 * `Profile` arrives the way the panel gives it to its webview: the module
 * source between a two-line CommonJS shim. It is written to be loadable
 * that way (no `require`, no `process`) and the extension's own test keeps
 * it that way.
 *
 * @param {string} token the POST token; see `respond`
 */
export function renderPage(token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>8BitScript Controller Setup</title>
<style>${THEME_CSS}${TOOLBAR_CSS}</style>
<link rel="stylesheet" href="/controller.css">
</head>
<body>
  <header class="page-head">
    <h1>Controller Setup</h1>
    <p class="lede" id="lede"></p>
  </header>

  <div class="cli-bar">
    <span class="cli-note" id="cli-note">Served by <code>8bs controller</code>. This tab is the only thing that can see your pad; the command is waiting for it.</span>
    <button id="cli-done">Done — stop the command</button>
  </div>

  <p class="notice" id="notice" hidden></p>

  <section class="block">
    <h2 class="section-label">Controllers <span class="summary-value" id="device-count"></span></h2>
    <div id="device-rows"></div>
    <p class="none" id="no-devices" hidden></p>
  </section>

  <section class="block" id="mapper" hidden>
    <h2 class="section-label">Mapping <span class="summary-value" id="mapper-device"></span></h2>
    <div class="pad-wrap">${PAD_SVG}</div>
    <p class="prompt" id="prompt" hidden></p>
    <div class="row-actions">
      <button class="wide secondary" id="walk">Guided setup</button>
      <button class="wide secondary" id="standard">Use the standard layout</button>
      <button class="wide secondary" id="clear">Clear every binding</button>
    </div>
    <div id="bindings"></div>
  </section>

  <section class="block" id="live-block" hidden>
    <h2 class="section-label">Live input <span class="summary-value" id="live-device"></span></h2>
    <div class="live" id="live"></div>
  </section>

  <details class="block preview" id="preview-fold" open>
    <summary><span class="section-label">How this maps onto each machine</span></summary>
    <div id="preview"></div>
  </details>

  <div class="hint">
    <span id="hint-file"></span>
    <button class="link" id="open">Print its path in the terminal</button>
  </div>
  <script>window.__8BS_TOKEN = ${JSON.stringify(token)};</script>
  <script src="/host.js"></script>
  <script src="/profile.js"></script>
  <script src="/controller.js"></script>
</body>
</html>`;
}

/**
 * The shim that makes the panel's page work in a tab.
 *
 * The page talks to its host through exactly two things —
 * `acquireVsCodeApi().postMessage(...)` up, and a `message` event with a
 * `{ type: 'state' }` payload down — so the whole adaptation is to send
 * the first over `fetch` and dispatch the reply as the second. Nothing in
 * `controller.js` changes, and nothing here knows what any message means.
 *
 * The sends are chained rather than fired in parallel. Every reply is the
 * *whole* state, so two in flight can land out of order and redraw the
 * page from the older one — and a guided walkthrough sends a `bind` per
 * button as fast as somebody can press them. A queue of one keeps the last
 * reply the last word. It also means the server handles one edit at a
 * time, which is what makes read-modify-write of the file safe.
 */
const HOST_JS = `(() => {
  const token = window.__8BS_TOKEN;
  let chain = Promise.resolve();
  const send = (message) => fetch('/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, message }),
  }).then((response) => response.json()).then((state) => {
    if (state && state.type === 'state') window.postMessage(state, '*');
  }).catch((error) => {
    // The command was stopped, or the tab outlived it. Say so where the
    // page already says things, rather than failing silently.
    const note = document.getElementById('cli-note');
    if (note) note.textContent = '8bs controller is no longer listening (' + error.message + '). Run it again to carry on.';
  });
  window.acquireVsCodeApi = () => ({
    postMessage: (message) => { chain = chain.then(() => send(message)); },
    // The panel keeps no state in the webview and calls neither of these;
    // they are here so the page is loadable if that ever changes.
    getState: () => null,
    setState: () => {},
  });
  document.getElementById('cli-done').addEventListener('click', () => {
    fetch('/done', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }).catch(() => {});
    document.getElementById('cli-note').textContent = 'Saved. You can close this tab — the command has finished.';
  });
})();`;

/**
 * What the page is served, by path.
 *
 * Built once per run rather than read per request: three files that cannot
 * change while the command is running, and a request handler that never
 * touches the disk is a request handler a test can call in a loop.
 *
 * @param {string} token
 */
export function pageAssets(token) {
  return new Map([
    ['/', { type: 'text/html; charset=utf-8', body: renderPage(token) }],
    ['/host.js', { type: 'text/javascript; charset=utf-8', body: HOST_JS }],
    // The same two-line shim the panel wraps this module in, so one file
    // is both a CommonJS module here and a `Profile` global there.
    ['/profile.js', {
      type: 'text/javascript; charset=utf-8',
      body: `var module = { exports: {} };\n${PROFILE_JS}\nvar Profile = module.exports;`,
    }],
    ['/controller.js', { type: 'text/javascript; charset=utf-8', body: PAGE_JS }],
    ['/controller.css', { type: 'text/css; charset=utf-8', body: PAGE_CSS }],
  ]);
}

/**
 * Everything the command knows, and every change it can be asked to make.
 *
 * This is the editor's `ControllerPanel` with the editor taken out: the
 * same message names, the same read-modify-write of the controllers file
 * on every edit, the same rule that a pad is written down as soon as it is
 * seen. It is a plain object with no server, no browser and no `vscode` in
 * it, so the whole protocol is testable against a temporary directory.
 *
 * @param {string} dir the project directory the profile is written into
 * @param {{ targets?: Array<object> }} [context] `describeTargets()`'s
 *   answer, for the per-machine preview. Passed in rather than loaded here
 *   because reading a project's config is async and this is not.
 */
export function createSession(dir, { targets = [] } = {}) {
  return {
    dir,
    targets,
    /** The pads the page can see, as it last described them. */
    detected: [],
    blocked: false,
    silenced: false,
    /** Which device the mapper is editing — a cursor, not a fact about the project. */
    selected: null,
    /** Set when the page says it is finished; the server stops on it. */
    finished: false,

    /** The detected pads with the key each is stored under (see `deviceKeys`). */
    keyed() {
      const keys = Profile.deviceKeys(this.detected.map((entry) => entry.id));
      return this.detected.map((entry, index) => ({ ...entry, key: keys[index] }));
    },

    /**
     * Apply one message from the page.
     *
     * @returns {string[]} lines for the terminal. The session never writes
     *   to stdout itself — a function that prints is a function a test has
     *   to capture stdout to check.
     */
    apply(message) {
      switch (message?.type) {
        case 'ready':
          return [];
        case 'detected':
          this.detected = Array.isArray(message.devices) ? message.devices : [];
          this.blocked = Boolean(message.blocked);
          this.silenced = Boolean(message.silenced);
          return this.remember();
        case 'select':
          this.selected = typeof message.id === 'string' ? message.id : null;
          return [];
        case 'assign':
          return this.edit(message.id, (device) => ({
            ...device,
            player: Number.isInteger(message.player)
              && message.player >= 0 && message.player <= Profile.MAX_PLAYERS
              ? message.player
              : 0,
          }));
        case 'bind':
          return this.edit(message.id, (device) => {
            const mapping = { ...device.mapping };
            if (message.binding === null || message.binding === undefined) delete mapping[message.control];
            else mapping[message.control] = message.binding;
            // Bound by hand makes it a hand-made mapping, whatever it
            // started as — `mode` records where the bindings came from.
            return { ...device, mode: 'custom', mapping };
          });
        case 'preset':
          return this.edit(message.id, (device) => {
            const seen = this.keyed().find((entry) => entry.key === device.id);
            if (message.preset !== 'standard') return { ...device, mode: 'custom', mapping: {} };
            const fresh = Profile.deviceFromDetected({
              ...seen, id: seen?.id ?? device.name, key: device.id, mapping: 'standard',
            });
            return { ...device, mode: 'standard', mapping: fresh.mapping };
          });
        case 'forget': {
          const { profile } = Store.readProfile(this.dir);
          Store.writeProfile(this.dir, Profile.withoutDevice(profile, message.id));
          if (this.selected === message.id) this.selected = null;
          return [];
        }
        case 'open':
          // The panel opens the file in an editor tab. There is no editor
          // here, so the terminal gets the path — which is the answer to
          // the question the button is actually asking, and one a person
          // can paste into whatever they open files with.
          return [Store.controllersPath(this.dir)];
        case 'done':
          this.finished = true;
          return [];
        default:
          return [];
      }
    },

    /**
     * Change one device and write the file back.
     *
     * Read-modify-write per edit, as the panel does: the file is checked
     * into the project and somebody may have it open in an editor, and
     * losing a hand-typed line is worse than reading a small JSON file
     * once per button press.
     */
    edit(id, change) {
      if (typeof id !== 'string') return [];
      const { profile } = Store.readProfile(this.dir);
      const device = profile.controllers.devices.find((entry) => entry.id === id);
      if (!device) return [];
      Store.writeProfile(this.dir, Profile.withDevice(profile, change(device)));
      return [];
    },

    /**
     * Write down any pad seen for the first time, unassigned.
     *
     * A pad is recorded on sight rather than on assignment, so the list of
     * controllers this project has ever seen survives one being unplugged
     * — and with it, its mapping.
     */
    remember() {
      if (this.detected.length === 0) return [];
      const { profile } = Store.readProfile(this.dir);
      let next = profile;
      const fresh = [];
      for (const entry of this.keyed()) {
        if (next.controllers.devices.some((device) => device.id === entry.key)) continue;
        next = Profile.withDevice(next, Profile.deviceFromDetected(entry));
        fresh.push(entry.id);
      }
      if (next !== profile) Store.writeProfile(this.dir, next);
      // One pad and nothing selected is not a choice; two is, and this
      // should not make it.
      if (this.selected === null && this.detected.length === 1) this.selected = this.keyed()[0].key;
      return fresh.map((name) => `detected ${name}`);
    },

    /**
     * The whole panel, as the page expects it.
     *
     * Every list, label and threshold in here comes from the profile
     * module rather than from this file: there is one place a nineteenth
     * control would be declared, and it is not the host.
     */
    state() {
      const { profile, exists, error } = Store.readProfile(this.dir);
      const live = new Map(this.keyed().map((entry) => [entry.key, entry]));
      const devices = profile.controllers.devices.map((device) => ({
        ...device,
        present: live.has(device.id),
        buttons: live.get(device.id)?.buttons ?? null,
        axes: live.get(device.id)?.axes ?? null,
        standard: live.get(device.id)?.mapping === 'standard',
      }));
      const selected = devices.find((device) => device.id === this.selected) ?? null;
      return {
        type: 'state',
        project: this.dir,
        projectLabel: this.dir,
        file: Store.controllersPath(this.dir),
        fileName: CONTROLLERS_FILE,
        exists,
        error,
        blocked: this.blocked,
        silenced: this.silenced,
        controls: Profile.LOGICAL_CONTROLS.map((id) => ({
          id, kind: Profile.CONTROL_KINDS[id], label: Profile.CONTROL_LABELS[id],
        })),
        walkthrough: Profile.WALKTHROUGH,
        standard: Profile.STANDARD_MAPPING,
        deadzone: Profile.DEADZONE,
        pressThreshold: Profile.PRESS_THRESHOLD,
        maxPlayers: Profile.MAX_PLAYERS,
        devices,
        selected: selected?.id ?? null,
        preview: preview(this.targets, selected),
      };
    },
  };
}

/**
 * How the selected device's mapping lands on each machine.
 *
 * Computed from `8bs targets`' own answer — the same `primaryPort` and the
 * same fact sheets the editor reads out of `8bs targets --json` — so no
 * machine knowledge lives in this file.
 *
 * The sheets are the *stock* machine's, where the editor's panel resolves
 * the hardware each target has been fitted with. A terminal command has no
 * such selection to read, and the difference is visible: an Atari fitted
 * with a multiplexer has four joystick ports rather than two. Worth
 * knowing when reading the preview; not worth a `--hardware` flag on a
 * command whose output is a file that does not depend on it.
 */
function preview(targets, device) {
  return targets.map((target) => ({
    title: target.title ?? target.id,
    known: true,
    ...Profile.project(target.id, target.facts ?? {}, device?.mapping ?? {}, {
      primaryPort: target.primaryPort ?? null,
      // The shapes a control list can be, so project() can name the kind
      // rather than answering null for every machine. They ride out on the
      // `input.controls` fact descriptor, which is the same route the
      // editor's own call site reads them by (controllerView.cjs) --
      // describeFacts() is where the catalog publishes them.
      kinds: describeFacts().find((fact) => fact.key === 'input.controls')?.kinds ?? null,
    }),
  }));
}

/**
 * Answer one request.
 *
 * Pure but for the session it is handed (which writes the profile): given
 * a method, a path and a body it returns exactly what to send, so the
 * protocol is tested without a socket.
 *
 * ---- the token ----------------------------------------------------------
 *
 * Any page in any browser on this machine can POST to a loopback port —
 * the port is guessable and a script only needs to hit it, not read the
 * answer. This one writes a file into the project, so a POST carries a
 * secret that is only in the page this server served. Cross-origin reads
 * are what the same-origin policy already prevents, so a page that did not
 * come from here cannot have it. GETs are unguarded: they are three static
 * files and the HTML, and gating them would mean a URL nobody could type.
 *
 * @param {{ method: string, pathname: string, body?: unknown }} request
 * @param {{ session: ReturnType<typeof createSession>, assets: Map<string, {type: string, body: string}>, token: string }} context
 * @returns {{ status: number, type: string, body: string, notices?: string[], close?: boolean }}
 */
export function respond({ method, pathname, body }, { session, assets, token }) {
  const path = pathname === '' ? '/' : pathname;
  if (method === 'GET' || method === 'HEAD') {
    const asset = assets.get(path);
    if (!asset) return { status: 404, type: 'text/plain; charset=utf-8', body: 'not found\n' };
    return { status: 200, type: asset.type, body: method === 'HEAD' ? '' : asset.body };
  }
  if (method !== 'POST') {
    return { status: 405, type: 'text/plain; charset=utf-8', body: 'method not allowed\n' };
  }
  if (path !== '/message' && path !== '/done') {
    return { status: 404, type: 'text/plain; charset=utf-8', body: 'not found\n' };
  }
  if (!body || typeof body !== 'object' || body.token !== token) {
    return { status: 403, type: 'text/plain; charset=utf-8', body: 'bad token\n' };
  }
  if (path === '/done') {
    session.finished = true;
    // The last thing this connection will carry: the command is about to
    // stop, and a browser that keeps the socket open would hold it there.
    return { status: 200, type: 'application/json', body: '{"ok":true}\n', close: true };
  }
  const notices = session.apply(body.message);
  return {
    status: 200,
    type: 'application/json',
    body: `${JSON.stringify(session.state())}\n`,
    notices,
  };
}

/**
 * `8bs controller`'s arguments.
 *
 * @param {string[]} args
 * @returns {{ mode: 'map'|'list'|'print', open: boolean, dir: string|null, error: string|null }}
 */
export function parseControllerArgs(args) {
  const out = { mode: 'map', open: true, dir: null, error: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--list') out.mode = 'list';
    else if (arg === '--print') out.mode = 'print';
    else if (arg === '--no-open') out.open = false;
    else if (arg === '--dir') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        out.error = '--dir expects a directory';
        return out;
      }
      out.dir = value;
      index += 1;
    } else {
      out.error = `unknown option '${arg}'`;
      return out;
    }
  }
  return out;
}

const USAGE = `Usage: 8bs controller [--list] [--print] [--no-open] [--dir <path>]

  (no options)  Serve the mapping page on loopback and open it in your
                browser: assign pads to players, bind the controls, and
                ${CONTROLLERS_FILE} is written as you go. The
                browser is where the detection happens because the Gamepad
                API is a browsing context's — this process has no HID.
  --no-open     Print the URL and wait, rather than spawning a window.
  --list        List the controllers this project has on record, with what
                each one is bound to. It cannot list what is *plugged in*:
                only a browser can see that, which is what the page is for.
  --print       Print ${CONTROLLERS_FILE} to stdout.
  --dir <path>  The project directory; defaults to the current one.
`;

/**
 * One line per device on record.
 *
 * "On record" and not "connected", and the difference is the whole reason
 * this command exists: this process cannot see a pad. What it can say is
 * what the project has written down, which is what a launch will use.
 *
 * @param {object} profile a normalized profile
 * @returns {string[]}
 */
export function listLines(profile) {
  const devices = profile?.controllers?.devices ?? [];
  if (devices.length === 0) return ['nothing on record yet.'];
  return devices.map((device) => {
    const bound = Profile.LOGICAL_CONTROLS.filter(
      (control) => Profile.parseBinding(device.mapping?.[control]) !== null,
    ).length;
    const who = device.player > 0 ? `player ${device.player}` : 'unassigned';
    return `${device.name ?? device.id}  ${who}, ${bound} of ${Profile.LOGICAL_CONTROLS.length} bound, ${device.mode ?? 'custom'} layout`;
  });
}

/**
 * What was written, said the way a launch will read it.
 *
 * `controllerPlayers` is the function `8bs run` puts through the emulator
 * adapters, so a summary computed with anything else could agree with the
 * page and still disagree with the machine. Its refusals (two devices on
 * one player) are reported here for the same reason.
 *
 * @param {object} stored the parsed controllers file
 * @returns {string[]}
 */
export function summaryLines(stored) {
  const result = controllerPlayers(stored);
  if (!result.ok) return [result.error];
  if (result.players.length === 0) {
    return ['no device is assigned to a player yet, so a run will find nothing to use.'];
  }
  return result.players.map((player) => {
    const bound = Object.keys(player.controls).length;
    return `player ${player.player} (host joystick ${player.pad}): ${player.name}, ${bound} controls bound`;
  });
}

/**
 * The most a message from the page may be.
 *
 * Sixteen kilobytes where web-runtime's status pings take four: the
 * largest message here is a whole device list, which is a handful of
 * `Gamepad.id` strings and their counts. Nothing the page sends is
 * unbounded, so anything larger did not come from it.
 */
const MESSAGE_LIMIT = 16384;

/** @returns {Promise<number>} exit code */
export async function controller(args) {
  const parsed = parseControllerArgs(args);
  if (parsed.error) {
    process.stderr.write(`8bs controller: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const dir = resolve(parsed.dir ?? process.cwd());

  if (parsed.mode === 'print') {
    const { profile, exists, error } = Store.readProfile(dir);
    if (error) {
      process.stderr.write(`8bs controller: ${error}\n`);
      return 1;
    }
    if (!exists) {
      process.stderr.write(`8bs controller: no ${CONTROLLERS_FILE} in ${dir}. Run '8bs controller' to make one.\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    return 0;
  }

  if (parsed.mode === 'list') {
    const { profile, exists, error } = Store.readProfile(dir);
    if (error) process.stderr.write(`8bs controller: ${error}\n`);
    process.stdout.write(`${exists ? Store.controllersPath(dir) : `no ${CONTROLLERS_FILE} in ${dir}`}\n`);
    for (const line of listLines(profile)) process.stdout.write(`  ${line}\n`);
    // Said every time, because the absence of a pad from this list means
    // nothing about whether one is plugged in — and somebody reading it
    // with a controller in their hands deserves to be told why.
    process.stdout.write(
      '\nthis lists what the project has on record; nothing here can see a pad — '
      + "run '8bs controller' to let a browser do that.\n",
    );
    return 0;
  }

  // The preview only: a project without a config still maps controllers,
  // it just cannot be told how they land on each machine.
  const config = await loadConfig(dir, '8bs controller');
  const { describeTargets } = await import('./targets.mjs');
  const session = createSession(dir, { targets: describeTargets(config) });
  const token = randomBytes(16).toString('hex');
  const assets = pageAssets(token);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (answer) => {
      const headers = { 'Content-Type': answer.type, 'Cache-Control': 'no-store' };
      // A browser holds its connection open for reuse, and `server.close`
      // waits for every open connection — so a `done` answered on a
      // keep-alive socket would leave the command sitting there until the
      // idle timeout. This one says it is the last.
      if (answer.close) headers.Connection = 'close';
      res.writeHead(answer.status, headers);
      res.end(answer.body);
      for (const notice of answer.notices ?? []) process.stdout.write(`${notice}\n`);
      if (session.finished) stop();
    };
    if (req.method === 'POST') {
      readJsonBody(req, MESSAGE_LIMIT).then((body) => send(respond(
        { method: 'POST', pathname: url.pathname, body }, { session, assets, token },
      )));
      return;
    }
    send(respond({ method: req.method ?? 'GET', pathname: url.pathname }, { session, assets, token }));
  });

  let stop = () => {};
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  process.stdout.write(`serving the controller mapper at ${url}\n`);
  process.stdout.write(
    'a browser is where the Gamepad API lives, so that tab — not this process, and not the '
    + "editor's panel — is what can see your pad. Press a button on it once; a browser hides a "
    + 'controller until it has been used.\n',
  );
  process.stdout.write(`bindings are written to ${Store.controllersPath(dir)} as you make them.\n`);
  if (parsed.open) openBrowser(url);
  else process.stdout.write('--no-open: open that URL yourself.\n');
  process.stdout.write("click Done in the page when you have finished, or press Ctrl+C.\n");

  return new Promise((finish) => {
    let stopped = false;
    stop = () => {
      if (stopped) return;
      stopped = true;
      // Both halves: `close` refuses new connections and waits for the
      // open ones, `closeAllConnections` is what makes that wait finite
      // when a tab is still holding a keep-alive socket.
      server.close(() => {
        const { profile } = Store.readProfile(dir);
        process.stdout.write(`\nwrote ${Store.controllersPath(dir)}\n`);
        for (const line of summaryLines(profile)) process.stdout.write(`  ${line}\n`);
        finish(0);
      });
      server.closeAllConnections();
    };
    process.on('SIGINT', stop);
  });
}
