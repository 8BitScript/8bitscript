// The Controller Setup panel: find the pads plugged into this machine, say
// what each one's buttons are called in 8BitScript's terms, and write that
// down in the project.
//
// It is a `createWebviewPanel` rather than a second view in the side bar,
// and that is the point of it being separate from launcherView.cjs: the
// launcher is a thing that is always there and always narrow, and this is
// a thing that is opened, used for two minutes with a pad in both hands,
// and closed. A gamepad silhouette does not fit in a 300px side bar, and a
// panel that polls an animation frame has no business staying resident
// behind a tree view.
//
// It matches the launcher everywhere else on purpose — the same nonce'd
// CSP, the same "the page holds no state, the host posts the whole thing"
// protocol, the same `media/*.css` + `media/*.js` split (a template
// literal in this file is what once turned a `\n` in the launcher's script
// into a real newline and emptied every dropdown), and the same rule that
// nothing about a machine is listed here that the toolchain could be asked
// for instead.
//
// ---- why the detection is in the page ------------------------------------
//
// The extension host is Node. It has no HID. The Gamepad API belongs to the
// renderer, so the webview is the only part of this extension that can see
// a pad at all; it polls `navigator.getGamepads()` on an animation frame
// and posts frames up. Everything the host does with those frames —
// normalizing, storing, projecting onto machines — is in controllerProfile.cjs
// and controllerStore.cjs, neither of which imports `vscode`, so the logic
// is tested with `node --test` and this file is the glue.
//
// That also means one failure mode this file cannot fix and must not hide:
// Chromium gates `navigator.getGamepads()` behind the `gamepad` permission
// policy, and a webview is a cross-origin iframe whose `allow` attribute
// the extension does not control. If the host window does not grant it,
// the page sees no pads *and no error*. That state looks exactly like
// "nothing is plugged in", so the page tells them apart itself and says
// which it is — see `media/controller.js`'s `blocked` handling.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const { ALL_TARGETS } = require('./projects.cjs');
const { labelOf } = require('./runner.cjs');
const settings = require('./settings.cjs');
const { effectiveFacts } = require('./hardwareCatalog.cjs');
const {
  CONTROL_KINDS, CONTROL_LABELS, DEADZONE, LOGICAL_CONTROLS, MAX_PLAYERS, PRESS_THRESHOLD,
  STANDARD_MAPPING, WALKTHROUGH,
  deviceFromDetected, deviceKeys, project: projectOnto, withDevice, withoutDevice,
} = require('./controllerProfile.cjs');
const { CONTROLLERS_FILE, controllersPath, readProfile, writeProfile } = require('./controllerStore.cjs');
const { PAD_SVG } = require('./controllerPad.cjs');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'controller.css'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'controller.js'), 'utf8');
/**
 * controllerProfile.cjs, shipped into the page as well as loaded here.
 *
 * The page has to read bindings too — it is the half that can see the pad —
 * and the deadzone that turns a shoved stick into a direction, the rule
 * that picks the loudest input when two move at once, and the four
 * directions' fallback to the left stick are all part of what a stored
 * profile *means*. Two copies of those numbers would be two profiles.
 *
 * So there is one module and both ends load it: Node `require`s it, and
 * the page is handed the same source behind a three-line CommonJS shim.
 * It is written to be loadable that way — no `require`, no `process`,
 * nothing but arithmetic — and test/controller.test.cjs holds it to that.
 */
const PROFILE_JS = fs.readFileSync(path.join(__dirname, 'controllerProfile.cjs'), 'utf8');

/**
 * The open panel, or nothing.
 *
 * Module-level and singular: `createWebviewPanel` opens a new tab every
 * time it is called, so a second invocation of the command has to reveal
 * the one that is already there. A person who runs a command twice meant
 * "show me that", not "give me two of them polling the same pad".
 */
let open = null;

