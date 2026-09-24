// `8bs targets --reach`: who is out there to run a build, joined with what
// the project asks (docs/project/reach.md). The sheet is research and is
// held to the same bar as a catalog — every figure sourced and dated — and
// the report keeps research and catalog apart: a machine that builds is
// answered by its stock sheet, one that does not by the research, marked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { RELEASE_MACHINES } from '@8bitscript/compiler';

import {
  INPUT_DEVICES, compact, delivery, describeReach, formatReach, loadReach, projectInput, reachProblems,
  standingFromFacts, standingFromSheet,
} from '../src/reach.mjs';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/8bs.mjs', import.meta.url));

function project(config) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-reach-'));
  writeFileSync(join(dir, '8bitscript.config.ts'), config);
  return dir;
}

test('the shipped sheet is sourced, dated, and has a row for every machine that builds', () => {
  const data = loadReach();
  assert.deepEqual(reachProblems(data), []);
  assert.match(data.refreshed, /^\d{4}-\d{2}-\d{2}$/);
  for (const id of RELEASE_MACHINES.filter((m) => m !== 'web')) {
    assert.equal(data.systems[id]?.status, 'builds', `${id} builds and the sheet says so`);
  }
  assert.ok(Object.keys(data.systems).length >= 25, 'the eight that build, the sixteen on the roadmap, and the 7800');
  assert.equal(data.systems.web, undefined, 'the web is a URL, not a fleet');
});

test('a figure with no source or date, a row with no status, a roadmap row with no phase — each is a problem in words', () => {
  /** A sheet with every building machine's row, so the only problems are the ones a test adds. */
  const sheet = (rows) => ({
    refreshed: '2026-09-20',
    systems: {
      ...Object.fromEntries(RELEASE_MACHINES.filter((m) => m !== 'web').map((m) => [m, { status: 'builds', name: m }])),
      ...rows,
    },
  });
  assert.deepEqual(reachProblems(sheet({ c64: { status: 'builds', name: 'C64', unitsSold: { low: 1, sources: [{ url: 'x', asOf: '2026' }] } } })), []);
  assert.deepEqual(reachProblems(sheet({ c64: { status: 'builds', name: 'C64', activity: { homebrewDb: [{ name: 'CSDb', value: 5 }] } } })),
    ['c64: activity.homebrewDb[0] has a figure and no source or date']);
  assert.deepEqual(reachProblems(sheet({ c64: { name: 'C64' }, zx: { status: 'roadmap', name: 'ZX' }, bogus: { status: 'builds', name: 'B' } })),
    ['c64: status must be builds, roadmap or unplanned', 'zx: on the roadmap and no phase', 'bogus: says it builds, and no such machine']);
  assert.deepEqual(reachProblems({ systems: {} }), ['the sheet has no `refreshed` date', ...RELEASE_MACHINES.filter((m) => m !== 'web').map((m) => `${m} builds and has no row`)]);
  // A figure flagged verify with a date is allowed: the flag is the source.
  assert.deepEqual(reachProblems(sheet({ c64: { status: 'builds', name: 'C64', activity: { subreddit: { members: 5, asOf: '2026-09-20', verify: true } } } })), []);
});

test('`input` is { primary, also? } over the six devices, and says what is wrong otherwise', () => {
  assert.deepEqual(projectInput(null), { ok: true, input: null });
  assert.deepEqual(projectInput({}), { ok: true, input: null });
  assert.deepEqual(projectInput({ input: { primary: 'stick' } }), { ok: true, input: { primary: 'stick', also: [] } });
  assert.deepEqual(projectInput({ input: { primary: 'stick', also: ['keyboard', 'pad', 'keyboard'] } }),
    { ok: true, input: { primary: 'stick', also: ['keyboard', 'pad'] } });
  assert.equal(projectInput({ input: 'stick' }).error, "8bitscript.config.ts's `input` must be { primary, also? }");
  assert.equal(projectInput({ input: { primary: 'joystick' } }).error,
    `8bitscript.config.ts's \`input\`.primary must be one of ${INPUT_DEVICES.join(', ')}, not "joystick"`);
  assert.equal(projectInput({ input: { primary: 'stick', also: 'keyboard' } }).error,
    `8bitscript.config.ts's \`input\`.also must list devices from ${INPUT_DEVICES.join(', ')}`);
  assert.equal(projectInput({ input: { primary: 'stick', also: ['stick'] } }).error,
    '8bitscript.config.ts\'s `input`.also repeats the primary device "stick"');
  assert.equal(projectInput({ input: { primary: 'stick', requires: [] } }).error,
    "8bitscript.config.ts's `input` has no key `requires` — only primary and also");
});

