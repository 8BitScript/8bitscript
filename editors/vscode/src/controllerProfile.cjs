// 8BitScript's normalized controller model: what a physical pad's raw
// buttons and axes are called once they stop being that pad's, and what
// each machine can actually carry of them.
//
// This module is deliberately free of the `vscode` API — like
// hardwareCatalog.cjs next door, and for the same reason: everything here
// is arithmetic on numbers the webview sampled and on the JSON the CLI
// printed, so it is tested with plain `node --test` and the thin editor
// glue (controllerView.cjs) stays separate.
//
// ---- why a normalized set at all -----------------------------------------
//
// The same profile has to project onto a VIC-20's one control port (four
// switches and a fire button — `packages/vic20/package.json` publishes
// `input.joysticks: 1`), onto an NES pad's eight bits, and onto the X16's
// SNES pads. A profile phrased in any one of those machines' terms cannot
// be projected onto the other two, and a profile phrased in the *host's*
// terms — "X-input button 0" — is a statement about the driver the person
// happened to boot with, not about what they pressed. So the stored names
// are 8BitScript's own, and both ends translate:
//
//     physical pad  --(mapping)-->  logical control  --(projection)-->  machine
//
// The left arrow is what the mapper in the panel edits. The right arrow is
// `project()` below, and is answered from the toolchain's fact sheet
// wherever the toolchain has an answer.
//
// ---- why these eighteen --------------------------------------------------
//
// They are the superset an 8-bit target could plausibly ask for, which is
// the SNES/console pad the X16 takes, plus the two analogue sticks and two
// analogue triggers a modern pad has and which a machine with paddles or a
// 1351 mouse could be fed from. Nothing beyond that: the reference device
// (an 8BitDo SN30 Pro in X-input mode) also reports two stick clicks, and
// they have no logical name here on purpose — no machine in the catalog
// has anything to project them onto, and inventing `l3`/`r3` would put a
// control in every stored profile that nothing downstream could ever read.

/**
 * The logical controls, in the order a panel should show them: the digital
 * ones a machine's switches map to, then the analogue ones.
 *
 * The order is load-bearing only for display — nothing is stored by index,
 * because an index is exactly the kind of thing that shifts when a control
 * is added.
 */
const LOGICAL_CONTROLS = [
  'up', 'down', 'left', 'right',
  'a', 'b', 'x', 'y',
  'l', 'r',
  'start', 'select',
  'leftStickX', 'leftStickY', 'rightStickX', 'rightStickY',
  'lt', 'rt',
];

/**
 * What each logical control *is*, which decides how a binding is read:
 *
 * - `digital` — on or off. A machine switch, a pad bit.
 * - `axis`    — a signed reading, -1 to 1, centred at rest.
 * - `analog`  — an unsigned reading, 0 to 1, at rest at 0 (a trigger).
 *
 * A `digital` control can be bound to an analogue source and a `analog`
 * one to a digital button — the reader below copes with both, because
 * which of the two a trigger arrives as depends on the driver, not on the
 * pad (see `readBinding`).
 */
const CONTROL_KINDS = {
  up: 'digital',
  down: 'digital',
  left: 'digital',
  right: 'digital',
  a: 'digital',
  b: 'digital',
  x: 'digital',
  y: 'digital',
  l: 'digital',
  r: 'digital',
  start: 'digital',
  select: 'digital',
  leftStickX: 'axis',
  leftStickY: 'axis',
  rightStickX: 'axis',
  rightStickY: 'axis',
  lt: 'analog',
  rt: 'analog',
};

/** A label for each control, for the mapper and the walkthrough's prompts. */
const CONTROL_LABELS = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  a: 'A',
  b: 'B',
  x: 'X',
  y: 'Y',
  l: 'L (left shoulder)',
  r: 'R (right shoulder)',
  start: 'Start',
  select: 'Select',
  leftStickX: 'Left stick, horizontal',
  leftStickY: 'Left stick, vertical',
  rightStickX: 'Right stick, horizontal',
  rightStickY: 'Right stick, vertical',
  lt: 'Left trigger',
  rt: 'Right trigger',
};

/**
 * How far a stick has to be pushed before it counts as a direction.
 *
 * This is a real decision and it belongs here rather than in the page: it
 * is the number that turns an analogue stick into the four switches a
 * VIC-20's control port has, so it is part of what a profile *means*, not
 * part of how a panel draws.
 *
 * 0.5 rather than a tighter figure because a clean diagonal on a round-gated
 * stick reads about 0.707 on each axis, and an Atari-standard joystick has
 * four independent switches — up and left really can both be closed. A
 * threshold above 0.707 would make diagonals unreachable; one far below it
 * would let a resting stick's drift (measured up to about 0.1 on the
 * reference SN30 Pro) close a switch on its own.
 */
