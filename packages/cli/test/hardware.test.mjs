// The hardware catalogs every machine package declares, and how a build's
// hardware is resolved from one: catalog defaults, then a named profile
// (the project's or a preset), then --hardware overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRequire } from 'node:module';

import { MACHINES } from '@8bitscript/compiler';

import {
  loadCatalog, resolveHardware, parseHardwareArg, projectProfiles, projectRequires, projectSystems,
  listedTargets, loadArgs, whatSatisfies, hardwareArgs,
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
    for (const emulator of Object.keys(catalog.run ?? {})) {
      assert.equal(emulator, EMULATOR[machine], `${machine} stock run names its own emulator`);
    }
    for (const [name, values] of Object.entries(catalog.presets)) {
      for (const [id, value] of Object.entries(values)) {
        assert.ok(catalog.options[id]?.values[value], `${machine} preset '${name}' sets ${id}=${value}, which exists`);
      }
    }
  }
});

test('stock X16 run captures the host mouse, the same job VICE -mouse does for a 1351', () => {
  // x16emu's -capture is mouse grab. Without it the KERNAL pointer only
  // tracks while the host cursor is over the window, and the mapping is
  // absolute so the arrow leaves the picture before the host cursor hits
  // the window edge. Ctrl+M toggles the same grab.
  const { hardware } = resolveHardware(loadCatalog('cx16'));
  assert.deepEqual(hardware.run.x16emu, ['-ram', '512', '-capture']);
});

