// The normalized controller model: what a raw button index means once it
// has a name, what a stored profile is allowed to contain, and what each
// machine can carry of it.
//
// Every one of these runs without a controller, without a browser and
// without the `vscode` API, which is the whole reason controllerProfile.cjs
// is a module of its own. What is *not* testable here is the one thing a
// person still has to do by hand: confirm that pressing A on a real pad
// lights the shape marked A. See the header of test/controller.test.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTROL_KINDS, CONTROL_LABELS, DEADZONE, DEVICE_CONTROLS, LOGICAL_CONTROLS, MAX_PLAYERS,
  PAD_KINDS, PRESS_THRESHOLD, PRIMARY_PORT, STANDARD_MAPPING, WALKTHROUGH,
  activeInputs, capture, deviceFromDetected, deviceKey, emptyProfile, formatBinding,
  normalizeDevice, normalizeProfile, parseBinding, pressed, project, readBinding,
  resolveDirection, toCliBinding, toCliPlayers, toConfigBlock, withDevice, withoutDevice,
} = require('../src/controllerProfile.cjs');

/** The reference pad: an 8BitDo SN30 Pro in X-input mode, at rest. */
const rest = () => ({ buttons: new Array(17).fill(0), axes: [0, 0, 0, 0] });

test('the control set is declared once, and everything agrees with it', () => {
  assert.equal(LOGICAL_CONTROLS.length, 18);
  assert.deepEqual([...new Set(LOGICAL_CONTROLS)], LOGICAL_CONTROLS, 'no control named twice');
  for (const control of LOGICAL_CONTROLS) {
    assert.ok(CONTROL_KINDS[control], `${control} has no kind`);
    assert.ok(CONTROL_LABELS[control], `${control} has no label`);
  }
  // The walkthrough asks for every control and invents none: a guided
  // setup that skipped one would leave a profile nothing said was short.
  assert.deepEqual([...WALKTHROUGH].sort(), [...LOGICAL_CONTROLS].sort());
  // The stick clicks the reference pad also reports are deliberately not
  // here — no machine in the catalog has anywhere to put them.
  assert.ok(!LOGICAL_CONTROLS.includes('l3'));
  assert.ok(!LOGICAL_CONTROLS.includes('r3'));
});

test('parseBinding takes the three shapes there are, and nothing else', () => {
  assert.deepEqual(parseBinding('button:0'), { source: 'button', index: 0, half: null });
  assert.deepEqual(parseBinding('axis:1'), { source: 'axis', index: 1, half: null });
  assert.deepEqual(parseBinding('axis:1+'), { source: 'axis', index: 1, half: '+' });
  assert.deepEqual(parseBinding('axis:1-'), { source: 'axis', index: 1, half: '-' });
  // A button has no halves; reading `button:3-` as `button:3` would hide a typo.
  assert.equal(parseBinding('button:3-'), null);
  for (const junk of ['', 'a', 'button:', 'button:-1', 'axis:x', 'trigger:0', null, 7, {}]) {
    assert.equal(parseBinding(junk), null, `${JSON.stringify(junk)} should not parse`);
  }
  for (const binding of ['button:0', 'axis:1', 'axis:1+', 'axis:1-']) {
    assert.equal(formatBinding(parseBinding(binding)), binding, 'parse and format are inverses');
  }
});

test('readBinding takes a GamepadButton, a bare number, or a pressed flag', () => {
  // The W3C shape the page sees, the flattened one it posts, and the old
  // shape a driver with no analogue reading gives.
  assert.equal(readBinding('button:2', { buttons: [0, 0, { value: 0.42, pressed: false }] }), 0.42);
  assert.equal(readBinding('button:2', { buttons: [0, 0, 0.42] }), 0.42);
  assert.equal(readBinding('button:2', { buttons: [0, 0, { pressed: true }] }), 1);
  // A binding to something this pad does not have reads as nothing rather
  // than throwing: a profile made on a richer pad must still open.
  assert.equal(readBinding('button:9', { buttons: [0] }), 0);
  assert.equal(readBinding('axis:3', { axes: [0] }), 0);
  assert.equal(readBinding('axis:0', { axes: [-0.6] }), -0.6, 'a whole axis keeps its sign');
  assert.equal(readBinding('axis:0-', { axes: [-0.6] }), 0.6, 'a half is the travel one way');
  assert.equal(readBinding('axis:0+', { axes: [-0.6] }), 0, 'and nothing the other way');
});