const DEADZONE = 0.5;

/**
 * How hard an analogue *button* has to be squeezed to count as pressed.
 *
 * Separate from DEADZONE because it answers a different question — a
 * trigger rests at 0 and travels one way, a stick rests at centre and
 * travels both — and because the W3C Gamepad spec gives every button a
 * `value` in 0..1 and a `pressed` flag whose threshold is the browser's,
 * not ours. Reading `value` against our own number keeps the same profile
 * behaving the same way in two different browsers.
 */
const PRESS_THRESHOLD = 0.5;

/**
 * Parse a binding string into what it addresses.
 *
 * The grammar is three shapes and nothing else, because anything richer
 * would be a thing a person could get wrong in a file they are allowed to
 * hand-edit:
 *
 *     button:6      button index 6
 *     axis:1        axis index 1, whole, signed
 *     axis:1+       axis index 1's positive half
 *     axis:1-       axis index 1's negative half
 *
 * Indices are the ones the Gamepad API reports for that device, which is
 * why they are only ever meaningful next to the device id they were
 * captured on — see `normalizeDevice`.
 *
 * @param {unknown} binding
 * @returns {{ source: 'button'|'axis', index: number, half: '+'|'-'|null }|null} null for anything unparseable
 */
function parseBinding(binding) {
  if (typeof binding !== 'string') return null;
  const match = /^(button|axis):(\d+)([+-]?)$/.exec(binding.trim());
  if (!match) return null;
  // A button has no halves: `button:3-` is not a tighter way of saying
  // something, it is a typo, and reading it as `button:3` would hide it.
  if (match[1] === 'button' && match[3] !== '') return null;
  return {
    source: match[1] === 'button' ? 'button' : 'axis',
    index: Number(match[2]),
    half: match[3] === '' ? null : /** @type {'+'|'-'} */ (match[3]),
  };
}

/** The string form of what `parseBinding` returns — the two are inverses. */
function formatBinding({ source, index, half = null }) {
  return `${source}:${index}${source === 'axis' && half ? half : ''}`;
}

/**
 * What a binding reads right now, given one frame of a gamepad's raw state.
 *
 * The return is in the units of the *binding*, not of the control it is
 * bound to: a whole axis gives -1..1, everything else gives 0..1. The
 * caller decides what that means for the control (`pressed` below
 * digitizes; an axis control keeps the sign).
 *
 * Two shapes of raw state are accepted for buttons, because both really
 * happen: the W3C `GamepadButton` object (`{ pressed, value }`) and a bare
 * number, which is what the webview sends over the message channel once
 * it has flattened the frame. The same tolerance is what lets a trigger be
 * bound either way — on the reference SN30 Pro in X-input mode the two
 * triggers arrive as analogue *buttons* 6 and 7 under Chromium's standard
 * mapping, and as axes under some other drivers, and a profile should not
 * have to know which.
 *
 * @param {string} binding
 * @param {{ buttons?: Array<number|{value?: number, pressed?: boolean}>, axes?: number[] }} state
 * @returns {number} 0 when the binding addresses something this device does not have
 */
function readBinding(binding, state) {
  const parsed = parseBinding(binding);
  if (!parsed) return 0;
  if (parsed.source === 'button') {
    const raw = state?.buttons?.[parsed.index];
    if (raw === undefined || raw === null) return 0;
    if (typeof raw === 'number') return clamp01(raw);
    if (typeof raw.value === 'number') return clamp01(raw.value);
    return raw.pressed ? 1 : 0;
  }
  const value = state?.axes?.[parsed.index];
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  if (parsed.half === null) return Math.max(-1, Math.min(1, value));
  // A half-axis is the travel in one direction and nothing in the other,
  // so pushing left never reads as a smaller push right.
  return parsed.half === '+' ? clamp01(value) : clamp01(-value);
}

function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Whether a binding counts as pressed this frame.
 *
 * A whole axis is not a press — `axis:1` bound to `left` would be true at
 * rest half the time, since "is -0.02 pressed" has no honest answer — so
 * it reads as false and the panel offers a half when a digital control is
 * being bound.
 */
function pressed(binding, state) {
  const parsed = parseBinding(binding);
  if (!parsed) return false;
  if (parsed.source === 'axis' && parsed.half === null) return false;
  const value = readBinding(binding, state);
  return value >= (parsed.source === 'button' ? PRESS_THRESHOLD : DEADZONE);
}

