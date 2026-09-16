// A project's programs and images, as 8bitscript.config.ts declares them
// (programs.mjs): the one-program spellings, the several-programs one,
// and everything the config can get wrong about either.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_FORMATS, imageOutFile, programArg, programStem, resolveImages, resolvePrograms, selectProgram,
} from '../src/programs.mjs';
import { defineConfig } from '../src/index.mjs';

const twoPrograms = {
  programs: {
    main: { entry: 'src/main.8bs' },
    format: { entry: 'src/tools/format.8bs', targets: ['c64', 'c128'], requires: { 'memory.ram': 32768 } },
  },
  targets: { c64: {}, c128: {}, pet: {}, web: {} },
  requires: { 'memory.ram': 8192 },
};

test('defineConfig returns what it is given; a config needs no wrapper to be one', () => {
  const config = { entry: 'src/main.8bs', targets: ['pet'] };
  assert.equal(defineConfig(config), config);
  assert.deepEqual(resolvePrograms(defineConfig(twoPrograms)), resolvePrograms(twoPrograms));
});

test('no config, or one `entry`, is the one program every project has, stem from the filename', () => {
  for (const config of [null, {}, { entry: 'src/hello-world.8bs' }, { entry: { default: 'src/main.8bs', nes: 'src/nes.8bs' } }]) {
    const result = resolvePrograms(config);
    assert.equal(result.ok, true, JSON.stringify(config));
    if (!result.ok) return;
    assert.equal(result.programs.length, 1);
    const [main] = result.programs;
    assert.equal(main.name, 'main');
    assert.equal(main.stemFromFilename, true, 'the entry spelling keeps the filename as the stem');
    assert.equal(main.targets, null);
    assert.deepEqual(main.entry, config?.entry ?? 'src/main.8bs');
  }
  // The project's floor is the program's.
  const floor = resolvePrograms({ entry: 'src/main.8bs', requires: { 'memory.ram': 8192 } });
  assert.ok(floor.ok && floor.programs[0].requires['memory.ram'] === 8192);
});

test('programs: each its own entry, targets a subset of the project\'s, requires raised over the project\'s', () => {
  const result = resolvePrograms(twoPrograms);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.programs.map((p) => p.name), ['main', 'format']);
  const [main, format] = result.programs;
  assert.equal(main.stemFromFilename, false, 'a named program is its own stem');
  assert.equal(main.targets, null);
  assert.deepEqual(main.requires, { 'memory.ram': 8192 });
  assert.deepEqual(format.targets, ['c64', 'c128']);
  assert.deepEqual(format.requires, { 'memory.ram': 32768 });
});

