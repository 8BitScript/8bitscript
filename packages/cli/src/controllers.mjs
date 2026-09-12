// Controller profiles → what each emulator actually takes at launch.
//
// A project says, once, which physical control drives which logical
// control — `a` is button 0, `left` is the negative half of the first
// stick axis — and every emulator this CLI launches gets that same
// profile in whatever shape it will accept: command-line flags for some,
// a generated temp file for others, and for two of them, nothing at all.
// The profile is normalized (the same eighteen names everywhere, the list
// docs/project/input.md calls "width"), so the editor's Controller Setup
// panel writes one thing and nine machines read it.
//
// The file is `8bitscript.controllers.json`, written by that panel
// (editors/vscode/src/controllerStore.cjs) and read by controllerPlayers()
// below. The binding grammar — `button:0`, `axis:1-` — is the panel's, and
// its parseBinding and this one are deliberately inverses: two spellings
// of the same mapping is how a binding comes to mean one thing at one end
// and another at the other.
//
// This file is deliberately all pure functions. Each adapter takes the
// profile and returns the arguments and file *contents* it implies;
// run.mjs does every read and write. That is what lets the tests assert on
// argument vectors without starting an emulator — which matters more here
// than anywhere else in the CLI, because `8bs run <target>` with no
// --screenshot opens a GUI and waits for a human, and a test that launches
// one does not time out, it hangs.
//
// ---------------------------------------------------------------------
// What each emulator can actually do, measured 2026-09-12 against the
// binaries on this machine (VICE 3.10 GTK3, atari800 SDL2, FCEUX 2.6.6
// Qt, x16emu, Xemu/xmega65). Every claim below is from that emulator's
// own `-help`/`--help` output or from a bounded probe run, never from
// memory — the flag names differ more than they look like they should.
//
// VICE (xvic/x64sc/x128/xpet) — the most scriptable of the eight.
//   `-joydev<port> <0-9>` picks which *host* device drives an emulated
//   port: "0: None, 1: Numpad, 2: Keyset 1, 3: Keyset 2, 4: Analog
//   joystick 0 ... 9: Analog joystick 5". That is the whole of what the
//   command line says about controllers. Which *device is plugged into*
//   the port — a joystick, paddles, a 1351 mouse — is
//   `-controlport<n>device`, and the machine catalogs already emit that
//   (packages/c64, packages/c128, packages/vic20 all carry port1/port2
//   options whose `run` lists say `-controlport1device 1`). Nothing here
//   emits a -controlportNdevice flag: that is the catalog's sentence to
//   say, and saying it twice would be two answers to one question. These
//   arguments go *after* `hardware.run[emulator]` for the same reason —
//   with one exception, `-config`, which VICE only honours as the first
//   argument on the line and which therefore travels as `leadingArgs`.
//   The measurement is beside that field, in viceController().
//
//   Per-button mapping is a file, and it works: VICE's `JoyMapFile`
//   resource names a .vjm joystick map, and the format is documented in
//   the binary itself ("# VICE joystick mapping file / # File format: /
//   # - normal line has 'joynum inputtype inputindex action'"). The
//   resource has no command-line form, but `-config <file>` does, so the
//   map is reached through a generated vicerc. Probed 2026-09-12 with
//   `x64sc -config /tmp/probe.vicerc -verbose -limitcycles 100000`
//   (bounded exit — no window to close): with the resource written
//   section-less VICE logged "Failed to open
//   `~/.config/vice/gtk3-joymap-C64SC.vjm'", i.e. it never saw it; under
//   a `[C64SC]` header it logged "Loading joystick map `/tmp/probe.vjm'"
//   and then parsed the file. The section names are the emulator's own —
//   `[C64SC]`, `[VIC20]`, `[C128]`, `[PET]`, each confirmed by the same
//   probe against its own binary.
//
//   What VICE cannot take from here: per-key *keyboard* joystick
//   assignments. `-keyset`/`+keyset` only enable the keysets; the
//   assignments themselves are the KeySet1North/KeySet1Fire/... resources
//   (confirmed by `strings x64sc`), which have no command-line form, and
//   whose values are the UI toolkit's key codes — GDK keyvals in this
//   GTK3 build, SDL keycodes in an SDL build, so a file written for one
//   is wrong for the other. A keyboard-driven player therefore gets
//   `-joydev<n> 1`, VICE's own built-in numpad joystick, and a note
//   saying so by name rather than a silent substitution.
//
// atari800 — a joystick map, but only for the keyboard.
//   `-kbdjoy0`/`-kbdjoy1` (and `-no-kbdjoy0`/`-no-kbdjoy1`) turn the
//   keyboard into stick 0 or stick 1; there is no -kbdjoy2/3, so a 400 or
//   800's third and fourth ports cannot be keyboard-driven. `-joy0hat`..
//   `-joy3hat` make a real pad's hat the directions, and `-nojoystick`
//   turns the lot off. Which keys those keyboard sticks read is not a
//   flag: they are `SDL2_JOY_<n>_UP/DOWN/LEFT/RIGHT/TRIGGER` in the
//   config file, and `-config <file>` takes one. run.mjs already writes a
//   per-process copy of ~/.atari800.cfg for the CRT knobs, so the
//   controller keys join that same file rather than opening a second one
//   — atari800 takes one -config.
//
//   What atari800 cannot take: a real pad's button numbers. It binds SDL
//   joystick <n> to port <n> itself, and `SDL2_JOY_<n>_BUTTON_KEYS` maps
//   pad buttons to *emulated keyboard* keys, not to stick directions.
//   And an Atari stick has exactly one trigger, so every named button
//   past `a` is a named refusal rather than a mapping.
//
// fceux — nothing. This is the honest answer, not a gap in the research.
//   `fceux --help` offers `--input(1,2) <device>` (gamepad, zapper,
//   powerpad.0/1, arkanoid), `--input(3,4)` for Famicom expansion
//   devices, and `--fourscore {0|1}`. That is which *device* is in each
//   port and nothing about which button is which. Every actual binding
//   lives in ~/.fceux/fceux.cfg as `SDL.Input.GamePad.<n>.*` (182
//   SDL.Input lines in this machine's own config) plus named profiles
//   under ~/.fceux/input/, both chosen from the Qt GUI. There is no
//   `-config <file>`; the only config flag is `--no-config {0|1}`, which
//   suppresses saving. FCEUX_HOME exists in the binary's strings and
//   would move the whole ~/.fceux tree, which is a different and much
//   larger thing than passing a mapping. So: fceux gets its port devices
//   and a note naming what it cannot take.
//
// x16emu — `-joy1`..`-joy4` "Enable binding a gamepad to SNES controller
//   port N", and that is all. No remapping; the pad's buttons are bound
//   by SDL's own game-controller database. `-keymap` is a *Commodore
//   keyboard layout* ("Enable a specific keyboard layout decode table"),
//   not a controller map — an easy and expensive thing to confuse.
//
// xmega65 (Xemu) — `-joyport (int-num) Default joystick port to emulate
//   (1 or 2)` and `-curskeyjoy (bool) Cursor keys as joystick`. One
//   emulated port at a time, no per-control mapping. Its `-keymap (str)
//   Set keymap configuration file to be used` is, again, a keyboard
//   layout.
//
// xpet — the PET has no control ports. VICE gives xpet only
//   `-controlport3device`..`-controlport10device` ("Joystick adapter port
//   1..8") and `-extrajoydev1`..`-extrajoydev8`; there is no
//   -controlport1device and no -joydev1, because a PET joystick was an
//   aftermarket user-port board. The catalog agrees (packages/pet has no
//   port option and its sheet says `input.joysticks: 0`), so a profile
//   aimed at a PET is refused by name here rather than handed flags the
//   emulator would take and the machine would not have.
//
// web — the browser runtime's input is one byte of six edge bits
//   (web-runtime.mjs's INPUT_OFFSET / InputEdge), written by keydown and
//   read by @8bitscript/web/input. There is nothing to configure at
//   launch and nowhere for a named button past confirm/cancel to land
//   yet; docs/project/input.md's note that the web sheet's `pads: 0` is
//   "wrong in spirit" is the work that has to happen first, and it is in
//   packages/web, not here.
// ---------------------------------------------------------------------

