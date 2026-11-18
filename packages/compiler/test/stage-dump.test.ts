import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build as buildMos } from '../src/mos/index.ts';
import type { BuildOptions, IrProgram } from '../src/mos/index.ts';
import { build as buildWasm } from '../src/wasm/index.ts';
import { link } from '../index.mjs';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';

const HELLO = 'let n: utinyint = 0;\n\nexport function main(): void {\n    n = 1;\n}\n';
const FILE = '/virtual/hello.8bs';

type Event = { stage: string; value: unknown; key?: string };

function recorder() {
  const events: Event[] = [];
  const dump = (stage: string, value: unknown, key?: string) => { events.push({ stage, value, key }); };
  return { events, dump, stages: () => events.map((e) => e.stage) };
}

test('link() emits tokens, ast, module-ir, diagnostics and linked-ir in order', () => {
  const rec = recorder();
  const result = link(HELLO, FILE, { machine: 'web', dump: rec.dump });
  assert.deepEqual(result.diagnostics, []);
  const stages = rec.stages();
  assert.deepEqual(stages.slice(-2), ['diagnostics', 'linked-ir']);
  assert.deepEqual(stages.slice(0, 3), ['tokens', 'ast', 'module-ir']);
  const perModule = rec.events.filter((e) => e.stage === 'tokens' || e.stage === 'ast' || e.stage === 'module-ir');
  assert.ok(perModule.every((e) => typeof e.key === 'string' && e.key.length > 0));
  assert.equal(rec.events.at(-1)?.value, result.ir);
});

test('link() stops at diagnostics when the program does not link', () => {
  const rec = recorder();
  const result = link('export function main(): void {\n    nope();\n}\n', FILE, { machine: 'web', dump: rec.dump });
  assert.equal(result.ir, null);
  assert.equal(rec.stages().at(-1), 'diagnostics');
  assert.equal(rec.stages().includes('linked-ir'), false);
});

test('the c64 build emits backend-input, link, bytes and size-report in order, with equal bytes', async () => {
  const resolved = resolveHardware(loadCatalog('c64'), {});
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  const hardware = resolved.hardware as unknown as BuildOptions['hardware'];
  const linked = link(HELLO, FILE, { machine: 'c64', facts: resolved.hardware.facts });
  assert.deepEqual(linked.diagnostics, []);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-stage-dump-'));
  try {
    const rec = recorder();
    const options = { machine: 'c64', hardware, frameRate: 60, report: true } as const;
    const plain = await buildMos(linked.ir as IrProgram, { ...options, outFile: join(scratch, 'a.prg') });
    const dumped = await buildMos(linked.ir as IrProgram, { ...options, outFile: join(scratch, 'b.prg'), dump: rec.dump });
    assert.ok(plain.ok && dumped.ok);
    if (!plain.ok || !dumped.ok) return;
    assert.deepEqual(rec.stages(), ['backend-input', 'link', 'bytes', 'size-report']);
    assert.deepEqual([...dumped.bytes], [...plain.bytes]);
    assert.deepEqual(rec.events[2].value, dumped.bytes);
    const input = rec.events[0].value as { entry: string; frameHook: { name: string | null; used: boolean } };
    assert.equal(input.entry, (linked.ir as IrProgram).entry);
    assert.equal(typeof input.frameHook.used, 'boolean');
    const linkValue = rec.events[1].value as { symbols: unknown[]; layout: unknown[]; memory: unknown };
    assert.ok(Array.isArray(linkValue.symbols) && Array.isArray(linkValue.layout) && linkValue.memory);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the web build emits wasm-input, bytes and size-report in order, with equal bytes', async () => {
  const linked = link(HELLO, FILE, { machine: 'web' });
  assert.deepEqual(linked.diagnostics, []);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-stage-dump-'));
  try {
    const rec = recorder();
    const options = { frameRate: 60, report: true };
    const plain = await buildWasm(linked.ir, { ...options, outFile: join(scratch, 'a.wasm') });
    const dumped = await buildWasm(linked.ir, { ...options, outFile: join(scratch, 'b.wasm'), dump: rec.dump });
    assert.ok(plain.ok && dumped.ok);
    if (!plain.ok || !dumped.ok) return;
    assert.deepEqual(rec.stages(), ['wasm-input', 'bytes', 'size-report']);
    assert.deepEqual([...dumped.bytes], [...plain.bytes]);
    const input = rec.events[0].value as Record<string, unknown>;
    assert.deepEqual(Object.keys(input).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), ['entry', 'functions', 'globals', 'remarks', 'strings']);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a refused build emits error with the message and a newline', async () => {
  const linked = link(HELLO, FILE, { machine: 'web' });
  const scratch = await mkdtemp(join(tmpdir(), '8bs-stage-dump-'));
  try {
    const mos = recorder();
    const refused = await buildMos(linked.ir as IrProgram, {
      machine: 'nope' as BuildOptions['machine'], hardware: { build: { defsym: {} }, facts: {} }, outFile: join(scratch, 'x.prg'), frameRate: 60, dump: mos.dump,
    });
    assert.equal(refused.ok, false);
    assert.deepEqual(mos.stages(), ['error']);
    assert.equal(mos.events[0].value, `${refused.ok ? '' : refused.error}\n`);

    const wasm = recorder();
    const noEntry = await buildWasm({ entry: 'missing', functions: [] }, { outFile: join(scratch, 'x.wasm'), frameRate: 60, dump: wasm.dump });
    assert.equal(noEntry.ok, false);
    assert.deepEqual(wasm.stages(), ['error']);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