/**
 * The four directions, answered for a device whose owner may have bound
 * only a stick.
 *
 * A machine's control port is four switches; a pad's D-pad is four
 * buttons; a modern stick is two signed axes. A profile that binds the
 * left stick and no D-pad still has to be able to steer a VIC-20, and a
 * profile that binds the D-pad and no stick still has to answer
 * `leftStickX` for a machine that wants a proportional reading. So each
 * direction resolves to the explicit binding first and falls back to the
 * matching half of the left stick, and that fallback is recorded so a
 * panel can say which of the two it is showing rather than implying the
 * D-pad was bound.
 *
 * The left stick and not the right: a machine with one stick expects the
 * one under the thumb that steers, and the right stick stays free for
 * whatever a program wants to aim with.
 *
 * @param {Record<string, string>} mapping
 * @param {'up'|'down'|'left'|'right'} direction
 * @returns {{ binding: string, from: 'explicit'|'leftStick' }|null}
 */
function resolveDirection(mapping, direction) {
  const explicit = mapping?.[direction];
  if (parseBinding(explicit)) return { binding: explicit, from: 'explicit' };
  const stick = { up: 'leftStickY', down: 'leftStickY', left: 'leftStickX', right: 'leftStickX' }[direction];
  const parsed = parseBinding(mapping?.[stick]);
  // Only a *whole* axis can be halved into two directions; a stick already
  // bound to one half is not a stick, it is that half.
  if (!parsed || parsed.source !== 'axis' || parsed.half !== null) return null;
  // Screen coordinates, which is the Gamepad API's convention and the one
  // every browser reports: -1 is up and left, +1 is down and right.
  const half = direction === 'up' || direction === 'left' ? '-' : '+';
  return { binding: formatBinding({ ...parsed, half }), from: 'leftStick' };
}

// ---- what a machine can carry --------------------------------------------
//
// Everything below this line that is *counted* comes from the toolchain:
// `8bs targets --json` publishes each machine's fact sheet, and
// `input.joysticks`, `input.pads`, `input.keyboard`, `input.mouse` and
// `input.paddles` (packages/compiler/src/fold/facts.mjs) are what say how
// many ports of what sort a machine has — including where a fitted option
// changes the answer, which is why `project()` takes a *resolved* sheet
// (hardwareCatalog.cjs's `effectiveFacts`) rather than a machine's stock
// one: `packages/atari8/package.json` raises `input.joysticks` to 4 for a
// multiplexer, and the C64's port options flip `input.mouse`.
//
// What the toolchain does *not* publish is what a port's device carries —
// that an Atari-standard joystick is four switches and one button, that an
// NES pad is eight bits, that the X16 takes a twelve-button SNES pad. That
// is the one table below, in one named place, and closing that gap is the
// first thing this panel needs from the CLI. See the report in
// `.changeset/controller-setup.md`.

/**
 * The logical controls each kind of port device carries.
 *
 * Sourced from this repository's own hardware layers rather than recalled:
 *
 * - `joystick` — `packages/c64/src/joystick.8bs` declares `Joystick.UP`,
 *   `DOWN`, `LEFT`, `RIGHT`, `FIRE`: five switches to ground. The VIC-20's
 *   and the Atari's ports are the same nine-pin standard.
 * - `pad.nes` — `packages/nes/src/pad.8bs` names the shift register's
 *   fixed order: A, B, SELECT, START, UP, DOWN, LEFT, RIGHT.
 * - `pad.snes` — the X16's controller ports take SNES pads, which add
 *   X, Y and the two shoulders to that eight.
 *
 * The fire button is `a`, not `b`: it is the one button the machine has,
 * and `a` is the one control every projection below has in common.
 */
const DEVICE_CONTROLS = {
  joystick: ['up', 'down', 'left', 'right', 'a'],
  'pad.nes': ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'],
  'pad.snes': ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'],
};

/**
 * Which pad a machine's `input.pads` ports take, where the fact's bare
 * count does not say.
 *
 * Two machines in the catalog publish a non-zero `input.pads` today — the
 * NES and the X16 — and they take different pads, so the count alone
 * cannot be projected. This is the whole of the editor's machine
 * knowledge, and it exists only until the CLI answers it; a machine not
 * named here projects nothing rather than guessing, which is the same rule
 * `packages/input/AGENTS.md` holds its own layers to ("a recalled matrix
 * that is wrong in two places is worse than a documented gap").
 */
