// The Controller Setup page.
//
// A real .js file rather than a template literal in the provider, for the
// reason launcher.js records: a `\n` inside a template became a real
// newline in the generated script, the script failed to parse, and every
// control filled from it stayed empty. Same rule here.
//
// It keeps no *project* state — the extension posts the whole panel on
// every change and this redraws it — but it does keep a frame of live
// gamepad readings, because that is the one thing the extension host
// cannot see. Node has no HID; the Gamepad API is the renderer's. So the
// division is: this file polls and draws, the host stores and projects.
//
// `Profile` is src/controllerProfile.cjs, injected into the page ahead of
// this script (see controllerView.cjs's `html`). That is deliberate rather
// than convenient: the deadzone that turns a shoved stick into a direction
// and the rule that picks the loudest input when two move at once are part
// of what a saved profile *means*, so the page and the host must not each
// have their own copy of them. There is one implementation and it is the
// one that is unit-tested.

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

/** The last state the extension posted. Null until the first one arrives. */
let data = null;

/**
 * This frame's raw reading of the selected pad — `{ buttons, axes }` as
 * plain numbers, which is one of the two shapes `Profile.readBinding`
 * takes. Flattened out of the live `Gamepad` object because a `Gamepad` is
 * a snapshot that browsers may or may not keep updating in place, and
 * because plain numbers are what a test can hand the same function.
 */
let frame = { buttons: [], axes: [], keys: [] };

/**
 * The keyboard keys held right now, as `KeyboardEvent.code`.
 *
 * A keyboard is in a *controller* panel because on one machine it is the
 * only controller there is: atari800 takes a joystick mapping in no shape
 * but keys (`-kbdjoy0/1` plus `SDL2_JOY_<n>_*`), so an Atari stick is a
 * keyboard stick. The CLI has always read `key:` bindings; this is the end
 * that can now capture one, which is what turns a hand-edited file into
 * something the walkthrough can produce.
 *
 * Cleared whenever the page stops being looked at: a key held while the
 * window loses focus never sends its `keyup` here, and a phantom held key
 * would bind itself to the next control anybody asked for.
 */
const heldKeys = new Set();

/**
 * What the page is waiting to be pressed: a queue of logical control ids.
 * One entry for a click on the pad, the whole walkthrough for the guided
 * setup, two for a stick (its horizontal axis, then its vertical).
 */
let queue = [];

/**
 * Whether the queue may accept a press yet.
 *
 * A person clicks `A` on the silhouette with the mouse, but they very
 * often click it while still holding the button they pressed a second ago,
 * and the walkthrough's every step begins with the button from the last
 * step still down. Accepting the first thing seen would bind that. So each
 * step waits for the pad to go quiet once, and only then listens.
 */
let armed = false;

/** Whether the page believes it is allowed to see gamepads at all. */
let blocked = false;

/**
 * Whether a `gamepadconnected` event has fired and nothing has ever been
 * listable since.
 *
 * The third state, and the one that cannot be read off the API. A
 * permissions policy that *throws* is caught in `pads()`; a policy — or an
 * editor sandbox — that instead lets the call succeed and quietly yields
 * nothing is indistinguishable from an unplugged pad, which is exactly the
 * confusion this panel exists to prevent. The event is the contradiction
 * that gives it away: the window announced a controller, and the same
 * window cannot list one. Nothing but a block explains that pair.
 *
 * "And nothing has ever been listable since" is the whole of it, and the
 * reason it is cleared in two places. Set it on connect and leave it set
 * and the most ordinary thing anyone does — plug a pad in, use it, unplug
 * it — ends with the panel announcing a sandbox refusal at somebody who
 * pulled a USB cable.
 */
let sawConnect = false;

/** The device list last reported upward, so only changes are sent. */
let reported = '';

/** Per-control rows of the binding table, kept so a frame can update them in place. */
const rows = new Map();

