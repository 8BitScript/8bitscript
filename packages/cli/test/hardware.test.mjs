// The hardware catalogs every machine package declares, and how a build's
// hardware is resolved from one: catalog defaults, then a named profile
// (the project's or a preset), then --hardware overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRequire } from 'node:module';

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
  assert.deepEqual(Object.keys(loadCatalog('atari8').presets).sort(), ['1200xl', '130xe', '400', '65xe', '800', '800xl', 'xegs']);
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

test('the Atari splits the machine from the medium: `model` picks the atari800 model, `media` picks the driver, the ROM size and the cartridge type', () => {
  const catalog = loadCatalog('atari8');

  // Stock: an 800XL loading a .xex, which is the SDK's own dos driver and
  // needs no build block at all.
  const stock = resolveHardware(catalog).hardware;
  assert.equal(stock.build.driver, undefined);
  assert.deepEqual(stock.build.defsym, {});
  assert.deepEqual(loadArgs(stock, 'atari800', '/x/m.xex', ['-run', '/x/m.xex']), ['-run', '/x/m.xex']);
  assert.deepEqual(stock.run.atari800, ['-xl', '-mouse', 'off', '-mouseport', '1']);
  assert.equal(stock.facts['storage.save'], true, 'a .xex under a DOS can save through CIO');
  assert.equal(stock.facts['memory.ram'], 40960);
  assert.equal(stock.facts['input.joysticks'], 2);

  // The `xegs` preset is one value on each axis — the console with a 256K
  // cartridge in it — which is what `--profile xegs` meant before the split.
  const { hardware } = resolveHardware(catalog, { profile: 'xegs' });
  assert.deepEqual(hardware.options.model, 'xegs');
  assert.deepEqual(hardware.options.media, 'xegs256');
  assert.equal(hardware.build.driver, 'mos-atari8-cart-xegs-clang');
  assert.equal(hardware.build.output, 'rom');
  assert.deepEqual(hardware.build.defsym, { __cart_rom_size: 256 });
  assert.deepEqual(loadArgs(hardware, 'atari800', '/x/m.rom', ['-run', '/x/m.rom']), ['-cart', '/x/m.rom', '-cart-type', '23']);
  assert.deepEqual(hardware.run.atari800, ['-xegs', '-mouse', 'off', '-mouseport', '1']);

  // Every medium: the driver that links it, the __cart_rom_size its link
  // script asserts on (the std cartridge script has no PROVIDE for it, so
  // the defsym is not optional there), and the atari800 -cart-type that
  // matches the image size — a raw cartridge image has no header, so
  // without the type the emulator stops at its "Select Cartridge Type" menu.
  const MEDIA = {
    cart8: ['mos-atari8-cart-std-clang', 8, '1'],
    cart16: ['mos-atari8-cart-std-clang', 16, '2'],
    xegs32: ['mos-atari8-cart-xegs-clang', 32, '12'],
    xegs64: ['mos-atari8-cart-xegs-clang', 64, '13'],
    xegs128: ['mos-atari8-cart-xegs-clang', 128, '14'],
    xegs256: ['mos-atari8-cart-xegs-clang', 256, '23'],
    xegs512: ['mos-atari8-cart-xegs-clang', 512, '24'],
    mega16: ['mos-atari8-cart-megacart-clang', 16, '26'],
    mega32: ['mos-atari8-cart-megacart-clang', 32, '27'],
    mega64: ['mos-atari8-cart-megacart-clang', 64, '28'],
    mega128: ['mos-atari8-cart-megacart-clang', 128, '29'],
    mega256: ['mos-atari8-cart-megacart-clang', 256, '30'],
    mega512: ['mos-atari8-cart-megacart-clang', 512, '31'],
  };
  for (const [media, [driver, size, type]] of Object.entries(MEDIA)) {
    const h = resolveHardware(catalog, { overrides: { media } }).hardware;
    assert.equal(h.build.driver, driver, media);
    assert.equal(h.build.output, 'rom', media);
    assert.deepEqual(h.build.defsym, { __cart_rom_size: size }, media);
    assert.deepEqual(loadArgs(h, 'atari800', '/x/m.rom', ['-run', '/x/m.rom']), ['-cart', '/x/m.rom', '-cart-type', type], media);
    // A cartridge links against the SDK's $0700-$1FFF window and has no
    // writable storage of its own.
    assert.equal(h.facts['memory.ram'], 6400, media);
    assert.equal(h.facts['storage.save'], false, media);
    assert.deepEqual(h.buildValues, [media], `${media} is the one value that changes the build, so it names the output`);
  }
});

