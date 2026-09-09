// The editor's reading of `8bs targets --json` and of a person's hardware
// selection: the same resolution order the CLI uses, so the panel shows
// what runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  effectiveFacts, effectiveOptions, hardwareArgs, matchesSystem, normalizeSelection, parseTargets,
  selectionLabel, worstSelection,
} = require('../src/hardwareCatalog.cjs');

const SAMPLE = JSON.stringify({
  targets: [{
    id: 'c64',
    title: 'Commodore 64',
    emulator: 'x64sc',
    region: true,
    options: {
      ram: { label: 'RAM Expansion Unit', default: 'none', detect: '@8bitscript/c64/reu', values: { none: { label: 'No expansion', affectsBuild: false }, reu512: { label: 'REU, 512 KiB', affectsBuild: false, facts: { 'memory.banked': true, 'memory.bankedKib': 512 } } } },
      port1: { label: 'Control port 1', default: 'none', values: { none: { label: 'Nothing', affectsBuild: false }, mouse1351: { label: '1351', affectsBuild: false, facts: { 'input.mouse': true } } } },
    },
    presets: { stock: { ram: 'none' }, reu512: { ram: 'reu512' } },
    profiles: { reu512: { ram: 'none', port1: 'mouse1351' } },
    hardware: {},
    facts: { 'video.sprites': 8, 'input.mouse': false, 'memory.banked': false, 'memory.bankedKib': 0 },
  }, {
    id: 'pet',
    title: 'Commodore PET',
    emulator: 'xpet',
    region: false,
    options: {
      model: {
        label: 'Model',
        default: '3032',
        values: {
          3008: { label: '3008', affectsBuild: true, facts: { 'memory.ram': 7167 } },
          3032: { label: '3032', affectsBuild: true, facts: { 'memory.ram': 31743 } },
          8032: { label: '8032', affectsBuild: true, facts: { 'video.columns': 80, 'memory.ram': 31743 } },
        },
      },
      drive: { label: 'Drive', default: 'none', values: { none: { label: 'None' }, dual: { label: 'Dual 8250', facts: { 'storage.save': true } } } },
    },
    presets: {},
    profiles: {},
    hardware: {},
    facts: {},
  }],
  systems: [
    { name: 'C64 with a mouse', target: 'c64', profile: null, hardware: { port1: 'mouse1351' }, region: null, label: 'port1=mouse1351' },
    { name: 'PAL C64 with an REU', target: 'c64', profile: 'reu512', hardware: {}, region: 'pal', label: 'port1=mouse1351' },
  ],
  facts: [
    { key: 'video.sprites', type: 'count', when: 'build', program: true, doc: 'Hardware sprites in total.' },
    { key: 'input.mouse', type: 'flag', when: 'run', program: true, doc: 'A mouse this build may use.' },
    { key: 'memory.banked', type: 'flag', when: 'run', program: true, doc: 'RAM beyond the window.' },
    { key: 'memory.bankedKib', type: 'count', when: 'run', program: true, doc: 'KiB of it.' },
  ],
});

test('parseTargets keys the CLI\'s list by id', () => {
  const targets = parseTargets(SAMPLE);
  assert.deepEqual([...targets.keys()], ['c64', 'pet']);
  assert.equal(targets.get('c64').title, 'Commodore 64');
});

test('normalizeSelection tolerates anything and returns stock for nothing', () => {
  assert.deepEqual(normalizeSelection(undefined), { profile: null, options: {} });
  assert.deepEqual(normalizeSelection({ profile: '', options: { a: '', b: 'x', c: 3 } }), { profile: null, options: { b: 'x' } });
});

test('hardwareArgs spells --profile and one --hardware flag', () => {
  assert.deepEqual(hardwareArgs({ profile: null, options: {} }), []);
  assert.deepEqual(hardwareArgs({ profile: 'reu512', options: { port1: 'mouse1351' } }), ['--profile', 'reu512', '--hardware', 'port1=mouse1351']);
});

test('effectiveOptions resolves defaults, then the profile (a project profile shadowing a preset), then options on top', () => {
  const target = parseTargets(SAMPLE).get('c64');
  assert.deepEqual(effectiveOptions(target, { profile: null, options: {} }), { ram: 'none', port1: 'none' });
  // The project's own `reu512` (no REU, a mouse) shadows the preset of that name.
  assert.deepEqual(effectiveOptions(target, { profile: 'reu512', options: {} }), { ram: 'none', port1: 'mouse1351' });
  assert.deepEqual(effectiveOptions(target, { profile: 'stock', options: { ram: 'reu512' } }), { ram: 'reu512', port1: 'none' });
  assert.equal(selectionLabel({ profile: 'stock', options: { ram: 'reu512' } }), 'stock ram=reu512');
  assert.equal(selectionLabel({ profile: null, options: {} }), '');
});