/**
 * The eighteen logical controls, in the order docs/project/input.md and
 * the editor's Controller Setup panel list them. The first eight are the
 * ones a machine can plausibly wire to a digital pin; the last six are
 * analog and only reach a target that has somewhere analog to put them.
 */
export const DIGITAL_CONTROLS = [
  'up', 'down', 'left', 'right',
  'a', 'b', 'x', 'y',
  'l', 'r', 'start', 'select',
];
export const ANALOG_CONTROLS = [
  'leftStickX', 'leftStickY', 'rightStickX', 'rightStickY', 'lt', 'rt',
];
export const CONTROLS = [...DIGITAL_CONTROLS, ...ANALOG_CONTROLS];

/**
 * One binding, in the grammar the editor's Controller Setup panel writes
 * (`editors/vscode/src/controllerProfile.cjs`, whose `parseBinding` is the
 * other half of this one):
 *
 *   button:0       button 0 of the device this mapping belongs to
 *   axis:1-        the negative half of its second axis
 *   axis:1         the whole axis (analogue; no digital half)
 *   key:ArrowLeft  a keyboard key, by DOM KeyboardEvent.code
 *
 * The indices are the Gamepad API's for that device, which is why they
 * only mean anything beside the device they were captured on — there is
 * no pad number *inside* a binding, because a device's mapping is already
 * that device's. The host joystick number the emulators want comes from
 * the player the device is assigned to; see controllerPlayers().
 *
 * `key:` is this end's own extension and the panel does not yet write it.
 * It is here because it is the only shape atari800 will take a mapping in
 * at all (its `SDL2_JOY_<n>_UP` keys), so a hand-written controllers file
 * can drive an Atari today; the panel needs one more alternative in its
 * own regex before it can. Named in this branch's report rather than left
 * to be discovered.
 *
 * A button has no halves: `button:3-` is a typo, not a tighter way of
 * saying `button:3`, and reading it as one would hide it — the same call
 * the panel makes.
 *
 * @param {unknown} text
 * @returns {{ kind: 'button'|'axis'|'key', index?: number, sign?: '+'|'-'|null, key?: string } | null}
 */
export function parseBinding(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const key = /^key:([A-Za-z0-9_]+)$/.exec(trimmed);
  if (key) return { kind: 'key', key: key[1] };
  const match = /^(button|axis):(\d+)([+-]?)$/.exec(trimmed);
  if (!match) return null;
  if (match[1] === 'button' && match[3] !== '') return null;
  if (match[1] === 'button') return { kind: 'button', index: Number(match[2]) };
  return { kind: 'axis', index: Number(match[2]), sign: match[3] === '' ? null : match[3] };
}

/** Which host device a binding reads — the player's pad, or the keyboard. */
export function bindingDevice(binding) {
  return binding.kind === 'key' ? 'keyboard' : 'pad';
}

/** The file the editor's Controller Setup panel writes, beside 8bitscript.config.ts. */
export const CONTROLLERS_FILE = '8bitscript.controllers.json';

/** VICE reaches six host gamepads and fceux four pads; four players is the panel's own ceiling. */
export const MAX_PLAYERS = 4;

