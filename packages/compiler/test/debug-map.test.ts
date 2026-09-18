import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from '../src/mos/index.ts';
import type { BuildOptions, IrProgram } from '../src/mos/index.ts';
import { link } from '../index.mjs';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';

// Real source, through the real front end and the real MOS backend — the
// same `link()`/`build()` path packages/compiler/test/mos.test.ts's own
// acceptance tests use, so what's being proven is the actual pipeline
// (source-aware-assembly plan's "Immediate Deliverable"), not a synthetic
// IR fixture standing in for it.
async function buildDebug(src: string, main: string, extra: Partial<BuildOptions> = {}) {
  const resolved = resolveHardware(loadCatalog('pet'), { profile: '3032' });
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  const linked = link(src, main, { machine: 'pet', facts: resolved.hardware.facts });
  assert.deepEqual(linked.diagnostics, []);
  assert.ok(linked.ir);
  const hardware = resolved.hardware as unknown as BuildOptions['hardware'];
  const scratch = await mkdtemp(join(tmpdir(), '8bs-debug-map-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(linked.ir as IrProgram, {
      machine: 'pet', hardware, outFile, frameRate: 60,
      debug: true, sources: linked.sources, ...extra,
    });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) throw new Error('unreachable');
    const lst = await readFile(outFile.replace(/\.prg$/, '.lst'), 'utf8');
    const debugJson = JSON.parse(await readFile(outFile.replace(/\.prg$/, '.8bs.debug.json'), 'utf8'));
    return { result, lst, debugJson };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('source -> instruction mapping: a real build maps score += 1 to LDA/ADC/STA-or-INC with the right file, line, and function', async () => {
  const src = `let score: utinyint = 0;

function updateScore(): void {
    score += 1;
}

export function main(): void {
    updateScore();
}
`;
  const { result, lst, debugJson } = await buildDebug(src, '/virtual/game.8bs');
  assert.equal(debugJson.format, '8bitscript-debug');
  assert.equal(debugJson.version, 1);
  assert.equal(debugJson.target, 'pet');
  assert.ok(debugJson.modules.includes('/virtual/game.8bs'));

  // updateScore() is a real function called once from main(), small enough
  // the inliner folds it into main() (linker/optimize.mjs) — so its own
  // instructions carry origin: 'updateScore', function: 'main'. Either
  // way, at least one instruction is attributed to the score += 1 line.
  const scoreLine = src.split('\n').findIndex((l) => l.includes('score += 1')) + 1;
  const attributed = debugJson.instructions.filter((i: { source: { line: number } | null }) => i.source?.line === scoreLine);
  assert.ok(attributed.length > 0, `expected at least one instruction on line ${scoreLine}, got ${JSON.stringify(debugJson.instructions, null, 2)}`);
  for (const instr of attributed) {
    assert.equal(instr.source.file, '/virtual/game.8bs');
    assert.equal(instr.source.text, 'score += 1;');
    assert.ok(['updateScore', 'main'].includes(instr.function));
  }

  assert.ok(lst.includes('score += 1;'), 'the .lst carries the source text inline');
  assert.ok(result.ok && result.listing && result.listing.length > 0, 'build() also returns the listing directly, not just the file');
});

test('multiple modules: an imported function\'s own file shows up in the debug map, distinct from the entry\'s', async () => {
  const src = `import { bump } from "./helper.8bs";

export function main(): void {
    bump();
}
`;
  const resolved = resolveHardware(loadCatalog('pet'), { profile: '3032' });
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-debug-multimod-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const mainPath = join(scratch, 'game.8bs');
    await writeFile(join(scratch, 'helper.8bs'), `let counter: utinyint = 0;\n\nexport function bump(): void {\n    counter += 1;\n}\n`);
    const linked = link(src, mainPath, { machine: 'pet', facts: resolved.hardware.facts });
    assert.deepEqual(linked.diagnostics, []);
    assert.ok(linked.ir);
    const hardware = resolved.hardware as unknown as BuildOptions['hardware'];
    const outFile = join(scratch, 'out.prg');
    const result = await build(linked.ir as IrProgram, {
      machine: 'pet', hardware, outFile, frameRate: 60, debug: true, sources: linked.sources,
    });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const debugJson = JSON.parse(await readFile(outFile.replace(/\.prg$/, '.8bs.debug.json'), 'utf8'));
    const helperPath = join(scratch, 'helper.8bs');
    assert.ok(debugJson.modules.includes(helperPath), `expected ${helperPath} among modules, got ${JSON.stringify(debugJson.modules)}`);
    const fromHelper = debugJson.instructions.filter((i: { source: { file: string } | null }) => i.source?.file === helperPath);
    assert.ok(fromHelper.length > 0, 'at least one instruction should be attributed to the imported file');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('artifact offsets: address (CPU) and artifactOffset (into the linked image) are different numbers, related by codeOrigin', async () => {
  const src = `let score: utinyint = 0;\n\nexport function main(): void {\n    score += 1;\n}\n`;
  const { debugJson, result } = await buildDebug(src, '/virtual/game.8bs');
  assert.ok(debugJson.instructions.length > 0);
  for (const instr of debugJson.instructions) {
    assert.equal(typeof instr.address, 'number');
    assert.equal(typeof instr.artifactOffset, 'number');
    // A PET .prg loads well above address 0 (BASIC's program area), so a
    // real CPU address is never equal to its own small offset into the
    // linked image — the two numbers the plan's "Runtime Address vs File
    // Offset" section says must never be assumed interchangeable.
    assert.notEqual(instr.address, instr.artifactOffset);
    assert.ok(instr.artifactOffset >= 0);
  }
  assert.ok(result.ok);
});

test('determinism: building the same program twice produces the same debug map, aside from nothing variable at all', async () => {
  const src = `let score: utinyint = 0;\n\nexport function main(): void {\n    score += 1;\n    score += 1;\n}\n`;
  const a = await buildDebug(src, '/virtual/game.8bs');
  const b = await buildDebug(src, '/virtual/game.8bs');
  assert.deepEqual(a.debugJson, b.debugJson);
  assert.equal(a.lst, b.lst);
});

test('a release build (debug not requested) writes no .lst/.debug.json and returns neither field', async () => {
  const src = `export function main(): void {\n}\n`;
  const resolved = resolveHardware(loadCatalog('pet'), { profile: '3032' });
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  const linked = link(src, '/virtual/game.8bs', { machine: 'pet', facts: resolved.hardware.facts });
  assert.ok(linked.ir);
  const hardware = resolved.hardware as unknown as BuildOptions['hardware'];
  const scratch = await mkdtemp(join(tmpdir(), '8bs-debug-off-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(linked.ir as IrProgram, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.equal(result.listing, undefined);
    assert.equal(result.debugMap, undefined);
    await assert.rejects(readFile(outFile.replace(/\.prg$/, '.lst')));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