test('a whole axis is never a press, and a half is one past the deadzone', () => {
  assert.equal(pressed('axis:0', { axes: [-0.9] }), false, '"is -0.9 pressed" has no honest answer');
  assert.equal(pressed('axis:0-', { axes: [-(DEADZONE + 0.01)] }), true);
  assert.equal(pressed('axis:0-', { axes: [-(DEADZONE - 0.01)] }), false);
  assert.equal(pressed('button:0', { buttons: [PRESS_THRESHOLD] }), true);
  assert.equal(pressed('button:0', { buttons: [PRESS_THRESHOLD - 0.01] }), false);
  // Below 1/sqrt(2), so a clean diagonal closes both switches — an
  // Atari-standard port really does have four independent ones.
  assert.ok(DEADZONE < Math.SQRT1_2, 'a diagonal must be reachable');
});

test('a direction falls back to the left stick, with the screen-coordinate sign', () => {
  const stick = { leftStickX: 'axis:0', leftStickY: 'axis:1' };
  assert.deepEqual(resolveDirection(stick, 'up'), { binding: 'axis:1-', from: 'leftStick' });
  assert.deepEqual(resolveDirection(stick, 'down'), { binding: 'axis:1+', from: 'leftStick' });
  assert.deepEqual(resolveDirection(stick, 'left'), { binding: 'axis:0-', from: 'leftStick' });
  assert.deepEqual(resolveDirection(stick, 'right'), { binding: 'axis:0+', from: 'leftStick' });
  // An explicit D-pad binding outranks the stick.
  assert.deepEqual(
    resolveDirection({ ...stick, up: 'button:12' }, 'up'),
    { binding: 'button:12', from: 'explicit' },
  );
  // A stick already bound to one half is not a stick.
  assert.equal(resolveDirection({ leftStickY: 'axis:1+' }, 'up'), null);
  assert.equal(resolveDirection({}, 'up'), null);
  // The right stick is left alone: a machine with one stick wants the one
  // that steers, and nothing should quietly take the aiming one.
  assert.equal(resolveDirection({ rightStickX: 'axis:2' }, 'left'), null);
});

test('capture takes the loudest input, and a button over an axis at a tie', () => {
  const state = { buttons: [0, 1, 0], axes: [0.7, -0.95] };
  // The stick is pushed harder than the button is analogue, but a button
  // at full travel is 1 and ties are the button's.
  assert.equal(capture(state), 'button:1');
  assert.equal(capture({ buttons: [], axes: [0.7, -0.95] }), 'axis:1-', 'the harder-pushed axis wins');
  assert.equal(capture({ buttons: [], axes: [0.7, -0.95] }, { wantsAxis: true }), 'axis:1');
  // Asking for an axis ignores buttons entirely: binding `leftStickX` to a
  // shoulder would give a stick with two positions.
  assert.equal(capture({ buttons: [1], axes: [] }, { wantsAxis: true }), null);
  assert.equal(capture(rest()), null, 'a pad at rest is not pressing anything');
});

test('activeInputs is what the live view lights, on the same thresholds', () => {
  const state = { buttons: [0, 1, 0.2, 0.9], axes: [0.05, -0.8] };
  assert.deepEqual(activeInputs(state), {
    buttons: [1, 3],
    axes: [{ index: 1, value: -0.8 }],
  });
  assert.deepEqual(activeInputs(rest()), { buttons: [], axes: [] });
});

test('a device is keyed by the only thing about a pad that survives unplugging it', () => {
  // `index` is the slot this session; the id string carries the vendor and
  // product ids, so that is the key.
  assert.equal(
    deviceKey('8BitDo SN30 Pro (Vendor: 2dc8 Product: 6001)'),
    '8bitdo-sn30-pro-vendor-2dc8-product-6001',
  );
  assert.equal(deviceKey(''), 'unknown-device');
  assert.equal(deviceKey(undefined), 'unknown-device');
  assert.ok(!deviceKey('///').includes('/'), 'a key goes in a JSON object and is read by a person');
});

test('a standard-mapping pad starts bound, and an unknown one starts empty', () => {
  const sn30 = deviceFromDetected({
    id: '8BitDo SN30 Pro (Vendor: 2dc8 Product: 6001)', mapping: 'standard', buttons: 17, axes: 4,
  });
  assert.equal(sn30.mode, 'standard');
  assert.equal(sn30.player, 0, 'detected is not assigned');
  assert.deepEqual(sn30.mapping, STANDARD_MAPPING);
  // A pad the browser will not vouch for is not guessed at: a confidently
  // wrong profile is worse than a plainly unset one.
  const unknown = deviceFromDetected({ id: 'Some Arcade Stick', mapping: '', buttons: 8, axes: 2 });
  assert.equal(unknown.mode, 'custom');
  assert.deepEqual(unknown.mapping, {});
  // And the standard layout is trimmed to what this pad actually reports,
  // so no control is shown as bound to an index that can never light.
  const small = deviceFromDetected({ id: 'Small Pad', mapping: 'standard', buttons: 10, axes: 2 });
  assert.equal(small.mapping.select, 'button:8');
  assert.equal(small.mapping.up, undefined, 'button:12 is not there to bind');
  assert.equal(small.mapping.rightStickX, undefined, 'axis:2 is not there either');
});