/**
 * The players a controllers file describes, in player order.
 *
 * The file is `8bitscript.controllers.json` and its shape is the editor's
 * (`editors/vscode/src/controllerStore.cjs` writes it,
 * `controllerProfile.cjs` normalizes it):
 *
 *     {
 *       "version": 1,
 *       "controllers": {
 *         "devices": [
 *           { "id": "...", "name": "8BitDo SN30 Pro", "player": 1,
 *             "mode": "standard",
 *             "mapping": { "up": "button:12", "a": "button:0" } }
 *         ]
 *       }
 *     }
 *
 * It is JSON and not a `controllers` block in 8bitscript.config.ts on the
 * editor's argument, which is a good one: the config is *source* a person
 * reads and a TypeScript rewriter edits, while this is eighteen
 * machine-generated bindings per device rewritten every time a button is
 * pressed in a walkthrough. It is also not knowledge the compiler needs —
 * which pad is Player 1 changes nothing that is built, only how an
 * emulator is launched.
 *
 * A device with `player: 0` is one the panel has seen and nobody has
 * assigned, and is skipped rather than being made player 1 — "plugged in"
 * and "playing" are different facts, and the file distinguishes them.
 *
 * **The host joystick number is the player number minus one.** Nothing in
 * the file carries one: a device is identified by its Gamepad API id
 * string, which is a browser's name for it and has no relationship to the
 * index SDL will hand the emulator — they are different subsystems
 * enumerating the same USB devices, and matching them by name would be a
 * guess that fails silently. Player order is the one mapping that is both
 * predictable and explainable: player 1 drives host joystick 0, player 2
 * host joystick 1. It is what VICE's `-joydev<n> 4` ("Analog joystick 0")
 * and the .vjm's `joynum` column both get, and it is why the pads should
 * be plugged in in player order.
 *
 * Anything unreadable reads as unbound rather than as an error, matching
 * what the panel does with the same file — it is hand-editable on purpose,
 * and a typo should cost one binding, not the launch. A file whose *shape*
 * is wrong is a different thing and is named.
 *
 * @param {unknown} stored the parsed 8bitscript.controllers.json
 * @returns {{ ok: true, players: Player[] } | { ok: false, error: string }}
 *
 * @typedef {{ player: number, pad: number, name: string, controls: Record<string, object> }} Player
 *   `controls` holds parsed bindings keyed by control name, with unbound
 *   controls absent rather than null, so `Object.entries` is the list of
 *   things this player actually asked for.
 */
export function controllerPlayers(stored) {
  if (stored === undefined || stored === null) return { ok: true, players: [] };
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    return { ok: false, error: `${CONTROLLERS_FILE} must be an object with a \`controllers.devices\` list` };
  }
  const devices = stored.controllers?.devices;
  if (devices === undefined) return { ok: true, players: [] };
  if (!Array.isArray(devices)) {
    return { ok: false, error: `${CONTROLLERS_FILE}: \`controllers.devices\` must be a list, one entry per device` };
  }
  const players = [];
  const claimed = new Map();
  for (const device of devices) {
    if (!device || typeof device !== 'object') continue;
    const number = device.player;
    if (!Number.isInteger(number) || number < 1) continue; // 0 and junk alike: not assigned to anyone.
    if (number > MAX_PLAYERS) {
      return { ok: false, error: `${CONTROLLERS_FILE}: '${device.name ?? device.id}' is player ${number}; there are ${MAX_PLAYERS} players at most` };
    }
    // The panel takes a player number off whichever device had it, so a
    // file with two devices on one player has been hand-edited into a
    // state the panel cannot show. Which of the two drives the port is
    // not a question this can answer, so it asks.
    if (claimed.has(number)) {
      return {
        ok: false,
        error: `${CONTROLLERS_FILE}: '${claimed.get(number)}' and '${device.name ?? device.id}' are both player ${number}`,
      };
    }
    claimed.set(number, device.name ?? device.id);
    const controls = {};
    for (const control of CONTROLS) {
      const binding = parseBinding(device.mapping?.[control]);
      if (binding) controls[control] = binding;
    }
    players.push({ player: number, pad: number - 1, name: device.name ?? device.id ?? `player ${number}`, controls });
  }
  players.sort((a, b) => a.player - b.player);
  return { ok: true, players };
}

/**
 * The emulated port a player drives when the profile does not say.
 *
 * The Commodore convention is not "player 1 is port 1": a C64 or C128
 * game reads port 2, because port 1 shares its lines with the keyboard
 * matrix and a stick left in it types. The catalogs already encode that —
 * packages/c64 and packages/c128 both default `port1: none, port2:
 * joystick` — so player 1 defaulting to port 2 is what makes an unedited
 * profile work on a stock machine instead of aiming `-joydev1` at a port
 * with nothing plugged into it. The VIC-20 has one port and it is port 1;
 * everything else counts players and ports together from 1.
 *
 * The MEGA65 is here on packages/mega65/AGENTS.md's word — "Joysticks are
 * CIA1 ports as on the C64 ($DC00/$DC01 low bits, with $D612.5 able to
 * swap them)" — the same wiring, so the same convention. That swap bit
 * means a program can change it at run time, which is why this is a
 * default and not a rule.
 *
 * The editor's Controller Setup panel carries its own copy of this table
 * (controllerProfile.cjs's PRIMARY_PORT) with a comment saying it should
 * not have to: `8bs targets --json` now publishes `primaryPort` per
 * machine, from here, so the panel can read it instead.
 *
 * @param {string} machine
 * @param {number} player 1-based
 * @returns {number} 1-based emulated port
 */
