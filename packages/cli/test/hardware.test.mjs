// The hardware catalogs every machine package declares, and how a build's
// hardware is resolved from one: catalog defaults, then a named profile
// (the project's or a preset), then --hardware overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MACHINES } from '@8bitscript/compiler';

import {
  loadCatalog, resolveHardware, parseHardwareArg, projectProfiles, listedTargets, loadArgs,
} from '../src/hardware.mjs';

const EMULATOR = {
  vic20: 'xvic', c64: 'x64sc', pet: 'xpet', c128: 'x128', atari8: 'atari800', nes: 'fceux', cx16: 'x16emu', mega65: 'xmega65',
};

test('every machine has a catalog; every value names only its own emulator, and every preset names real values', () => {
  for (const machine of MACHINES) {
    const catalog = loadCatalog(machine);
    for (const [id, option] of Object.entries(catalog.options)) {
      assert.ok(option.label, `${machine}.${id} has a label`);
      assert.ok(Object.hasOwn(option.values, option.default), `${machine}.${id}: default '${option.default}' is a value`);
      for (const [value, entry] of Object.entries(option.values)) {
        assert.ok(entry.label, `${machine}.${id}=${value} has a label`);
        for (const emulator of Object.keys({ ...entry.run, ...entry.load })) {
          assert.equal(emulator, EMULATOR[machine], `${machine}.${id}=${value} names its own emulator`);
        }
        if (entry.load) assert.ok(entry.load[EMULATOR[machine]].includes('{out}'), `${machine}.${id}=${value}: load names {out}`);
      }
    }
    for (const [name, values] of Object.entries(catalog.presets)) {
      for (const [id, value] of Object.entries(values)) {
        assert.ok(catalog.options[id]?.values[value], `${machine} preset '${name}' sets ${id}=${value}, which exists`);
      }
    }
  }
});

test('the catalog defaults are the stock machine: no tags, no build values, and the presets that existed as --profile names still do', () => {
  const stock = resolveHardware(loadCatalog('vic20'));
  assert.ok(stock.ok);
  assert.deepEqual(stock.hardware.tags, []);
  assert.deepEqual(stock.hardware.buildValues, []);
  assert.deepEqual(stock.hardware.build.defsym, { __memory_expansion: 0 });
  assert.equal(stock.hardware.label, 'stock');
  assert.deepEqual(Object.keys(loadCatalog('vic20').presets), ['unexpanded', '3k', '8k', '16k', '24k']);
  assert.deepEqual(Object.keys(loadCatalog('pet').presets).sort(), ['3008', '3016', '3032', '4016', '4032', '8032']);
  assert.deepEqual(Object.keys(loadCatalog('atari8').presets).sort(), ['130xe', '400', '65xe', '800', '800xl', 'xegs']);
  assert.ok(Object.keys(loadCatalog('c64').presets).includes('reu512'));
});

test('a preset resolves to its values: the VIC-20 8k, 16k and 24k all carry the one `expanded` tag, and their own name for the build', () => {
  for (const [preset, kb] of [['8k', 8], ['16k', 16], ['24k', 24]]) {
    const { ok, hardware } = resolveHardware(loadCatalog('vic20'), { profile: preset });
    assert.ok(ok);
    assert.deepEqual(hardware.tags, ['expanded'], preset);
    assert.deepEqual(hardware.buildValues, [preset]);
    assert.deepEqual(hardware.build.defsym, { __memory_expansion: kb });
    assert.deepEqual(hardware.run.xvic, ['-memory', preset, '-controlport1device', '1']);
  }
  const three = resolveHardware(loadCatalog('vic20'), { profile: '3k' }).hardware;
  assert.deepEqual(three.tags, ['3k']);
});

test('the PET model is a build (RAM), a run flag, a tag, and facts', () => {
  const { hardware } = resolveHardware(loadCatalog('pet'), { profile: '8032' });
  assert.deepEqual(hardware.tags, ['8032']);
  assert.deepEqual(hardware.build.defsym, { __ram_size: 32 });
  assert.deepEqual(hardware.run.xpet, ['-model', '8032']);
  assert.equal(hardware.facts['video.columns'], 80);
  assert.equal(hardware.facts['video.frameRate'], 50);
  const stock = resolveHardware(loadCatalog('pet')).hardware;
  assert.deepEqual(stock.run.xpet, ['-model', '3032']);
  assert.equal(stock.facts['video.columns'], 40);
});