test('the catalog defaults are the stock machine: no tags, no build values, and the presets that existed as --profile names still do', () => {
  const stock = resolveHardware(loadCatalog('vic20'));
  assert.ok(stock.ok);
  assert.deepEqual(stock.hardware.tags, []);
  assert.deepEqual(stock.hardware.buildValues, []);
  assert.deepEqual(stock.hardware.build.defsym, { __memory_expansion: 0 });
  assert.equal(stock.hardware.label, 'stock');
  assert.deepEqual(Object.keys(loadCatalog('vic20').presets), ['unexpanded', '3k', '8k', '16k', '24k']);
  assert.deepEqual(Object.keys(loadCatalog('pet').presets).sort(), ['2001', '3008', '3016', '3032', '4016', '4032', '8032']);
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

test('the PET 2001 needs an explicit -ramsize alongside -model: unlike every other PET model name, "2001" alone does not tell VICE how much RAM to give it', () => {
  const { hardware } = resolveHardware(loadCatalog('pet'), { profile: '2001' });
  assert.deepEqual(hardware.run.xpet, ['-model', '2001', '-ramsize', '4']);
  assert.deepEqual(hardware.build.defsym, { __ram_size: 4 });
  assert.equal(hardware.facts['memory.ram'], 3071, 'measured under VICE: 4096 - $0401, confirmed on screen as "3071 BYTES FREE"');
});

test('the Atari splits the machine from the medium: `model` picks the atari800 model, `media` picks the startup, the ROM size and the cartridge type', () => {
  const catalog = loadCatalog('atari8');

  // Stock: an 800XL loading a .xex, which is the stock DOS-style load and
  // needs no build block at all.
  const stock = resolveHardware(catalog).hardware;
  assert.equal(stock.build.startup, undefined);
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
  assert.equal(hardware.build.startup, 'cart-xegs');
  assert.equal(hardware.build.output, 'rom');
  assert.deepEqual(hardware.build.defsym, { __cart_rom_size: 256 });
  assert.deepEqual(loadArgs(hardware, 'atari800', '/x/m.rom', ['-run', '/x/m.rom']), ['-cart', '/x/m.rom', '-cart-type', '23']);
  assert.deepEqual(hardware.run.atari800, ['-xegs', '-mouse', 'off', '-mouseport', '1']);

  // Every medium: the startup shape that links it, the __cart_rom_size its
  // link script asserts on (the std cartridge script has no PROVIDE for
  // it, so the defsym is not optional there), and the atari800 -cart-type
  // that matches the image size — a raw cartridge image has no header, so
  // without the type the emulator stops at its "Select Cartridge Type" menu.
  const MEDIA = {
    cart8: ['cart-std', 8, '1'],
    cart16: ['cart-std', 16, '2'],
    xegs32: ['cart-xegs', 32, '12'],
    xegs64: ['cart-xegs', 64, '13'],
    xegs128: ['cart-xegs', 128, '14'],
    xegs256: ['cart-xegs', 256, '23'],
    xegs512: ['cart-xegs', 512, '24'],
    mega16: ['cart-megacart', 16, '26'],
    mega32: ['cart-megacart', 32, '27'],
    mega64: ['cart-megacart', 64, '28'],
    mega128: ['cart-megacart', 128, '29'],
    mega256: ['cart-megacart', 256, '30'],
    mega512: ['cart-megacart', 512, '31'],
  };
  for (const [media, [startup, size, type]] of Object.entries(MEDIA)) {
    const h = resolveHardware(catalog, { overrides: { media } }).hardware;
    assert.equal(h.build.startup, startup, media);
    assert.equal(h.build.output, 'rom', media);
    assert.deepEqual(h.build.defsym, { __cart_rom_size: size }, media);
    assert.deepEqual(loadArgs(h, 'atari800', '/x/m.rom', ['-run', '/x/m.rom']), ['-cart', '/x/m.rom', '-cart-type', type], media);
    // A cartridge links against the $0700-$1FFF window and has no
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
    assert.equal(h.build.startup, undefined, `${model} still links the stock .xex`);
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
  assert.deepEqual(hardware.options, { ram: 'reu512', sid: '8580', port1: 'mouse1351', port2: 'joystick', drive: '1541' });
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

test('hardwareArgs collects --profile and repeating --hardware, and names a missing value', () => {
  const ok = hardwareArgs(['--target', 'pet', '--profile', '8032', '--hardware', 'model=4032', 'src/main.8bs']);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.profile, '8032');
  assert.deepEqual(ok.overrides, { model: '4032' });
  assert.deepEqual([...ok.consumed].sort((a, b) => a - b), [2, 3, 4, 5]);

  const twice = hardwareArgs(['--hardware', 'ram=8k', '--hardware', 'port1=mouse1351']);
  assert.equal(twice.ok, true);
  if (!twice.ok) return;
  assert.deepEqual(twice.overrides, { ram: '8k', port1: 'mouse1351' });

  assert.equal(hardwareArgs(['--profile']).ok, false);
  assert.match(hardwareArgs(['--profile']).ok ? '' : hardwareArgs(['--profile']).error, /--profile expects a name/);
  assert.equal(hardwareArgs(['--hardware']).ok, false);
  assert.match(hardwareArgs(['--hardware']).ok ? '' : hardwareArgs(['--hardware']).error, /--hardware expects option=value/);
  assert.equal(hardwareArgs(['--hardware', 'ram']).ok, false);
});

// The `systems` block: whole machines a project has been set up for, each
// one of its targets with the hardware already fitted. Every entry is
// checked here, because a system the config names and the editor silently
// drops is worse to debug than an error.
test('a project\'s systems resolve to the command line each one stands for', () => {
  const config = {
    targets: { c64: { hardware: { port1: 'mouse1351' }, profiles: { loaded: { ram: 'reu512' } } }, vic20: {}, web: {} },
    systems: {
      'C64 with an REU': { target: 'c64', profile: 'loaded', region: 'pal' },
      'C64 with a joystick': { target: 'c64', hardware: { port1: 'joystick' } },
      'Expanded VIC-20': { target: 'vic20', profile: '8k' },
      'The browser': { target: 'web' },
    },
  };
  const { ok, systems } = projectSystems(config);
  assert.ok(ok);
  assert.deepEqual(systems.map((s) => s.name), [
    'C64 with an REU', 'C64 with a joystick', 'Expanded VIC-20', 'The browser',
  ]);
  // A project profile is resolved against that machine's own profiles, and
  // the project's stock hardware is under it: the mouse is still fitted.
  assert.deepEqual(systems[0], {
    name: 'C64 with an REU', target: 'c64', profile: 'loaded', hardware: {}, region: 'pal',
    label: 'ram=reu512 port1=mouse1351', unmet: [],
  });
  assert.equal(systems[1].label, 'port1=joystick');
  assert.equal(systems[2].label, 'ram=8k');
  assert.equal(systems[3].label, 'stock');
  assert.deepEqual(projectSystems({ targets: ['c64'] }), { ok: true, systems: [] });
  assert.deepEqual(projectSystems(null), { ok: true, systems: [] });
  // An explicit `profile: null` is what anything filling the shape in
  // mechanically writes, and means the same as leaving it out.
  const explicit = projectSystems({ targets: ['nes'], systems: { x: { target: 'nes', profile: null, hardware: {}, region: null } } });
  assert.ok(explicit.ok, explicit.error);
  assert.equal(explicit.systems[0].label, 'stock');
});

test('a system the config gets wrong is an error, not a missing row', () => {
  const base = { targets: { c64: {}, pet: {}, web: {} } };
  const bad = (systems) => projectSystems({ ...base, systems });
  assert.match(bad({ x: { target: 'spectrum' } }).error, /'spectrum' is not a machine/);
  assert.match(bad({ x: { target: 'nes' } }).error, /does not target nes\. Targets: c64, pet, web/);
  assert.match(bad({ x: { target: 'c64', region: 'secam' } }).error, /region must be 'ntsc' or 'pal'/);
  assert.match(bad({ x: { target: 'pet', region: 'pal' } }).error, /the pet has no region to pick/);
  assert.match(bad({ x: { target: 'c64', profile: 'huge' } }).error, /unknown c64 profile 'huge'/);
  assert.match(bad({ x: { target: 'c64', hardware: { model: '8032' } } }).error, /has no 'model' option/);
  assert.match(bad({ x: { target: 'c64', hardware: { ram: '8k' } } }).error, /'8k' is not a value the c64's 'ram' option takes/);
  assert.match(bad({ x: 'c64' }).error, /must be an object with a target/);
  assert.match(projectSystems({ ...base, systems: ['c64'] }).error, /must be an object of name/);
  // A system is offered beside the bare machines, in one list, so a name
  // that is already a machine's would be two entries answering to one word.
  assert.match(bad({ c64: { target: 'c64' } }).error, /'c64' is a machine's own name/);
  // The name of the system is in every message, so it can be found.
  assert.match(bad({ 'My C64': { target: 'spectrum' } }).error, /system 'My C64'/);
});

test('the machines with a region are one set, and a system may only pin one for those', () => {
  const config = { targets: ['c64', 'nes', 'pet', 'web'] };
  const withRegion = (target) => projectSystems({ ...config, systems: { x: { target, region: 'pal' } } });
  for (const target of ['c64']) assert.ok(withRegion(target).ok, target);
  // The editor's Save writes `region` only for the machines this says have
  // one; NES and PET do not, and a config claiming otherwise is refused.
  for (const target of ['nes', 'pet', 'web']) {
    assert.match(withRegion(target).error, new RegExp(`the ${target} has no region to pick`));
  }
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
  assert.equal(stockFacts('web')['input.keyboard'], true);
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

// What a program needs of any machine it is built for: `requires` in its
// config, a floor per fact. This is the sentence a program gets to say
// instead of the linker's overflow at the end of a build.
test('requires takes a floor per fact, and refuses what cannot be a floor', () => {
  assert.deepEqual(projectRequires({ requires: { 'memory.ram': 8192, 'storage.save': true } }),
    { ok: true, requires: { 'memory.ram': 8192, 'storage.save': true } });
  assert.deepEqual(projectRequires({}), { ok: true, requires: {} });
  assert.deepEqual(projectRequires(null), { ok: true, requires: {} });

  const bad = (requires) => projectRequires({ requires }).error;
  // A run fact is answered on the machine, not by the build.
  assert.match(bad({ 'input.mouse': true }), /settled on the machine, not by the build/);
  assert.match(bad({ 'memory.banked': true }), /settled on the machine/);
  assert.match(bad({ 'video.nope': 1 }), /is not a fact/);
  assert.match(bad({ 'video.frameRate': 50 }), /not on a program's sheet/);
  assert.match(bad({ 'memory.ram': 0 }), /a whole number above zero/);
  assert.match(bad({ 'memory.ram': '8k' }), /a whole number above zero/);
  assert.match(bad({ 'storage.save': false }), /require it with true, or leave it out/);
  assert.match(projectRequires({ requires: ['memory.ram'] }).error, /must be an object of fact/);
});

test('whatSatisfies names the one change that would meet a requirement', () => {
  // The half of the message that makes it actionable: not "needs 8192"
  // but "ram=8k gives 11775".
  assert.deepEqual(whatSatisfies(loadCatalog('vic20'), 'memory.ram', 8192),
    ['ram=8k gives 11775', 'ram=16k gives 19967', 'ram=24k gives 28159']);
  // Nothing fits when the machine cannot be fitted with it at all.
  assert.deepEqual(whatSatisfies(loadCatalog('nes'), 'storage.save', true), []);
  // A drive is what makes a machine one a program can save on.
  assert.deepEqual(whatSatisfies(loadCatalog('c64'), 'storage.kib', 780),
    ['drive=1581 gives 783']);
});

test('a system carries what it falls short of, and one that fits carries nothing', () => {
  const config = {
    targets: ['vic20', 'nes'],
    requires: { 'memory.ram': 8192, 'storage.save': true },
    systems: {
      'VIC-20, stock': { target: 'vic20' },
      'VIC-20 with 8K': { target: 'vic20', profile: '8k' },
      'NES': { target: 'nes' },
    },
  };
  const { systems } = projectSystems(config);
  assert.deepEqual(systems[0].unmet, [{ key: 'memory.ram', need: 8192, have: 3583 }]);
  assert.deepEqual(systems[1].unmet, []);
  assert.deepEqual(systems[2].unmet.map((u) => u.key), ['memory.ram', 'storage.save']);
});

test('a requires block the config gets wrong gives no verdict rather than a wrong one', () => {
  // Otherwise every system is marked short over a key the CLI is about to
  // refuse, and an array `requires` asks the sheet for a fact named '0'.
  const withRequires = (requires) => projectSystems({
    targets: ['c64'], requires, systems: { C64: { target: 'c64' } },
  }).systems[0].unmet;
  assert.deepEqual(withRequires({ 'input.mouse': true }), [], 'a run fact is refused, not applied');
  assert.deepEqual(withRequires(['memory.ram']), []);
  assert.deepEqual(withRequires({ 'memory.ram': 8192 }), [], 'a c64 has 51199');
  assert.deepEqual(withRequires({ 'memory.ram': 60000 }), [{ key: 'memory.ram', need: 60000, have: 51199 }]);
});

// Storage: the drives, measured rather than recalled. `c1541` formatted an
// image of each type and its own directory reported the free blocks; a
// block holds 254 bytes.
test('the Commodore drives are a hardware axis, and each says what it holds', () => {
  // Measured, then divided: c1541 formatted an image of each type and its
  // own directory reported the free blocks; a block holds 254 bytes, and
  // the fact is KiB rounded down.
  const usable = (machine, drive) => resolveHardware(loadCatalog(machine), { overrides: { drive } })
    .hardware.facts['storage.kib'];
  assert.equal(usable('c64', '1541'), 164, '664 blocks = 168656 bytes');
  assert.equal(usable('c64', '1571'), 329, '1328 blocks = 337312 bytes');
  assert.equal(usable('c64', '1581'), 783, '3160 blocks = 802640 bytes');
  assert.equal(usable('pet', '4040'), 166, '670 blocks = 170180 bytes');
  assert.equal(usable('pet', '8050'), 508, '2052 blocks = 521208 bytes');
  assert.equal(usable('pet', '8250'), 1025, '4133 blocks = 1049782 bytes');
  assert.equal(usable('c128', '1571'), 329);

  // No drive is nowhere to save, and both facts say so together.
  const none = resolveHardware(loadCatalog('vic20'), { overrides: { drive: 'none' } }).hardware.facts;
  assert.equal(none['storage.save'], false);
  assert.equal(none['storage.kib'], 0);

  // A drive is not linked in and is not an emulator flag — it is what the
  // program may assume — so it carries no tag and no build values.
  const fitted = resolveHardware(loadCatalog('c64'), { overrides: { drive: '1581' } }).hardware;
  assert.deepEqual(fitted.tags, []);
  assert.deepEqual(fitted.buildValues, []);
});

test('storage.save and storage.kib agree on every machine and every value', () => {
  for (const machine of MACHINES) {
    const catalog = loadCatalog(machine);
    const check = (facts, where) => {
      if (!Object.hasOwn(facts, 'storage.save') && !Object.hasOwn(facts, 'storage.kib')) return;
      const stock = resolveHardware(catalog).hardware.facts;
      const save = facts['storage.save'] ?? stock['storage.save'];
      const bytes = facts['storage.kib'] ?? stock['storage.kib'];
      assert.equal(save, bytes > 0, `${where}: storage.save ${save} but storage.kib ${bytes}`);
    };
    check(catalog.facts, `${machine} stock`);
    for (const [id, option] of Object.entries(catalog.options)) {
      for (const [value, entry] of Object.entries(option.values)) {
        check(entry.facts ?? {}, `${machine} ${id}=${value}`);
      }
    }
  }
});