export const PRIMARY_PORT = { c64: 2, c128: 2, mega65: 2 };

export function defaultPort(machine, player) {
  const primary = PRIMARY_PORT[machine] ?? 1;
  if (primary === 1) return player;
  // Player 1 takes the primary port; everyone after fills the rest in
  // order, skipping the one already taken.
  if (player === 1) return primary;
  return player <= primary ? player - 1 : player;
}

/**
 * SDL2 keycodes for the DOM `KeyboardEvent.code` names a setup panel
 * captures — what atari800 writes in `SDL2_JOY_<n>_UP` and friends.
 *
 * The rule is SDL's own, and it is checkable against a config atari800
 * wrote itself: a printable key is its ASCII codepoint, and everything
 * else is `(1 << 30) | scancode`. This machine's ~/.atari800.cfg has
 * `SDL2_JOY_1_LEFT=97` / `_RIGHT=100` / `_UP=119` / `_DOWN=115`, which is
 * a/d/w/s, and `SDL2_JOY_0_LEFT=1073741916` / `_RIGHT=1073741918` /
 * `_UP=1073741920` / `_DOWN=1073741917`, which are 1073741824 + 92/94/96/93
 * — SDL_SCANCODE_KP_4/KP_6/KP_8/KP_5, the numeric keypad's arrows. Its
 * two triggers are 1073742052 and 1073742048, i.e. scancodes 228 and 224,
 * SDL_SCANCODE_RCTRL and _LCTRL. So the table below holds scancodes only,
 * and the codepoint arithmetic is done once, here.
 */
const SDL_SCANCODE = {
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44,
  NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88,
  Numpad1: 89, Numpad2: 90, Numpad3: 91, Numpad4: 92, Numpad5: 93,
  Numpad6: 94, Numpad7: 95, Numpad8: 96, Numpad9: 97, Numpad0: 98, NumpadDecimal: 99,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
  ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
};
const SDL_SCANCODE_MASK = 1 << 30;

/**
 * The SDL2 keycode for a `KeyboardEvent.code`, or null for a key this
 * table does not name. Letters and digits are their own ASCII codes —
 * lowercase, which is what SDL reports and what atari800 stores.
 *
 * @param {string} code
 * @returns {number|null}
 */
export function sdlKeycode(code) {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase().charCodeAt(0);
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1].charCodeAt(0);
  const scancode = SDL_SCANCODE[code];
  return scancode === undefined ? null : SDL_SCANCODE_MASK | scancode;
}