class ControllerPanel {
  /** @param {import('./runner.cjs').Projects} projects */
  constructor(panel, projects) {
    this.panel = panel;
    this.projects = projects;
    /**
     * Which device the mapper is editing.
     *
     * This is the only state the panel keeps, and it is kept because it is
     * not the project's: which of two pads somebody is looking at is a
     * cursor position, not a mapping. Everything that *is* the project's
     * goes straight to the controllers file and is read back, so the panel
     * and the file cannot disagree — the same rule the launcher follows
     * with the editor's settings.
     */
    this.selected = null;
    /**
     * The last frame the page reported: which devices it can see, with
     * their button and axis counts. Held so the host can tell a stored
     * device that is plugged in from one that is only remembered.
     */
    this.detected = [];
    this.blocked = false;
    this.silenced = false;
  }

  /**
   * The pads the page can see, each with the key it is stored under.
   *
   * Keyed here rather than in the page because two identical pads — the
   * ordinary two-player setup — report identical `id` strings, and
   * `deviceKeys` is the one rule that tells them apart. Both ends call it
   * on the same ordered list so both reach the same answer.
   */
  keyed() {
    const keys = deviceKeys(this.detected.map((entry) => entry.id));
    return this.detected.map((entry, index) => ({ ...entry, key: keys[index] }));
  }

  /** The project the panel writes into: the launcher's, or the first there is. */
  selectedProject() {
    const all = this.projects.all;
    const chosen = settings.getProject();
    return all.find((entry) => entry.dir === chosen)
      ?? this.projects.visible[0] ?? all[0] ?? null;
  }

  async apply(message) {
    switch (message?.type) {
      case 'ready':
        await this.post();
        return;
      case 'detected':
        // The page's view of the world, wholesale: which pads it can see,
        // and whether it believes it is allowed to look. Frames of live
        // button state are *not* sent up — they are a hundred messages a
        // second and the host has nothing to do with them. Only the list
        // changing, and only when it changes.
        this.detected = Array.isArray(message.devices) ? message.devices : [];
        this.blocked = Boolean(message.blocked);
        // The quieter refusal: the page saw a controller connect and then
        // could not list one. Kept apart from `blocked` because the two
        // want different sentences — one is "the call was refused", the
        // other "the call was answered with nothing".
        this.silenced = Boolean(message.silenced);
        await this.remember();
        await this.post();
        return;
      case 'select':
        this.selected = typeof message.id === 'string' ? message.id : null;
        await this.post();
        return;
      case 'assign':
        await this.edit(message.id, (device) => ({
          ...device,
          player: Number.isInteger(message.player) && message.player >= 0 && message.player <= MAX_PLAYERS
            ? message.player
            : 0,
        }));
        return;
      case 'bind':
        await this.edit(message.id, (device) => {
          const mapping = { ...device.mapping };
          if (message.binding === null || message.binding === undefined) delete mapping[message.control];
          else mapping[message.control] = message.binding;
          // Binding by hand makes it a hand-made mapping, whatever it
          // started as: `mode` records where the bindings came from, and a
          // profile somebody has corrected is no longer the driver's.
          return { ...device, mode: 'custom', mapping };
        });
        return;
      case 'preset':
        // Back to what the browser's standard layout says, or to nothing.
        await this.edit(message.id, (device) => {
          const seen = this.keyed().find((entry) => entry.key === device.id);
          if (message.preset !== 'standard') return { ...device, mode: 'custom', mapping: {} };
          const fresh = deviceFromDetected({
            ...seen, id: seen?.id ?? device.name, key: device.id, mapping: 'standard',
          });
          return { ...device, mode: 'standard', mapping: fresh.mapping };
        });
        return;
      case 'forget': {
        const project = this.selectedProject();
        if (!project) return;
        const { profile } = readProfile(project.dir);
        writeProfile(project.dir, withoutDevice(profile, message.id));
        if (this.selected === message.id) this.selected = null;
        await this.post();
        return;
      }
      case 'open': {
        const project = this.selectedProject();
        if (!project) return;
        const file = controllersPath(project.dir);
        if (!fs.existsSync(file)) writeProfile(project.dir, readProfile(project.dir).profile);
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
        return;
      }
      default:
    }
  }

