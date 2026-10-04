// The launcher's states as the design draws them (docs/design/), built through
// the real rules in src/launcherState.cjs so a fixture cannot claim something
// the extension would never say. The tests use these, and so does the script
// that renders the real page to PNG (docs/design/wired).
'use strict';

const units = require('../../src/units.cjs');
const { availabilityFromMatrix, movedNote, normalizeState } = require('../../src/launcherState.cjs');

const SYSTEMS = [
  { id: 'pet', short: 'PET', name: 'Commodore PET', spec: '4032 · 32 KB', region: 'NTSC', emulator: 'xpet' },
  { id: 'vic20', short: 'VIC-20', name: 'Commodore VIC-20', spec: '8 KB expansion', region: 'NTSC', emulator: 'xvic' },
  { id: 'c64', short: 'C64', name: 'Commodore 64', spec: '64 KB', region: 'NTSC', emulator: 'x64sc' },
  { id: 'cx16', short: 'X16', name: 'Commander X16', spec: '512 KB banked', region: 'NTSC', emulator: 'x16emu' },
  { id: 'web', short: 'Web', name: 'Web', spec: 'browser runtime', region: '—', emulator: null },
];
const ALL = SYSTEMS.map((s) => s.id);
const sys = (id) => SYSTEMS.find((s) => s.id === id);

const SEED = { name: 'SEED', label: 'Seed', kind: 'number', def: 7, help: 'Fixes the random draws, so a run repeats exactly.' };
const CREDITS = { name: 'START_CREDITS', label: 'Starting credits', kind: 'number', def: 1000, help: 'Credits in the bank when the machine starts.' };

/** The Vegas Nights programs, as the config would describe them. */
const PROGRAMS = [
  { id: 'slot3x3', group: 'Slots', title: '3×3 Slot', entry: 'src/labs/slot3x3/main.8bs', targets: ALL,
    description: 'Three paylines across the middle and both diagonals. Pixel-smooth reels, exact 93.98% return.',
    inputs: [SEED, CREDITS, { name: 'OUTCOME', label: 'Force an outcome', kind: 'select', def: 'random', options: ['random', 'lose', 'cherries', 'lines', 'jackpot'], help: 'Replaces the five seeded slot3x3-* variants.' }] },
  { id: 'slot5x5', group: 'Slots', title: '5×5 Ways Slot', entry: 'src/labs/slot5x5/main.8bs', targets: ALL,
    description: '3,125 ways, a free-spin bonus and four jackpot meters. Needs the 8 KB VIC-20.',
    inputs: [SEED, { name: 'FORCE_BONUS', label: 'Start in the bonus round', kind: 'bool', def: false, help: 'Begins inside a free-spin round.' }, CREDITS,
      { name: 'THEME', label: 'Symbol theme', kind: 'select', def: 'classic', options: ['classic', 'cosmic'], help: 'Which tile art the reels use.' }] },
  { id: 'lobby', group: 'Slots', title: 'Lobby', entry: 'src/lobby/main.8bs', targets: ALL, description: 'The front door: pick a machine.', inputs: [] },
  { id: 'hello-reels', group: 'Labs', title: 'Hello Reels', entry: 'src/labs/hello-reels/main.8bs', targets: ALL, description: 'Three cells and a key press.', inputs: [] },
  { id: 'sound-test', group: 'Labs', title: 'Sound Test', entry: 'src/labs/sound-test/main.8bs', targets: ALL, description: 'Plays each slot sound on a key press.', inputs: [] },
  { id: 'tile-test', group: 'Labs', title: 'Tile Test', entry: 'src/labs/tile-test/main.8bs', targets: ['pet', 'vic20', 'c64', 'cx16'], description: 'Every symbol of the theme, as the tables draw it.', inputs: [], wasmBlock: { vic20: "The VIC-20's WASM build can't redefine characters yet, and Tile Test draws with them." } },
  { id: 'slot3x3-probe', group: 'Test rigs', title: 'slot3x3-probe', entry: 'src/labs/slot3x3/probe.8bs', targets: ALL, inputs: [] },
  { id: 'slot3x3-ruler', group: 'Test rigs', title: 'slot3x3-ruler', entry: 'src/labs/slot3x3/ruler.8bs', targets: ALL, inputs: [] },
  { id: 'slot3x3-glyphs', group: 'Test rigs', title: 'slot3x3-glyphs', entry: 'src/labs/slot3x3/glyphs.8bs', targets: ALL, inputs: [] },
  { id: 'slot5x5-retrigger-jackpot-seeded-ruler', group: 'Test rigs', title: 'slot5x5-retrigger-jackpot-seeded-ruler', entry: 'src/labs/slot5x5/retrigger-jackpot-seeded-ruler.8bs', targets: ALL, inputs: [] },
];