/** `a, b and c` — a list said the way a sentence says it, as run.mjs's listOf does. */
function listOf(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The controls a player bound that an adapter has nowhere to put, as one
 * note naming every one of them. The repo's standing rule is that what a
 * machine cannot do is refused *by name* — "start, select and both
 * sticks" is a sentence someone can act on, a silent drop is a bug report
 * three weeks later.
 *
 * @returns {string[]} zero or one note
 */
function unmappedNote(emulator, player, controls, why) {
  if (controls.length === 0) return [];
  return [`${emulator}: player ${player}'s ${listOf(controls)} ${controls.length === 1 ? 'has' : 'have'} nowhere to go — ${why}`];
}

// ---------------------------------------------------------------------
// VICE: xvic, x64sc, x128 (and xpet, which is refused — see below).
// ---------------------------------------------------------------------

/** The vicerc section each VICE emulator reads its own resources from — probed, see the header. */
export const VICE_SECTION = { xvic: 'VIC20', x64sc: 'C64SC', x128: 'C128', xpet: 'PET' };

/**
 * The Commodore control port's pins, as VICE's own .vjm header names
 * them: "1 pin  joystick (pin: 1/2/4/8/16/32/64 = u/d/l/r/fire/fire2/fire3)".
 *
 * A real 9-pin Commodore stick has one fire button, and a plain
 * `Joystick` joyport device reads only pin 16. fire2/fire3 exist for the
 * multi-button joyport devices in VICE's -controlportNdevice list, so `b`
 * and `x` are mapped rather than refused, but the note below says which
 * of the three the catalog's own device will actually see.
 */
const VICE_PIN = { up: 1, down: 2, left: 4, right: 8, a: 16, b: 32, x: 64 };

/**
 * `-joydev<n>` values, from `x64sc -help`: "0: None, 1: Numpad, 2: Keyset
 * 1, 3: Keyset 2, 4: Analog joystick 0 ... 9: Analog joystick 5".
 */
const VICE_JOYDEV_NUMPAD = 1;
const VICE_JOYDEV_ANALOG_0 = 4;
const VICE_ANALOG_JOYSTICKS = 6;

/** How many emulated ports `-joydev<n>` reaches on each VICE machine — from each binary's own -help. */
const VICE_JOYDEV_PORTS = { vic20: 1, c64: 2, c128: 2, pet: 0 };

/**
 * One .vjm line per pad binding: `joynum inputtype inputindex action
 * [params]`, with inputtype 0=axis, 1=button, 2=hat and action `1 <pin>`
 * for "joystick pin". The index arithmetic is the file format's, quoted
 * in each branch, because none of it is guessable:
 *
 *   buttons  inputindex is the zero-based button index
 *   axes     "axis 0 has inputindex 0,1 respectively for positive and
 *            negative, axis 1 has 2,3 etc."
 *
 * VICE's third input type, the hat, has no branch because no binding can
 * ask for one: the Gamepad API's standard mapping reports a D-pad as
 * buttons 12-15, so that is what the panel captures and what arrives here.
 * (The format's own hat indices stride by five — "hat 0 has inputindex
 * 0,1,2,3 ... Hat 1 has 5,6,7,8 etc." — which is noted because it is
 * exactly the sort of thing a later hat branch would assume wrongly.)
 *
 * @param {number} joynum the host joystick, from the player's number
 */
function vjmLine(joynum, binding, pin) {
  if (binding.kind === 'button') return `${joynum} 1 ${binding.index} 1 ${pin}`;
  // Only half an axis is a digital direction; a whole axis has no pin.
  if (binding.kind === 'axis' && binding.sign) {
    return `${joynum} 0 ${binding.index * 2 + (binding.sign === '+' ? 0 : 1)} 1 ${pin}`;
  }
  return null;
}

/**
 * xvic / x64sc / x128.
 *
 * @param {string} machine
 * @param {Player[]} players
 * @param {{ emulator: string, hardware: object, joymapPath: string,
 *           vicercPath: string, baseVicerc?: string }} context
 * @returns {{ ok: true, args: string[], files: {path: string, contents: string}[], notes: string[] }
 *          | { ok: false, error: string }}
 */
export function viceController(machine, players, { emulator, hardware, joymapPath, vicercPath, baseVicerc = '' }) {
  const ports = VICE_JOYDEV_PORTS[machine] ?? 0;
  if (ports === 0) {
    return {
      ok: false,
      error: `the ${machine} has no control ports for a controller profile to drive — `
        + `${emulator} offers only the userport joystick adapter (-controlport3device and up), `
        + 'which this machine\'s catalog does not fit',
    };
  }
  const args = [];
  const notes = [];
  const lines = [];
  for (const player of players) {
    const port = defaultPort(machine, player.player);
    if (port > ports) {
      return {
        ok: false,
        error: `the ${machine} has ${ports === 1 ? 'one control port' : `${ports} control ports`}, `
          + `so there is nowhere for player ${player.player} ('${player.name}') to plug in`,
      };
    }
    // The catalog decides what is *plugged into* the port. Pointing
    // -joydev at a port holding nothing (or a mouse) is the failure mode
    // this check exists for: VICE takes the flag, the emulated machine
    // reads an empty port, and the program looks broken. whatSatisfies()
    // sets the register for the answer — say the change, not just the
    // problem.
    const fitted = hardware?.options?.[`port${port}`];
    if (fitted !== undefined && fitted !== 'joystick') {
      return {
        ok: false,
        error: `the ${machine}'s port ${port} has ${fitted === 'none' ? 'nothing plugged into it' : `a ${fitted} in it`}, `
          + `so player ${player.player} has nothing to drive. Add --hardware port${port}=joystick`,
      };
    }

    const bound = Object.entries(player.controls);
    if (bound.length === 0) continue;
    const devices = [...new Set(bound.map(([, binding]) => bindingDevice(binding)))];
    if (devices.length > 1) {
      return {
        ok: false,
        error: `${emulator} drives one emulated port from one host device (-joydev${port}), but `
          + `player ${player.player} mixes ${listOf(devices)}`,
      };
    }
    const [device] = devices;

    if (device === 'keyboard') {
      // -keyset only enables the keysets; the assignments are resources
      // with no CLI form and a toolkit-specific key encoding. See header.
      args.push(`-joydev${port}`, String(VICE_JOYDEV_NUMPAD));
      const keys = bound.map(([, binding]) => binding.key);
      notes.push(
        `${emulator}: player ${player.player}'s keyboard bindings (${listOf(keys)}) cannot be set from the command line — `
        + 'VICE\'s KeySet1*/KeySet2* assignments are resources with no flag, so this is -joydev'
        + `${port} 1, VICE's own numpad joystick, instead`,
      );
      continue;
    }

    const pad = player.pad;
    if (pad >= VICE_ANALOG_JOYSTICKS) {
      return {
        ok: false,
        error: `${emulator} reaches six host gamepads (-joydev${port} 4-9 are "Analog joystick 0" to "5"); `
          + `player ${player.player} would be host joystick ${pad}`,
      };
    }
    args.push(`-joydev${port}`, String(VICE_JOYDEV_ANALOG_0 + pad));

    const unmapped = [];
    for (const [control, binding] of bound) {
      const pin = VICE_PIN[control];
      if (pin === undefined) {
        // A stick axis is the binding someone reaches for first, because
        // it is what the reference pad's left stick actually is — and a
        // Commodore port has no analog pin for it. It does have four
        // digital directions, and VICE's own map can drive them from the
        // halves of that same axis, so the note says which two lines to
        // write rather than just that this one is wrong.
        if (ANALOG_CONTROLS.includes(control) && binding.kind === 'axis') {
          unmapped.push(
            `${control} (an analog axis — a Commodore port has none; bind the directions to `
            + `axis:${binding.index}- and axis:${binding.index}+ instead)`,
          );
          continue;
        }
        unmapped.push(control);
        continue;
      }
      const line = vjmLine(pad, binding, pin);
      if (line === null) {
        // A whole axis with no sign: analog, and a Commodore port has no
        // analog pin to put it on. Naming the fix is the point.
        unmapped.push(`${control} (a whole axis — bind the halves, axis:${binding.index}- and axis:${binding.index}+)`);
        continue;
      }
      lines.push(line);
    }
    notes.push(...unmappedNote(
      emulator, player.player, unmapped,
      'a Commodore control port has four directions and its fire pins, and nothing else',
    ));
    // fire2/fire3 are real pins, but only the multi-button joyport
    // devices read them; the catalog fits a plain `Joystick`.
    const extraFire = bound.filter(([control]) => control === 'b' || control === 'x').map(([control]) => control);
    if (extraFire.length > 0) {
      notes.push(
        `${emulator}: player ${player.player}'s ${listOf(extraFire)} ${extraFire.length === 1 ? 'is' : 'are'} mapped to `
        + `${extraFire.length === 1 ? 'pin' : 'pins'} fire2/fire3, which a plain Joystick in port ${port} does not read — `
        + 'a one-button Commodore stick sees `a` only',
      );
    }
  }

  const files = [];
  // `-config` is not an ordinary flag: it must come *first* on the
  // command line or it does nothing at all. Measured 2026-09-12 with two
  // otherwise identical bounded runs:
  //
  //   x64sc -config <vicerc> -sidmodel 1 -verbose -limitcycles 100000
  //     → "Joystick: Loading joystick map `...vjm'"
  //   x64sc -sidmodel 1 -config <vicerc> -verbose -limitcycles 100000
  //     → no such line; VICE went on to its default map
  //
  // and with the flag buried mid-argv (where these arguments would
  // naturally land, after hardware.run[emulator]) the emulator logged
  // "Failed to open `~/.config/vice/gtk3-joymap-C64SC.vjm'" — the
  // profile silently doing nothing, which is the exact failure mode this
  // whole file exists to avoid. So it travels separately, and
  // emulatorInvocation() puts it at the head of the vector. Flags *after*
  // -config are still parsed normally, so -joydev and the catalog's own
  // -controlportNdevice are unaffected by leading with it.
  const leadingArgs = [];
  if (lines.length > 0) {
    // `!CLEAR` first: the format's own header says "A joystick map is read
    // in as patch to the current map", so without it VICE's minimal
    // default mapping stays underneath and a button the profile left
    // unbound still fires.
    files.push({
      path: joymapPath,
      contents: [
        '# VICE joystick mapping file',
        '# Written by 8bs run from this project\'s controllers profile. Do not edit.',
        '# joynum inputtype inputindex action [params] — inputtype 0=axis 1=button 2=hat, action `1 pin`.',
        '!CLEAR',
        ...lines,
        '',
      ].join('\n'),
    });
    files.push({ path: vicercPath, contents: setViceResource(baseVicerc, VICE_SECTION[emulator], 'JoyMapFile', `"${joymapPath}"`) });
    leadingArgs.push('-config', vicercPath);
  }
  return { ok: true, args, leadingArgs, files, notes };
}

/**
 * A vicerc with one resource set inside one machine's section, keeping
 * everything the user already had.
 *
 * `-config` does not add to the user's ~/.config/vice/vicerc, it replaces
 * it, so writing a bare two-line file would silently drop every setting
 * they have — window size, keymap, drive paths. This copies theirs and
 * edits one line, the same shape as run.mjs's atari800CleanDisplayConfig
 * and for the same reason. A resource written *outside* a section is not
 * read at all: the probe in this file's header set JoyMapFile with no
 * header and VICE went on looking for its default map.
 *
 * @param {string} base the user's vicerc, or '' when they have none
 * @param {string} section e.g. 'C64SC'
 */
export function setViceResource(base, section, key, value) {
  const text = base === '' ? '' : base.replace(/\n*$/, '\n');
  const header = new RegExp(`^\\[${section}\\]$`, 'm');
  const found = header.exec(text);
  if (!found) return `${text}${text === '' ? '' : '\n'}[${section}]\n${key}=${value}\n`;
  const start = found.index + found[0].length + 1;
  const rest = text.slice(start);
  // The section runs to the next `[Header]` line or the end of the file.
  const next = /^\[[^\]]+\]$/m.exec(rest);
  const end = next ? start + next.index : text.length;
  const body = text.slice(start, end);
  const existing = new RegExp(`^${key}=.*$`, 'm');
  const replaced = existing.test(body) ? body.replace(existing, `${key}=${value}`) : `${key}=${value}\n${body}`;
  return text.slice(0, start) + replaced + text.slice(end);
}