test('parseTargets carries the fact schema, and effectiveFacts merges the stock sheet with the chosen values\'', () => {
  const targets = parseTargets(SAMPLE);
  assert.deepEqual(targets.facts.map((f) => f.key), ['video.sprites', 'input.mouse', 'memory.banked', 'memory.bankedKib']);
  const target = targets.get('c64');
  assert.deepEqual(effectiveFacts(target, {}), { 'video.sprites': 8, 'input.mouse': false, 'memory.banked': false, 'memory.bankedKib': 0 });
  assert.deepEqual(effectiveFacts(target, { profile: 'reu512', options: { port1: 'mouse1351' } }), {
    'video.sprites': 8, 'input.mouse': true, 'memory.banked': false, 'memory.bankedKib': 0,
  }, 'the project profile named reu512 shadows the preset and fits no REU');
  assert.deepEqual(effectiveFacts(target, { options: { ram: 'reu512' } }), {
    'video.sprites': 8, 'input.mouse': false, 'memory.banked': true, 'memory.bankedKib': 512,
  });
  assert.deepEqual(effectiveFacts({ options: {} }, {}), {}, 'a target with no catalog has an empty sheet here');
  assert.deepEqual(parseTargets(JSON.stringify({ targets: [] })).facts, [], 'an older CLI without a schema');
});

test('a project\'s own hardware for a target is its stock in the panel, under a profile and the options', () => {
  const target = { ...parseTargets(SAMPLE).get('c64'), hardware: { ram: 'reu512' } };
  assert.equal(effectiveOptions(target, {}).ram, 'reu512');
  assert.equal(effectiveOptions(target, { profile: 'stock' }).ram, 'none', 'a named profile over it');
  assert.equal(effectiveOptions(target, { options: { ram: 'none' } }).ram, 'none', 'an option over it');
  assert.equal(effectiveFacts(target, {})['memory.banked'], true);
});

// The whole machines a project has been set up for ride on the map the way
// the fact schema does: they are the project's, not any one machine's.
test('parseTargets carries the project\'s systems, and an old toolchain\'s answer has none', () => {
  assert.deepEqual(parseTargets(SAMPLE).systems.map((s) => s.name), ['C64 with a mouse', 'PAL C64 with an REU']);
  assert.deepEqual(parseTargets(JSON.stringify({ targets: [] })).systems, []);
  assert.equal(parseTargets(SAMPLE).systemsError, null);
});

test('a systems block the config gets wrong is a message, not a missing panel', () => {
  // The CLI still answers about the machines; only the systems are gone,
  // and the reason comes with them so the typo can be found.
  const targets = parseTargets(JSON.stringify({
    targets: [{ id: 'c64', title: 'Commodore 64', options: {}, presets: {}, profiles: {}, hardware: {}, facts: {} }],
    systems: [],
    systemsError: "8bs.config.ts: system 'My NES': this project does not target nes",
  }));
  assert.equal(targets.get('c64').title, 'Commodore 64');
  assert.deepEqual(targets.systems, []);
  assert.match(targets.systemsError, /does not target nes/);
});

test('a selection is recognised as one of the project\'s systems by what it fits, not by what was clicked', () => {
  const targets = parseTargets(SAMPLE);
  const target = targets.get('c64');
  const [mouse, reu] = targets.systems;

  // Reaching the same machine by hand names it just the same.
  assert.equal(matchesSystem(mouse, target, { profile: null, options: { port1: 'mouse1351' } }, 'ntsc'), true);
  assert.equal(matchesSystem(mouse, target, { profile: null, options: {} }, 'ntsc'), false);

  // The project's `reu512` profile is a mouse and no expansion; the entry
  // names that profile, so a selection naming it directly is the same fit.
  assert.equal(matchesSystem(reu, target, { profile: 'reu512', options: {} }, 'pal'), true);
  // ...but not on the wrong region, which the entry pins.
  assert.equal(matchesSystem(reu, target, { profile: 'reu512', options: {} }, 'ntsc'), false);
  // An entry that pins no region fits either.
  assert.equal(matchesSystem(mouse, target, { profile: null, options: { port1: 'mouse1351' } }, 'pal'), true);
  assert.equal(matchesSystem(mouse, undefined, { profile: null, options: {} }, 'ntsc'), false);
});

test('worstSelection picks the lowest memory.ram value, leaving other options at their default', () => {
  const pet = parseTargets(SAMPLE).get('pet');
  assert.deepEqual(worstSelection(pet), { profile: null, options: { model: '3008' } });
  assert.equal(effectiveOptions(pet, worstSelection(pet)).model, '3008');
  assert.equal(effectiveOptions(pet, worstSelection(pet)).drive, 'none', 'an option with no memory.ram values is untouched');
  assert.equal(effectiveFacts(pet, worstSelection(pet))['memory.ram'], 7167);
});

test('worstSelection is a no-op on a machine with no memory.ram-varying option', () => {
  const c64 = parseTargets(SAMPLE).get('c64');
  assert.deepEqual(worstSelection(c64), { profile: null, options: {} });
});

test('worstSelection leaves an option alone when its lowest value is already the default', () => {
  const target = { options: { model: { default: '3008', values: { 3008: { facts: { 'memory.ram': 7167 } }, 3032: { facts: { 'memory.ram': 31743 } } } } } };
  assert.deepEqual(worstSelection(target), { profile: null, options: {} });
});