/**
 * A ready state for Vegas Nights.
 *
 * @param {object} [o]
 * @param {string} [o.system]
 * @param {string} [o.program] the selected program id
 * @param {Record<string, string>} [o.remembered] last-used runtime per program
 * @param {Record<string, object>} [o.values] changed input values per program
 * @param {string[]} [o.missing] emulator names that are not installed
 */
function vegas({ system = 'c64', program = 'slot3x3', remembered = {}, values = {}, missing = [], running = [], history = [], notices = [], programs = PROGRAMS, live = {} } = {}) {
  const machine = sys(system);
  const doctor = machine.emulator && missing.includes(machine.emulator) ? { notInstalled: [system], failed: [], ready: [] } : null;
  const list = programs.map((p) => {
    const onSystem = p.targets.includes(system);
    const matrix = units.runtimeMatrix({ runtime: units.legacyRuntime(system), target: system, program: { label: p.title, targets: p.targets }, doctor });
    const av = availabilityFromMatrix(matrix, { emulator: machine.emulator });
    const block = p.wasmBlock?.[system];
    if (block) { av.editor = { ok: false, reason: block, use: 'native' }; av.browser = av.editor; }
    const works = Object.fromEntries(Object.keys(av).map((id) => [id, { available: av[id].ok }]));
    const primary = onSystem ? units.defaultRuntime({ matrix: works, remembered: remembered[p.id], preferEditor: true }) : null;
    const moved = primary ? movedNote(remembered[p.id], primary, av) : '';
    return {
      id: p.id, title: p.title, group: p.group, description: p.description ?? '', entry: p.entry, onSystem,
      inputs: p.inputs.map((i) => ({ ...i, value: values[p.id]?.[i.name] ?? i.def })),
      runtimes: av, primary, ...(moved ? { primaryMoved: moved } : {}), live: live[p.id] ?? [],
    };
  });
  const selected = list.find((p) => p.id === program);
  const changed = selected.inputs.filter((i) => i.value !== i.def);
  const base = ['run', system, '--program', program, ...changed.flatMap((i) => ['--define', `${i.name}=${i.value}`]), '--size'];
  const command = units.formatCommand([...base, ...units.runtimeArgs(selected.primary ?? 'native', system)]);
  return normalizeState({
    phase: 'ready',
    notices,
    projects: [{ id: '/v', label: 'Vegas Nights', where: 'vegas-nights', group: 'Projects' }, { id: '/2048', label: '2048', where: '2048', group: 'Projects' }],
    project: { id: '/v', name: 'Vegas Nights', sub: 'vegas-nights' },
    systems: SYSTEMS.map((s) => ({ ...s, group: '', enabled: programs.find((p) => p.id === program).targets.includes(s.id) })),
    system,
    summary: { name: machine.name, text: [machine.spec, machine.region !== '—' ? machine.region : null, 'English'].filter(Boolean).join(' · ') },
    programs: list,
    program,
    collapsedGroups: ['Test rigs'],
    command,
    running,
    history,
  });
}

/** A project with one program: no picker, fewer rows. */
function single({ system = 'vic20' } = {}) {
  const only = { id: 'main', group: '', title: '2048', entry: 'src/2048.8bs', targets: ALL, description: 'The sliding-tile puzzle, one source tree for five machines.', inputs: [] };
  const state = vegas({ system, program: 'main', programs: [only] });
  state.project = { id: '/2048', name: '2048', sub: '2048' };
  return state;
}

const RUNNING = [
  { id: 'r1', programId: 'slot5x5', title: '5×5 Ways Slot', system: 'c64', runtime: 'native', elapsed: '2m 14s', fps: '50 fps', detail: 'x64sc', command: '8bs run c64 --program slot5x5 --size',
    details: [{ label: 'Hardware', value: 'stock machine' }, { label: 'Image', value: 'dist/slot5x5.prg', mono: true }, { label: 'Memory', value: '105 bytes RAM · 10899 bytes program' }],
    size: [{ name: 'program', text: '10899 B · 100.0%' }, { name: 'reel tables', text: '2840 B · 26.1%' }] },
  { id: 'r2', programId: 'slot5x5', title: '5×5 Ways Slot', system: 'c64', runtime: 'editor', elapsed: '41s', fps: '60 fps', detail: 'http://127.0.0.1:4173', url: 'http://127.0.0.1:4173',
    command: '8bs run c64 --program slot5x5 --web --no-open --port 0', details: [{ label: 'Local URL', value: 'http://127.0.0.1:4173', mono: true }] },
];
const HISTORY = [
  { id: 'h1', title: '3×3 Slot', system: 'pet', runtime: 'browser', result: 'Stopped', when: '14:02', ok: true },
  { id: 'h2', title: 'Tile Test', system: 'vic20', runtime: 'native', result: 'Build failed · 2 errors', when: '13:48', ok: false },
];

module.exports = { ALL, HISTORY, PROGRAMS, RUNNING, SYSTEMS, single, vegas };
