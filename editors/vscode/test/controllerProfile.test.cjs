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
  CANCEL_KEY, CONTROL_KINDS, CONTROL_LABELS, DEADZONE, LOGICAL_CONTROLS, MAX_PLAYERS,
  PRESS_THRESHOLD, PRIMARY_PORT, STANDARD_MAPPING, WALKTHROUGH,
  activeInputs, capture, controllerKind, deviceFromDetected, deviceKey, deviceKeys, emptyProfile,
  formatBinding, isKeyBinding,
  normalizeDevice, normalizeProfile, parseBinding, pressed, project: projectWith, readBinding,
  resolveDirection, withDevice, withoutDevice,
} = require('../src/controllerProfile.cjs');

// The controller shapes that have a name, taken from the toolchain itself
// rather than copied here. `8bs targets --json` publishes this table on the
// `input.controls` fact's description (packages/compiler/src/fold/facts.mjs,
// CONTROLLER_KINDS) and controllerView.cjs hands it to `project()`; a copy
// in this file would pass while the editor and the toolchain disagreed,
// which is the exact failure the two deleted tables used to be.
//
// This is the one place a test in this extension reaches across the
// monorepo, and it is a deliberate one: it is a *cross-check*, not a
// dependency — the extension itself imports nothing (its package.json has
// no `dependencies` at all) and only ever sees this table as JSON.
const { CONTROLLER_KINDS } = require('../../../packages/compiler/index.mjs');

/** As controllerView.cjs calls it: the toolchain's kinds always in hand. */
const project = (target, facts, mapping, catalog = {}) => projectWith(
  target,
  facts,
  mapping,
  { kinds: JSON.parse(JSON.stringify(CONTROLLER_KINDS)), ...catalog },
);

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