/**
 * The live view's chips and axis rows, by reference rather than by id.
 *
 * By reference because they are built here rather than in the page's HTML,
 * and an id that only exists after a render is an id the "every element
 * the script reaches for is on the page" test in test/controller.test.cjs
 * cannot check — the test is worth more than the shorthand.
 */
let liveButtons = null;
let liveAxes = null;
/** The keyboard line under them, which is on the page rather than built per pad. */
const liveKeys = document.createElement('div');

// ---- reading the pads ----------------------------------------------------

/**
 * Every connected pad, or null when this window will not let the page look.
 *
 * The null is the important case and it is why this is not a one-liner.
 * Chromium gates `navigator.getGamepads()` behind the `gamepad` permission
 * policy, whose default allowlist is the document's own origin; a webview
 * is a cross-origin iframe, and an extension cannot set the `allow`
 * attribute on the iframe the editor creates for it. Where the policy
 * denies it, the call throws a `SecurityError` — and where the API is
 * simply absent, there is no call to make.
 *
 * Both of those must be told apart from "nothing is plugged in", because
 * on screen they are the same empty list, and a person with a pad in their
 * hands will spend the afternoon on the wrong problem.
 */
function pads() {
  if (typeof navigator.getGamepads !== 'function') return null;
  try {
    return Array.from(navigator.getGamepads()).filter(Boolean);
  } catch (error) {
    return null;
  }
}

/** One pad, as the shape `Profile` reads bindings out of. */
function flatten(gamepad) {
  return {
    buttons: Array.from(gamepad.buttons, (button) => (typeof button === 'number' ? button : button.value)),
    axes: Array.from(gamepad.axes),
  };
}

/** What the extension needs to know about a pad — never a frame of button state. */
function describe(gamepad) {
  return {
    id: gamepad.id,
    mapping: gamepad.mapping,
    buttons: gamepad.buttons.length,
    axes: gamepad.axes.length,
  };
}

/**
 * The animation-frame loop.
 *
 * It stops drawing while the tab is hidden, rather than stopping outright:
 * the panel is retained when hidden so a half-finished walkthrough
 * survives a glance at another file, and a retained page quietly burning a
 * frame callback behind an editor is exactly the thing that makes people
 * distrust webviews. `requestAnimationFrame` is already throttled to
 * nothing in a hidden tab by the browser, so this is belt and braces — but
 * it also means the page can *say* it is paused instead of showing a
 * frozen frame that reads as a dead controller.
 */
function tick() {
  requestAnimationFrame(tick);
  const list = pads();
  blocked = list === null;
  const connected = list ?? [];

  // Tell the extension when the set of pads changes, and only then.
  // Listing even one pad resolves the contradiction: this window can
  // answer, so whatever it says later about an empty list is the truth.
  if (connected.length > 0) sawConnect = false;
  // A window that announced a controller and has never once been able to
  // list one is a window refusing to answer, however quietly it does it.
  const silenced = sawConnect && connected.length === 0;
  const signature = (blocked ? 'blocked' : '') + (silenced ? 'silenced' : '')
    + connected.map((pad) => `${pad.id}#${pad.buttons.length}/${pad.axes.length}`).join('|');
  if (signature !== reported) {
    reported = signature;
    vscode.postMessage({
      type: 'detected', blocked, silenced, devices: connected.map(describe),
    });
  }

  if (document.hidden) return;

  // Keyed with `deviceKeys` rather than `deviceKey`, on the same ordered
  // list the extension keys, because two identical pads — the ordinary
  // two-player setup — report identical `id` strings.
  const keys = Profile.deviceKeys(connected.map((pad) => pad.id));
  const at = data?.selected ? keys.indexOf(data.selected) : -1;
  const selected = at === -1 ? null : connected[at];
  frame = selected ? flatten(selected) : { buttons: [], axes: [] };
  // Keys ride on the same frame as the pad's buttons, so everything
  // downstream — lighting a shape, filling a meter, capturing a binding —
  // treats a key exactly as it treats a button.
  frame.keys = [...heldKeys];
  advance();
  paint();
}