  /**
   * Change one device and write the file back.
   *
   * Read-modify-write on every edit rather than holding the profile in
   * memory: the file is source that a person may have open in a tab next
   * to this panel, and the panel losing an edit somebody typed by hand is
   * worse than reading a small JSON file once per button press.
   */
  async edit(id, change) {
    const project = this.selectedProject();
    if (!project || typeof id !== 'string') return;
    const { profile } = readProfile(project.dir);
    const device = profile.controllers.devices.find((entry) => entry.id === id);
    if (!device) return;
    writeProfile(project.dir, withDevice(profile, change(device)));
    await this.post();
  }

  /**
   * Add any pad the page has just seen for the first time.
   *
   * A device is written down as soon as it is detected, unassigned, rather
   * than waiting for somebody to assign it: the list of pads this project
   * has ever seen is what the panel is a view of, and a pad that vanishes
   * from the list when it is unplugged takes its mapping with it.
   */
  async remember() {
    const project = this.selectedProject();
    if (!project || this.detected.length === 0) return;
    const { profile } = readProfile(project.dir);
    let next = profile;
    for (const entry of this.keyed()) {
      if (next.controllers.devices.some((device) => device.id === entry.key)) continue;
      next = withDevice(next, deviceFromDetected(entry));
    }
    if (next !== profile) writeProfile(project.dir, next);
    // Nothing selected yet, and exactly one pad to look at: select it.
    // Two pads is a choice and the panel should not make it.
    if (this.selected === null && this.detected.length === 1) {
      this.selected = this.keyed()[0].key;
    }
  }

  /** Push the whole panel to the page; it keeps no copy of its own. */
  async post() {
    const project = this.selectedProject();
    const { profile, exists, error } = project
      ? readProfile(project.dir)
      : { profile: { controllers: { devices: [] } }, exists: false, error: null };
    const live = new Map(this.keyed().map((entry) => [entry.key, entry]));
    const devices = profile.controllers.devices.map((device) => ({
      ...device,
      // Present means the page can see it right now; buttons and axes are
      // the device's own counts, so the mapper can refuse to offer a
      // binding to an index this pad does not have.
      present: live.has(device.id),
      buttons: live.get(device.id)?.buttons ?? null,
      axes: live.get(device.id)?.axes ?? null,
      standard: live.get(device.id)?.mapping === 'standard',
    }));
    const selected = devices.find((device) => device.id === this.selected) ?? null;
    this.panel.webview.postMessage({
      type: 'state',
      project: project?.dir ?? '',
      projectLabel: project ? labelOf(project) : '',
      file: project ? controllersPath(project.dir) : '',
      fileName: CONTROLLERS_FILE,
      exists,
      error,
      blocked: this.blocked,
      silenced: this.silenced,
      // The page lists no control, no label and no order of its own: all
      // three come from controllerProfile.cjs, which is the one place they
      // are declared and the one place a nineteenth control would be added.
      controls: LOGICAL_CONTROLS.map((id) => ({
        id, kind: CONTROL_KINDS[id], label: CONTROL_LABELS[id],
      })),
      walkthrough: WALKTHROUGH,
      standard: STANDARD_MAPPING,
      deadzone: DEADZONE,
      pressThreshold: PRESS_THRESHOLD,
      maxPlayers: MAX_PLAYERS,
      devices,
      selected: selected?.id ?? null,
      preview: await this.preview(project, selected),
    });
  }