const PAD_KINDS = {
  nes: 'pad.nes',
  cx16: 'pad.snes',
};

/**
 * Which numbered port a machine's first player is read from, for a
 * toolchain too old to say.
 *
 * Not cosmetic: `packages/c64/src/joystick.8bs` records that "port 2 is
 * where a game reads its player, and where every C64 game asked for the
 * stick", because port 1 shares wires with the keyboard's rows and a stick
 * there types. A panel that assigned Player 1 to port 1 on a C64 would be
 * wrong on the one machine the convention is strongest on.
 *
 * **The toolchain is the authority.** `8bs targets --json` publishes
 * `primaryPort` per machine, and `project()` below takes it and prefers
 * it; this table answers only when the answer is missing, which is an
 * older `@8bitscript/cli` in the project. It is deliberately the two
 * machines the convention is documented for and no more: the MEGA65 is
 * wired as the C64 is (`packages/mega65/AGENTS.md`) but has a `$D612.5`
 * swap bit a program can flip at run time, and a guess here that
 * disagreed with the toolchain would be worse than no guess.
 */
const PRIMARY_PORT = {
  c64: 2,
  c128: 2,
};

/**
 * How one device's mapping projects onto one machine.
 *
 * @param {string} target the machine id
 * @param {Record<string, number|boolean>} facts a resolved fact sheet —
 *   hardwareCatalog.cjs's `effectiveFacts(target, selection)`, so the
 *   answer is for the machine as it is fitted, not as it ships
 * @param {Record<string, string>} mapping one device's `mapping`
 * @param {{ primaryPort?: number|null }} [catalog] what the toolchain says
 *   about this machine beyond its facts — today just which port the first
 *   player is read from, published by `8bs targets --json`
 * @returns {{
 *   target: string,
 *   kind: string|null,
 *   ports: number,
 *   firstPort: number,
 *   controls: string[],
 *   bound: string[],
 *   missing: string[],
 *   unused: string[],
 *   note: string|null,
 * }}
 */
function project(target, facts, mapping, catalog = {}) {
  const joysticks = countFact(facts, 'input.joysticks');
  const pads = countFact(facts, 'input.pads');
  // A machine with both would be a machine with two different shapes of
  // port; none in the catalog has, and pads are the richer of the two, so
  // they win and the note says what was set aside.
  const kind = pads > 0 ? (PAD_KINDS[target] ?? null) : (joysticks > 0 ? 'joystick' : null);
  const ports = pads > 0 ? pads : joysticks;
  const controls = kind ? DEVICE_CONTROLS[kind] ?? [] : [];
  const ordered = LOGICAL_CONTROLS.filter((control) => controls.includes(control));
  const bound = ordered.filter((control) => answered(mapping, control));
  const missing = ordered.filter((control) => !answered(mapping, control));
  // What the pad has that this machine has nowhere to put. Worth showing:
  // it is the difference between "this profile does not fit here" and
  // "this machine simply has fewer buttons", and only the second is fine.
  const unused = LOGICAL_CONTROLS
    .filter((control) => !controls.includes(control) && answered(mapping, control));
  return {
    target,
    kind,
    ports,
    // The toolchain's answer wins; the table is only for a toolchain that
    // does not publish one yet.
    firstPort: catalog?.primaryPort ?? PRIMARY_PORT[target] ?? 1,
    controls: ordered,
    bound,
    missing,
    unused,
    note: projectionNote(target, kind, ports, pads, joysticks, facts),
  };
}

/** Why a machine shows nothing, or shows less than its ports suggest. */
function projectionNote(target, kind, ports, pads, joysticks, facts) {
  if (pads > 0 && kind === null) {
    return `The toolchain says ${target} has ${pads} controller port(s), but not what pad they take, so nothing can be projected onto them yet.`;
  }
  if (ports === 0) {
    return facts?.['input.keyboard']
      ? 'No control ports on this machine — its input layer reads the keyboard.'
      : 'No control ports on this machine.';
  }
  if (pads > 0 && joysticks > 0) {
    return `Also ${joysticks} joystick port(s); the controller ports are the richer of the two and are what is shown.`;
  }
  return null;
}

/** Whether a control has something a machine could actually read. */
function answered(mapping, control) {
  if (control === 'up' || control === 'down' || control === 'left' || control === 'right') {
    return resolveDirection(mapping, control) !== null;
  }
  return parseBinding(mapping?.[control]) !== null;
}