test('a machine that builds answers from its catalog: ports are standard, run-time facts are optional at most', () => {
  const c64 = { 'input.joysticks': 2, 'input.pads': 0, 'input.keyboard': true, 'input.mouse': true, 'input.paddles': true };
  assert.equal(standingFromFacts('stick', c64), 'standard');
  assert.equal(standingFromFacts('pad', c64), 'absent');
  assert.equal(standingFromFacts('keyboard', c64), 'standard');
  assert.equal(standingFromFacts('mouse', c64), 'optional');
  assert.equal(standingFromFacts('paddles', c64), 'optional');
  assert.equal(standingFromFacts('touch', c64), 'absent');
  const nes = { 'input.joysticks': 0, 'input.pads': 2, 'input.keyboard': false };
  assert.equal(standingFromFacts('stick', nes), 'absent');
  assert.equal(standingFromFacts('pad', nes), 'standard');
  assert.equal(standingFromFacts('mouse', nes), 'absent');
});

test('a machine with no package answers from the sheet, by the words the research uses', () => {
  const spectrum = { standard: ['keyboard'], optional: ['kempston-joystick', 'kempston-mouse'] };
  assert.equal(standingFromSheet('keyboard', spectrum), 'standard');
  assert.equal(standingFromSheet('stick', spectrum), 'optional');
  assert.equal(standingFromSheet('mouse', spectrum), 'optional');
  assert.equal(standingFromSheet('pad', spectrum), 'absent');
  assert.equal(standingFromSheet('pad', { standard: ['gamepad (built-in)'] }), 'standard');
  assert.equal(standingFromSheet('pad', { standard: ['controller with 12-key keypad'] }), 'standard');
  assert.equal(standingFromSheet('stick', undefined), 'absent');
});

test('delivery: the file the toolchain writes reaches the routes that take it, and the others say what they want', () => {
  const system = { routes: [
    { route: 'emulator', formats: ['prg', 'd64'] },
    { route: 'original-hardware+tape', formats: ['tap'] },
    { route: 'mini-console', formats: [] },
  ] };
  assert.deepEqual(delivery(system, 'prg'), {
    shape: 'single', writes: 'prg', reaches: ['emulator'], wants: [{ route: 'original-hardware+tape', formats: ['tap'] }],
  });
  assert.deepEqual(delivery(system, null), {
    shape: 'single', writes: null, reaches: [], wants: [{ route: 'emulator', formats: ['prg', 'd64'] }, { route: 'original-hardware+tape', formats: ['tap'] }],
  });
});

test('describeReach joins the project with the sheet: floors from the catalog, input standings marked by where they came from', () => {
  const rows = describeReach({ requires: { 'input.keyboard': true }, input: { primary: 'stick', also: ['keyboard', 'pad'] } });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(by.nes.floor, [{ key: 'input.keyboard', need: true, have: false }]);
  assert.deepEqual(by.c64.floor, []);
  assert.deepEqual(by.spectrum.floor, [], 'spectrum builds and has a keyboard');
  assert.equal(by.spectrum.status, 'builds');
  assert.deepEqual(by.c64.input, {
    primary: { device: 'stick', standing: 'standard', from: 'catalog' },
    also: [{ device: 'keyboard', standing: 'standard', from: 'catalog' }, { device: 'pad', standing: 'absent', from: 'catalog' }],
  });
  assert.deepEqual(by.pet.input.primary, { device: 'stick', standing: 'absent', from: 'catalog' });
  assert.deepEqual(by.nes.input.primary, { device: 'stick', standing: 'absent', from: 'catalog' });
  assert.deepEqual(by.nes.input.also[1], { device: 'pad', standing: 'standard', from: 'catalog' });
  assert.deepEqual(by.spectrum.input.primary, { device: 'stick', standing: 'standard', from: 'catalog' });
  assert.equal(by.c64.delivery.writes, 'prg');
  assert.ok(by.c64.delivery.reaches.includes('emulator'));
  assert.equal(by.atari8.delivery.writes, 'xex');
  assert.equal(by.nes.delivery.writes, 'nes');
  assert.equal(by.gb.delivery.writes, 'gb');
  assert.equal(by.nes.reach.units.contested, false);
  assert.equal(by.c64.reach.units.contested, true);
  assert.equal(typeof by.c64.reach.pageviews2025, 'number');
  assert.equal(by.mega65.reach.pageviewsProxy, true, 'no article of its own');
  assert.equal(by.c64.reach.refreshed, loadReach().refreshed);
});