  /**
   * How the selected device's mapping lands on each machine.
   *
   * The fact sheet is resolved per target the way the launcher resolves
   * it — the stored hardware selection, or the worst-RAM fallback, through
   * `effectiveFacts` — rather than the machine's stock sheet, because a
   * fitted option really does change the answer: `packages/atari8` raises
   * `input.joysticks` to 4 for a multiplexer, and the C64's control-port
   * options are what turn `input.mouse` on. A preview computed from stock
   * facts would disagree with the machine a Run actually starts, and the
   * whole reason the launcher resolves facts this way is that the panel
   * and the run must not disagree.
   */
  async preview(project, device) {
    const targets = await this.projects.loadTargets(project?.dir);
    return ALL_TARGETS.map((id) => {
      const target = targets?.get(id) ?? null;
      const facts = target
        ? effectiveFacts(target, settings.getEffectiveHardware(id, target))
        : null;
      return {
        // The machine's name is the toolchain's, never this extension's;
        // with no toolchain to ask there is only the id, and the page says
        // so rather than inventing a title.
        title: target?.title ?? id,
        known: facts !== null,
        ...onMachine(id, facts, device, target, targets),
      };
    });
  }
}

/**
 * One machine's row of the preview, or the row that says the toolchain
 * could not be asked. Imported as `projectOnto` rather than `project`
 * because `project` is what a *directory with a config in it* is called
 * everywhere else in this extension, and one word cannot be both.
 */
function onMachine(id, facts, device, target, targets) {
  if (!facts) {
    return {
      target: id, kind: null, ports: 0, firstPort: 1, controls: [], bound: [], missing: [], unused: [],
      note: 'No toolchain found to ask what this machine has.',
    };
  }
  // `primaryPort` is the toolchain's — `8bs targets --json` publishes it
  // per machine precisely so this editor stops keeping its own table. So
  // are the controller shapes that have a name: they hang off the
  // `input.controls` fact's own description rather than off a machine,
  // because which shapes exist is the vocabulary and is the same for all
  // nine, while *which one a machine has* is the fact itself.
  const kinds = (targets?.facts ?? []).find((fact) => fact.key === 'input.controls')?.kinds ?? null;
  return projectOnto(id, facts, device?.mapping ?? {}, {
    primaryPort: target?.primaryPort ?? null,
    kinds,
  });
}

const ICONS = {
  file: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.5 1H3.8C3.4 1 3 1.4 3 1.9v12.2c0 .5.4.9.8.9h8.4c.4 0 .8-.4.8-.9V4.8L9.5 1zm0 1.6L11.9 5H9.5V2.6zM4 14V2h4.5v3.5c0 .3.2.5.5.5h3v8H4z"/></svg>',
};

function html(webview) {
  const nonce = crypto.randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${CSS}</style>
<title>Controller Setup</title>
</head>
<body>
  <header class="page-head">
    <h1>Controller Setup</h1>
    <p class="lede" id="lede"></p>
  </header>

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
    <button class="link" id="open">${ICONS.file} Open it</button>
  </div>
  <script nonce="${nonce}">var module = { exports: {} };
${PROFILE_JS}
var Profile = module.exports;</script>
  <script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import('./runner.cjs').Projects} projects
 */
function registerControllerView(context, projects) {
  context.subscriptions.push(
    vscode.commands.registerCommand('8bitscript.controllerSetup', () => {
      if (open) {
        open.panel.reveal(vscode.ViewColumn.Active);
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        '8bitscript.controllers',
        'Controller Setup',
        vscode.ViewColumn.Active,
        // Retained while hidden so a walkthrough somebody is halfway
        // through survives a glance at another tab. The page stops polling
        // when it is not visible and says so, so a retained panel is not a
        // panel quietly burning an animation frame behind a file.
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const view = new ControllerPanel(panel, projects);
      panel.webview.html = html(panel.webview);
      const subscriptions = [
        panel.webview.onDidReceiveMessage((message) => view.apply(message)),
        projects.onDidChange(() => view.post()),
        vscode.workspace.onDidChangeConfiguration((event) => {
          // The project the panel writes into is the launcher's selection,
          // and the hardware each machine is fitted with is what the
          // preview is computed from, so both move the panel.
          if (settings.affectsAny(event)) view.post();
        }),
      ];
      panel.onDidDispose(() => {
        for (const subscription of subscriptions) subscription.dispose();
        open = null;
      });
      open = view;
    }),
  );
}

module.exports = { registerControllerView };