test('the standard layout names every control the W3C layout has', () => {
  for (const control of LOGICAL_CONTROLS) {
    assert.ok(STANDARD_MAPPING[control], `${control} is unbound in the standard layout`);
    assert.ok(parseBinding(STANDARD_MAPPING[control]), `${control} is bound to nonsense`);
  }
});

test('a stored profile keeps what it can read and silently drops the rest', () => {
  const profile = normalizeProfile({
    controllers: {
      devices: [
        { id: 'pad-one', name: 'One', player: 1, mode: 'standard', mapping: { a: 'button:0', b: 'nope', zz: 'button:1' } },
        { id: 'pad-one', name: 'A duplicate', player: 2, mapping: {} },
        { name: 'no id at all', player: 1 },
        'not an object',
        { id: 'pad-two', player: 99, mode: 'invented', mapping: { leftStickX: 'axis:0' } },
      ],
    },
  });
  assert.equal(profile.controllers.devices.length, 2, 'the duplicate and the id-less entry are gone');
  const [one, two] = profile.controllers.devices;
  assert.deepEqual(one.mapping, { a: 'button:0' }, 'an unreadable binding is an unset one');
  assert.equal(one.player, 1);
  assert.equal(two.player, 0, 'a player outside 0..4 is unassigned');
  assert.equal(two.mode, 'custom', 'an unknown mode is a hand-made one');
  assert.equal(two.name, 'pad-two', 'a nameless device is named by its id');
  // Written in control order, so two saves of the same profile are the
  // same bytes and a diff shows what changed rather than what moved.
  const ordered = normalizeDevice({
    id: 'x', mapping: { start: 'button:9', a: 'button:0', up: 'button:12' },
  });
  assert.deepEqual(Object.keys(ordered.mapping), ['up', 'a', 'start']);
  // Anything at all unreadable is simply a project with no controllers.
  assert.deepEqual(normalizeProfile(null), emptyProfile());
  assert.deepEqual(normalizeProfile({ controllers: 'yes' }), emptyProfile());
});

test('assigning a player takes it off whoever had it, and keeps the list still', () => {
  // Three devices, and the *middle* one edited: with two, every wrong way
  // of putting a device back in its place still lands in the right slot by
  // accident, and this is a list somebody is clicking rows in.
  let profile = emptyProfile();
  profile = withDevice(profile, { id: 'a', name: 'A', player: 1, mapping: {} });
  profile = withDevice(profile, { id: 'b', name: 'B', player: 2, mapping: {} });
  profile = withDevice(profile, { id: 'c', name: 'C', player: 3, mapping: {} });
  const before = JSON.parse(JSON.stringify(profile));

  const after = withDevice(profile, { id: 'b', name: 'B', player: 1, mapping: {} });
  assert.deepEqual(profile, before, 'the input is not edited in place');
  assert.deepEqual(
    after.controllers.devices.map((device) => [device.id, device.player]),
    [['a', 0], ['b', 1], ['c', 3]],
    'B took Player 1, A was unassigned, C was untouched, and nothing moved',
  );
  // The first of three, too — the other end of the same mistake.
  assert.deepEqual(
    withDevice(after, { id: 'a', name: 'A', player: 4, mapping: {} })
      .controllers.devices.map((device) => device.id),
    ['a', 'b', 'c'],
  );
  // A device nobody has seen before goes on the end.
  assert.deepEqual(
    withDevice(after, { id: 'd', name: 'D', player: 0, mapping: {} })
      .controllers.devices.map((device) => device.id),
    ['a', 'b', 'c', 'd'],
  );
  // Unassigning does not unassign everyone else.
  const unassigned = withDevice(after, { id: 'b', name: 'B', player: 0, mapping: {} });
  assert.deepEqual(unassigned.controllers.devices.map((d) => d.player), [0, 0, 3]);

  assert.deepEqual(withoutDevice(after, 'a').controllers.devices.map((d) => d.id), ['b', 'c']);
  assert.deepEqual(withoutDevice(after, 'nobody'), after, 'forgetting what is not there is nothing');
});

