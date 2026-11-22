import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as buildMos } from '../src/mos/index.ts';
import type { BuildOptions, IrProgram } from '../src/mos/index.ts';
import { build as buildWasm } from '../src/wasm/index.ts';
import { link } from '../index.mjs';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';

const HELLO_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'hello-world', 'src', 'hello-world.8bs');
const HELLO = readFileSync(HELLO_FILE, 'utf8');
const FILE = HELLO_FILE;

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
  assert.deepEqual(stages.slice(0, 2), ['tokens', 'ast']);
  assert.ok(stages.includes('module-ir'));
  assert.ok(stages.lastIndexOf('tokens') < stages.indexOf('module-ir'), 'every module is read before any is finished');
  const perModule = rec.events.filter((e) => e.stage === 'tokens' || e.stage === 'ast' || e.stage === 'module-ir');
  assert.ok(perModule.every((e) => typeof e.key === 'string' && e.key.length > 0));
  assert.equal(rec.events.at(-1)?.value, result.ir);
});

test('link() stops at diagnostics when the program does not link', () => {
  const rec = recorder();
  const result = link('pub fn main() {\n    nope();\n}\n', FILE, { machine: 'web', dump: rec.dump });
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

// ---- both sides of every condition -----------------------------------------

const vic20 = resolveHardware(loadCatalog('vic20'), {});
assert.ok(vic20.ok);
const vic20Hardware = vic20.ok ? (vic20.hardware as unknown as BuildOptions['hardware']) : (undefined as never);
const u8 = 'utinyint';
const HOOK = 'vic20RasterFrame';
const hookFn = (touchGlobal: boolean) => ({
  name: HOOK,
  body: [...(touchGlobal ? [{ kind: 'assign', target: 'g', value: { kind: 'const', value: 2, type: u8 } }] : []), { kind: 'return' }],
});
const mainFn = (body: unknown[]) => ({ name: 'main', body: [{ kind: 'waitFrame' }, ...body] });
const setG = { kind: 'assign', target: 'g', value: { kind: 'const', value: 1, type: u8 } };

const hookPrograms: Record<string, { ir: unknown; used: boolean }> = {
  'no hook function in the program': { ir: { entry: 'main', functions: [mainFn([])], globals: [] }, used: false },
  'a hook nothing calls or feeds': { ir: { entry: 'main', functions: [mainFn([]), hookFn(false)], globals: [] }, used: false },
  'a hook main calls and the optimizer inlines away': { ir: { entry: 'main', functions: [mainFn([{ kind: 'call', name: HOOK, args: [] }]), hookFn(false)], globals: [] }, used: true },
  'a hook fed through a shared global': { ir: { entry: 'main', functions: [mainFn([setG]), hookFn(true)], globals: [{ name: 'g', type: u8, address: null }] }, used: true },
};

for (const [name, { ir, used }] of Object.entries(hookPrograms)) {
  test(`vic20 frame hook with ${name}: backend-input says used=${used}, bytes equal with and without dump`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-stage-dump-'));
    try {
      const rec = recorder();
      const options = { machine: 'vic20', hardware: vic20Hardware, frameRate: 60 } as const;
      const plain = await buildMos(ir as IrProgram, { ...options, outFile: join(scratch, 'a.prg') });
      const dumped = await buildMos(ir as IrProgram, { ...options, outFile: join(scratch, 'b.prg'), dump: rec.dump });
      const input = rec.events[0].value as { frameHook: { name: string | null; used: boolean } };
      assert.deepEqual(input.frameHook, { name: HOOK, used });
      if (name.includes('inlines away')) {
        // Used, but no longer a callable function: the backend refuses it by name.
        assert.ok(!plain.ok && !dumped.ok);
        assert.deepEqual(dumped, plain);
        assert.deepEqual(rec.stages(), ['backend-input', 'error']);
        return;
      }
      assert.ok(plain.ok && dumped.ok, plain.ok ? '' : plain.error);
      if (!plain.ok || !dumped.ok) return;
      assert.deepEqual([...dumped.bytes], [...plain.bytes]);
      assert.deepEqual(rec.stages(), ['backend-input', 'link', 'bytes']);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

test('mos stages: size-report only with report, and a plain build with debug and remarks still matches', async () => {
  const linked = link(HELLO, FILE, { machine: 'c64', facts: resolveHardware(loadCatalog('c64'), {}).hardware?.facts });
  const resolved = resolveHardware(loadCatalog('c64'), {});
  assert.ok(resolved.ok);
  const hardware = resolved.hardware as unknown as BuildOptions['hardware'];
  const scratch = await mkdtemp(join(tmpdir(), '8bs-stage-dump-'));
  try {
    for (const report of [false, true]) {
      const rec = recorder();
      const outFile = join(scratch, `r${report}.prg`);
      const result = await buildMos(linked.ir as IrProgram, { machine: 'c64', hardware, frameRate: 60, report, debug: true, remarks: true, sources: linked.sources, outFile, dump: rec.dump });
      assert.ok(result.ok);
      assert.equal(rec.stages().includes('size-report'), report);
      assert.deepEqual(rec.stages(), ['backend-input', 'link', 'bytes', ...(report ? ['size-report'] : []), 'debug', 'listing', 'remarks']);
      assert.deepEqual(rec.events.at(-3)?.value, result.debugMap);
      assert.deepEqual(rec.events.at(-2)?.value, result.listing);
      assert.deepEqual(rec.events.at(-1)?.value, result.remarks);
      const input = rec.events[0].value as { report: boolean; debug: boolean; remarks: boolean };
      assert.deepEqual([input.report, input.debug, input.remarks], [report, true, true]);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('mos build without debug and remarks emits neither stage', async () => {
  const resolved = resolveHardware(loadCatalog('c64'), {});
  assert.ok(resolved.ok);
  const hardware = resolved.hardware as unknown as BuildOptions['hardware'];
  const linked = link(HELLO, FILE, { machine: 'c64', facts: resolved.hardware.facts });
  const scratch = await mkdtemp(join(tmpdir(), '8bs-stage-dump-'));
  try {
    const rec = recorder();
    const result = await buildMos(linked.ir as IrProgram, { machine: 'c64', hardware, frameRate: 60, outFile: join(scratch, 'p.prg'), dump: rec.dump });
    assert.ok(result.ok);
    assert.deepEqual(rec.stages(), ['backend-input', 'link', 'bytes']);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a refused mos build is the same with and without dump', async () => {
  const ir = { entry: 'nope', functions: [{ name: 'main', body: [] }], globals: [] } as IrProgram;
  const scratch = await mkdtemp(join(tmpdir(), '8bs-stage-dump-'));
  try {
    const options = { machine: 'vic20', hardware: vic20Hardware, frameRate: 60, outFile: join(scratch, 'x.prg') } as const;
    const plain = await buildMos(ir, options);
    const rec = recorder();
    const dumped = await buildMos(ir, { ...options, dump: rec.dump });
    assert.deepEqual(dumped, plain);
    assert.equal(plain.ok, false);
    assert.deepEqual(rec.stages(), ['error']);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('wasm stages: size-report only with report, and a failing build matches with and without dump', async () => {
  const linked = link(HELLO, FILE, { machine: 'web' });
  const scratch = await mkdtemp(join(tmpdir(), '8bs-stage-dump-'));
  try {
    for (const report of [false, true]) {
      const rec = recorder();
      const result = await buildWasm(linked.ir, { frameRate: 60, report, outFile: join(scratch, `r${report}.wasm`), dump: rec.dump });
      assert.ok(result.ok);
      assert.equal(rec.stages().includes('size-report'), report);
    }
    const bad = { entry: 'missing', functions: [] };
    const options = { outFile: join(scratch, 'bad.wasm'), frameRate: 60 };
    const plain = await buildWasm(bad, options);
    const rec = recorder();
    const dumped = await buildWasm(bad, { ...options, dump: rec.dump });
    assert.deepEqual(dumped, plain);
    assert.equal(plain.ok, false);
    assert.deepEqual(rec.stages(), ['error']);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('link() gives the same result with and without dump, for good and failing programs', () => {
  const bad = 'pub fn main() {\n    nope();\n}\n';
  for (const [text, file] of [[HELLO, FILE], [bad, '/virtual/bad.8bs']] as const) {
    const plain = link(text, file, { machine: 'web' });
    const rec = recorder();
    const dumped = link(text, file, { machine: 'web', dump: rec.dump });
    assert.deepEqual(dumped.diagnostics, plain.diagnostics);
    if (file === '/virtual/bad.8bs') assert.ok(plain.diagnostics.length > 0);
    assert.equal(dumped.ir === null, plain.ir === null);
  }
});

test('a program that imports another module dumps tokens, ast and module-ir for each file', () => {
  const rec = recorder();
  link(HELLO, FILE, { machine: 'c64', facts: resolveHardware(loadCatalog('c64'), {}).hardware?.facts, dump: rec.dump });
  const keys = rec.events.filter((e) => e.stage === 'tokens').map((e) => e.key);
  assert.ok(keys.length > 1, 'hello-world imports the text package');
  assert.equal(new Set(keys).size, keys.length);
  for (const stage of ['ast', 'module-ir']) {
    assert.deepEqual(rec.events.filter((e) => e.stage === stage).map((e) => e.key).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  }
});
