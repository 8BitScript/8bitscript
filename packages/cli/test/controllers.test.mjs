// The controller adapters (controllers.mjs): one per emulator, each a
// pure function from a normalized profile to the arguments and file
// contents that emulator will take.
//
// Everything here asserts on an *argument vector* or on file contents.
// Nothing here starts an emulator, and nothing here may: `8bs run
// <target>` with no --screenshot opens a GUI and waits for a human, so a
// test that launched one would not fail, it would hang the suite until CI
// killed it. The whole reason these adapters are pure functions is that
// this file can be complete without any of that — the flag names
// themselves were checked once, by hand, against each emulator's own
// -help output and (for VICE's JoyMapFile) a bounded `-limitcycles`
// probe; controllers.mjs's header records what each one said.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROLS,
  atari800Controller,
  bindingDevice,
  CONTROLLERS_FILE,
  controllerInvocation,
  controllerPlayers,
  defaultPort,
  fceuxController,
  parseBinding,
  sdlKeycode,
  setConfigKey,
  setViceResource,
  viceController,
  webController,
  x16emuController,
  xmega65Controller,
} from '../src/controllers.mjs';
import { loadCatalog, resolveHardware } from '../src/hardware.mjs';

const hardwareFor = (machine, choice = {}) => resolveHardware(loadCatalog(machine), choice).hardware;

/** One player, the shape controllerPlayers() hands an adapter. */
function player(controls, { number = 1, pad = number - 1, name = 'SN30 Pro' } = {}) {
  const parsed = {};
  for (const [control, binding] of Object.entries(controls)) parsed[control] = parseBinding(binding);
  return { player: number, pad, name, controls: parsed };
}

/**
 * The reference pad of docs/project/input.md — an 8BitDo SN30 Pro in
 * X-input mode — as the Gamepad API's standard mapping reports it, which
 * is what the editor's panel captures: the D-pad arrives as buttons
 * 12-15, not as a hat.
 */
const SN30_PRO = {
  up: 'button:12',
  down: 'button:13',
  left: 'button:14',
  right: 'button:15',
  a: 'button:0',
  b: 'button:1',
};

// ---------------------------------------------------------------------
// The profile itself
// ---------------------------------------------------------------------

test('the eighteen controls are the ones docs/project/input.md names, digital first', () => {
  assert.deepEqual(CONTROLS, [
    'up', 'down', 'left', 'right',
    'a', 'b', 'x', 'y',
    'l', 'r', 'start', 'select',
    'leftStickX', 'leftStickY', 'rightStickX', 'rightStickY', 'lt', 'rt',
  ]);
});

test('parseBinding is the inverse of the panel\'s own, so both ends read one grammar', () => {
  // editors/vscode/src/controllerProfile.cjs writes these.
  assert.deepEqual(parseBinding('button:3'), { kind: 'button', index: 3 });
  assert.deepEqual(parseBinding('axis:1-'), { kind: 'axis', index: 1, sign: '-' });
  assert.deepEqual(parseBinding('axis:1+'), { kind: 'axis', index: 1, sign: '+' });
  assert.deepEqual(parseBinding('axis:0'), { kind: 'axis', index: 0, sign: null });
  // `button:3-` is a typo, not a tighter way of saying `button:3` — the
  // same call the panel makes, so neither end quietly repairs it.
  assert.equal(parseBinding('button:3-'), null);
  for (const bad of ['', 'button3', 'button:', 'axis:1*', 'pad0.button0', null, 7]) {
    assert.equal(parseBinding(bad), null, JSON.stringify(bad));
  }
  // This end's own extension, for the one emulator that takes a keyboard
  // stick and nothing else. The panel does not write it yet.
  assert.deepEqual(parseBinding('key:ArrowUp'), { kind: 'key', key: 'ArrowUp' });
});

