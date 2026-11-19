// Regenerates fixtures/waitframe.json. Run from the repo root:
//   node crates/mos/tests/gen/waitframe.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  frameEdgeWait, waitFrameKeepsInterrupts, waitFrameRoutine, waitFrameSetup,
  WAIT_FRAME_LABEL, WAIT_FRAME_ZP_BYTES,
} from '../../../../packages/compiler/src/mos/startup/waitframe.ts';

const machines = [
  'vic20', 'c64', 'pet', 'c128', 'mega65', 'cx16', 'nes', 'atari8', 'plus4', 'oric', 'apple2', 'bbc',
  'atari5200', 'lynx', 'pce', 'supervision', 'atari2600', 'atari7800',
];
const rates = [1, 25, 30, 50, 59.94, 60, 60.0988, 100, 255, 256, 1000];
const hooks = [null, 'hook'];
const pairs = [[0x10, 0x14], [0xf0, 0xf4]];

const setups = {};
const routines = {};
const rows = [];
for (const machine of machines) {
  for (const [acc, num] of pairs) {
    for (const rate of rates) {
      const key = `${machine}|${rate}|${acc}`;
      setups[key] = JSON.stringify(waitFrameSetup(rate, acc, num, machine));
      for (const hook of hooks) {
        const rkey = `${machine}|${acc}|${hook}`;
        if (!(rkey in routines)) routines[rkey] = JSON.stringify(waitFrameRoutine(acc, num, machine, hook));
        rows.push({ machine, rate, acc, num, hook, setup: key, routine: rkey });
      }
    }
  }
}
const edges = machines.map((machine) => {
  const d = frameEdgeWait(machine, 'tagx');
  return { machine, keeps: waitFrameKeepsInterrupts(machine), edge: d === null ? null : JSON.stringify(d) };
});
const out = { label: WAIT_FRAME_LABEL, zpBytes: WAIT_FRAME_ZP_BYTES, setups, routines, rows, edges };
writeFileSync(fileURLToPath(new URL('../fixtures/waitframe.json', import.meta.url)), JSON.stringify(out));
console.log(rows.length, Object.keys(setups).length, Object.keys(routines).length);
