// Values a build is handed (defines.mjs): `--define NAME=VALUE` as typed,
// a program's `define` block as written, and the typo guard between them
// and what the program actually reads with `#define("NAME", default)`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkDefines, defineArgs, effectiveDefines, nearestName, parseDefineValue, resolveDefineBlock,
} from '../src/defines.mjs';
import { resolvePrograms } from '../src/programs.mjs';

test('a value as typed: true/false, whole numbers (decimal or 0x), strings, and quotes to force a string', () => {
  assert.equal(parseDefineValue('true'), true);
  assert.equal(parseDefineValue('false'), false);
  assert.equal(parseDefineValue('42'), 42);
  assert.equal(parseDefineValue('0x2A'), 42);
  assert.equal(parseDefineValue('cosmic'), 'cosmic');
  assert.equal(parseDefineValue('"007"'), '007', 'quotes force a string out of something that reads as a number');
  assert.equal(parseDefineValue('"true"'), 'true');
  assert.equal(parseDefineValue(''), '', 'an empty value is the empty string');
  assert.equal(parseDefineValue('-3'), '-3', 'a negative number is not a define value; it stays text');
});

test('--define is repeatable, takes the later of two for one name, and reports the indices it consumed', () => {
  const args = ['pet', '--define', 'SEED=1', '--program', 'x', '--define', 'FORCE_BONUS=true', '--define', 'SEED=9', 'file.8bs'];
  const result = defineArgs(args);
  assert.equal(result.ok, true);
  assert.deepEqual(result.defines, { SEED: 9, FORCE_BONUS: true });
  assert.deepEqual(result.consumed, [1, 2, 5, 6, 7, 8]);
  assert.deepEqual(defineArgs(['pet']), { ok: true, defines: {}, consumed: [] });
  assert.equal(defineArgs(['--define', 'A=b=c']).defines.A, 'b=c', 'only the first = splits');
});

test('--define says what it wanted when it is malformed', () => {
  for (const [args, pattern] of [
    [['--define'], /expects NAME=VALUE/],
    [['--define', '--size'], /expects NAME=VALUE/],
    [['--define', 'SEED'], /expected NAME=VALUE/],
    [['--define', '=3'], /expected NAME=VALUE/],
    [['--define', 'seed=3'], /capital letters/],
    [['--define', '1ST=3'], /capital letters/],
  ]) {
    const result = defineArgs(args);
    assert.equal(result.ok, false, args.join(' '));
    assert.match(result.error, pattern);
  }
});

test('a program\'s define block: values, { value, description }, and what is refused', () => {
  const ok = resolveDefineBlock({ SEED: 10, FORCE_BONUS: { value: true, description: 'start in the bonus' }, THEME: 'classic' }, 'p.define');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.define, [
    { name: 'SEED', value: 10, kind: 'int', description: null },
    { name: 'FORCE_BONUS', value: true, kind: 'bool', description: 'start in the bonus' },
    { name: 'THEME', value: 'classic', kind: 'string', description: null },
  ]);
  assert.deepEqual(resolveDefineBlock(undefined, 'p.define'), { ok: true, define: [] });
  for (const [block, pattern] of [
    [[], /must be an object/],
    [{ seed: 1 }, /capital letters/],
    [{ SEED: -1 }, /whole number, true or false, or a string/],
    [{ SEED: 1.5 }, /whole number, true or false, or a string/],
    [{ SEED: null }, /whole number, true or false, or a string/],
    [{ SEED: { description: 'x' } }, /whole number, true or false, or a string/],
    [{ SEED: { value: 1, description: 3 } }, /description must be a string/],
  ]) {
    const result = resolveDefineBlock(block, 'p.define');
    assert.equal(result.ok, false, JSON.stringify(block));
    assert.match(result.error, pattern);
  }
});

test('the programs block carries title, description, group and define, and refuses what is not a string', () => {
  const result = resolvePrograms({
    programs: {
      slot: {
        entry: 'src/slot.8bs', title: 'Slot', description: 'Spins once.', group: 'Labs', define: { SEED: 3 },
      },
      plain: { entry: 'src/plain.8bs' },
    },
  });
  assert.equal(result.ok, true);
  const [slot, plain] = result.programs;
  assert.equal(slot.title, 'Slot');
  assert.equal(slot.group, 'Labs');
  assert.equal(slot.description, 'Spins once.');
  assert.deepEqual(slot.define.map((d) => [d.name, d.value]), [['SEED', 3]]);
  assert.deepEqual([plain.title, plain.description, plain.group, plain.define], [null, null, null, []]);
  for (const key of ['title', 'description', 'group']) {
    const bad = resolvePrograms({ programs: { slot: { entry: 'src/slot.8bs', [key]: '' } } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, new RegExp(`programs.slot.${key} must be a non-empty string`));
  }
  const badDefine = resolvePrograms({ programs: { slot: { entry: 'src/slot.8bs', define: { seed: 1 } } } });
  assert.equal(badDefine.ok, false);
  assert.match(badDefine.error, /programs\.slot\.define\.seed/);
  // The one-program spellings take none: nothing to name.
  const entry = resolvePrograms({ entry: 'src/main.8bs' });
  assert.deepEqual(entry.programs[0].define, []);
});

test('nearestName suggests a typo\'s likely name, and nothing when nothing is near', () => {
  assert.equal(nearestName('SEDD', ['SEED', 'FORCE_BONUS']), 'SEED');
  assert.equal(nearestName('FORCE_BONUSS', ['SEED', 'FORCE_BONUS']), 'FORCE_BONUS');
  assert.equal(nearestName('THEME', ['SEED', 'FORCE_BONUS']), null);
  assert.equal(nearestName('SEED', []), null);
});

test('what a build is handed: the program\'s define block, over which --define wins', () => {
  const program = { define: [{ name: 'SEED', value: 7 }, { name: 'THEME', value: 'a' }] };
  assert.deepEqual(effectiveDefines(program), { SEED: 7, THEME: 'a' });
  assert.deepEqual(effectiveDefines(program, { SEED: 9, FORCE_BONUS: true }), { SEED: 9, THEME: 'a', FORCE_BONUS: true });
  assert.deepEqual(effectiveDefines({}, {}), {});
});

test('the typo guard: a handed name the program never reads is an error, a config-only one a warning', () => {
  const sites = [{ name: 'SEED' }, { name: 'FORCE_BONUS' }];
  const program = { name: 'slot', define: [{ name: 'GHOST' }, { name: 'SEED' }] };
  const clean = checkDefines(program, sites, { SEED: 1 });
  assert.equal(clean.errors.length, 0);
  assert.match(clean.warnings[0], /programs\.slot\.define names GHOST, which no #define in the program reads — it reads SEED, FORCE_BONUS/);
  const typo = checkDefines({ name: 'slot', define: [] }, sites, { SEDD: 1 });
  assert.equal(typo.errors.length, 1);
  assert.match(typo.errors[0], /--define SEDD: program 'slot' has no #define\("SEDD", …\) — it reads SEED, FORCE_BONUS; did you mean SEED\?/);
  const none = checkDefines({ name: 'plain', define: [] }, [], { SEED: 1 });
  assert.match(none.errors[0], /it reads no #define at all/);
  assert.doesNotMatch(none.errors[0], /did you mean/);
  // A name handed on the command line is not also warned about from the config.
  assert.deepEqual(checkDefines({ name: 'p', define: [{ name: 'SEED' }] }, [], { SEED: 1 }).warnings, []);
});
