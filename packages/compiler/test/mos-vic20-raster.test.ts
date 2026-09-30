// The VIC-20's raster list is applied by the frame runtime: the VIC has no
// interrupt, so FRAME_SYNC.vic20 names @8bitscript/vic20/rasterline's
// vic20RasterFrame() as its frame hook and waitFrame() calls it after
// every frame edge (packages/vic20/AGENTS.md, "Raster splits"). Nothing in
// a program calls the hook, so the pruner keeps it only when a function
// the program reaches shares a global with it — the rule pinned here, with
// the guard that tells "pruned, nothing feeds it" (fine, and free) from
// "inlined away while the program feeds it" (refused by name).
// packages/vic20/test/raster.test.mjs is the same thing seen on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build, FRAME_SYNC } from '../src/mos/index.ts';
import type { BuildOptions, IrProgram } from '../src/mos/index.ts';
import { waitFrameRoutine } from '../src/mos/startup/waitframe.ts';
import { frameHookWanted, pruneUnreachable } from '../src/linker/reachability.mjs';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';

const HOOK = 'vic20RasterFrame';

/** The hook's shape: it reads the plan the program commits, and ends in `return`. */
const hookReadingPlan = (withReturn = true) => ({
  name: HOOK,
  body: [
    {
      kind: 'memoryWrite',
      address: { kind: 'const', value: 0x900f, type: 'usmallint' },
      value: { kind: 'ref', name: 'plan', type: 'utinyint' },
    },
    ...(withReturn ? [{ kind: 'return' }] : []),
  ],
});

const commitPlan = { kind: 'assign', target: 'plan', value: { kind: 'const', value: 3, type: 'utinyint' } };
const frameLoop = { kind: 'while', test: { kind: 'const', value: 1, type: 'bool' }, body: [{ kind: 'waitFrame' }] };

const program = (mainBody: unknown[], hook = hookReadingPlan()): IrProgram => ({
  entry: 'main',
  functions: [{ name: 'main', body: mainBody }, hook] as IrProgram['functions'],
  globals: [{ name: 'plan', type: 'utinyint', address: null }],
});

async function buildVic20(ir: IrProgram) {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-vic20-raster-'));
  const resolved = resolveHardware(loadCatalog('vic20'), {});
  assert.ok(resolved.ok);
  const result = await build(ir, {
    machine: 'vic20',
    hardware: (resolved.ok ? resolved.hardware : {}) as unknown as BuildOptions['hardware'],
    outFile: join(scratch, 'out.prg'),
    frameRate: 60,
  });
  await rm(scratch, { recursive: true, force: true });
  return result;
}

test('FRAME_SYNC.vic20 names the raster hook, and waitFrame() calls it right after the frame edge', () => {
  const sync = FRAME_SYNC.vic20;
  assert.equal(sync.kind, 'level');
  assert.equal('frameHook' in sync ? sync.frameHook : undefined, HOOK);
  const routine = waitFrameRoutine(0x10, 0x18, 'vic20', '__8bs_fn_vic20RasterFrame');
  const wait = routine.findIndex((d) => d.kind === 'label' && /_returning$/.test(d.name));
  const hook = routine.findIndex((d) => d.kind === 'instruction' && d.mnemonic === 'JSR');
  assert.ok(wait >= 0 && hook > wait, 'the hook is called after the raster wait returns to the top of the frame');
  const between = routine.slice(wait, hook).filter((d) => d.kind === 'instruction').map((d) => d.kind === 'instruction' && d.mnemonic);
  assert.deepEqual(between, ['LDA', 'CMP', 'BCS'], 'and nothing but the wait itself runs before it');
});

test('pruneUnreachable keeps a frame hook that shares a global with reachable code, and only then', () => {
  const fed = pruneUnreachable(program([commitPlan, frameLoop]), { frameHook: HOOK });
  assert.ok(fed.functions.some((fn) => fn.name === HOOK), 'main writes the plan the hook reads: kept');
  assert.ok(fed.globals.some((g) => g.name === 'plan'));

  const unfed = pruneUnreachable(program([frameLoop]), { frameHook: HOOK });
  assert.equal(unfed.functions.some((fn) => fn.name === HOOK), false, 'nothing touches the plan: pruned');
  assert.equal(unfed.globals.some((g) => g.name === 'plan'), false, 'and the plan with it');

  const unnamed = pruneUnreachable(program([commitPlan, frameLoop]));
  assert.equal(unnamed.functions.some((fn) => fn.name === HOOK), false, 'a machine with no hook roots nothing');
});

test('frameHookWanted reads the hook\'s globals against the live functions\', never the hook\'s own or a local\'s', () => {
  const hook = hookReadingPlan();
  const globals = [{ name: 'plan' }];
  assert.equal(frameHookWanted(hook, [{ name: 'main', body: [commitPlan] }], globals), true);
  assert.equal(frameHookWanted(hook, [{ name: 'main', body: [frameLoop] }], globals), false);
  assert.equal(frameHookWanted(hook, [hook], globals), false, 'the hook reading its own global does not feed it');
  assert.equal(frameHookWanted(hook, [{ name: 'main', body: [commitPlan] }], []), false, 'a name that is not a global is a local');
});

test('a VIC-20 program that feeds the hook links it, and the wait routine JSRs it', async () => {
  const result = await buildVic20(program([commitPlan, frameLoop]));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const bytes = [...result.bytes];
  // LDA $9004 / CMP #64 / BCS back, then JSR: the hook after the edge.
  const edge = bytes.findIndex((_, i) => bytes[i] === 0xad && bytes[i + 1] === 0x04 && bytes[i + 2] === 0x90
    && bytes[i + 3] === 0xc9 && bytes[i + 4] === 0x40 && bytes[i + 5] === 0xb0 && bytes[i + 7] === 0x20);
  assert.ok(edge > 0, 'the returning half of the raster wait is followed by a JSR');
});

test('a VIC-20 program that never feeds the hook is byte-identical to one with no hook at all', async () => {
  const withHook = await buildVic20(program([frameLoop]));
  const without: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [frameLoop] }] as IrProgram['functions'], globals: [] };
  const plain = await buildVic20(without);
  assert.equal(withHook.ok && plain.ok, true);
  if (!withHook.ok || !plain.ok) return;
  assert.deepEqual([...withHook.bytes], [...plain.bytes]);
});

test('a fed hook the program also calls, and the inliner pastes into its caller, stays callable: the pruner roots it', async () => {
  // The NES's failure — a no-`return` hook inlined into its one call site
  // and pruned, so nothing delivers the queue — cannot happen to a hook
  // the pruner roots by name: the pasted copy runs where it was called and
  // the function itself is kept for the backend's JSR. (The guard in
  // mos/index.ts still stands for a hook whose only root is a call.)
  const result = await buildVic20(program([commitPlan, { kind: 'call', name: HOOK, args: [] }, frameLoop], hookReadingPlan(false)));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const bytes = [...result.bytes];
  const edge = bytes.findIndex((_, i) => bytes[i] === 0xad && bytes[i + 1] === 0x04 && bytes[i + 2] === 0x90
    && bytes[i + 3] === 0xc9 && bytes[i + 4] === 0x40 && bytes[i + 5] === 0xb0 && bytes[i + 7] === 0x20);
  assert.ok(edge > 0, 'the wait routine still JSRs the hook');
});