test('the Atari model axis is run-only: every model links the same .xex, and only 400/800 have four joystick ports', () => {
  const catalog = loadCatalog('atari8');
  const FLAG = {
    400: '-atari', 800: '-atari', '1200xl': '-1200', '800xl': '-xl', '65xe': '-xl', '130xe': '-xe', xegs: '-xegs',
  };
  for (const [model, flag] of Object.entries(FLAG)) {
    const h = resolveHardware(catalog, { overrides: { model } }).hardware;
    assert.deepEqual(h.run.atari800, [flag, '-mouse', 'off', '-mouseport', '1'], model);
    assert.equal(h.build.driver, undefined, `${model} still links the stock .xex driver`);
    assert.deepEqual(h.buildValues, [], `${model} changes nothing about the build, so it never names the output`);
    assert.equal(h.facts['input.joysticks'], model === '400' || model === '800' ? 4 : 2, model);
  }
  // Only the 130XE has extended RAM, and only it names a probe for it.
  const xe = resolveHardware(catalog, { overrides: { model: '130xe' } }).hardware;
  assert.equal(xe.facts['memory.banked'], true);
  assert.equal(xe.facts['memory.bankedKib'], 64);
  assert.equal(resolveHardware(catalog, { overrides: { model: '800xl' } }).hardware.facts['memory.banked'], false);
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
  // `-mouse` is VICE's mouse *grab* ("Enable mouse grab" in x64sc -help), and
  // it rides with the 1351 rather than being a separate option: without it
  // the emulator never feeds host pointer movement to the device in the
  // port, so a program fitted with a mouse would find one that never moves.
  assert.deepEqual(hardware.run.x64sc, ['-reu', '-reusize', '512', '-sidmodel', '1', '-controlport1device', '3', '-mouse', '-controlport2device', '1']);
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

// The fact sheets: every catalog's stock facts cover every key a program
// can read (a fact is never missing), every fact anywhere in a catalog is
// a key the compiler knows with a value of its type, and the CLI's stock
// sheet is the catalog's own merged for its defaults.
import { FACTS, PROGRAM_FACTS, factProblems } from '@8bitscript/compiler';
import { projectHardware, stockFacts } from '../src/hardware.mjs';

test('every catalog declares every program fact for the stock machine, and only known facts anywhere', () => {
  for (const machine of MACHINES) {
    const catalog = loadCatalog(machine);
    assert.deepEqual(factProblems(catalog.facts), [], `${machine}: catalog facts`);
    const missing = PROGRAM_FACTS.filter((key) => !Object.hasOwn(catalog.facts, key));
    assert.deepEqual(missing, [], `${machine}: a fact is never missing — declare it, 0 or false if the machine lacks the thing`);
    for (const [id, option] of Object.entries(catalog.options)) {
      for (const [value, entry] of Object.entries(option.values)) {
        assert.deepEqual(factProblems(entry.facts ?? {}), [], `${machine} ${id}=${value}`);
        for (const key of Object.keys(entry.facts ?? {})) assert.ok(FACTS.has(key), `${machine} ${id}=${value}: ${key}`);
      }
    }
  }
});

test('stockFacts is the catalog\'s sheet with each default value\'s facts merged; a value changes it', () => {
  assert.deepEqual(stockFacts('c64'), resolveHardware(loadCatalog('c64'), {}).hardware.facts);
  assert.equal(stockFacts('c64')['video.sprites'], 8);
  assert.equal(stockFacts('c64')['memory.banked'], false);
  const reu = resolveHardware(loadCatalog('c64'), { profile: 'reu512' }).hardware.facts;
  assert.equal(reu['memory.banked'], true);
  assert.equal(reu['memory.bankedKib'], 512);
  assert.equal(reu['video.sprites'], 8, 'the rest of the sheet is untouched');
  assert.equal(stockFacts('pet')['video.columns'], 40);
  assert.equal(stockFacts('nes')['input.keyboard'], false);
  assert.equal(stockFacts('vic20')['memory.ram'], 3583, 'the unexpanded VIC-20');
  assert.equal(resolveHardware(loadCatalog('vic20'), { profile: '8k' }).hardware.facts['memory.ram'], 11775);
});

test('a project\'s own hardware for a target sits under a profile and under --hardware', () => {
  const config = { targets: { pet: { hardware: { model: '8032' }, profiles: { small: { model: '3008' } } }, c64: {} } };
  assert.deepEqual(projectHardware(config, 'pet'), { model: '8032' });
  assert.deepEqual(projectHardware(config, 'c64'), {});
  assert.deepEqual(projectHardware(null, 'pet'), {});
  assert.deepEqual(projectHardware({ targets: ['pet'] }, 'pet'), {});
  const catalog = loadCatalog('pet');
  const defaults = projectHardware(config, 'pet');
  const profiles = projectProfiles(config, 'pet');
  assert.equal(resolveHardware(catalog, { defaults }).hardware.options.model, '8032', 'the project\'s default');
  assert.equal(resolveHardware(catalog, { defaults }).hardware.facts['video.columns'], 80);
  assert.deepEqual(resolveHardware(catalog, { defaults }).hardware.tags, ['8032']);
  assert.equal(resolveHardware(catalog, { defaults, profiles, profile: 'small' }).hardware.options.model, '3008', 'a profile over it');
  assert.equal(resolveHardware(catalog, { defaults, profiles, profile: 'small', overrides: { model: '4032' } }).hardware.options.model, '4032', '--hardware over both');
  const bad = resolveHardware(catalog, { defaults: { model: 'nope' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /'nope' is not a value .* \(from this project's hardware\)/);
});

test('every detect names a subpath its own machine package really exports, on the option or on one value', () => {
  const require_ = createRequire(import.meta.url);
  const found = [];
  for (const machine of MACHINES) {
    const catalog = loadCatalog(machine);
    for (const [id, option] of Object.entries(catalog.options)) {
      const probes = [[option.detect, id]];
      for (const [value, entry] of Object.entries(option.values)) probes.push([entry.detect, `${id}=${value}`]);
      for (const [detect, where] of probes) {
        if (detect === undefined) continue;
        found.push(`${machine} ${where} -> ${detect}`);
        const parts = /^@8bitscript\/([a-z0-9]+)\/(.+)$/.exec(detect);
        assert.ok(parts, `${machine} ${where}: '${detect}' is not a package subpath`);
        assert.equal(parts[1], machine, `${machine} ${where}: a probe lives in its own machine's package`);
        const pkg = require_(`@8bitscript/${machine}/package.json`);
        assert.ok(pkg['8bitscript'].exports[`./${parts[2]}`], `${machine} ${where}: ${detect} is exported`);
      }
    }
  }
  found.sort();
  assert.deepEqual(found, [
    // On the option: one probe finds every value of it.
    'c64 ram -> @8bitscript/c64/reu',
    'c128 vdc -> @8bitscript/c128/vdc',
    'cx16 ram -> @8bitscript/cx16/banks',
    // On one value: its siblings are a different build, or nothing to find.
    'c64 port1=mouse1351 -> @8bitscript/c64/mouse',
    'c64 port2=mouse1351 -> @8bitscript/c64/mouse',
    'c128 ram=256k -> @8bitscript/c128/banks',
    'atari8 model=130xe -> @8bitscript/atari8/banks',
  ].sort(), 'every probe that exists');
});
