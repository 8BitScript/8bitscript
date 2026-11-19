// Times `parse` on the largest in-repo `.8bs` file, converted to the new
// syntax by the migrate printer. Run from the repo root (needs the workspace
// installed): node crates/front-wasm/tests/bench.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { convertSource } from '../../../packages/cli/src/migrate/print.mjs';
import { parse } from '../../../packages/compiler/src/front/index.mjs';

const skip = new Set(['node_modules', '.git', 'target', 'dist']);
let largest = { size: 0, path: '' };
const scan = (dir) => {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) scan(path);
    else if (name.endsWith('.8bs') && !name.startsWith('8bitscript.config') && stat.size > largest.size) {
      largest = { size: stat.size, path };
    }
  }
};
scan('packages');

const { text } = convertSource(readFileSync(largest.path, 'utf8'), { file: largest.path });
const first = parse([], text, largest.path);
if (first.diagnostics.length > 0) throw new Error(`diagnostics: ${first.diagnostics[0].message}`);
const runs = [];
for (let i = 0; i < 50; i += 1) {
  const start = process.hrtime.bigint();
  parse([], text, largest.path);
  runs.push(Number(process.hrtime.bigint() - start) / 1e6);
}
runs.sort((a, b) => a - b);
console.log(`${largest.path}: ${largest.size} bytes old, ${text.length} new; parse median ${runs[25].toFixed(1)} ms, max ${runs[49].toFixed(1)} ms`);
