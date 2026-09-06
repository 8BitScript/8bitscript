// The editor's reading of `8bs targets --json` and of a person's hardware
// selection: the same resolution order the CLI uses, so the panel shows
// what runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  effectiveOptions, hardwareArgs, normalizeSelection, parseTargets, selectionLabel,
} = require('../src/hardwareCatalog.cjs');

const SAMPLE = JSON.stringify({
  targets: [{
    id: 'c64',
    title: 'Commodore 64',
    emulator: 'x64sc',
    region: true,
    options: {
      ram: { label: 'RAM Expansion Unit', default: 'none', values: { none: { label: 'No expansion', affectsBuild: false }, reu512: { label: 'REU, 512 KiB', affectsBuild: false } } },
      port1: { label: 'Control port 1', default: 'none', values: { none: { label: 'Nothing', affectsBuild: false }, mouse1351: { label: '1351', affectsBuild: false } } },
    },
    presets: { stock: { ram: 'none' }, reu512: { ram: 'reu512' } },
    profiles: { reu512: { ram: 'none', port1: 'mouse1351' } },
  }],
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