test('a machine is asked as the project builds it: its own hardware, not the stock catalog', () => {
  // Stock PET is the 4K 2001: a floor of 8K would refuse it. The project fits 32K, and `8bs build pet` clears it, so the report must too.
  const config = { targets: { pet: { hardware: { model: '4032', ram: '32' } }, c64: { hardware: { port1: 'mouse1351' } }, atari8: { hardware: { media: 'cart8' } } } };
  const stock = Object.fromEntries(describeReach({ requires: { 'memory.ram': 8192 }, input: { primary: 'mouse', also: [] } }).map((r) => [r.id, r]));
  const own = Object.fromEntries(describeReach({ config, requires: { 'memory.ram': 8192 }, input: { primary: 'mouse', also: [] } }).map((r) => [r.id, r]));
  assert.deepEqual(stock.pet.floor, [{ key: 'memory.ram', need: 8192, have: 3071 }]);
  assert.deepEqual(own.pet.floor, []);
  assert.equal(stock.c64.input.primary.standing, 'absent');
  assert.equal(own.c64.input.primary.standing, 'optional', 'a mouse in a port is a run-time fact: optional at most');
  assert.equal(stock.atari8.delivery.writes, 'xex');
  assert.equal(own.atari8.delivery.writes, 'rom', 'a cartridge media value changes what the build writes');
  // A hardware value the catalog does not have is `8bs build`'s to refuse; the report falls back to the stock sheet rather than crash.
  assert.deepEqual(describeReach({ config: { targets: { pet: { hardware: { ram: '99' } } } }, requires: { 'memory.ram': 8192 } }).find((r) => r.id === 'pet').floor,
    [{ key: 'memory.ram', need: 8192, have: 3071 }]);
});

test('the table form prints the standing, the file and the figures with their markers', () => {
  const rows = describeReach({ requires: { 'input.keyboard': true }, input: { primary: 'stick', also: ['pad'] } });
  const by = Object.fromEntries(rows.map((r) => [r.id, formatReach(r).join('\n')]));
  assert.match(by.c64, /^c64 {9}builds\n {12}input {4}stick: standard · pad: absent\n {12}single {3}\.prg reaches .*emulator/);
  assert.match(by.c64, /reach {4}12\.5M–30M sold † · /);
  assert.match(by.nes, /^nes {9}refused: input\.keyboard needs it, has false/);
  assert.match(by.nes, /61\.91M sold · /, 'an uncontested figure has no dagger');
  assert.match(by.spectrum, /^spectrum\s+builds/);
  assert.match(by.mega65, /views\/yr ‡/);
  assert.match(by.supervision, /no units figure/);
});

test('compact: a number the reader can quote', () => {
  assert.equal(compact(12500000), '12.5M');
  assert.equal(compact(61910000), '61.91M');
  assert.equal(compact(452104), '452K');
  assert.equal(compact(1745), '1,745');
  assert.equal(compact(46), '46');
  assert.equal(compact(null), null);
});

test('8bs targets --reach: the report, and --json its rows; a wrong `input` is refused in words', async () => {
  const dir = project(`export default { entry: 'src/main.8bs', targets: { c64: {}, nes: {}, pet: { hardware: { model: '4032', ram: '32' } } },
    requires: { 'input.keyboard': true, 'memory.ram': 8192 }, input: { primary: 'stick', also: ['keyboard'] } };\n`);
  const { stdout } = await run(process.execPath, [BIN, 'targets', '--reach'], { cwd: dir });
  assert.match(stdout, /^This program is designed for: stick, and also plays on keyboard\n\n/);
  assert.match(stdout, /^pet {9}builds\n/m, 'the 32K PET the project fits clears the 8K floor');
  assert.match(stdout, /^vic20 {7}refused: memory\.ram needs 8192, has 3583\n/m, 'the unexpanded VIC-20 the project did not fit does not');
  assert.match(stdout, /\nnes {9}refused: input\.keyboard needs it, has false; memory\.ram needs 8192, has 1536\n/);
  assert.match(stdout, /\nreach sheet refreshed \d{4}-\d{2}-\d{2} \(packages\/cli\/data\/reach\.json/);
  const { stdout: json } = await run(process.execPath, [BIN, 'targets', '--reach', '--json'], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.input, { primary: 'stick', also: ['keyboard'] });
  assert.ok(parsed.reach.length >= 25);
  assert.equal(parsed.reach.find((r) => r.id === 'nes').floor.length, 2);

  const bad = project("export default { entry: 'src/main.8bs', input: { primary: 'joystick' } };\n");
  await assert.rejects(run(process.execPath, [BIN, 'targets', '--reach'], { cwd: bad }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /8bs targets: 8bitscript\.config\.ts's `input`\.primary must be one of stick, pad, keyboard, mouse, paddles, touch, not "joystick"/);
    return true;
  });
});