test('parseBinding takes the four shapes there are, and nothing else', () => {
  assert.deepEqual(parseBinding('button:0'), { source: 'button', index: 0, half: null, key: null });
  assert.deepEqual(parseBinding('axis:1'), { source: 'axis', index: 1, half: null, key: null });
  assert.deepEqual(parseBinding('axis:1+'), { source: 'axis', index: 1, half: '+', key: null });
  assert.deepEqual(parseBinding('axis:1-'), { source: 'axis', index: 1, half: '-', key: null });
  // The fourth shape, and the only one atari800 can take a mapping in at
  // all — its `-kbdjoy0/1` binds an emulated stick to emulated keys, and a
  // real pad's buttons reach nothing. Same character class as the CLI's
  // own parser, so a name one end writes the other reads.
  assert.deepEqual(parseBinding('key:ArrowLeft'), { source: 'key', index: null, half: null, key: 'ArrowLeft' });
  assert.deepEqual(parseBinding(' key:Enter '), { source: 'key', index: null, half: null, key: 'Enter' });
  assert.equal(parseBinding('key:'), null);
  assert.equal(parseBinding('key:Arrow Left'), null, 'a DOM key code has no spaces');
  // A button has no halves; reading `button:3-` as `button:3` would hide a typo.
  assert.equal(parseBinding('button:3-'), null);
  for (const junk of ['', 'a', 'button:', 'button:-1', 'axis:x', 'trigger:0', null, 7, {}]) {
    assert.equal(parseBinding(junk), null, `${JSON.stringify(junk)} should not parse`);
  }
  for (const binding of ['button:0', 'axis:1', 'axis:1+', 'axis:1-', 'key:ArrowLeft']) {
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
  const state = { buttons: [0, 1, 0.2, 0.9], axes: [0.05, -0.8], keys: ['KeyZ'] };
  assert.deepEqual(activeInputs(state), {
    buttons: [1, 3],
    axes: [{ index: 1, value: -0.8 }],
    // Held keys ride along: a `key:` binding is a real binding, so a live
    // view that left them out would show a control lighting with nothing
    // on the page to explain why.
    keys: ['KeyZ'],
  });
  assert.deepEqual(activeInputs(rest()), { buttons: [], axes: [], keys: [] });
  // A Set is what the page keeps; an array is what a test writes.
  assert.deepEqual(activeInputs({ keys: new Set(['KeyA']) }).keys, ['KeyA']);
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

test('two of the same controller are two controllers', () => {
  // Two 8BitDo SN30 Pros report byte-identical id strings, and that is the
  // ordinary Player 1 + Player 2 setup rather than an edge case. Keying on
  // the id alone would give them one profile between them and silently
  // drop the second.
  const id = '8BitDo SN30 Pro (Vendor: 2dc8 Product: 6001)';
  const keys = deviceKeys([id, id, 'Some Arcade Stick', id]);
  assert.deepEqual(keys, [
    '8bitdo-sn30-pro-vendor-2dc8-product-6001',
    '8bitdo-sn30-pro-vendor-2dc8-product-6001#2',
    'some-arcade-stick',
    '8bitdo-sn30-pro-vendor-2dc8-product-6001#3',
  ]);
  assert.deepEqual(deviceKeys([]), []);
  assert.deepEqual(deviceKeys(undefined), []);
  // And the rows are not two identical lines in a list.
  const second = deviceFromDetected({ id, key: keys[1], mapping: 'standard', buttons: 17, axes: 4 });
  assert.equal(second.id, keys[1]);
  assert.match(second.name, /#2$/);
  // Both can be stored, and both can be players.
  let profile = emptyProfile();
  profile = withDevice(profile, { ...deviceFromDetected({ id, key: keys[0], mapping: 'standard', buttons: 17, axes: 4 }), player: 1 });
  profile = withDevice(profile, { ...second, player: 2 });
  assert.equal(profile.controllers.devices.length, 2);
  assert.deepEqual(profile.controllers.devices.map((d) => d.player), [1, 2]);
  // The CLI takes the host joystick number from the player number minus
  // one (packages/cli/src/controllers.mjs's controllerPlayers), so two
  // distinct players is the whole of what this end has to get right.
  assert.notEqual(profile.controllers.devices[0].id, profile.controllers.devices[1].id);
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

const STICK = ['up', 'down', 'left', 'right', 'a'];
const VIC20 = { 'input.keyboard': true, 'input.joysticks': 1, 'input.pads': 0, 'input.controls': STICK };
const C64 = { 'input.keyboard': true, 'input.joysticks': 2, 'input.pads': 0, 'input.controls': STICK };
const NES = {
  'input.keyboard': false,
  'input.joysticks': 0,
  'input.pads': 2,
  'input.controls': ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start'],
};
const CX16 = {
  'input.keyboard': true,
  'input.joysticks': 0,
  'input.pads': 2,
  'input.controls': ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'],
};
const PET = { 'input.keyboard': true, 'input.joysticks': 0, 'input.pads': 0, 'input.controls': [] };

/** A fully bound reference pad. */
const FULL = deviceFromDetected({ id: 'SN30', mapping: 'standard', buttons: 17, axes: 4 }).mapping;

test('the same profile projects onto a VIC-20, an NES and an X16', () => {
  const vic20 = project('vic20', VIC20, FULL);
  assert.equal(vic20.kind, 'atari-stick');
  assert.equal(vic20.ports, 1);
  assert.deepEqual(vic20.controls, ['up', 'down', 'left', 'right', 'a'], 'four switches and fire');
  assert.deepEqual(vic20.missing, [], 'the reference pad answers all five');
  assert.ok(vic20.unused.includes('y') && vic20.unused.includes('rt'));

  const nes = project('nes', NES, FULL);
  assert.equal(nes.kind, 'nes-pad');
  assert.equal(nes.ports, 2);
  assert.deepEqual(nes.controls, ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select']);

  const cx16 = project('cx16', CX16, FULL);
  assert.equal(cx16.kind, 'snes-pad');
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

test('player one is read from the port the toolchain names', () => {
  // `8bs targets --json` publishes `primaryPort` per machine, and it wins.
  assert.equal(project('vic20', VIC20, FULL, { primaryPort: 2 }).firstPort, 2);
  // Only a toolchain too old to say falls back to the table here, which is
  // the two machines packages/c64/src/joystick.8bs documents: "port 2 is
  // where a game reads its player, and where every C64 game asked for the
  // stick".
  assert.equal(project('c64', C64, FULL).firstPort, 2);
  assert.equal(PRIMARY_PORT.c128, 2);
  assert.deepEqual(Object.keys(PRIMARY_PORT).sort(), ['c128', 'c64'], 'and no machine it is a guess for');
  assert.equal(project('vic20', VIC20, FULL).firstPort, 1, 'the VIC-20 has only the one');
});

test('a fitted option changes the projection, because the fact sheet does', () => {
  // packages/atari8/package.json raises input.joysticks to 4 under its
  // multiplexer values; the preview is computed from the resolved sheet,
  // so four ports is what it must show.
  const stock = project('atari8', { 'input.joysticks': 2, 'input.pads': 0, 'input.controls': STICK }, FULL);
  const multiplexed = project('atari8', { 'input.joysticks': 4, 'input.pads': 0, 'input.controls': STICK }, FULL);
  assert.equal(stock.ports, 2);
  assert.equal(multiplexed.ports, 4);
});

test('a port whose contents the toolchain has not said is not guessed at', () => {
  // This editor used to carry the answer itself, for exactly the two
  // machines that publish a pad; a third was named as unknown rather than
  // guessed at. The catalogs answer now, and the rule survives the move: a
  // machine with ports and no `input.controls` gets a sentence, not an
  // invented pad. That covers both an older `@8bitscript/cli` and a
  // Commodore with nothing plugged into either port.
  const invented = project('somefuturemachine', { 'input.pads': 2 }, FULL);
  assert.equal(invented.kind, null);
  assert.deepEqual(invented.controls, []);
  assert.match(invented.note, /nothing about what is in them/);

  // A machine whose ports are empty because they were emptied. The C64's
  // catalog puts the stick on the `joystick` value of a control port, so
  // `--hardware port1=none,port2=none` really does resolve to no controls.
  const unplugged = project('c64', { ...C64, 'input.controls': [] }, FULL);
  assert.equal(unplugged.kind, null);
  assert.match(unplugged.note, /nothing about what is in them/);

  // And a toolchain too old to publish the shapes: the controls are still
  // the machine's, so the row is still right — only the *name* for the
  // shape is missing, and it is missing rather than guessed.
  const noKinds = projectWith('c64', C64, FULL, { primaryPort: 2 });
  assert.equal(noKinds.kind, null);
  assert.deepEqual(noKinds.controls, STICK, 'the controls do not depend on the shape having a name');
});

test('a kind is derived from the controls, and an unnamed shape has no name', () => {
  // The point of deriving: a machine gets its kind by listing what its
  // controller carries, and a device that matches a shape already in the
  // table is recognised without a line of code changing at either end.
  const kinds = CONTROLLER_KINDS;
  assert.deepEqual(kinds.map((entry) => entry.kind), ['atari-stick', 'nes-pad', 'snes-pad', 'xbox-style']);
  for (const { controls } of kinds) {
    for (const control of controls) {
      assert.ok(LOGICAL_CONTROLS.includes(control), `${control} is not a logical control`);
    }
    assert.deepEqual([...new Set(controls)], controls, 'a shape names each control once');
  }
  // Order is a readability choice in a catalog (an NES pad is listed in
  // its shift register's order), never a different device.
  assert.equal(controllerKind(['a', 'right', 'left', 'down', 'up'], kinds), 'atari-stick');
  assert.equal(controllerKind(LOGICAL_CONTROLS, kinds), 'xbox-style');
  // Exact set equality, not "has at least these": a two-button stick is
  // not an NES pad just because it clears the bar for `a` and `b`.
  assert.equal(controllerKind(['up', 'down', 'left', 'right', 'a', 'b'], kinds), null);
  assert.equal(controllerKind([], kinds), null);
  assert.equal(controllerKind(STICK, undefined), null, 'no table, no name');
});

test('four players, because that is as many as a pad ever has', () => {
  assert.equal(MAX_PLAYERS, 4);
});

// ---- a keyboard key is a first-class binding -----------------------------
//
// Not a special case bolted on. It is the only shape atari800 takes a
// joystick mapping in, so on that machine it is *the* binding, and the
// three questions that are not "what is the pad doing" have to see it:
// is this control answered at all, is this direction bound, and does the
// table say a name or say "not bound".

test('a key binding is read, pressed, and captured like any other', () => {
  const holding = { buttons: [0, 0], axes: [0, 0], keys: ['ArrowUp', 'KeyZ'] };
  assert.equal(readBinding('key:ArrowUp', holding), 1);
  assert.equal(readBinding('key:KeyQ', holding), 0);
  assert.equal(readBinding('key:ArrowUp', { keys: new Set(['ArrowUp']) }), 1, 'a Set reads too');
  assert.equal(pressed('key:ArrowUp', holding), true);
  assert.equal(pressed('key:KeyQ', holding), false);
  assert.equal(pressed('key:ArrowUp', rest()), false);

  assert.equal(capture(holding), 'key:ArrowUp', 'a held key can be bound');
  // A pad a person is holding wins over a key they are leaning on.
  assert.equal(capture({ buttons: [1], axes: [], keys: ['KeyZ'] }), 'button:0');
  // No key and no button is a push, so an axis step takes neither.
  assert.equal(capture(holding, { wantsAxis: true }), null);
  // Escape is what cancels a walkthrough; one that bound its own way out
  // would be unusable. It can still be hand-written into the file.
  assert.equal(capture({ buttons: [], axes: [], keys: [CANCEL_KEY] }), null);
  assert.equal(CANCEL_KEY, 'Escape');
  assert.ok(parseBinding(`key:${CANCEL_KEY}`), 'and it round-trips when it is');
});

test('a keyboard stick survives a save, and reads as bound everywhere', () => {
  // The trap this closes: `normalizeDevice` rebuilds `mapping` from the
  // bindings it recognises, and the panel saves on every change — so a
  // hand-written Atari stick used to last exactly until somebody opened
  // the panel and pressed one button.
  const atari = {
    up: 'key:ArrowUp',
    down: 'key:ArrowDown',
    left: 'key:ArrowLeft',
    right: 'key:ArrowRight',
    a: 'key:ControlLeft',
  };
  const device = normalizeDevice({ id: 'kbd', name: 'Keyboard', player: 1, mapping: atari });
  assert.deepEqual(device.mapping, atari, 'every key survives the rewrite');
  const round = normalizeProfile({ controllers: { devices: [device] } });
  assert.deepEqual(round.controllers.devices[0].mapping, atari);

  // A direction bound to a key is bound *explicitly*, and must not read as
  // having come from a stick that is also bound.
  assert.deepEqual(
    resolveDirection({ ...atari, leftStickY: 'axis:1' }, 'up'),
    { binding: 'key:ArrowUp', from: 'explicit' },
  );

  // And the machine it was written for sees a complete stick rather than
  // four red gaps — which is what the panel showed while `key:` was held
  // at arm's length from parseBinding.
  const atari8 = project('atari8', { 'input.joysticks': 2, 'input.pads': 0, 'input.controls': STICK }, atari);
  assert.deepEqual(atari8.missing, [], 'the Atari reads all five');
  assert.deepEqual(atari8.bound, ['up', 'down', 'left', 'right', 'a']);
  assert.deepEqual(project('vic20', VIC20, atari).missing, [], 'and so does a VIC-20');
});