// ---- binding -------------------------------------------------------------

/**
 * Ask for one or more controls in turn.
 *
 * @param {string[]} controls logical control ids
 */
function ask(controls) {
  queue = controls.filter((control) => data?.controls.some((entry) => entry.id === control));
  armed = false;
  paint();
}

function stopAsking() {
  queue = [];
  armed = false;
  paint();
}

/**
 * Move the queue on when the pad says so.
 *
 * An axis control asks for a *whole* axis rather than a half: binding
 * `leftStickX` to `axis:0+` would give a stick that only exists to the
 * right. `Profile.capture` knows the difference; the page only has to say
 * which kind of control it is asking for, and that comes from the
 * extension's `controls` list rather than from a rule written here.
 */
function advance() {
  if (queue.length === 0) return;
  const control = queue[0];
  const kind = data?.controls.find((entry) => entry.id === control)?.kind;
  // Quiet once before listening — see `armed`.
  if (!armed) {
    if (Profile.capture(frame, { wantsAxis: false }) === null) armed = true;
    return;
  }
  const captured = Profile.capture(frame, { wantsAxis: kind === 'axis' });
  if (captured === null) return;
  vscode.postMessage({
    type: 'bind', id: data.selected, control, binding: captured,
  });
  queue = queue.slice(1);
  armed = false;
}

// ---- drawing -------------------------------------------------------------

/** The device list, the mapper's table and the preview: rebuilt when state arrives. */
function render() {
  if (!data) return;

  $('lede').textContent = data.project
    ? `Mapping controllers for ${data.projectLabel}. Press a button on your pad — it lights up below.`
    : 'No project open. A project is a directory with an 8bitscript.config.ts in it.';

  const notice = $('notice');
  const warning = trouble();
  notice.hidden = warning === null;
  notice.textContent = warning ?? '';

  renderDevices();
  renderBindings();
  renderPreview();

  $('hint-file').textContent = data.file
    ? `${data.exists ? 'Saved in' : 'Will be saved in'} ${data.file}`
    : '';
  $('open').hidden = !data.file;
  $('terminal').hidden = !(data.blocked || data.silenced);
}

/** Whatever is stopping this from working, said once, in the right order. */
function trouble() {
  if (data.blocked) {
    return 'This window is not handing the panel gamepad access, so no controller can be detected here. '
      + 'navigator.getGamepads() is either missing or refused by the window’s permissions policy — '
      + 'that is the editor’s webview sandbox, not a setting in this extension and not your controller.';
  }
  if (data.silenced) {
    return 'This window saw a controller connect and then reported no controllers at all. '
      + 'That contradiction is a permissions policy answering silently rather than refusing — '
      + 'again the editor’s webview sandbox, not your controller. Nothing you press here will register.';
  }
  if (data.error) return data.error;
  if (!data.project) return 'No project to save a controller profile into.';
  if (data.devices.length === 0) {
    return 'No controller seen yet. Plug one in and press a button on it — a browser hides a pad '
      + 'until it has been used once, so a connected-but-untouched controller really is invisible.';
  }
  return null;
}

