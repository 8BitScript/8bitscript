// The editor's reading of `8bs targets --json` and of a person's hardware
// selection: the same resolution order the CLI uses, so the panel shows
// what runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  effectiveFacts, effectiveOptions, hardwareArgs, normalizeSelection, parseTargets, selectionLabel,
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
  }],
  facts: [
    { key: 'video.sprites', type: 'count', when: 'build', program: true, doc: 'Hardware sprites in total.' },
    { key: 'input.mouse', type: 'flag', when: 'run', program: true, doc: 'A mouse this build may use.' },
    { key: 'memory.banked', type: 'flag', when: 'run', program: true, doc: 'RAM beyond the window.' },
    { key: 'memory.bankedKib', type: 'count', when: 'run', program: true, doc: 'KiB of it.' },
  ],
});

test('parseTargets keys the CLI\'s list by id', () => {
  const targets = parseTargets(SAMPLE);
  assert.deepEqual([...targets.keys()], ['c64']);
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
