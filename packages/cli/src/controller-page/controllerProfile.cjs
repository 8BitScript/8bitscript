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
 * The key that cancels a binding step, and therefore the one key that can
 * never be bound by pressing it.
 *
 * Named here rather than in the page because `capture` is what has to
 * refuse it, and a page that refused it separately would be a second
 * opinion about the same key.
 */
const CANCEL_KEY = 'Escape';

/**
 * Parse a binding string into what it addresses.
 *
 * The grammar is four shapes and nothing else, because anything richer
 * would be a thing a person could get wrong in a file they are allowed to
 * hand-edit:
 *
 *     button:6       button index 6
 *     axis:1         axis index 1, whole, signed
 *     axis:1+        axis index 1's positive half
 *     axis:1-        axis index 1's negative half
 *     key:ArrowLeft  a keyboard key, by DOM `KeyboardEvent.code`
 *
 * Indices are the ones the Gamepad API reports for that device, which is
 * why they are only ever meaningful next to the device id they were
 * captured on — see `normalizeDevice`.
 *
 * ---- why a keyboard key is in a *controller* profile ---------------------
 *
 * Because on one machine it is the only shape a mapping can take at all.
 * `packages/cli/src/controllers.mjs` measured it: atari800 has no
 * per-button controller mapping — `-kbdjoy0`/`-kbdjoy1` turn the
 * *keyboard* into stick 0 or 1 and `SDL2_JOY_<n>_UP` and friends say which
 * keys, while a real pad's buttons only reach emulated keyboard keys. An
 * Atari stick is a keyboard stick or it is nothing.
 *
 * It lives in `parseBinding` rather than beside it because the question
 * this function answers is not "what does this address on the pad" — it is
 * "what does this control read from", and a key is an answer to that. Three
 * of the callers ask exactly that and nothing more: `answered` (does this
 * control have an answer at all, for the per-machine preview),
 * `resolveDirection` (is this direction bound, or does it fall back to the
 * stick), and the page's binding table (does this row say a name or say
 * *not bound*). A key binding held at arm's length from `parseBinding` is
 * invisible to all three, so a fully bound Atari keyboard stick showed
 * every direction as *missing* on the machine it was written for.
 *
 * The rest of the callers read live state, and they have an answer too: a
 * webview has `keydown` and `keyup`, so `readBinding` reads a held key the
 * same way it reads a held button, the silhouette lights, and `capture`
 * can bind one.
 *
 * The names are `KeyboardEvent.code` — physical positions, not the letters
 * a layout prints — which is what the page captures and what the CLI's
 * `sdlKeycode` turns into the numbers atari800 stores. Same character
 * class as the CLI's own parser, so a name one end writes the other reads.
 *
 * @param {unknown} binding
 * @returns {{ source: 'button'|'axis'|'key', index: number|null, half: '+'|'-'|null, key: string|null }|null}
 *   null for anything unparseable
 */
function parseBinding(binding) {
  if (typeof binding !== 'string') return null;
  const trimmed = binding.trim();
  const key = /^key:([A-Za-z0-9_]+)$/.exec(trimmed);
  if (key) return { source: 'key', index: null, half: null, key: key[1] };
  const match = /^(button|axis):(\d+)([+-]?)$/.exec(trimmed);
  if (!match) return null;
  // A button has no halves: `button:3-` is not a tighter way of saying
  // something, it is a typo, and reading it as `button:3` would hide it.
  // The CLI's parser makes the same call, deliberately.
  if (match[1] === 'button' && match[3] !== '') return null;
  return {
    source: match[1] === 'button' ? 'button' : 'axis',
    index: Number(match[2]),
    half: match[3] === '' ? null : /** @type {'+'|'-'} */ (match[3]),
    key: null,
  };
}