test('the Atari XEGS changes the driver, the output, and how atari800 loads the file', () => {
  const { hardware } = resolveHardware(loadCatalog('atari8'), { profile: 'xegs' });
  assert.equal(hardware.build.driver, 'mos-atari8-cart-xegs-clang');
  assert.equal(hardware.build.output, 'rom');
  assert.deepEqual(loadArgs(hardware, 'atari800', '/x/m.rom', ['-run', '/x/m.rom']), ['-cart', '/x/m.rom', '-cart-type', '23']);
  const stock = resolveHardware(loadCatalog('atari8')).hardware;
  assert.equal(stock.build.driver, undefined);
  assert.deepEqual(loadArgs(stock, 'atari800', '/x/m.xex', ['-run', '/x/m.xex']), ['-run', '/x/m.xex']);
  assert.deepEqual(stock.run.atari800, ['-xl', '-mouse', 'off']);
});

test('--hardware sets options on top of a profile; a mouse in a port is a fact', () => {
  const { ok, hardware } = resolveHardware(loadCatalog('c64'), {
    profile: 'reu512', overrides: { port1: 'mouse1351', sid: '8580' },
  });
  assert.ok(ok);
  assert.deepEqual(hardware.options, { ram: 'reu512', sid: '8580', port1: 'mouse1351', port2: 'joystick' });
  assert.deepEqual(hardware.tags, ['reu512', '8580', 'mouse1351']);
  assert.deepEqual(hardware.buildValues, [], 'nothing on the C64 changes the build');
  assert.equal(hardware.facts['input.mouse'], true);
  assert.equal(hardware.facts['memory.banked'], true);
  assert.deepEqual(hardware.run.x64sc, ['-reu', '-reusize', '512', '-sidmodel', '1', '-controlport1device', '3', '-controlport2device', '1']);
  assert.equal(hardware.label, 'ram=reu512 sid=8580 port1=mouse1351');
});

test('a project profile shadows a catalog preset of the same name, and unknown names or values are refused with the lists', () => {
  const catalog = loadCatalog('vic20');
  const profiles = { '8k': { ram: '24k' }, big: { ram: '16k', port1: 'paddles' } };
  assert.equal(resolveHardware(catalog, { profile: '8k', profiles }).hardware.options.ram, '24k');
  assert.equal(resolveHardware(catalog, { profile: 'big', profiles }).hardware.options.port1, 'paddles');
  const unknown = resolveHardware(catalog, { profile: 'huge', profiles });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown vic20 profile 'huge'\. Profiles: 8k, big, unexpanded, 3k/);
  const badOption = resolveHardware(catalog, { overrides: { sid: '8580' } });
  assert.match(badOption.error, /has no 'sid' option \(from --hardware\)\. Options: ram, port1/);
  const badValue = resolveHardware(catalog, { overrides: { ram: '32k' } });
  assert.match(badValue.error, /'32k' is not a value the vic20's 'ram' option takes/);
  const none = resolveHardware(loadCatalog('web'), { profile: 'x' });
  assert.match(none.error, /has no profiles to choose from/);
});

test('parseHardwareArg and the config helpers', () => {
  assert.deepEqual(parseHardwareArg('ram=8k, port1=mouse1351'), { ok: true, overrides: { ram: '8k', port1: 'mouse1351' } });
  assert.equal(parseHardwareArg('ram').ok, false);
  const config = { targets: { c64: { profiles: { loaded: { ram: 'reu512' } } }, web: {} } };
  assert.deepEqual(projectProfiles(config, 'c64'), { loaded: { ram: 'reu512' } });
  assert.deepEqual(projectProfiles(config, 'web'), {});
  assert.deepEqual(projectProfiles({ targets: ['c64'] }, 'c64'), {});
  assert.deepEqual(listedTargets(config), ['c64', 'web']);
  assert.deepEqual(listedTargets({ targets: ['vic20'] }), ['vic20']);
  assert.equal(listedTargets(null), null);
});