test('bindingDevice names the host device, so an adapter can tell a pad from the keyboard', () => {
  assert.equal(bindingDevice(parseBinding('button:0')), 'pad');
  assert.equal(bindingDevice(parseBinding('key:Space')), 'keyboard');
});

test('the file is the panel\'s own, and an absent or empty one is no players', () => {
  assert.equal(CONTROLLERS_FILE, '8bitscript.controllers.json');
  assert.deepEqual(controllerPlayers(null), { ok: true, players: [] });
  assert.deepEqual(controllerPlayers({}), { ok: true, players: [] });
  assert.deepEqual(controllerPlayers({ version: 1, controllers: { devices: [] } }), { ok: true, players: [] });
});

test('controllerPlayers reads the panel\'s devices, in player order, pad index from the player', () => {
  const result = controllerPlayers({
    version: 1,
    controllers: {
      devices: [
        { id: 'b', name: 'Second pad', player: 2, mode: 'standard', mapping: { a: 'button:0' } },
        { id: 'a', name: 'SN30 Pro', player: 1, mode: 'standard', mapping: SN30_PRO },
      ],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.players.map((p) => [p.player, p.pad, p.name]), [[1, 0, 'SN30 Pro'], [2, 1, 'Second pad']]);
  // Nothing in the file carries a host joystick number — a device is a
  // Gamepad API id string, which has no relation to the index SDL hands
  // the emulator — so player order is it: player 1 is host joystick 0.
  assert.deepEqual(result.players[0].controls.a, { kind: 'button', index: 0 });
});

test('a device nobody has assigned is not player 1 — "plugged in" and "playing" are different facts', () => {
  const result = controllerPlayers({
    controllers: { devices: [{ id: 'a', name: 'Seen once', player: 0, mapping: { a: 'button:0' } }] },
  });
  assert.deepEqual(result, { ok: true, players: [] });
});

test('a binding the grammar cannot read costs that binding, not the launch', () => {
  const result = controllerPlayers({
    controllers: { devices: [{ id: 'a', player: 1, mapping: { a: 'button:0', b: 'nonsense', fire: 'button:2' } }] },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.players[0].controls), ['a'], 'the file is hand-editable; a typo is one binding');
});

test('a file whose shape is wrong is named, and so are two devices on one player', () => {
  assert.match(controllerPlayers([]).error, /must be an object with a `controllers\.devices` list/);
  assert.match(controllerPlayers({ controllers: { devices: {} } }).error, /must be a list, one entry per device/);
  assert.match(
    controllerPlayers({ controllers: { devices: [{ id: 'a', player: 9, mapping: {} }] } }).error,
    /is player 9; there are 4 players at most/,
  );
  assert.match(
    controllerPlayers({
      controllers: { devices: [{ id: 'a', name: 'One', player: 1 }, { id: 'b', name: 'Two', player: 1 }] },
    }).error,
    /'One' and 'Two' are both player 1/,
  );
});

test('player 1 defaults to the port the machine actually has a stick in', () => {
  // The catalogs put the stock joystick in port 2 on both, because port 1
  // shares its lines with the keyboard matrix.
  assert.equal(hardwareFor('c64').options.port2, 'joystick');
  assert.equal(hardwareFor('c128').options.port2, 'joystick');
  assert.equal(defaultPort('c64', 1), 2);
  assert.equal(defaultPort('c128', 1), 2);
  assert.equal(defaultPort('c64', 2), 1);
  assert.equal(defaultPort('vic20', 1), 1, 'the VIC-20 has one port and it is port 1');
  assert.equal(defaultPort('atari8', 2), 2);
});

// ---------------------------------------------------------------------
// VICE
// ---------------------------------------------------------------------

const VICE_CONTEXT = {
  emulator: 'x64sc',
  hardware: hardwareFor('c64'),
  joymapPath: '/tmp/j.vjm',
  vicercPath: '/tmp/j.vicerc',
  baseVicerc: '',
};

test('x64sc: a pad on the stock C64 drives port 2 through -joydev2 and a generated joystick map', () => {
  const result = viceController('c64', [player(SN30_PRO)], VICE_CONTEXT);
  assert.equal(result.ok, true);
  // "4: Analog joystick 0", from `x64sc -help`. The -controlport2device
  // that says a joystick is *in* the port is the catalog's, and is not
  // repeated here.
  assert.deepEqual(result.args, ['-joydev2', '4']);
  // -config is not an ordinary flag: VICE honours it only as the first
  // argument on the line, so it travels separately and leads the vector.
  assert.deepEqual(result.leadingArgs, ['-config', '/tmp/j.vicerc']);
  assert.ok(!result.args.includes('-controlport2device'), 'the catalog says what is plugged in, not this');

  const joymap = result.files.find((file) => file.path === '/tmp/j.vjm');
  const lines = joymap.contents.split('\n').filter((line) => line && !line.startsWith('#'));
  // `joynum inputtype inputindex action [params]`: inputtype 1 is a
  // button, and action `1 <pin>` with 1/2/4/8 = u/d/l/r and 16/32 =
  // fire/fire2. The D-pad is buttons 12-15 because that is what the
  // Gamepad API's standard mapping calls it — VICE's hat type is
  // unreachable from a profile, by construction.
  assert.deepEqual(lines, [
    '!CLEAR',
    '0 1 12 1 1',
    '0 1 13 1 2',
    '0 1 14 1 4',
    '0 1 15 1 8',
    '0 1 0 1 16',
    '0 1 1 1 32',
  ]);
});

test('x64sc: the vicerc that reaches JoyMapFile puts it under the emulator\'s own section', () => {
  const result = viceController('c64', [player({ a: 'button:0' })], VICE_CONTEXT);
  const vicerc = result.files.find((file) => file.path === '/tmp/j.vicerc');
  // Probed 2026-09-12: section-less, VICE never sees the resource and goes
  // on looking for ~/.config/vice/gtk3-joymap-C64SC.vjm; under [C64SC] it
  // logs "Loading joystick map".
  assert.equal(vicerc.contents, '[C64SC]\nJoyMapFile="/tmp/j.vjm"\n');
});

test('setViceResource keeps everything the user already had, because -config replaces their vicerc', () => {
  const base = '[C64SC]\nWindow0Width=800\n\n[VIC20]\nWindow0Width=640\n';
  const written = setViceResource(base, 'C64SC', 'JoyMapFile', '"/tmp/j.vjm"');
  assert.match(written, /^\[C64SC\]\nJoyMapFile="\/tmp\/j\.vjm"\nWindow0Width=800$/m);
  assert.match(written, /\[VIC20\]\nWindow0Width=640/, 'another machine\'s section is untouched');

  const replaced = setViceResource('[C64SC]\nJoyMapFile="/old.vjm"\n', 'C64SC', 'JoyMapFile', '"/new.vjm"');
  assert.equal(replaced, '[C64SC]\nJoyMapFile="/new.vjm"\n');

  const appended = setViceResource('[VIC20]\nWindow0Width=640\n', 'C64SC', 'JoyMapFile', '"/j.vjm"');
  assert.match(appended, /\[VIC20\]\nWindow0Width=640\n\n\[C64SC\]\nJoyMapFile="\/j\.vjm"\n$/);
});

test('x64sc: an axis half is a direction, a whole axis is refused by name with the fix', () => {
  const halves = viceController('c64', [player({ left: 'axis:0-', right: 'axis:0+' })], VICE_CONTEXT);
  const lines = halves.files[0].contents.split('\n').filter((line) => line && !line.startsWith('#') && line !== '!CLEAR');
  // "axis 0 has inputindex 0,1 respectively for positive and negative".
  assert.deepEqual(lines, ['0 0 1 1 4', '0 0 0 1 8']);

  // The binding someone writes first, because it is what the reference
  // pad's left stick is. It cannot reach a Commodore port, and the note
  // says which two lines to write instead rather than only that.
  const stick = viceController('c64', [player({ leftStickX: 'axis:0' })], VICE_CONTEXT);
  assert.equal(stick.ok, true);
  assert.deepEqual(stick.files, [], 'nothing analog reached the file');
  assert.match(
    stick.notes.join('\n'),
    /leftStickX \(an analog axis — a Commodore port has none; bind the directions to axis:0- and axis:0\+ instead\)/,
  );

  // A *direction* bound to a whole axis has a pin but no half to put it
  // on, and is named with the same fix.
  const whole = viceController('c64', [player({ left: 'axis:0' })], VICE_CONTEXT);
  assert.equal(whole.ok, true);
  assert.deepEqual(whole.files, [], 'a signless axis produced no map line');
  assert.match(whole.notes.join('\n'), /left \(a whole axis — bind the halves, axis:0- and axis:0\+\)/);
});

test('x64sc: controls a Commodore port has no pin for are named, not dropped', () => {
  const result = viceController(
    'c64',
    [player({ a: 'button:0', start: 'button:9', select: 'button:8', rt: 'axis:5' })],
    VICE_CONTEXT,
  );
  assert.equal(result.ok, true);
  const notes = result.notes.join('\n');
  assert.match(notes, /player 1's start, select and rt .* nowhere to go/);
  assert.match(notes, /four directions and its fire pins/);
});

test('x64sc: fire2/fire3 are mapped but named — a one-button Commodore stick reads fire only', () => {
  const result = viceController('c64', [player({ a: 'button:0', b: 'button:1' })], VICE_CONTEXT);
  assert.match(result.notes.join('\n'), /player 1's b is mapped to pin fire2\/fire3, which a plain Joystick in port 2 does not read/);
});

test('x64sc: a keyboard player gets VICE\'s numpad joystick, and is told the keysets are not reachable', () => {
  const result = viceController('c64', [player({ up: 'key:ArrowUp', a: 'key:Space' })], VICE_CONTEXT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, ['-joydev2', '1'], '"1: Numpad", from x64sc -help');
  assert.deepEqual(result.files, [], 'there is no file that can carry a keyset assignment');
  assert.match(
    result.notes.join('\n'),
    /keyboard bindings \(ArrowUp and Space\) cannot be set from the command line — VICE's KeySet1\*\/KeySet2\* assignments are resources with no flag/,
  );
});

test('x64sc: a port with nothing in it is refused with the --hardware that fixes it', () => {
  const result = viceController('c64', [player(SN30_PRO, { number: 2 })], VICE_CONTEXT);
  assert.equal(result.ok, false);
  assert.match(result.error, /port 1 has nothing plugged into it.*Add --hardware port1=joystick/s);
});

test('x64sc: a port holding a mouse is refused by what is actually in it', () => {
  const result = viceController('c64', [player(SN30_PRO, { number: 2 })], {
    ...VICE_CONTEXT, hardware: hardwareFor('c64', { overrides: { port1: 'mouse1351' } }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /port 1 has a mouse1351 in it/);
});

test('xvic: the VIC-20 has one port, and asking for a second is refused by count', () => {
  const context = { ...VICE_CONTEXT, emulator: 'xvic', hardware: hardwareFor('vic20') };
  const ok = viceController('vic20', [player(SN30_PRO)], context);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.args, ['-joydev1', '4'], 'the VIC-20\'s one port is port 1');
  assert.equal(ok.files.find((file) => file.path === '/tmp/j.vicerc').contents, '[VIC20]\nJoyMapFile="/tmp/j.vjm"\n');

  const tooMany = viceController('vic20', [player(SN30_PRO, { number: 2 })], context);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /the vic20 has one control port, so there is nowhere for player 2 \('SN30 Pro'\) to plug in/);
});

test('x128: two players reach both ports, each with its own -joydev and one shared map', () => {
  const result = viceController(
    'c128',
    [player(SN30_PRO, { number: 1 }), player({ a: 'button:0' }, { number: 2 })],
    { ...VICE_CONTEXT, emulator: 'x128', hardware: hardwareFor('c128', { overrides: { port1: 'joystick' } }) },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, ['-joydev2', '4', '-joydev1', '5']);
  assert.deepEqual(result.leadingArgs, ['-config', '/tmp/j.vicerc']);
  assert.match(result.files[0].contents, /^1 1 0 1 16$/m, 'player 2 is host joystick 1');
  assert.equal(result.files[1].contents, '[C128]\nJoyMapFile="/tmp/j.vjm"\n');
});

test('x64sc: one emulated port is driven by one host device, and a mixed player is refused', () => {
  const result = viceController('c64', [player({ up: 'key:ArrowUp', a: 'button:0' })], VICE_CONTEXT);
  assert.equal(result.ok, false);
  assert.match(result.error, /x64sc drives one emulated port from one host device \(-joydev2\), but player 1 mixes/);
});

test('x64sc: VICE reaches six host gamepads, and a seventh is refused by name', () => {
  const result = viceController('c64', [player({ a: 'button:0' }, { number: 1, pad: 6 })], VICE_CONTEXT);
  assert.equal(result.ok, false);
  assert.match(result.error, /reaches six host gamepads .*Analog joystick 0" to "5"\); player 1 would be host joystick 6/);
});

test('the PET is refused by name — it has no control ports, and its sheet says so', () => {
  assert.equal(hardwareFor('pet').facts['input.joysticks'], 0);
  const result = controllerInvocation('pet', [player(SN30_PRO)], { emulator: 'xpet', hardware: hardwareFor('pet') });
  assert.equal(result.ok, false);
  assert.match(result.error, /the pet has no control ports/);
  assert.match(result.error, /userport joystick adapter/, 'what xpet does offer, so the refusal is informative');
  assert.match(result.error, /belongs in packages\/pet's catalog as an option/);
});

// ---------------------------------------------------------------------
// atari800
// ---------------------------------------------------------------------

const ATARI_CONTEXT = { emulator: 'atari800', hardware: hardwareFor('atari8'), configPath: '/tmp/a.cfg', baseConfig: '' };

test('sdlKeycode follows SDL\'s own rule, checked against a config atari800 wrote itself', () => {
  // ~/.atari800.cfg on this machine: SDL2_JOY_1_LEFT=97 (a), _RIGHT=100
  // (d), _UP=119 (w), _DOWN=115 (s) — printable keys are their ASCII code.
  assert.equal(sdlKeycode('KeyA'), 97);
  assert.equal(sdlKeycode('KeyD'), 100);
  assert.equal(sdlKeycode('KeyW'), 119);
  assert.equal(sdlKeycode('KeyS'), 115);
  assert.equal(sdlKeycode('Digit0'), 48);
  // ...and everything else is (1 << 30) | scancode: 1073741916/18/20/17
  // are SDL_SCANCODE_KP_4/KP_6/KP_8/KP_5, the same file's stick 0.
  assert.equal(sdlKeycode('Numpad4'), 1073741916);
  assert.equal(sdlKeycode('Numpad6'), 1073741918);
  assert.equal(sdlKeycode('Numpad8'), 1073741920);
  assert.equal(sdlKeycode('Numpad5'), 1073741917);
  // Its two triggers, RCTRL and LCTRL.
  assert.equal(sdlKeycode('ControlRight'), 1073742052);
  assert.equal(sdlKeycode('ControlLeft'), 1073742048);
  assert.equal(sdlKeycode('ArrowUp'), 1073741906);
  assert.equal(sdlKeycode('Meh'), null, 'a key this table cannot name is null, not a wrong number');
});

test('atari800: a keyboard stick is -kbdjoy0 plus the SDL keycodes in the one -config', () => {
  const result = atari800Controller('atari8', [player({
    up: 'key:ArrowUp', down: 'key:ArrowDown', left: 'key:ArrowLeft', right: 'key:ArrowRight', a: 'key:ControlRight',
  })], ATARI_CONTEXT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, ['-kbdjoy0']);
  assert.deepEqual(result.leadingArgs, ['-config', '/tmp/a.cfg', '-no-autosave-config']);
  const cfg = result.files[0].contents;
  assert.equal(result.files[0].path, '/tmp/a.cfg');
  assert.match(cfg, /^SDL2_JOY_0_UP=1073741906$/m);
  assert.match(cfg, /^SDL2_JOY_0_DOWN=1073741905$/m);
  assert.match(cfg, /^SDL2_JOY_0_LEFT=1073741904$/m);
  assert.match(cfg, /^SDL2_JOY_0_RIGHT=1073741903$/m);
  assert.match(cfg, /^SDL2_JOY_0_TRIGGER=1073742052$/m);
});

test('atari800: the controller keys join the CRT knobs rather than opening a second -config', () => {
  const result = atari800Controller('atari8', [player({ a: 'key:Space' })], {
    ...ATARI_CONTEXT, baseConfig: 'ROM_OS_B=/roms/os.rom\nCRT_BEAM_SHAPE=0\n',
  });
  const cfg = result.files[0].contents;
  assert.match(cfg, /^ROM_OS_B=\/roms\/os\.rom$/m, 'the user\'s ROM paths survive — without them the emulator boots to black');
  assert.match(cfg, /^CRT_BEAM_SHAPE=0$/m);
  assert.match(cfg, /^SDL2_JOY_0_TRIGGER=1073741868$/m);
  assert.equal(result.leadingArgs.filter((arg) => arg === '-config').length, 1, 'atari800 takes one -config');
});

test('atari800: a second player is stick 1, and a third cannot be keyboard-driven', () => {
  const second = atari800Controller('atari8', [player({ a: 'key:Space' }, { number: 2 })], ATARI_CONTEXT);
  assert.deepEqual(second.args.slice(0, 1), ['-kbdjoy1'], 'atari800 counts sticks from 0; the profile counts ports from 1');
  assert.match(second.files[0].contents, /^SDL2_JOY_1_TRIGGER=/m);

  // A 400/800 has four ports, but `atari800 -help` lists -kbdjoy0 and
  // -kbdjoy1 and no more.
  const wide = hardwareFor('atari8', { overrides: { model: '800' } });
  assert.equal(wide.facts['input.joysticks'], 4);
  const third = atari800Controller('atari8', [player({ a: 'key:Space' }, { number: 3 })], { ...ATARI_CONTEXT, hardware: wide });
  assert.equal(third.ok, false);
  assert.match(third.error, /-kbdjoy0 and -kbdjoy1 and no more, so stick 2 cannot be keyboard-driven/);
});

test('atari800: an XL has two ports and a fifth player is refused with the profile that has four', () => {
  const result = atari800Controller('atari8', [player({ a: 'key:Space' }, { number: 3 })], ATARI_CONTEXT);
  assert.equal(result.ok, false);
  assert.match(result.error, /this Atari has 2 joystick ports.*--profile 400 and --profile 800/s);
});

test('atari800: a pad is named rather than mapped — there is no per-button config key for it', () => {
  const result = atari800Controller('atari8', [player(SN30_PRO)], ATARI_CONTEXT);
  assert.equal(result.ok, true);
  // -joy0hat is deliberately absent: it is a fact about SDL's view of the
  // host pad, and the profile records the Gamepad API's.
  assert.deepEqual(result.args, ['-no-kbdjoy0'], 'the keyboard is told not to also drive this stick, and that is all');
  assert.deepEqual(result.files, [], 'nothing to write: the keys are only for a keyboard stick');
  assert.match(result.notes.join('\n'), /atari800 wires SDL joystick 0 to stick 0 itself and has no per-button map/);
  assert.match(result.notes.join('\n'), /player 1's b .* nowhere to go — an Atari stick has four directions and one trigger/);
});

test('atari800: a key the table cannot name is refused rather than turned into a wrong keycode', () => {
  const result = atari800Controller('atari8', [player({ a: 'key:Compose' })], ATARI_CONTEXT);
  assert.equal(result.ok, false);
  assert.match(result.error, /'Compose' is not a key name this CLI can turn into an SDL keycode/);
});

test('setConfigKey replaces a key in place and appends a missing one, on an empty base too', () => {
  assert.equal(setConfigKey('A=1\nB=2\n', 'B', '9'), 'A=1\nB=9\n');
  assert.equal(setConfigKey('A=1\n', 'B', '9'), 'A=1\nB=9\n');
  assert.equal(setConfigKey('', 'B', '9'), 'B=9\n');
});

// ---------------------------------------------------------------------
// fceux, x16emu, xmega65, web — the ones that take little or nothing
// ---------------------------------------------------------------------

test('fceux: the port device is all it takes, and the mapping is refused by name', () => {
  const result = fceuxController('nes', [player(SN30_PRO)], { emulator: 'fceux', hardware: hardwareFor('nes') });
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, ['--input1', 'gamepad']);
  assert.deepEqual(result.files, []);
  assert.match(
    result.notes.join('\n'),
    /the button mapping cannot be passed on the command line at all/,
  );
  assert.match(result.notes.join('\n'), /~\/\.fceux\/fceux\.cfg as SDL\.Input\.GamePad/);
  assert.match(result.notes.join('\n'), /there is no -config <file>, only --no-config/);
});

test('fceux: two pads are two --input flags; a third port is refused, expansion slot and all', () => {
  const two = fceuxController(
    'nes',
    [player({ a: 'button:0' }, { number: 1 }), player({ a: 'button:0' }, { number: 2 })],
    { emulator: 'fceux', hardware: hardwareFor('nes') },
  );
  assert.deepEqual(two.args, ['--input1', 'gamepad', '--input2', 'gamepad']);

  const three = fceuxController('nes', [player({ a: 'button:0' }, { number: 3 })], { emulator: 'fceux', hardware: hardwareFor('nes') });
  assert.equal(three.ok, false);
  assert.match(three.error, /the nes has 2 pad ports/);
  assert.match(three.error, /--input3\/--input4 are the Famicom expansion slot, not more pads/);
});

test('x16emu: -joy<n> binds a pad to a SNES port, and that is the whole of what it takes', () => {
  const result = x16emuController('cx16', [player(SN30_PRO)], { emulator: 'x16emu', hardware: hardwareFor('cx16') });
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, ['-joy1']);
  assert.deepEqual(result.files, []);
  assert.match(result.notes.join('\n'), /SDL's game-controller database, and x16emu takes no mapping of its own/);
  assert.match(result.notes.join('\n'), /-keymap is a Commodore keyboard layout, not a controller map/);
});

test('x16emu: a keyboard binding has nowhere to go and is named', () => {
  const result = x16emuController('cx16', [player({ a: 'key:Space' })], { emulator: 'x16emu', hardware: hardwareFor('cx16') });
  assert.match(result.notes.join('\n'), /keyboard bindings have nowhere to go — x16emu has no keyboard-as-joystick option/);
});

test('xmega65: one port at a time, and the cursor keys when the profile asks for the arrows', () => {
  const arrows = xmega65Controller('mega65', [player({
    up: 'key:ArrowUp', down: 'key:ArrowDown', left: 'key:ArrowLeft', right: 'key:ArrowRight',
  })], { emulator: 'xmega65', hardware: hardwareFor('mega65') });
  assert.equal(arrows.ok, true);
  // The MEGA65's joysticks are CIA1 ports as on the C64, so player 1 is
  // port 2 (packages/mega65/AGENTS.md).
  assert.deepEqual(arrows.args, ['-joyport', '2', '-curskeyjoy']);

  const pad = xmega65Controller('mega65', [player(SN30_PRO)], { emulator: 'xmega65', hardware: hardwareFor('mega65') });
  assert.deepEqual(pad.args, ['-joyport', '2'], 'no -curskeyjoy for a pad');
  assert.match(pad.notes.join('\n'), /Xemu has no per-control mapping, and its -keymap is a keyboard layout file/);

  const two = xmega65Controller('mega65', [player(SN30_PRO, { number: 1 }), player(SN30_PRO, { number: 2 })], { emulator: 'xmega65' });
  assert.equal(two.ok, false);
  assert.match(two.error, /emulates one joystick port at a time \(-joyport 1\|2\); this profile has 2 players/);
});

test('web: a profile is accepted and has nowhere to land yet, which is said rather than ignored', () => {
  assert.deepEqual(webController('web', []), { ok: true, args: [], leadingArgs: [], files: [], notes: [] });
  const result = webController('web', [player(SN30_PRO)]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, []);
  assert.match(result.notes.join('\n'), /six fixed edge bits \(arrows, Enter, Escape\)/);
  assert.match(result.notes.join('\n'), /that work is in packages\/web/);
});

test('controllerInvocation with no players adds nothing at all, on every machine', () => {
  for (const machine of ['pet', 'vic20', 'c64', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web']) {
    assert.deepEqual(
      controllerInvocation(machine, [], { emulator: 'x', hardware: hardwareFor(machine) }),
      { ok: true, args: [], leadingArgs: [], files: [], notes: [] },
      machine,
    );
  }
});

test('a `key:` binding rides through to the emulator without complaint', () => {
  // It used to earn a warning, because the panel rewrote the file on save
  // and dropped every binding it could not read — so a hand-written Atari
  // keyboard stick worked until somebody opened Controller Setup and
  // pressed a button. The panel's parseBinding takes `key:` as a first-class
  // shape now and can capture one, so the warning described a trap that no
  // longer exists and said so at every launch. A launch is quiet again.
  const result = controllerInvocation('atari8', [player({ a: 'key:Space' })], {
    emulator: 'atari800', hardware: hardwareFor('atari8'), configPath: '/tmp/a.cfg', baseConfig: '',
  });
  assert.equal(result.ok, true);
  // The binding reaches atari800, which is the whole point: it takes a
  // joystick mapping in no other shape than emulated keys.
  assert.ok(
    result.files.some((file) => /SDL2_JOY_0_/.test(file.contents)),
    'the key reaches the config atari800 reads',
  );
  assert.ok(
    !result.notes.join('\n').includes('key:'),
    'and nothing is said about it — the panel reads and writes this shape now',
  );

  const pads = controllerInvocation('atari8', [player(SN30_PRO)], {
    emulator: 'atari800', hardware: hardwareFor('atari8'), configPath: '/tmp/a.cfg', baseConfig: '',
  });
  assert.ok(!pads.notes.join('\n').includes('key:'), 'nor when the panel wrote the file');
});

test('a C64 has two control ports, so players 3 and 4 are refused by count rather than aimed at an adapter', () => {
  // -controlport3device and up are VICE's joystick-*adapter* ports, which
  // no catalog fits; -joydev only reaches the two real ones.
  assert.equal(defaultPort('c64', 3), 3);
  const result = viceController('c64', [player(SN30_PRO, { number: 3 })], VICE_CONTEXT);
  assert.equal(result.ok, false);
  assert.match(result.error, /the c64 has 2 control ports, so there is nowhere for player 3 \('SN30 Pro'\) to plug in/);
});