/**
 * Whether a binding names a keyboard key rather than anything on a gamepad.
 *
 * A view of `parseBinding`, not a second parser: the two disagreeing about
 * what `key:Arrow Left` is would be the kind of bug that only shows up in
 * a file somebody hand-edited. Kept as a name of its own because "is this
 * the keyboard" is a question three places ask — the live view groups keys
 * apart from pad inputs, the mapper says which it is about to bind, and
 * the per-machine preview notes that a keyboard stick reaches exactly one
 * of the nine emulators.
 *
 * @param {unknown} binding
 * @returns {boolean}
 */
function isKeyBinding(binding) {
  return parseBinding(binding)?.source === 'key';
}

/** The string form of what `parseBinding` returns — the two are inverses. */
function formatBinding({ source, index, half = null, key = null }) {
  if (source === 'key') return `key:${key}`;
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
 * A key reads from `state.keys`, the codes the page currently has held —
 * a webview gets `keydown` and `keyup`, so a `key:` binding is as live as
 * any other and lights the same shapes. Accepted as a Set or as an array,
 * because a Set is what the page keeps and an array is what a test writes.
 *
 * @param {string} binding
 * @param {{ buttons?: Array<number|{value?: number, pressed?: boolean}>, axes?: number[],
 *           keys?: Set<string>|string[] }} state
 * @returns {number} 0 when the binding addresses something this device does not have
 */
function readBinding(binding, state) {
  const parsed = parseBinding(binding);
  if (!parsed) return 0;
  if (parsed.source === 'key') return heldKeys(state).includes(parsed.key) ? 1 : 0;
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

/** The keys a state says are held, however the caller spells them. */
function heldKeys(state) {
  const keys = state?.keys;
  if (!keys) return [];
  return Array.isArray(keys) ? keys : [...keys];
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
  // A key is down or it is not; a button may be analogue; a half-axis is
  // travel, and travel is measured against the stick's own deadzone.
  if (parsed.source === 'key') return value === 1;
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
// `input.joysticks`, `input.pads`, `input.controls`, `input.keyboard`,
// `input.mouse` and `input.paddles` (packages/compiler/src/fold/facts.mjs)
// are what say how many ports of what sort a machine has and what the
// thing in one of them carries — including where a fitted option changes
// the answer, which is why `project()` takes a *resolved* sheet
// (hardwareCatalog.cjs's `effectiveFacts`) rather than a machine's stock
// one: `packages/atari8/package.json` raises `input.joysticks` to 4 for a
// multiplexer, and the C64's port options both flip `input.mouse` and
// decide whether there is a stick to read at all.
//
// This module used to carry two tables of its own here, named in the
// branch report as the thing to delete: one saying what each kind of port
// device carries ("a joystick is four switches and a fire button"), one
// saying which pad each machine's controller ports take. They existed
// because the toolchain published port *counts* and nothing about what was
// in a port. It does now: every machine package's catalog declares
// `input.controls`, the logical controls its controller actually carries,
// and the shapes that have a name ride beside that fact's own description
// in `8bs targets --json`'s `facts` array. So both tables are gone, and
// this file is back to the rule hardwareCatalog.cjs states next door — it
// asks the toolchain and shows the answer.

/**
 * The name for a shape of controller, from the table the toolchain
 * publishes: `atari-stick`, `nes-pad`, `snes-pad`, `xbox-style`.
 *
 * The kind is *derived*, here and in the CLI, from the one list the
 * machine declares — never stored beside it, because a name and the shape
 * it names are two statements that can disagree, and only one of them can
 * be checked. Matching is exact set equality, so a machine added tomorrow
 * whose controller happens to be an Atari stick is recognised as one with
 * nothing changed at either end, and a shape matching nothing is `null`
 * rather than the nearest guess.
 *
 * `kinds` is `facts.find((f) => f.key === 'input.controls').kinds` out of
 * `8bs targets --json` — controllerView.cjs hands it in. It is not on a
 * machine's sheet because it is not about a machine: it is the vocabulary,
 * the same for all nine. A toolchain too old to publish it yields `null`,
 * and `projectionNote` below says what is missing rather than drawing a
 * machine with ports and no controls on it.
 *
 * @param {string[]} controls
 * @param {{ kind: string, controls: string[] }[]} [kinds]
 * @returns {string|null}
 */
function controllerKind(controls, kinds) {
  if (!Array.isArray(controls) || controls.length === 0 || !Array.isArray(kinds)) return null;
  const have = new Set(controls);
  const match = kinds.find((entry) => Array.isArray(entry?.controls)
    && entry.controls.length === have.size
    && entry.controls.every((control) => have.has(control)));
  return match?.kind ?? null;
}

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
 * @param {{ primaryPort?: number|null, kinds?: object[] }} [catalog] what
 *   the toolchain says beyond this machine's facts, out of
 *   `8bs targets --json`: which port the first player is read from, and
 *   the controller shapes that have a name — the `input.controls` fact's
 *   own `kinds` table, which is the vocabulary rather than a machine's
 *   answer and so is not on any machine's sheet
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
  const ports = pads > 0 ? pads : joysticks;
  // What the thing in the port carries, straight off the resolved sheet.
  // A Commodore declares this on the `joystick` *value* of a control port
  // rather than on the machine, so unplugging the stick really does empty
  // it — which is the truth about that machine as fitted, and is why the
  // preview resolves facts per target instead of reading a stock sheet.
  const controls = Array.isArray(facts?.['input.controls']) ? facts['input.controls'] : [];
  const kind = controllerKind(controls, catalog?.kinds);
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
    note: projectionNote(target, controls, ports, pads, joysticks, facts),
  };
}

/** Why a machine shows nothing, or shows less than its ports suggest. */
function projectionNote(target, controls, ports, pads, joysticks, facts) {
  // Ports, and nothing said about what is in them. Either every port is
  // genuinely empty — on a Commodore that is one `--hardware port1=none`
  // away, and the panel should say so rather than draw a machine with no
  // controls — or the catalog does not declare `input.controls` at all,
  // which is an older `@8bitscript/cli` in this project. One sentence
  // covers both, because from here they are the same silence.
  if (ports > 0 && controls.length === 0) {
    return `The toolchain says ${target} has ${ports} control port(s) but nothing about what is in them, so nothing can be projected onto them.`;
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
 * Keys for a whole connected list, with identical pads told apart.
 *
 * Two 8BitDo SN30 Pros report byte-identical `id` strings — which is the
 * ordinary two-player setup, not an edge case — so `deviceKey` alone
 * would give them one key, one profile and one player between them. The
 * second and later get `#2`, `#3` … by their position in the list.
 *
 * The honest cost, and it is worth saying out loud: which of two identical
 * pads is `#1` depends on the order the browser enumerates them, which is
 * roughly the order they were plugged in. Swap the cables and the two
 * profiles swap with them. There is nothing better available — the Gamepad
 * API exposes no serial number, and `Gamepad.index` is the same
 * plug-ordered number wearing a different hat — and mapping only one of
 * two identical pads is worse than a profile that can be swapped back by
 * changing one `player` in the file.
 *
 * Both ends must agree, so both call this on the same ordered list: the
 * page to find the device it has selected, the extension to store it.
 *
 * @param {string[]} ids the connected pads' `Gamepad.id` strings, in order
 * @returns {string[]} one key each, in the same order
 */
function deviceKeys(ids) {
  const seen = new Map();
  return (ids ?? []).map((raw) => {
    const base = deviceKey(raw);
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    return nth === 1 ? base : `${base}#${nth}`;
  });
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
  // `key` when the caller disambiguated a list (deviceKeys), the bare key
  // otherwise — a caller with one pad in hand has nothing to disambiguate
  // against.
  const key = typeof detected?.key === 'string' && detected.key !== ''
    ? detected.key
    : deviceKey(detected?.id);
  const nth = /#(\d+)$/.exec(key);
  return normalizeDevice({
    id: key,
    // Named so two of the same pad are not two identical rows.
    name: `${String(detected?.id ?? 'Unknown controller')}${nth ? ` #${nth[1]}` : ''}`,
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
    // A key is not on the device, so there is no count to be within. The
    // standard layout has none today; this is here so it stays true if one
    // is ever added rather than silently dropping it on an index compare.
    if (parsed.source === 'key') { result[control] = binding; continue; }
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
 * @param {{ buttons?: Array<number|object>, axes?: number[], keys?: Set<string>|string[] }} state
 * @returns {{ buttons: number[], axes: Array<{ index: number, value: number }>, keys: string[] }}
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
  // Held keys ride along: a `key:` binding is a real binding here, so a
  // live view that left them out would show a control lighting with
  // nothing on the page to explain why.
  return { buttons, axes, keys: heldKeys(state) };
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
 * whole travel. Buttons and keys are both excluded then: binding
 * `leftStickX` to a shoulder or to `KeyA` would give a stick with two
 * positions.
 *
 * A held key can be captured, which is what makes an Atari keyboard stick
 * reachable from the panel rather than only by hand — atari800 takes a
 * mapping in no other shape. Escape is never captured: it is what cancels
 * the walkthrough, and a walkthrough that bound its own way out would be
 * unusable. Somebody who really wants Escape can write `key:Escape` in the
 * file, which now round-trips.
 *
 * @param {{ buttons?: Array<number|object>, axes?: number[], keys?: Set<string>|string[] }} state
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
    // After the buttons, so a pad a person is holding wins over a key they
    // happen to be leaning on; both read 1, and the tie rule below is
    // "strictly greater".
    for (const code of heldKeys(state)) {
      if (code !== CANCEL_KEY && strength < 1) {
        best = `key:${code}`;
        strength = 1;
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
// Nothing to do, and that is the finished state rather than a gap.
//
// `packages/cli/src/controllers.mjs` reads `8bitscript.controllers.json`
// itself — `controllerPlayers()` takes the very object `controllerStore.cjs`
// writes, keeps the same eighteen control names, and parses the same four
// binding shapes (its own `parseBinding` rejects `button:3-` as a typo for
// the same reason this one does). From there it is that file's business to
// turn a player into `-joydev`, a `.vjm`, an `SDL2_JOY_<n>_UP` or a named
// refusal.
//
// The host joystick number is **the player number minus one**, and it is
// deliberately not in this file: a device is identified here by its
// Gamepad API id string, which is a browser's name for it and has no
// relationship to the index SDL hands an emulator. They are different
// subsystems enumerating the same USB devices, and matching them by name
// would be a guess that fails silently. So player order is the contract,
// and the pads should be plugged in in player order.
//
// An earlier version of this module emitted a `controllers.players` block
// for 8bitscript.config.ts, because that is where the CLI first read a
// profile from. It reads this file now, so that block is gone: a panel
// offering somebody a snippet to paste into a config nothing consults
// would be exactly the kind of quiet trap the two ends have spent this
// branch closing.

module.exports = {
  CANCEL_KEY,
  CONTROL_KINDS,
  CONTROL_LABELS,
  DEADZONE,
  LOGICAL_CONTROLS,
  MAX_PLAYERS,
  MODES,
  PRESS_THRESHOLD,
  PRIMARY_PORT,
  PROFILE_VERSION,
  STANDARD_MAPPING,
  WALKTHROUGH,
  activeInputs,
  capture,
  controllerKind,
  deviceFromDetected,
  deviceKey,
  deviceKeys,
  emptyProfile,
  formatBinding,
  isKeyBinding,
  normalizeDevice,
  normalizeProfile,
  parseBinding,
  pressed,
  project,
  readBinding,
  resolveDirection,
  withDevice,
  withoutDevice,
};