function renderDevices() {
  const root = $('device-rows');
  root.textContent = '';
  const present = data.devices.filter((device) => device.present).length;
  $('device-count').textContent = data.devices.length === 0
    ? ''
    : `${present} of ${data.devices.length} connected`;
  $('no-devices').hidden = data.devices.length > 0;
  $('no-devices').textContent = 'Nothing here yet.';

  for (const device of data.devices) {
    const row = document.createElement('div');
    row.className = 'device' + (device.id === data.selected ? ' selected' : '');
    row.addEventListener('click', () => vscode.postMessage({ type: 'select', id: device.id }));

    const dot = document.createElement('span');
    dot.className = 'dot' + (device.present ? '' : ' away');
    dot.title = device.present ? 'Connected' : 'Remembered from the profile, not connected now';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = device.name;

    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = device.present
      ? `${device.buttons} buttons · ${device.axes} axes · ${device.standard ? 'standard layout' : 'own layout'}`
      : 'not connected';

    // Unassigned, then the players. The count comes from the extension so
    // the page does not decide how many players there can be.
    const player = document.createElement('select');
    for (let index = 0; index <= data.maxPlayers; index += 1) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = index === 0 ? 'Unassigned' : `Player ${index}`;
      option.selected = index === device.player;
      player.appendChild(option);
    }
    player.addEventListener('click', (event) => event.stopPropagation());
    player.addEventListener('change', (event) => vscode.postMessage({
      type: 'assign', id: device.id, player: Number(event.target.value),
    }));

    const forget = document.createElement('button');
    forget.className = 'small secondary';
    forget.textContent = 'Forget';
    forget.title = 'Drop this controller from the project’s profile';
    forget.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'forget', id: device.id });
    });

    row.append(dot, name, detail, player, forget);
    root.appendChild(row);
  }
}

/**
 * The mapper: the silhouette's click targets, and the table of all
 * eighteen controls under it.
 *
 * The table exists as well as the picture because a picture cannot honestly
 * show a binding — "A is button 0" is a fact with a number in it — and
 * because two of the eighteen (each stick's vertical axis) share a shape
 * with another. Clicking a stick asks for both in turn; the table is where
 * either can be re-bound on its own.
 */