// ---------------------------------------------------------------------
// atari800
// ---------------------------------------------------------------------

/** The four directions and the one trigger an Atari stick has, as config-key suffixes. */
const ATARI_STICK = { up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', a: 'TRIGGER' };

/**
 * Sets one `KEY=value` line in an atari800 config, replacing the key in
 * place if it is there and appending it if it is not. Shared with
 * run.mjs's atari800CleanDisplayConfig so the CRT knobs and the joystick
 * keys are written by one piece of code into one file — atari800 takes a
 * single `-config`.
 *
 * @param {string} text
 * @param {string} key
 * @param {string|number} value
 */
export function setConfigKey(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  return `${text.trimEnd()}\n${key}=${value}\n`.replace(/^\n/, '');
}

/**
 * atari800.
 *
 * @param {string} machine
 * @param {Player[]} players
 * @param {{ emulator: string, hardware: object, configPath: string, baseConfig?: string }} context
 */
export function atari800Controller(machine, players, { emulator, hardware, configPath, baseConfig = '' }) {
  // 400s and 800s have four ports, every XL/XE two — the catalog's
  // `input.joysticks` fact already says which, per model.
  const ports = hardware?.facts?.['input.joysticks'] ?? 2;
  const args = [];
  const notes = [];
  let config = baseConfig;
  let wroteKeys = false;

  for (const player of players) {
    const port = defaultPort(machine, player.player);
    if (port > ports) {
      return {
        ok: false,
        error: `this Atari has ${ports} joystick ports, `
          + `so there is nowhere for player ${player.player} ('${player.name}') to plug in. `
          + 'The four-port machines are --profile 400 and --profile 800',
      };
    }
    const bound = Object.entries(player.controls);
    if (bound.length === 0) continue;
    const stick = port - 1; // atari800 counts sticks from 0; our ports from 1.
    const devices = [...new Set(bound.map(([, binding]) => bindingDevice(binding)))];
    if (devices.length > 1) {
      return {
        ok: false,
        error: `${emulator} drives one stick from one host device; player ${player.player} mixes ${listOf(devices)}`,
      };
    }
    const [device] = devices;

    if (device === 'keyboard') {
      if (stick > 1) {
        return {
          ok: false,
          error: `${emulator} has -kbdjoy0 and -kbdjoy1 and no more, so stick ${stick} cannot be keyboard-driven; `
            + `move player ${player.player} to port 1 or 2`,
        };
      }
      args.push(`-kbdjoy${stick}`);
      const unmapped = [];
      for (const [control, binding] of bound) {
        const suffix = ATARI_STICK[control];
        if (suffix === undefined) {
          unmapped.push(control);
          continue;
        }
        const keycode = sdlKeycode(binding.key);
        if (keycode === null) {
          return {
            ok: false,
            error: `${emulator}: '${binding.key}' is not a key name this CLI can turn into an SDL keycode `
              + `(player ${player.player}'s ${control}). Use a DOM KeyboardEvent.code such as ArrowUp, KeyZ or Numpad5`,
          };
        }
        config = setConfigKey(config, `SDL2_JOY_${stick}_${suffix}`, keycode);
        wroteKeys = true;
      }
      notes.push(...unmappedNote(
        emulator, player.player, unmapped,
        'an Atari stick has four directions and one trigger',
      ));
      continue;
    }

    // A real pad. atari800 binds SDL joystick <n> to stick <n> itself and
    // has no flag or config key that moves a pad *button* onto the
    // trigger — SDL2_JOY_<n>_BUTTON_KEYS maps buttons onto emulated
    // keyboard keys, which is a different thing. So the one thing worth
    // saying is that the keyboard is *not* also driving this stick: the
    // config file may still hold keys from an earlier profile, and both
    // would be live at once. The rest is named.
    //
    // `-joy<n>hat` is deliberately not emitted. It says whether SDL sees
    // the pad's D-pad as a hat, which is a fact about the host device and
    // its driver; the profile records what the *Gamepad API* reported,
    // where a standard-mapping D-pad is buttons 12-15 and no hat exists.
    // Passing it would be guessing at the other subsystem's view of the
    // same plastic.
    if (stick <= 1) args.push(`-no-kbdjoy${stick}`);
    notes.push(
      `${emulator}: player ${player.player}'s pad bindings are not settable from the command line — atari800 wires `
      + `SDL joystick ${stick} to stick ${stick} itself and has no per-button map (SDL2_JOY_${stick}_BUTTON_KEYS binds `
      + `buttons to emulated *keys*). Plug '${player.name}' in as host joystick ${stick} and its own default fire `
      + 'button works',
    );
    notes.push(...unmappedNote(
      emulator, player.player,
      bound.map(([control]) => control).filter((control) => ATARI_STICK[control] === undefined),
      'an Atari stick has four directions and one trigger',
    ));
  }

  // Same shape as VICE's above: atari800's own -config has always been
  // the first thing run.mjs hands it (the CRT-knob copy predates this
  // file), and a configuration file that only takes effect from one
  // position is not a thing to discover twice. It leads here too.
  const files = wroteKeys ? [{ path: configPath, contents: config }] : [];
  const leadingArgs = wroteKeys ? ['-config', configPath, '-no-autosave-config'] : [];
  return { ok: true, args, leadingArgs, files, notes };
}

// ---------------------------------------------------------------------
// fceux, x16emu, xmega65, web — the emulators that take little or nothing
// ---------------------------------------------------------------------

/**
 * fceux. Takes which device is in each port and nothing else; see the
 * header for why the mapping itself cannot be passed at all.
 */
export function fceuxController(machine, players, { emulator, hardware }) {
  const pads = hardware?.facts?.['input.pads'] ?? 2;
  const args = [];
  const notes = [];
  for (const player of players) {
    const port = defaultPort(machine, player.player);
    if (port > pads) {
      // `--input3`/`--input4` are not a third and fourth pad — fceux's own
      // help calls them "the famicom expansion device", and packages/nes's
      // catalog already owns that axis (`--hardware expansion=familykeyboard`
      // emits `--input3 familykeyboard`). Four pads are the Four Score
      // adapter, `--fourscore 1`, which is a different machine to fit and
      // belongs in the catalog beside it rather than being invented here.
      return {
        ok: false,
        error: `the ${machine} has ${pads} pad ports, so there is nowhere for player ${player.player} `
          + `('${player.name}') to plug in. `
          + `${emulator}'s --input3/--input4 are the Famicom expansion slot, not more pads, and four pads are the Four `
          + 'Score adapter (--fourscore), which no catalog fits yet',
      };
    }
    args.push(`--input${port}`, 'gamepad');
  }
  if (players.some((player) => Object.keys(player.controls).length > 0)) {
    notes.push(
      `${emulator}: the button mapping cannot be passed on the command line at all — \`fceux --help\` offers `
      + '--input1/--input2 (which device is in the port) and --fourscore, and nothing else. FCEUX keeps its bindings '
      + 'in ~/.fceux/fceux.cfg as SDL.Input.GamePad.<n>.* plus named profiles under ~/.fceux/input/, both set from its '
      + 'own Qt input dialog; there is no -config <file>, only --no-config. Map the pad once in FCEUX and it sticks',
    );
  }
  return { ok: true, args, leadingArgs: [], files: [], notes };
}

/**
 * x16emu. `-joy1`..`-joy4` bind a host gamepad to a SNES port; nothing
 * remaps it. The X16's ports are pads, not joysticks — its sheet says
 * `joysticks: 0, pads: 2` and its KERNAL calls them `joystick_get`
 * anyway, which is exactly the confusion docs/project/input.md names. The
 * catalog's count is the one that binds here: x16emu offers four -joy
 * flags, but a board with two ports is what the program was built for.
 */
export function x16emuController(machine, players, { emulator, hardware }) {
  const pads = hardware?.facts?.['input.pads'] ?? 2;
  const args = [];
  const notes = [];
  for (const player of players) {
    const port = defaultPort(machine, player.player);
    if (port > pads) {
      return {
        ok: false,
        error: `the ${machine}'s sheet says ${pads} pad ports, so there is nowhere for player ${player.player} `
          + `('${player.name}') to plug in. `
          + `(${emulator} itself offers -joy1..-joy4; some X16 boards carry four, and the catalog is what says so.)`,
      };
    }
    args.push(`-joy${port}`);
  }
  if (players.some((player) => Object.values(player.controls).some((binding) => binding.kind !== 'key'))) {
    notes.push(
      `${emulator}: -joy1..-joy4 only "Enable binding a gamepad to SNES controller port N" — which pad button is which `
      + 'SNES button comes from SDL\'s game-controller database, and x16emu takes no mapping of its own. (Its -keymap is '
      + 'a Commodore keyboard layout, not a controller map.)',
    );
  }
  if (players.some((player) => Object.values(player.controls).some((binding) => binding.kind === 'key'))) {
    notes.push(`${emulator}: keyboard bindings have nowhere to go — x16emu has no keyboard-as-joystick option`);
  }
  return { ok: true, args, leadingArgs: [], files: [], notes };
}

/** xmega65 (Xemu). One emulated port at a time, and cursor keys or a pad. */
export function xmega65Controller(machine, players, { emulator }) {
  const args = [];
  const notes = [];
  if (players.length > 1) {
    return {
      ok: false,
      error: `${emulator} emulates one joystick port at a time (-joyport 1|2); this profile has ${players.length} players`,
    };
  }
  for (const player of players) {
    const port = defaultPort(machine, player.player);
    if (port !== 1 && port !== 2) {
      return { ok: false, error: `${emulator}'s -joyport takes 1 or 2, and player ${player.player} works out as port ${port}` };
    }
    args.push('-joyport', String(port));
    const bound = Object.entries(player.controls);
    if (bound.length === 0) continue;
    // The one thing Xemu will take: the cursor keys as the stick. Offered
    // when the profile's directions are the arrows, because that is the
    // only keyboard layout the flag can mean.
    const arrows = ['up', 'down', 'left', 'right'];
    const bindsArrows = arrows.every((control) => player.controls[control]?.key === `Arrow${control[0].toUpperCase()}${control.slice(1)}`);
    if (bindsArrows) args.push('-curskeyjoy');
    notes.push(
      `${emulator}: only the port is settable (-joyport ${port}${bindsArrows ? ' -curskeyjoy' : ''}) — Xemu has no per-control `
      + 'mapping, and its -keymap is a keyboard layout file, not a joystick map. A pad plugged in drives the emulated '
      + 'stick with Xemu\'s own defaults',
    );
  }
  return { ok: true, args, leadingArgs: [], files: [], notes };
}

/** web. The browser runtime's input is six fixed edge bits; see the header. */
export function webController(machine, players) {
  if (players.length === 0) return { ok: true, args: [], leadingArgs: [], files: [], notes: [] };
  return {
    ok: true,
    args: [],
    leadingArgs: [],
    files: [],
    notes: [
      'web: the browser runtime reads six fixed edge bits (arrows, Enter, Escape) written by web-runtime.mjs, so a '
      + 'controller profile has nowhere to land yet. The Gamepad API is exactly what the web target should be reading — '
      + 'docs/project/input.md calls its `pads: 0` sheet "wrong in spirit" — and that work is in packages/web',
    ],
  };
}

/** xpet, and any other machine whose catalog fits no control port at all. */
function noPortsController(machine, players, { emulator }) {
  if (players.length === 0) return { ok: true, args: [], leadingArgs: [], files: [], notes: [] };
  return {
    ok: false,
    error: `the ${machine} has no control ports — ${emulator} offers only the userport joystick adapter `
      + '(-controlport3device and up, -extrajoydev1 and up), which this machine\'s catalog does not fit, and its sheet '
      + 'says input.joysticks: 0. A PET joystick was an aftermarket user-port board; if it is ever fitted it belongs '
      + 'in packages/pet\'s catalog as an option, beside model/ram/speaker/drive',
  };
}

const ADAPTERS = {
  vic20: viceController,
  c64: viceController,
  c128: viceController,
  pet: noPortsController,
  atari8: atari800Controller,
  nes: fceuxController,
  cx16: x16emuController,
  mega65: xmega65Controller,
  web: webController,
};

/**
 * The controller flags and files for one launch — the adapter for this
 * machine's emulator, applied to this project's profile.
 *
 * Returns an empty result for a project with no `controllers` block,
 * which is every project that existed before this one: a launch then adds
 * no arguments, writes no files, and is byte-identical to what it was.
 *
 * @param {string} machine
 * @param {Player[]} players
 * @param {{ emulator: string, hardware?: object, joymapPath?: string,
 *           vicercPath?: string, baseVicerc?: string,
 *           configPath?: string, baseConfig?: string }} context
 * @returns {{ ok: true, args: string[], files: {path: string, contents: string}[], notes: string[] }
 *          | { ok: false, error: string }}
 */
export function controllerInvocation(machine, players, context) {
  if (!players || players.length === 0) return { ok: true, args: [], leadingArgs: [], files: [], notes: [] };
  const adapter = ADAPTERS[machine];
  if (!adapter) {
    return { ok: false, error: `no controller adapter for '${machine}'` };
  }
  return adapter(machine, players, context);
}