/** A fact sheet's count, defaulting to none rather than to something. */
function countFact(facts, key) {
  const value = facts?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ---- the stored profile --------------------------------------------------

/** The shape version written into the file, so a later reader can tell. */
const PROFILE_VERSION = 1;

/**
 * The two ways a device's mapping can have come about.
 *
 * `standard` means the browser reported `Gamepad.mapping === "standard"` —
 * the W3C's fixed 17-button, 4-axis layout — and the mapping was taken
 * from it, so it is as good as the driver's own. `custom` means somebody
 * pressed the buttons. They are stored apart because only the first can be
 * safely regenerated for a device that reports the same layout, and only
 * the second is a person's work that must never be silently overwritten.
 */
const MODES = ['standard', 'custom'];

/** 0 is unassigned; 1-4 are players. Four because that is as many as a pad ever has. */
const MAX_PLAYERS = 4;

/**
 * The W3C "standard gamepad" layout, as logical controls.
 *
 * Not machine knowledge and not a guess: it is
 * https://w3c.github.io/gamepad/#remapping, the layout a browser promises
 * when it sets `Gamepad.mapping === "standard"`, and it is what makes the
 * reference device usable without a walkthrough — an 8BitDo SN30 Pro in
 * X-input mode (powered on with X+START) is reported as standard by
 * Chromium. It is a *starting point*, never a stored fact: what gets
 * written to the file is the resulting button indices, so a device that
 * lies about being standard is corrected by rebinding rather than by
 * special-casing it here.
 *
 * The face buttons are the standard's positional 0-3 (bottom, right, left,
 * top). Under X-input those are A, B, X, Y in that order, which is the
 * reference pad's own printing; a pad whose labels sit elsewhere gets the
 * walkthrough.
 */
const STANDARD_MAPPING = {
  a: 'button:0',
  b: 'button:1',
  x: 'button:2',
  y: 'button:3',
  l: 'button:4',
  r: 'button:5',
  lt: 'button:6',
  rt: 'button:7',
  select: 'button:8',
  start: 'button:9',
  up: 'button:12',
  down: 'button:13',
  left: 'button:14',
  right: 'button:15',
  leftStickX: 'axis:0',
  leftStickY: 'axis:1',
  rightStickX: 'axis:2',
  rightStickY: 'axis:3',
};

/**
 * A device's stored id.
 *
 * The Gamepad API's `id` is a free-form string that usually carries the
 * USB vendor and product ids and a human name
 * ("8BitDo SN30 Pro (Vendor: 2dc8 Product: 6001)"), and it is the only
 * thing about a pad that is stable across unplugging it. `index` is not —
 * it is the slot the browser happened to put it in this session. So the id
 * is the whole string, lowercased and squeezed to a file-safe key, and the
 * original is kept as `name` for people to read.
 *
 * @param {string} rawId
 */
function deviceKey(rawId) {
  return String(rawId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'unknown-device';
}

/**
 * One device entry, with everything unrecognizable dropped rather than
 * carried.
 *
 * The rule is hardwareCatalog.cjs's `normalizeSelection`: a stored value
 * this cannot understand is not an error to raise, it is a value that was
 * never set — the panel then shows an unbound control, which is a state it
 * already knows how to present and a person already knows how to fix.
 *
 * @param {unknown} stored
 * @returns {{ id: string, name: string, player: number, mode: string, mapping: Record<string, string> }|null}
 */
function normalizeDevice(stored) {
  if (!stored || typeof stored !== 'object') return null;
  const id = typeof stored.id === 'string' && stored.id !== '' ? stored.id : null;
  if (!id) return null;
  const player = Number.isInteger(stored.player) && stored.player >= 0 && stored.player <= MAX_PLAYERS
    ? stored.player
    : 0;
  const mapping = {};
  if (stored.mapping && typeof stored.mapping === 'object') {
    // Written in LOGICAL_CONTROLS order rather than the file's, so two
    // saves of the same profile are the same bytes and a diff of a
    // controllers file shows what changed rather than what moved.
    for (const control of LOGICAL_CONTROLS) {
      const binding = stored.mapping[control];
      if (parseBinding(binding)) mapping[control] = binding.trim();
    }
  }
  return {
    id,
    name: typeof stored.name === 'string' && stored.name !== '' ? stored.name : id,
    player,
    mode: MODES.includes(stored.mode) ? stored.mode : 'custom',
    mapping,
  };
}

/**
 * A whole controllers file, normalized.
 *
 * Anything malformed reads as "no controllers configured", which is the
 * state a project with no file at all is in — so a file somebody broke by
 * hand costs them their profile and never the panel.
 *
 * @param {unknown} stored the parsed JSON
 * @returns {{ version: number, controllers: { devices: object[] } }}
 */
function normalizeProfile(stored) {
  const list = Array.isArray(stored?.controllers?.devices) ? stored.controllers.devices : [];
  const devices = [];
  const seen = new Set();
  for (const entry of list) {
    const device = normalizeDevice(entry);
    // One entry per device: a file with the same id twice would make the
    // panel's assignment ambiguous, and the first entry is the one a
    // person reading the file would expect to win.
    if (device && !seen.has(device.id)) {
      seen.add(device.id);
      devices.push(device);
    }
  }
  return { version: PROFILE_VERSION, controllers: { devices } };
}

/** An empty profile — what a project with no controllers file has. */
function emptyProfile() {
  return { version: PROFILE_VERSION, controllers: { devices: [] } };
}

/**
 * Fold one device's state into a profile and give the new profile back.
 *
 * Pure, and returns a fresh object rather than editing in place, because
 * the caller writes the result to disk and a half-applied edit that also
 * mutated the in-memory copy is the bug that survives a failed write.
 *
 * A player number other than 0 is taken off whichever device had it: two
 * devices both claiming Player 1 is not a state the panel can present, and
 * the one just assigned is the one the person is looking at.
 *
 * @param {object} profile
 * @param {{ id: string, name?: string, player?: number, mode?: string, mapping?: Record<string, string> }} device
 */
function withDevice(profile, device) {
  const normalized = normalizeDevice({ ...device, id: device?.id });
  if (!normalized) return normalizeProfile(profile);
  const base = normalizeProfile(profile);
  // Replaced where it already is rather than removed and re-added: the
  // file's order is the order devices were first seen, which is the order
  // the panel lists them in, and a device that jumped to the bottom every
  // time its player changed would move under the cursor that just clicked
  // it. A device not seen before goes on the end.
  const devices = base.controllers.devices.map((entry) => {
    if (entry.id === normalized.id) return normalized;
    // Two devices cannot both be Player 1, and the one just assigned is
    // the one the person is looking at.
    return normalized.player !== 0 && entry.player === normalized.player
      ? { ...entry, player: 0 }
      : entry;
  });
  if (!base.controllers.devices.some((entry) => entry.id === normalized.id)) devices.push(normalized);
  return { version: PROFILE_VERSION, controllers: { devices } };
}

/** Drop a device from a profile — Forget, for a pad that is not coming back. */
function withoutDevice(profile, id) {
  const base = normalizeProfile(profile);
  return {
    version: PROFILE_VERSION,
    controllers: { devices: base.controllers.devices.filter((entry) => entry.id !== id) },
  };
}

/**
 * A device the browser just reported, as an entry ready to be stored.
 *
 * A pad the browser calls `standard` starts bound; anything else starts
 * empty and is bound by hand, because a non-standard pad's indices are
 * that driver's and guessing them would produce a profile that is
 * confidently wrong rather than plainly unset.
 *
 * @param {{ id: string, mapping?: string, buttons?: number, axes?: number }} detected
 */
function deviceFromDetected(detected) {
  const standard = detected?.mapping === 'standard';
  return normalizeDevice({
    id: deviceKey(detected?.id),
    name: String(detected?.id ?? 'Unknown controller'),
    player: 0,
    mode: standard ? 'standard' : 'custom',
    // Only the controls this device actually has: a standard-mapping pad
    // with 10 buttons should not be stored claiming a `button:15` it
    // cannot report, or the panel would show a bound control that never
    // lights.
    mapping: standard ? withinDevice(STANDARD_MAPPING, detected) : {},
  });
}

/** STANDARD_MAPPING trimmed to the buttons and axes one device reports. */
function withinDevice(mapping, detected) {
  const buttons = Number.isInteger(detected?.buttons) ? detected.buttons : 0;
  const axes = Number.isInteger(detected?.axes) ? detected.axes : 0;
  const result = {};
  for (const [control, binding] of Object.entries(mapping)) {
    const parsed = parseBinding(binding);
    if (!parsed) continue;
    if (parsed.index < (parsed.source === 'button' ? buttons : axes)) result[control] = binding;
  }
  return result;
}

/**
 * Which raw inputs are doing something this frame, for the live view.
 *
 * Answered here rather than in the page so the thresholds that decide
 * "moving" are the same ones the bindings are read with — a live view that
 * used a different figure would show an axis as still while a binding on
 * it was firing.
 *
 * @param {{ buttons?: Array<number|object>, axes?: number[] }} state
 * @returns {{ buttons: number[], axes: Array<{ index: number, value: number }> }}
 */
function activeInputs(state) {
  const buttons = [];
  for (let index = 0; index < (state?.buttons?.length ?? 0); index += 1) {
    if (readBinding(`button:${index}`, state) >= PRESS_THRESHOLD) buttons.push(index);
  }
  const axes = [];
  for (let index = 0; index < (state?.axes?.length ?? 0); index += 1) {
    const value = readBinding(`axis:${index}`, state);
    if (Math.abs(value) >= DEADZONE) axes.push({ index, value });
  }
  return { buttons, axes };
}

/**
 * The one raw input a person just pressed, for binding by pressing.
 *
 * The loudest wins rather than the lowest-numbered: a stick shoved into a
 * corner moves two axes, and a pad's own D-pad often reports as a button
 * *and* an axis at once, so "the first one seen" binds whichever the
 * driver happened to enumerate first. Buttons are preferred over axes at
 * equal strength, because a button is unambiguous and an axis still has to
 * have a half chosen for it.
 *
 * `wantsAxis` asks for a whole axis instead of a half — what binding
 * `leftStickX` means, where the press is a *push* and the control is the
 * whole travel.
 *
 * @param {{ buttons?: Array<number|object>, axes?: number[] }} state
 * @param {{ wantsAxis?: boolean }} [options]
 * @returns {string|null} a binding string, or null when nothing is being pressed
 */
function capture(state, { wantsAxis = false } = {}) {
  let best = null;
  let strength = 0;
  if (!wantsAxis) {
    for (let index = 0; index < (state?.buttons?.length ?? 0); index += 1) {
      const value = readBinding(`button:${index}`, state);
      if (value >= PRESS_THRESHOLD && value > strength) {
        best = `button:${index}`;
        strength = value;
      }
    }
  }
  for (let index = 0; index < (state?.axes?.length ?? 0); index += 1) {
    const value = readBinding(`axis:${index}`, state);
    const magnitude = Math.abs(value);
    // Strictly greater, so an axis never displaces a button it ties with.
    if (magnitude >= DEADZONE && magnitude > strength) {
      best = wantsAxis ? `axis:${index}` : `axis:${index}${value > 0 ? '+' : '-'}`;
      strength = magnitude;
    }
  }
  return best;
}

/**
 * The order the guided walkthrough asks for controls.
 *
 * The four directions first because they are the ones every machine in the
 * catalog has and the ones a half-finished profile is least useful
 * without; then the buttons a console pad has, in the order they are
 * printed on a pad; the sticks and triggers last, since no machine
 * projects them today and a person should be able to stop before them
 * with a profile that is already complete for every target.
 */
const WALKTHROUGH = [
  'up', 'down', 'left', 'right',
  'a', 'b', 'start', 'select',
  'x', 'y', 'l', 'r',
  'leftStickX', 'leftStickY', 'rightStickX', 'rightStickY',
  'lt', 'rt',
];


// ---- handing the profile to the toolchain --------------------------------
//
// `packages/cli/src/controllers.mjs` is the other end of this: it turns a
// profile into whatever each emulator takes at launch — `-joydev` and a
// generated `.vjm` for VICE, `SDL2_JOY_<n>_*` keys in an atari800 config,
// `-joy1..4` for x16emu, and a named refusal for the two that take
// nothing. It reads the profile out of the project's **8bitscript.config.ts**,
// as a `controllers.players` block, and it spells a binding with the host
// pad's index in it:
//
//     controllers: {
//       players: [
//         { port: 2, controls: { up: 'pad0.hat0.up', a: 'pad0.button0' } },
//       ],
//     }
//
// This editor stores something different on purpose, and the two are not
// in competition — they answer different questions:
//
//   * The CLI's block is **per player**: which emulated port, driven by
//     which host input. That is what a launch needs.
//   * This panel's file is **per device**: which physical pad, identified
//     by the one string about it that survives being unplugged, and what
//     its own buttons are called. That is what a mapper needs — a pad's
//     index is the slot the browser happened to give it this session, and
//     a mapping keyed on it would be wrong the next time somebody plugs
//     the mouse in first.
//
// So the panel keeps the device file and *emits* the CLI's block from it,
// resolving the pad index at the moment somebody asks. The block is
// offered to paste rather than written into the config by this extension,
// which is exactly what runner.cjs's `saveSystem` already falls back to
// for a config it cannot safely rewrite: the config is source, and source
// a person reads is edited by a person or by the editor's own undo stack,
// never by a panel spraying JSON into TypeScript.

/**
 * One of this profile's bindings, in the CLI's grammar.
 *
 * The two grammars are the same shapes with the pad named: what is
 * `button:3` against a device here is `pad0.button3` there, because the
 * CLI's block has no device identity of its own and has to carry the host
 * index in the string. The hat form (`pad0.hat0.up`) has no counterpart
 * here — the Gamepad API reports a hat as buttons or as an axis, never as
 * a hat, so this end never has one to emit.
 *
 * @param {string} binding
 * @param {number} pad the host pad index, counted from 0
 * @returns {string|null}
 */
function toCliBinding(binding, pad) {
  const parsed = parseBinding(binding);
  if (!parsed) return null;
  if (parsed.source === 'button') return `pad${pad}.button${parsed.index}`;
  return `pad${pad}.axis${parsed.index}${parsed.half ?? ''}`;
}

/**
 * The `controllers.players` block this profile means, for the CLI.
 *
 * Players in order, one entry each, unassigned devices left out. `port` is
 * omitted rather than computed: `packages/cli/src/controllers.mjs`'s
 * `defaultPort` already knows that a C64 or C128 reads player one from
 * port 2 and everything else counts players and ports together, and the
 * machine it is being launched on is not known here — a block written for
 * a C64 must still be right when the same project is run on an NES.
 *
 * The four directions go through `resolveDirection`, so a profile that
 * binds only the left stick emits four real direction bindings rather than
 * an empty `controls` map the CLI would have nothing to do with.
 *
 * @param {object} profile
 * @param {Record<string, number>} padIndex device id → the host pad index
 * @returns {{ players: Array<{ controls: Record<string, string> }> }}
 */
function toCliPlayers(profile, padIndex = {}) {
  const devices = normalizeProfile(profile).controllers.devices
    .filter((device) => device.player !== 0)
    .sort((a, b) => a.player - b.player);
  const players = [];
  for (const device of devices) {
    const pad = padIndex[device.id];
    // A device nobody can see has no host index, and an invented one would
    // aim an emulator at a port with nothing in it. It is left out, and
    // the panel says which.
    if (!Number.isInteger(pad)) continue;
    const controls = {};
    for (const control of LOGICAL_CONTROLS) {
      const resolved = control === 'up' || control === 'down' || control === 'left' || control === 'right'
        ? resolveDirection(device.mapping, control)
        : (parseBinding(device.mapping[control]) ? { binding: device.mapping[control] } : null);
      const binding = resolved ? toCliBinding(resolved.binding, pad) : null;
      if (binding) controls[control] = binding;
    }
    players.push({ controls });
  }
  return { players };
}

/**
 * That block as the TypeScript somebody pastes into 8bitscript.config.ts.
 *
 * Two-space indent and single quotes, which is how every config in this
 * repository is written and what runner.cjs's `systemLine` already emits
 * for a saved system.
 *
 * @param {object} profile
 * @param {Record<string, number>} padIndex
 * @param {{ indent?: string }} [options]
 */
function toConfigBlock(profile, padIndex = {}, { indent = '  ' } = {}) {
  const { players } = toCliPlayers(profile, padIndex);
  if (players.length === 0) return `${indent}controllers: { players: [] },`;
  const lines = [`${indent}controllers: {`, `${indent}  players: [`];
  for (const player of players) {
    // One binding a line rather than one player a line: eighteen of them
    // on one line is a diff nobody can read, and this is source somebody
    // is about to paste into a file they own.
    lines.push(`${indent}    {`, `${indent}      controls: {`);
    for (const [control, binding] of Object.entries(player.controls)) {
      lines.push(`${indent}        ${control}: '${binding}',`);
    }
    lines.push(`${indent}      },`, `${indent}    },`);
  }
  lines.push(`${indent}  ],`, `${indent}},`);
  return lines.join('\n');
}

module.exports = {
  CONTROL_KINDS,
  CONTROL_LABELS,
  DEADZONE,
  DEVICE_CONTROLS,
  LOGICAL_CONTROLS,
  MAX_PLAYERS,
  MODES,
  PAD_KINDS,
  PRESS_THRESHOLD,
  PRIMARY_PORT,
  PROFILE_VERSION,
  STANDARD_MAPPING,
  WALKTHROUGH,
  activeInputs,
  capture,
  deviceFromDetected,
  deviceKey,
  emptyProfile,
  formatBinding,
  normalizeDevice,
  normalizeProfile,
  parseBinding,
  pressed,
  project,
  readBinding,
  resolveDirection,
  toCliBinding,
  toCliPlayers,
  toConfigBlock,
  withDevice,
  withoutDevice,
};
