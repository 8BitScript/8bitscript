// Fixture data for the prototypes: the real Vegas Nights programs (see its
// 8bitscript.config.8bs) with the extra fields the redesign adds to a program
// — a title, a description, a group and `define` inputs. Everything here is
// illustrative: the reasons a runtime is unavailable, the run times, the
// frame rates. The README says which fields are proposals.

export const SYSTEMS = [
  { id: 'pet', short: 'PET', name: 'Commodore PET', spec: '4032 · 32 KB', region: 'NTSC', emulator: 'xpet' },
  { id: 'vic20', short: 'VIC-20', name: 'Commodore VIC-20', spec: '8 KB expansion', region: 'NTSC', emulator: 'xvic' },
  { id: 'c64', short: 'C64', name: 'Commodore 64', spec: '64 KB', region: 'NTSC', emulator: 'x64sc' },
  { id: 'cx16', short: 'X16', name: 'Commander X16', spec: '512 KB banked', region: 'NTSC', emulator: 'x16emu' },
  { id: 'web', short: 'Web', name: 'Web', spec: 'browser runtime', region: '—', emulator: null },
];
export const system = (id) => SYSTEMS.find((s) => s.id === id);

const ALL = ['pet', 'vic20', 'c64', 'cx16', 'web'];

export const VEGAS = {
  id: 'vegas-nights',
  name: 'Vegas Nights',
  dir: 'vegas-nights',
  cli: '@8bitscript/cli 0.24.0',
  programs: [
    { id: 'slot3x3', group: 'Slots', title: '3×3 Slot', entry: 'src/labs/slot3x3/main.8bs', targets: ALL,
      desc: 'Three paylines across the middle and both diagonals. Pixel-smooth reels, exact 93.98% return.',
      asm: true,
      inputs: [
        { name: 'SEED', label: 'Seed', kind: 'number', def: 7, value: 7, help: 'Fixes the random draws, so a run repeats exactly.' },
        { name: 'START_CREDITS', label: 'Starting credits', kind: 'number', def: 1000, value: 1000, help: 'Credits in the bank when the machine starts.' },
        { name: 'OUTCOME', label: 'Force an outcome', kind: 'select', def: 'random', value: 'random',
          options: ['random', 'lose', 'cherries', 'lines', 'jackpot'], help: 'Replaces the five seeded slot3x3-* variants.' },
      ] },
    { id: 'slot5x5', group: 'Slots', title: '5×5 Ways Slot', entry: 'src/labs/slot5x5/main.8bs', targets: ALL,
      desc: '3,125 ways, a free-spin bonus and four jackpot meters. Needs the 8 KB VIC-20.',
      asm: true,
      inputs: [
        { name: 'SEED', label: 'Seed', kind: 'number', def: 7, value: 10, help: 'Fixes the random draws, so a run repeats exactly.' },
        { name: 'FORCE_BONUS', label: 'Start in the bonus round', kind: 'bool', def: false, value: true, help: 'Begins inside a free-spin round.' },
        { name: 'START_CREDITS', label: 'Starting credits', kind: 'number', def: 1000, value: 5000, help: 'Credits in the bank when the machine starts.' },
        { name: 'THEME', label: 'Symbol theme', kind: 'select', def: 'classic', value: 'classic', options: ['classic', 'cosmic'], help: 'Which tile art the reels use.' },
      ] },
    { id: 'lobby', group: 'Slots', title: 'Lobby', entry: 'src/lobby/main.8bs', targets: ALL, desc: 'The front door: pick a machine.', inputs: [] },
    { id: 'hello-reels', group: 'Labs', title: 'Hello Reels', entry: 'src/labs/hello-reels/main.8bs', targets: ALL, desc: 'Three cells and a key press.', inputs: [] },
    { id: 'sound-test', group: 'Labs', title: 'Sound Test', entry: 'src/labs/sound-test/main.8bs', targets: ALL, desc: 'Plays each slot sound on a key press.', inputs: [] },
    { id: 'tile-test', group: 'Labs', title: 'Tile Test', entry: 'src/labs/tile-test/main.8bs', targets: ['pet', 'vic20', 'c64', 'cx16'], desc: 'Every symbol of the theme, as the tables draw it.', inputs: [] },
    { id: 'slot3x3-probe', group: 'Test rigs', title: 'slot3x3-probe', entry: 'src/labs/slot3x3/probe.8bs', targets: ALL, desc: '', inputs: [] },
    { id: 'slot3x3-ruler', group: 'Test rigs', title: 'slot3x3-ruler', entry: 'src/labs/slot3x3/ruler.8bs', targets: ALL, desc: '', inputs: [] },
    { id: 'slot3x3-glyphs', group: 'Test rigs', title: 'slot3x3-glyphs', entry: 'src/labs/slot3x3/glyphs.8bs', targets: ALL, desc: '', inputs: [] },
    { id: 'slot5x5-retrigger-jackpot-seeded-ruler', group: 'Test rigs', title: 'slot5x5-retrigger-jackpot-seeded-ruler',
      entry: 'src/labs/slot5x5/retrigger-jackpot-seeded-ruler.8bs', targets: ALL, desc: '', inputs: [] },
  ],
};
export const program = (id) => VEGAS.programs.find((p) => p.id === id);

export const TWENTY_FORTY_EIGHT = {
  id: '2048', name: '2048', dir: '2048', cli: '@8bitscript/cli 0.24.0',
  programs: [{ id: 'main', group: '', title: '2048', entry: 'src/2048.8bs', targets: ALL,
    desc: 'The sliding-tile puzzle, one source tree for five machines.', inputs: [] }],
};

// Live runs and history for the Running list.
export const RUNNING = [
  { id: 'r1', title: '5×5 Ways Slot', system: 'c64', runtime: 'native', elapsed: '02:14', fps: '50 fps',
    cmd: '8bs run c64 --program slot5x5 --size', detail: 'x64sc · pid 41872' },
  { id: 'r2', title: '5×5 Ways Slot', system: 'c64', runtime: 'editor', elapsed: '00:41', fps: '60 fps',
    cmd: '8bs run c64 --program slot5x5 --web --no-open --port 0', detail: 'http://127.0.0.1:4173', url: 'http://127.0.0.1:4173' },
];
export const HISTORY = [
  { id: 'h1', title: '3×3 Slot', system: 'pet', runtime: 'browser', result: 'Stopped', when: '14:02', ok: true },
  { id: 'h2', title: 'Tile Test', system: 'vic20', runtime: 'native', result: 'Build failed · 2 errors', when: '13:48', ok: false },
];