function renderBindings() {
  const device = data.devices.find((entry) => entry.id === data.selected) ?? null;
  $('mapper').hidden = device === null;
  $('live-block').hidden = device === null;
  if (!device) return;

  $('mapper-device').textContent = device.name + (device.present ? '' : ' — not connected');
  $('live-device').textContent = device.present ? '' : 'not connected';

  for (const shape of document.querySelectorAll('#pad [data-control]')) {
    const controls = shape.dataset.control.split(' ');
    shape.onclick = () => ask(controls);
    const labels = controls.map((id) => data.controls.find((entry) => entry.id === id)?.label ?? id);
    shape.querySelector?.('title')?.remove();
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${labels.join(', ')} — click, then press it on the pad`;
    shape.appendChild(title);
  }

  const root = $('bindings');
  root.textContent = '';
  rows.clear();
  const table = document.createElement('table');
  table.className = 'bindings';
  let kind = null;
  for (const control of data.controls) {
    if (control.kind !== kind) {
      kind = control.kind;
      const head = document.createElement('tr');
      head.className = 'group';
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.textContent = {
        digital: 'Buttons and directions',
        axis: 'Sticks',
        analog: 'Triggers',
      }[kind] ?? kind;
      head.appendChild(cell);
      table.appendChild(head);
    }
    const row = document.createElement('tr');

    const name = document.createElement('td');
    name.textContent = control.label;

    const binding = document.createElement('td');
    binding.className = 'binding';

    const meterCell = document.createElement('td');
    const meter = document.createElement('div');
    meter.className = 'meter';
    const bar = document.createElement('span');
    meter.appendChild(bar);
    meterCell.appendChild(meter);

    const actions = document.createElement('td');
    const set = document.createElement('button');
    set.className = 'small secondary';
    set.textContent = 'Set';
    set.addEventListener('click', () => ask([control.id]));
    const clear = document.createElement('button');
    clear.className = 'small secondary';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => vscode.postMessage({
      type: 'bind', id: data.selected, control: control.id, binding: null,
    }));
    actions.append(set, ' ', clear);

    row.append(name, binding, meterCell, actions);
    table.appendChild(row);
    rows.set(control.id, { row, binding, bar });
  }
  root.appendChild(table);
}

/** What the mapping lands on, machine by machine. */
function renderPreview() {
  const root = $('preview');
  root.textContent = '';
  const table = document.createElement('table');
  table.className = 'preview';
  const head = document.createElement('tr');
  for (const label of ['Machine', 'Ports', 'What it reads']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    head.appendChild(cell);
  }
  table.appendChild(head);

  for (const entry of data.preview) {
    const row = document.createElement('tr');

    const machine = document.createElement('td');
    machine.className = 'machine';
    machine.textContent = entry.title;

    const ports = document.createElement('td');
    ports.className = 'ports';
    ports.textContent = entry.ports === 0
      ? '—'
      : `${entry.ports} × ${entry.kind ?? 'port'}`
        + (entry.firstPort !== 1 ? `, player 1 on port ${entry.firstPort}` : '');

    const controls = document.createElement('td');
    if (entry.controls.length === 0) {
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = entry.note ?? 'Nothing to map onto.';
      controls.appendChild(note);
    } else {
      for (const control of entry.controls) {
        const chip = document.createElement('span');
        chip.className = 'chip ' + (entry.bound.includes(control) ? 'ok' : 'gap');
        chip.textContent = data.controls.find((c) => c.id === control)?.label ?? control;
        chip.title = entry.bound.includes(control)
          ? 'Bound on this controller'
          : 'This machine reads it, and nothing on the controller is bound to it';
        controls.append(chip, ' ');
      }
      if (entry.unused.length > 0) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = ` — ${entry.unused.length} control(s) this machine has nowhere for`;
        controls.appendChild(note);
      }
      if (entry.note) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = ` — ${entry.note}`;
        controls.appendChild(note);
      }
    }

    row.append(machine, ports, controls);
    table.appendChild(row);
  }
  root.appendChild(table);
}

/**
 * Everything that changes on a frame: the lit shapes, the meters, the live
 * chips, the prompt.
 *
 * Nothing here creates or destroys a node — the DOM is built in `render`
 * and only attributes and text move — because sixty rebuilds a second of a
 * table with eighteen rows is how a webview earns its reputation.
 */
function paint() {
  if (!data) return;
  const device = data.devices.find((entry) => entry.id === data.selected) ?? null;
  const mapping = device?.mapping ?? {};
  const asking = queue[0] ?? null;

  const prompt = $('prompt');
  prompt.hidden = asking === null;
  if (asking !== null) {
    const label = data.controls.find((entry) => entry.id === asking)?.label ?? asking;
    const step = queue.length > 1 ? ` (${queue.length - 1} more after this)` : '';
    const kind = data.controls.find((entry) => entry.id === asking)?.kind;
    if (armed) {
      // Naming the keyboard here rather than in a paragraph nobody reads:
      // this is the moment somebody mapping an Atari stick needs to know
      // that a key is a legal answer.
      prompt.textContent = kind === 'axis'
        // A whole axis is a push, and no key and no button is one.
        ? `Push ${label} on the controller now${step} — Esc to stop.`
        : `Press ${label} on the controller now${step}`
          + ' — or a keyboard key, which is the only mapping the Atari takes. Esc to stop.';
    } else {
      // Naming what is still down turns a prompt that seems stuck into a
      // diagnosis: a pad that rests an axis away from centre — a trigger
      // sharing an axis is the usual cause — never goes quiet on its own,
      // and without this the step simply hangs with nothing to look at.
      const active = Profile.activeInputs(frame);
      const holding = [
        ...active.buttons.map((index) => `button ${index}`),
        ...active.axes.map((axis) => `axis ${axis.index}`),
      ];
      prompt.textContent = `Let go of everything, then press ${label}${step} — Esc to stop.`
        + (holding.length > 0 ? `  Still reading: ${holding.join(', ')}.` : '');
    }
  }

  for (const shape of document.querySelectorAll('#pad [data-control]')) {
    const controls = shape.dataset.control.split(' ');
    const lit = controls.some((control) => isActive(mapping, control));
    const bound = controls.some((control) => Profile.parseBinding(mapping[control]) !== null);
    shape.classList.toggle('on', lit);
    shape.classList.toggle('bound', bound && !lit);
    shape.classList.toggle('asking', controls.includes(asking));
  }

  // The knobs move with the sticks: a still knob on a pad somebody is
  // waggling says the binding is wrong, faster than any number can.
  for (const knob of document.querySelectorAll('#pad [data-knob]')) {
    const side = knob.dataset.knob === 'left' ? 'left' : 'right';
    const x = Profile.readBinding(mapping[`${side}StickX`] ?? '', frame);
    const y = Profile.readBinding(mapping[`${side}StickY`] ?? '', frame);
    knob.setAttribute('transform', `translate(${(x * 8).toFixed(2)} ${(y * 8).toFixed(2)})`);
  }

  for (const control of data.controls) {
    const entry = rows.get(control.id);
    if (!entry) continue;
    const resolved = resolve(mapping, control.id);
    entry.binding.textContent = resolved
      ? resolved.binding + (resolved.from === 'leftStick' ? ' (from the left stick)' : '')
      : 'not bound';
    entry.binding.classList.toggle('unbound', resolved === null);
    entry.row.classList.toggle('asking', control.id === asking);
    const value = resolved ? Profile.readBinding(resolved.binding, frame) : 0;
    // A signed axis draws from the middle out; everything else from the left.
    if (control.kind === 'axis') {
      const half = Math.abs(value) * 50;
      entry.bar.style.left = `${value < 0 ? 50 - half : 50}%`;
      entry.bar.style.width = `${half}%`;
    } else {
      entry.bar.style.left = '0';
      entry.bar.style.width = `${Math.max(0, value) * 100}%`;
    }
  }

  renderLive(device);
}

/** Whether a control is being pressed or pushed right now. */
function isActive(mapping, control) {
  const resolved = resolve(mapping, control);
  if (!resolved) return false;
  const value = Profile.readBinding(resolved.binding, frame);
  const parsed = Profile.parseBinding(resolved.binding);
  if (parsed.source === 'axis' && parsed.half === null) return Math.abs(value) >= Profile.DEADZONE;
  return Profile.pressed(resolved.binding, frame);
}

/**
 * What answers a control: its own binding, or — for the four directions —
 * the left stick, which is `Profile.resolveDirection`'s business and not
 * this page's. Everything else is its binding or nothing.
 */
function resolve(mapping, control) {
  if (control === 'up' || control === 'down' || control === 'left' || control === 'right') {
    return Profile.resolveDirection(mapping, control);
  }
  return Profile.parseBinding(mapping[control]) ? { binding: mapping[control], from: 'explicit' } : null;
}

/**
 * The raw inputs, unmapped: every button and every axis this pad reports,
 * lit as they move.
 *
 * This is the part that answers "is the device even talking", which is a
 * different question from "is my mapping right" and has to be answerable
 * without any mapping at all — so it is indexes and numbers, not names.
 */
function renderLive(device) {
  const root = $('live');
  const buttons = frame.buttons.length;
  const axes = frame.axes.length;
  // Rebuilt only when the shape of the pad changes, so the chips are not
  // recreated sixty times a second.
  if (root.dataset.shape !== `${device?.id ?? ''}:${buttons}/${axes}`) {
    root.dataset.shape = `${device?.id ?? ''}:${buttons}/${axes}`;
    root.textContent = '';
    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'group';
    const buttonLabel = document.createElement('span');
    buttonLabel.className = 'section-label';
    buttonLabel.textContent = `Buttons (${buttons})`;
    const chips = document.createElement('div');
    chips.className = 'chips';
    liveButtons = chips;
    for (let index = 0; index < buttons; index += 1) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = String(index);
      chips.appendChild(chip);
    }
    buttonGroup.append(buttonLabel, chips);

    const axisGroup = document.createElement('div');
    axisGroup.className = 'group';
    const axisLabel = document.createElement('span');
    axisLabel.className = 'section-label';
    axisLabel.textContent = `Axes (${axes})`;
    const list = document.createElement('div');
    liveAxes = list;
    for (let index = 0; index < axes; index += 1) {
      const row = document.createElement('div');
      row.className = 'axis-row';
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = `axis ${index}`;
      const bar = document.createElement('div');
      bar.className = 'axis-bar';
      bar.appendChild(document.createElement('span'));
      const value = document.createElement('span');
      value.className = 'n';
      row.append(n, bar, value);
      list.appendChild(row);
    }
    axisGroup.append(axisLabel, list);
    liveKeys.className = 'live-keys';
    root.append(buttonGroup, axisGroup, liveKeys);
  }

  const active = Profile.activeInputs(frame);
  // The keyboard is not part of the pad's shape, so it is a line of its
  // own that appears only while something is held rather than a hundred
  // chips that are always there.
  liveKeys.textContent = active.keys.length > 0
    ? `Keyboard: ${active.keys.join(', ')}`
    : '';
  liveKeys.hidden = active.keys.length === 0;
  const pressedSet = new Set(active.buttons);
  const chips = liveButtons;
  for (let index = 0; index < chips.children.length; index += 1) {
    chips.children[index].classList.toggle('on', pressedSet.has(index));
  }
  const list = liveAxes;
  for (let index = 0; index < list.children.length; index += 1) {
    const value = frame.axes[index] ?? 0;
    const [, bar, text] = list.children[index].children;
    const half = Math.min(1, Math.abs(value)) * 50;
    bar.firstChild.style.left = `${value < 0 ? 50 - half : 50}%`;
    bar.firstChild.style.width = `${half}%`;
    text.textContent = value.toFixed(2);
  }
}

// ---- wiring --------------------------------------------------------------

window.addEventListener('message', ({ data: message }) => {
  if (message.type !== 'state') return;
  data = message;
  // A queue asking for a device that is no longer the selected one is a
  // walkthrough somebody abandoned by clicking another pad.
  if (queue.length > 0 && !data.devices.some((device) => device.id === data.selected)) queue = [];
  render();
  paint();
});

$('walk').addEventListener('click', () => ask(data?.walkthrough ?? []));
$('standard').addEventListener('click', () => vscode.postMessage({
  type: 'preset', id: data?.selected, preset: 'standard',
}));
$('clear').addEventListener('click', () => vscode.postMessage({
  type: 'preset', id: data?.selected, preset: 'none',
}));
$('open').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
$('scan').addEventListener('click', () => {
  reported = '';
});
// Shown only when the window is refusing or silencing the Gamepad API,
// because that is the only time it is the answer rather than a detour:
// `8bs controller` serves this same page to a real browser and writes the
// same file, so a sandbox that cannot be argued with stops being the end
// of the road.
$('terminal').addEventListener('click', () => vscode.postMessage({ type: 'terminal' }));
$('prompt').addEventListener('click', stopAsking);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    heldKeys.clear();
    stopAsking();
    return;
  }
  heldKeys.add(event.code);
  // While a step is waiting, the key is the answer and not a keystroke for
  // the page: without this, binding Space scrolls and binding Tab walks
  // the focus out of the panel mid-walkthrough.
  if (queue.length > 0) event.preventDefault();
});
window.addEventListener('keyup', (event) => heldKeys.delete(event.code));
// A key held while the window loses focus never sends its keyup here, and
// a phantom held key would bind itself to the next control anybody asked
// for — so anything that means "the page stopped being looked at" drops
// the lot.
window.addEventListener('blur', () => heldKeys.clear());
document.addEventListener('visibilitychange', () => heldKeys.clear());
// A browser does not report a pad until it has been used, and the event is
// the moment that changes — poll immediately rather than a frame later, so
// the "press a button" notice clears the instant somebody does.
window.addEventListener('gamepadconnected', () => { sawConnect = true; reported = ''; });
// An unplug is a pad leaving, not a window refusing: the contradiction is
// over, and the list going empty from here means exactly what it says.
window.addEventListener('gamepaddisconnected', () => { sawConnect = false; reported = ''; });

requestAnimationFrame(tick);
vscode.postMessage({ type: 'ready' });