test('the ways a programs block is wrong, each named in the program\'s own terms', () => {
  const bad = (config) => {
    const result = resolvePrograms(config);
    assert.equal(result.ok, false, JSON.stringify(config));
    return result.ok ? '' : result.error;
  };
  assert.match(bad({ entry: 'src/main.8bs', programs: { main: { entry: 'src/main.8bs' } } }), /both `entry` and `programs`/);
  assert.match(bad({ programs: [] }), /must be an object/);
  assert.match(bad({ programs: {} }), /names no program/);
  assert.match(bad({ programs: { 'my prog': { entry: 'a.8bs' } } }), /output filename/);
  assert.match(bad({ programs: { main: 'src/main.8bs' } }), /must be \{ entry/);
  assert.match(bad({ programs: { main: {} } }), /needs an entry/);
  // The rule the rest of 8BX builds on: a program starts from .8bs.
  assert.match(bad({ programs: { main: { entry: 'src/App.8bx' } } }), /a \.8bx file; a program starts from a \.8bs file that imports what the \.8bx exports/);
  assert.match(bad({ programs: { main: { entry: 'src/main.ts' } } }), /not a \.8bs file/);
  assert.match(bad({ programs: { main: { entry: 'a.8bs', targets: [] } } }), /non-empty array/);
  assert.match(bad({ programs: { main: { entry: 'a.8bs', targets: ['amiga'] } } }), /'amiga', which is no machine/);
  assert.match(bad({ targets: ['pet'], programs: { main: { entry: 'a.8bs', targets: ['c64'] } } }), /project's targets are pet; a program builds for a subset/);
  assert.match(bad({ programs: { main: { entry: 'a.8bs', requires: [] } } }), /requires must be an object/);
  assert.match(bad({ programs: { main: { entry: 'a.8bs', requires: { 'memory.ram': 'lots' } } } }), /requires:/);
  assert.match(bad({ requires: { 'memory.ram': 8192 }, programs: { main: { entry: 'a.8bs', requires: { 'memory.ram': 4096 } } } }), /below the project's 8192; a program may raise a floor, not lower one/);
  // A flag cannot be lowered either: `false` is refused by the requires
  // rule itself, before this one has to say anything.
  assert.match(bad({ requires: { 'storage.save': true }, programs: { main: { entry: 'a.8bs', requires: { 'storage.save': false } } } }), /is a flag: require it with true/);
});

test('selectProgram: --program by name, else main, else the only one, else ask', () => {
  const { programs } = resolvePrograms(twoPrograms);
  assert.equal(selectProgram(programs, 'format').program.name, 'format');
  assert.equal(selectProgram(programs, undefined).program.name, 'main');
  assert.match(selectProgram(programs, 'copy').error, /no program named 'copy' \(programs: main, format\)/);
  const only = resolvePrograms({ programs: { tool: { entry: 'src/tool.8bs' } } }).programs;
  assert.equal(selectProgram(only, undefined).program.name, 'tool');
  const several = resolvePrograms({ programs: { a: { entry: 'a.8bs' }, b: { entry: 'b.8bs' } } }).programs;
  assert.match(selectProgram(several, undefined).error, /2 programs \(a, b\) and none named main; say which with --program/);
});

test('programArg reads --program and reports what it consumed', () => {
  assert.deepEqual(programArg(['--target', 'c64']), { ok: true, program: undefined, consumed: [] });
  assert.deepEqual(programArg(['c64', '--program', 'format', '--size']), { ok: true, program: 'format', consumed: [1, 2] });
  assert.match(programArg(['--program']).error, /expects a name/);
  assert.match(programArg(['--program', '--size']).error, /expects a name/);
});

test('programStem: the program\'s name, or the entry filename with a twin\'s machine folded away', () => {
  const named = { name: 'format', stemFromFilename: false };
  const sugar = { name: 'main', stemFromFilename: true };
  assert.equal(programStem(named, '/p/src/tools/format.c64.8bs', 'c64'), 'format');
  // The entry spelling: exactly what 0.10 did, so no dist/ name moves.
  assert.equal(programStem(sugar, '/p/src/hello-world.8bs', 'pet'), 'hello-world');
  assert.equal(programStem(sugar, '/p/src/main.nes.8bs', 'nes'), 'main');
  assert.equal(programStem(sugar, '/p/src/main.nes.8bs', 'c64'), 'main.nes');
});

test('images: a container over programs, checked against what they build for', () => {
  const { programs } = resolvePrograms(twoPrograms);
  const good = resolveImages({
    ...twoPrograms,
    images: {
      'geos-tools': {
        target: 'c64', format: 'd64', boot: 'main',
        files: [
          { program: 'main', name: 'GEOS TOOLS' },
          { program: 'format', name: 'FORMAT' },
          { path: 'assets/font.bin', name: 'FONT' },
        ],
      },
    },
  }, programs);
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.equal(good.images.length, 1);
  const [image] = good.images;
  assert.deepEqual(image.files.map((f) => f.type), ['prg', 'prg', 'seq'], 'a program is prg, a file is seq, unless said');
  assert.match(imageOutFile(image, '/p'), /^\/p\/dist\/geos-tools\.d64$/);
  assert.deepEqual(resolveImages({}, programs), { ok: true, images: [] });
  assert.deepEqual(IMAGE_FORMATS.nes, []);
  assert.deepEqual(IMAGE_FORMATS.web, []);
});

test('the ways an images block is wrong', () => {
  const { programs } = resolvePrograms(twoPrograms);
  const image = (spec) => ({ ...twoPrograms, images: { disk: spec } });
  const file = (f) => image({ target: 'c64', format: 'd64', boot: 'main', files: [{ program: 'main', name: 'MAIN' }, f] });
  const bad = (config) => {
    const result = resolveImages(config, programs);
    assert.equal(result.ok, false, JSON.stringify(config.images));
    return result.ok ? '' : result.error;
  };
  assert.match(bad({ ...twoPrograms, images: [] }), /must be an object/);
  assert.match(bad({ ...twoPrograms, images: { 'a disk': {} } }), /its filename/);
  assert.match(bad(image('d64')), /must be \{ target, format, boot, files \}/);
  assert.match(bad(image({ target: 'amiga' })), /target must be a machine/);
  const all = { ...twoPrograms, targets: ['c64', 'c128', 'pet', 'web', 'nes'] };
  assert.match(bad({ ...all, images: { disk: { target: 'nes' } } }), /the nes has no disk image to write; its cartridge is the program/);
  assert.match(bad({ ...all, images: { disk: { target: 'web' } } }), /its bundle is the program/);
  assert.match(bad(image({ target: 'c64', format: 'atr' })), /format must be one of d64, d71, d81 for the c64/);
  assert.match(bad({ ...twoPrograms, targets: ['c64'], images: { disk: { target: 'pet', format: 'd64', boot: 'main', files: [{ program: 'main', name: 'M' }] } } }), /targets \(c64\) do not list/);
  assert.match(bad(image({ target: 'c64', format: 'd64', boot: 'main', files: [] })), /at least one/);
  assert.match(bad(file('x')), /must be \{ program, name \} or \{ path, name \}/);
  assert.match(bad(file({ program: 'main', path: 'x', name: 'X' })), /not both/);
  assert.match(bad(file({ name: 'X' })), /not neither/);
  assert.match(bad(file({ program: 'copy', name: 'COPY' })), /'copy', which is no program \(main, format\)/);
  // format builds for c64 and c128 only — a PET disk cannot hold it.
  assert.match(bad({ ...twoPrograms, images: { disk: { target: 'pet', format: 'd64', boot: 'format', files: [{ program: 'format', name: 'FORMAT' }] } } }), /'format' does not build for the pet/);
  assert.match(bad(file({ program: 'format', name: '' })), /needs a name: what the file is called on the disk/);
  assert.match(bad(file({ program: 'format', name: 'A NAME THAT IS FAR TOO LONG' })), /longer than the 16 characters/);
  assert.match(bad(file({ program: 'format', name: 'MAIN' })), /'MAIN' is already used/);
  assert.match(bad(file({ program: 'format', name: 'F', type: 'usr' })), /type must be 'prg' or 'seq'/);
  assert.match(bad(image({ target: 'c64', format: 'd64', boot: 'copy', files: [{ program: 'main', name: 'M' }] })), /boot must name one of the image's programs \(main\)/);
  assert.match(bad(image({ target: 'c64', format: 'd64', boot: 'main', files: [{ path: 'a.bin', name: 'A' }] })), /\(none listed\)/);
});