// ---- the projection onto each machine ------------------------------------
//
// The counts come from the fact sheets the machine packages publish
// (`8bitscript.hardware.facts` in each package.json, printed by
// `8bs targets --json`); the sheets below are those values, so a test that
// passes here is a statement about the real catalog.

const VIC20 = { 'input.keyboard': true, 'input.joysticks': 1, 'input.pads': 0 };
const C64 = { 'input.keyboard': true, 'input.joysticks': 2, 'input.pads': 0 };
const NES = { 'input.keyboard': false, 'input.joysticks': 0, 'input.pads': 2 };
const CX16 = { 'input.keyboard': true, 'input.joysticks': 0, 'input.pads': 2 };
const PET = { 'input.keyboard': true, 'input.joysticks': 0, 'input.pads': 0 };

/** A fully bound reference pad. */
const FULL = deviceFromDetected({ id: 'SN30', mapping: 'standard', buttons: 17, axes: 4 }).mapping;

test('the same profile projects onto a VIC-20, an NES and an X16', () => {
  const vic20 = project('vic20', VIC20, FULL);
  assert.equal(vic20.kind, 'joystick');
  assert.equal(vic20.ports, 1);
  assert.deepEqual(vic20.controls, ['up', 'down', 'left', 'right', 'a'], 'four switches and fire');
  assert.deepEqual(vic20.missing, [], 'the reference pad answers all five');
  assert.ok(vic20.unused.includes('y') && vic20.unused.includes('rt'));

  const nes = project('nes', NES, FULL);
  assert.equal(nes.kind, 'pad.nes');
  assert.equal(nes.ports, 2);
  assert.deepEqual(nes.controls, ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select']);

  const cx16 = project('cx16', CX16, FULL);
  assert.equal(cx16.kind, 'pad.snes');
  assert.ok(cx16.controls.includes('x') && cx16.controls.includes('l'));
  assert.deepEqual(cx16.missing, []);
  // Nothing in the catalog projects a stick or a trigger today, so they
  // are unused everywhere rather than quietly counted as bound.
  for (const entry of [vic20, nes, cx16]) {
    assert.ok(entry.unused.includes('leftStickX'));
  }
});

test('a machine with no ports says so instead of showing an empty row', () => {
  const pet = project('pet', PET, FULL);
  assert.equal(pet.kind, null);
  assert.equal(pet.ports, 0);
  assert.deepEqual(pet.controls, []);
  assert.match(pet.note, /keyboard/, 'the PET has no control ports at all — its layer reads keys');
});

test('a stick-only profile still steers a joystick port', () => {
  const stickOnly = { leftStickX: 'axis:0', leftStickY: 'axis:1', a: 'button:0' };
  const vic20 = project('vic20', VIC20, stickOnly);
  assert.deepEqual(vic20.missing, [], 'the four directions come off the left stick');
  // And a profile with no direction at all is short, and named as short.
  const buttonsOnly = project('vic20', VIC20, { a: 'button:0' });
  assert.deepEqual(buttonsOnly.missing, ['up', 'down', 'left', 'right']);
  assert.deepEqual(buttonsOnly.bound, ['a']);
});

test('player one is read from the port the machine’s own games used', () => {
  // packages/c64/src/joystick.8bs: "port 2 is where a game reads its
  // player, and where every C64 game asked for the stick".
  assert.equal(project('c64', C64, FULL).firstPort, 2);
  assert.equal(PRIMARY_PORT.c128, 2);
  assert.equal(project('vic20', VIC20, FULL).firstPort, 1, 'the VIC-20 has only the one');
});

test('a fitted option changes the projection, because the fact sheet does', () => {
  // packages/atari8/package.json raises input.joysticks to 4 under its
  // multiplexer values; the preview is computed from the resolved sheet,
  // so four ports is what it must show.
  const stock = project('atari8', { 'input.joysticks': 2, 'input.pads': 0 }, FULL);
  const multiplexed = project('atari8', { 'input.joysticks': 4, 'input.pads': 0 }, FULL);
  assert.equal(stock.ports, 2);
  assert.equal(multiplexed.ports, 4);
});

test('a pad port whose shape the toolchain has not said is not guessed at', () => {
  // The count is the toolchain's; what a pad *carries* is the one thing
  // this editor still has to know, and it knows it for exactly the two
  // machines that publish a pad today. A third says so rather than
  // projecting an NES pad onto it.
  assert.deepEqual(Object.keys(PAD_KINDS).sort(), ['cx16', 'nes']);
  const invented = project('somefuturemachine', { 'input.pads': 2 }, FULL);
  assert.equal(invented.kind, null);
  assert.deepEqual(invented.controls, []);
  assert.match(invented.note, /not what pad they take/);
  for (const controls of Object.values(DEVICE_CONTROLS)) {
    for (const control of controls) {
      assert.ok(LOGICAL_CONTROLS.includes(control), `${control} is not a logical control`);
    }
  }
});

test('four players, because that is as many as a pad ever has', () => {
  assert.equal(MAX_PLAYERS, 4);
});

// ---- handing it to the toolchain -----------------------------------------
//
// `packages/cli/src/controllers.mjs` reads a `controllers.players` block
// out of 8bitscript.config.ts and turns it into emulator flags. Its
// `parseBinding` takes `pad0.button3`, `pad0.axis1`, `pad0.axis1-`,
// `pad0.hat0.up` and `key.ArrowLeft`; this end emits the first three,
// because the Gamepad API reports a hat as buttons or as an axis and never
// as a hat, and because a panel that watches a pad has no key to offer.
//
// The grammar is asserted against a copy of that regex rather than by
// importing the CLI: these tests are the editor's and must run with no
// toolchain installed. The copy is cited so the two can be compared.
const CLI_BINDING = /^pad(\d+)\.(button(\d+)|axis(\d+)[+-]?)$/;

test('a binding crosses to the CLI grammar as the same shape, pad named', () => {
  assert.equal(toCliBinding('button:3', 0), 'pad0.button3');
  assert.equal(toCliBinding('axis:1', 2), 'pad2.axis1');
  assert.equal(toCliBinding('axis:1-', 0), 'pad0.axis1-');
  assert.equal(toCliBinding('axis:1+', 1), 'pad1.axis1+');
  assert.equal(toCliBinding('nonsense', 0), null);
});

test('the config block is what 8bs run reads, and only for pads it can see', () => {
  let profile = emptyProfile();
  profile = withDevice(profile, {
    id: 'one', name: 'One', player: 1, mode: 'standard',
    // Only a stick and a fire button: the four directions have to come off
    // the stick, or the block would reach the CLI with nothing to steer.
    mapping: { leftStickX: 'axis:0', leftStickY: 'axis:1', a: 'button:0' },
  });
  profile = withDevice(profile, {
    id: 'two', name: 'Two', player: 2, mode: 'custom', mapping: { a: 'button:1' },
  });
  profile = withDevice(profile, {
    id: 'spare', name: 'Spare', player: 0, mode: 'custom', mapping: { a: 'button:2' },
  });

  const { players } = toCliPlayers(profile, { one: 0, two: 1, spare: 2 });
  assert.equal(players.length, 2, 'an unassigned device is not a player');
  assert.deepEqual(players[0].controls, {
    up: 'pad0.axis1-',
    down: 'pad0.axis1+',
    left: 'pad0.axis0-',
    right: 'pad0.axis0+',
    a: 'pad0.button0',
    leftStickX: 'pad0.axis0',
    leftStickY: 'pad0.axis1',
  });
  assert.deepEqual(players[1].controls, { a: 'pad1.button1' });
  for (const player of players) {
    for (const binding of Object.values(player.controls)) {
      assert.match(binding, CLI_BINDING, `${binding} is not a binding the CLI parses`);
    }
  }
  // Players come out in player order however the file is ordered.
  const reversed = toCliPlayers(
    withDevice(profile, { id: 'two', name: 'Two', player: 1, mapping: { a: 'button:1' } }),
    { one: 0, two: 1 },
  );
  assert.equal(reversed.players[0].controls.a, 'pad1.button1', 'whoever holds Player 1 is first');

  // A device nothing can see has no host pad index, and an invented one
  // would aim an emulator at a port with nothing in it.
  assert.deepEqual(toCliPlayers(profile, {}).players, []);
});

test('the config block is TypeScript somebody can paste', () => {
  const profile = withDevice(emptyProfile(), {
    id: 'one', name: 'One', player: 1, mapping: { a: 'button:0', up: 'button:12' },
  });
  const block = toConfigBlock(profile, { one: 0 });
  assert.match(block, /^ {2}controllers: \{\n {4}players: \[\n/);
  assert.match(block, /^ {10}up: 'pad0\.button12',$/m, 'one binding a line, single-quoted');
  assert.match(block, /\n {2}\},$/, 'and it ends as a trailing-comma property');
  // A profile with nobody assigned still produces something valid rather
  // than nothing, so pasting it is never a syntax error.
  assert.equal(toConfigBlock(emptyProfile(), {}), '  controllers: { players: [] },');
});
