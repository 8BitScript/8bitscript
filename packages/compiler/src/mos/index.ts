// The 6502 backend: IR in, machine code out.
//
// `build()` for the PET now lowers the linked IR's entry function for real:
// memoryWrite of a literal (milestone 4), 8-bit arithmetic, control flow,
// and locals (milestone 6) — everything else still fails naming the
// construct. It assembles the result alongside the epilogue, links it
// against the machine's real RAM ceiling (globals from milestone 5's
// allocator, locals and expression temporaries from milestone 6's, stacked
// in the same zero-page budget), and wraps it in the BASIC stub. This file
// also holds the contract the CLI calls and the machine facts the future
// code generator will need: the instruction-set variant of each CPU, the
// file extension a build produces, and the frame-sync numbers `waitFrame()`
// is paced against.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { basicStub } from './basic-stub.ts';
import { buildDataSection } from './data.ts';
import type { ConstArrayGlobal, IrString } from './data.ts';
import { link } from './link/index.ts';
import { lower } from './lower/index.ts';
import type { Directive, FunctionSite, IrFunction } from './lower/index.ts';
import { LocalAllocator } from './lower/allocator.ts';
import { prgBytes } from './prg.ts';
import { epilogue, prologue, usesDecimalSensitiveMath } from './startup/commodore.ts';
import { WAIT_FRAME_ZP_BYTES, usesWaitFrame, waitFrameRoutine, waitFrameSetup } from './startup/waitframe.ts';
import { storageBytes } from '../types/index.mjs';
import { allocate, placeZp } from './zp/index.ts';
import type { IrGlobal, ZpHole } from './zp/index.ts';

/** The linked IR's top-level shape — the pieces `functions` (lower/index.ts), `globals` (zp/index.ts), and `strings` (mos/data.ts's own string-table half) each read. */
export interface IrProgram {
  entry: string;
  functions: IrFunction[];
  globals: IrGlobal[];
  /** ir.strings (ir/index.mjs) — every string literal the linked program declares, merged and deduplicated by the linker. Optional only so existing synthetic test fixtures that predate milestone 9 don't all need updating; real linked IR always sets it (possibly `[]`). */
  strings?: IrString[];
}

export type Machine = 'vic20' | 'c64' | 'pet' | 'c128' | 'mega65' | 'cx16' | 'nes' | 'atari8';

/** What the CLI hands a build. `hardware` is the resolved object from packages/cli/src/hardware.mjs. */
export interface BuildOptions {
  machine: Machine;
  hardware: { build: { defsym: Record<string, number>; startup?: string; output?: string }; facts: Record<string, unknown> };
  outFile: string;
  frameRate: number;
}

export type BuildResult =
  | { ok: true; bytes: Uint8Array; memory: { variables: number; program: number } }
  | { ok: false; error: string };

export interface CpuVariant {
  core: '6502' | '6510' | '8502' | '65C02' | '45GS10' | '2A03';
  decimalMode: boolean;
  jmpIndirectPageBug: boolean;
  extraOpcodes: ReadonlyArray<'STZ' | 'BRA' | 'PHX' | 'PHY' | 'PLX' | 'PLY' | 'TRB' | 'TSB' | 'INW' | 'DEW'>;
  undocumentedOpcodes: boolean;
}

const NONE: CpuVariant['extraOpcodes'] = [];
const CMOS: CpuVariant['extraOpcodes'] = ['STZ', 'BRA', 'PHX', 'PHY', 'PLX', 'PLY', 'TRB', 'TSB'];
const MEGA65_EXTRA: CpuVariant['extraOpcodes'] = [...CMOS, 'INW', 'DEW'];

/** The instruction-set variant each machine runs. Data, not logic. */
export const CPU: Record<Machine, CpuVariant> = {
  vic20: { core: '6502', decimalMode: true, jmpIndirectPageBug: true, extraOpcodes: NONE, undocumentedOpcodes: false },
  pet: { core: '6502', decimalMode: true, jmpIndirectPageBug: true, extraOpcodes: NONE, undocumentedOpcodes: false },
  c64: { core: '6510', decimalMode: true, jmpIndirectPageBug: true, extraOpcodes: NONE, undocumentedOpcodes: false },
  c128: { core: '8502', decimalMode: true, jmpIndirectPageBug: true, extraOpcodes: NONE, undocumentedOpcodes: false },
  cx16: { core: '65C02', decimalMode: true, jmpIndirectPageBug: false, extraOpcodes: CMOS, undocumentedOpcodes: false },
  mega65: { core: '45GS10', decimalMode: true, jmpIndirectPageBug: false, extraOpcodes: MEGA65_EXTRA, undocumentedOpcodes: false },
  nes: { core: '2A03', decimalMode: false, jmpIndirectPageBug: true, extraOpcodes: NONE, undocumentedOpcodes: false },
  atari8: { core: '6502', decimalMode: true, jmpIndirectPageBug: true, extraOpcodes: NONE, undocumentedOpcodes: true },
};

// Where BASIC's own program area starts, and so where a Commodore .prg's
// load address and boot stub go — the same on every model of a machine
// (a PET's --profile only changes RAM size and columns, never this).
// Only the PET builds in 0.2.0; the other two entries are milestone 1's own
// roadmap note that the C64 and VIC-20 need just this number to follow,
// once RELEASE_MACHINES lets them.
const LOAD_ADDRESS: Partial<Record<Machine, number>> = {
  pet: 0x0401,
  c64: 0x0801,
  vic20: 0x1001,
};

// Milestone 5's own settled decision: every program shape this backend
// builds today returns to BASIC (main() falling through to RTS lands back
// in the SYS that called it — no "never returns" shape exists yet, that
// waits on a real main-loop construct at milestone 10), so the safe zp
// budget always leaves BASIC's own zero page alone rather than picking
// between two shapes with only one actually buildable. packages/pet's own
// AGENTS.md documents BASIC's range as $0002-$008D (from PETdoc.txt/
// progmod.html); $8E-$FF is what is left before the CPU stack at $0100
// on BASIC 2/4. BASIC 1 (the original 2001) copies CHRGET to $C2-$D9
// instead of $70-$87 — same 24-byte routine, different address — and a
// program that occupies that window returns to a smashed interpreter,
// which prints `?SYNTAX ERROR IN 0`. `memory.chrget` on the 2001 catalog
// value opens that hole; BASIC 2/4's CHRGET sits below $8E and costs
// nothing.
const PET_ZP_BUDGET = { zpOrigin: 0x8e, zpCeiling: 0x100 };
const CHRGET_BYTES = 24;

function petZpHoles(facts: Record<string, unknown>): ZpHole[] {
  const chrget = facts['memory.chrget'];
  if (typeof chrget !== 'number') return [];
  const start = chrget;
  const end = chrget + CHRGET_BYTES;
  if (end <= PET_ZP_BUDGET.zpOrigin || start >= PET_ZP_BUDGET.zpCeiling) return [];
  return [{ start, end }];
}

/** The file extension a build for this machine and hardware produces. */
export function outputExtension(machine: Machine, hardware?: BuildOptions['hardware']): string {
  if (hardware?.build?.output) return hardware.build.output;
  if (machine === 'nes') return 'nes';
  if (machine === 'atari8') return 'xex';
  return 'prg';
}

// ---- milestone 7: functions and the calling convention --------------------
// See mos/AGENTS.md for the design this implements: every parameter and
// local gets a fixed zero-page slot the owning function never shares with
// another, decided in two passes (parameters, which only need a param
// count to size; then bodies, which need lowering to size their own locals)
// so a call site's target address is always known regardless of lowering
// order.

/**
 * Every name `node` (or anything nested under it — an IR statement/
 * expression tree, at runtime a plain, loosely-typed object) calls,
 * collected into `out`. Deliberately untyped and structural rather than a
 * per-kind switch: the real IR carries far more fields than this file's own
 * narrow interfaces name (see lower/index.ts's own header comment), and a
 * generic walk never goes stale as new node kinds gain fields.
 */
function collectCallNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCallNames(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.kind === 'call' && typeof obj.name === 'string') out.add(obj.name);
    for (const value of Object.values(obj)) collectCallNames(value, out);
  }
}

/**
 * The first call cycle found in `functions`' own call graph (a function
 * that, directly or transitively, calls itself), as the chain of names
 * involved — or null if the graph is a DAG. Reusing a fixed zero-page
 * address across nested calls (mos/AGENTS.md) is only sound when a
 * function's own frame is never live twice on the call stack at once, so
 * this has to run, and refuse, before any zero page is assigned.
 */
function findCallCycle(functions: IrFunction[]): string[] | null {
  const callees = new Map<string, Set<string>>();
  for (const fn of functions) {
    const out = new Set<string>();
    collectCallNames(fn.body, out);
    callees.set(fn.name, out);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  function visit(name: string): string[] | null {
    if (state.get(name) === 'done') return null;
    if (state.get(name) === 'visiting') return stack.slice(stack.indexOf(name));
    state.set(name, 'visiting');
    stack.push(name);
    for (const callee of callees.get(name) ?? []) {
      if (!callees.has(callee)) continue; // not one of this program's own functions — not this check's job
      const found = visit(callee);
      if (found) return found;
    }
    stack.pop();
    state.set(name, 'done');
    return null;
  }
  for (const fn of functions) {
    const found = visit(fn.name);
    if (found) return found;
  }
  return null;
}

const RTS: Directive = { kind: 'instruction', mnemonic: 'RTS', mode: 'implied' };
const ldaImm = (value: number): Directive => ({ kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value } });
const staZp = (address: number): Directive => ({ kind: 'instruction', mnemonic: 'STA', mode: 'zeropage', operand: { kind: 'value', value: address } });

/** Lowers `ir` to machine code, writes `outFile`, and returns the bytes and a size report. */
export async function build(ir: IrProgram, options: BuildOptions): Promise<BuildResult> {
  if (options.machine !== 'pet') {
    return {
      ok: false,
      error: `the ${options.machine} is not a target in 0.2.0: the native 6502 backend is being brought up on the PET first (Hello, PET), and the other 6502 machines return in a later release`,
    };
  }

  const entryFn = ir.functions.find((fn) => fn.name === ir.entry);
  if (!entryFn) return { ok: false, error: `the linked entry point '${ir.entry}' names no function in ir.functions` };

  const cycle = findCallCycle(ir.functions);
  if (cycle) return { ok: false, error: `recursion isn't lowered yet: ${cycle.join(' -> ')} -> ${cycle[0]} calls itself, directly or through another function` };

  // Globals first: every function's own parameters, then every function's
  // own locals and expression temporaries, bump-allocate from whatever zero
  // page globals didn't take, so each pass below needs to know where the
  // previous one's remainder starts before it can run.
  const zpHoles = petZpHoles(options.hardware.facts);
  const zp = allocate(ir.globals, { ...PET_ZP_BUDGET, holes: zpHoles });
  if (!zp.ok) return { ok: false, error: zp.error };

  const globalTypes = new Map(ir.globals.map((g) => [g.name, g.type]));
  const globalBindings = new Map(zp.globals.map((g) => [g.name, { address: g.address, type: globalTypes.get(g.name)! }]));
  const globalInits = new Map(ir.globals.map((g) => [g.name, typeof g.init === 'number' ? g.init : 0]));

  // Every zp-storage global's own initial value, written before the entry
  // function's own body runs — real RAM at power-on has no guaranteed
  // content (VICE does not zero-fill it, matching real hardware), so a
  // global this backend never explicitly writes an initializer for reads
  // whatever was already there. @8bitscript/pet/text's own `currentReverse:
  // bool = false` is exactly this: never written by anything print() calls
  // (only setReverse() does, which text.print's own gate never reaches),
  // so every character came out however that zp byte's boot-time content
  // happened to read — reverse video on an 8032 profile, plain on a 2001,
  // same program, same build, two different screenshots (discovered
  // building milestone 9's real gate). A pinned global (storage 'pinned')
  // is deliberately excluded: it names a hardware register, not RAM, and
  // writing its own `init` (defaulted to 0 by ir/index.mjs the same way
  // an ordinary global's is, whether or not the source ever wrote `= ...`)
  // would be a real, possibly harmful side effect this backend has no
  // business taking on a register nothing here declared an intent for.
  const globalInitProgram: Directive[] = [];
  for (const g of zp.globals) {
    if (g.storage !== 'zp') continue;
    const init = globalInits.get(g.name) ?? 0;
    const width = storageBytes(globalTypes.get(g.name)!);
    globalInitProgram.push(ldaImm(init & 0xff), staZp(g.address));
    if (width === 2) globalInitProgram.push(ldaImm((init >> 8) & 0xff), staZp(g.address + 1));
  }

  // Every const array global (zp/index.ts's own allocate() already refused
  // a mutable one and skipped a const one without erroring, so anything
  // with `.array` set here is guaranteed constant) — placed in the data
  // section below, never in zero page. Only a 1- or 2-byte element is
  // lowered (index()/storeIndex()'s own width, mos/lower/index.ts): wider
  // ones are refused here, by name, rather than mis-encoded by data.ts.
  const constArrayGlobals: ConstArrayGlobal[] = [];
  for (const g of ir.globals) {
    if (g.array === undefined) continue;
    const width = storageBytes(g.type);
    if (width !== 1 && width !== 2) {
      return { ok: false, error: `'${g.name}' is an array<${g.type}, ${g.array}>: only a 1- or 2-byte element is lowered yet` };
    }
    constArrayGlobals.push({ name: g.name, type: g.type, array: g.array, init: (g.init as number[] | null) ?? [] });
  }
  const arrays = new Map(constArrayGlobals.map((g) => [g.name, { elementType: g.type }]));

  // waitFrame()'s own pacing state — an accumulator, a measured `num`, and
  // setup's own scratch cell (mos/startup/waitframe.ts) — claims its zero
  // page right after globals, the same way a function's parameters do below,
  // and only when the linked program calls waitFrame() anywhere (entry or
  // any function it can reach): a program that never does pays nothing for
  // state it never needs.
  let paramCursor = PET_ZP_BUDGET.zpOrigin + zp.zpUsed;
  const needsWaitFrame = usesWaitFrame(ir.functions);
  let waitFrameAcc = 0, waitFrameNum = 0, waitFrameTmp = 0;
  if (needsWaitFrame) {
    const placed = placeZp(paramCursor, WAIT_FRAME_ZP_BYTES, PET_ZP_BUDGET.zpCeiling, zpHoles);
    if (!placed.ok) {
      return { ok: false, error: `waitFrame() needs ${WAIT_FRAME_ZP_BYTES} bytes of zero page for its own pacing state but only ${placed.remaining} byte(s) remain` };
    }
    waitFrameAcc = placed.address;
    waitFrameNum = placed.address + 4;
    waitFrameTmp = placed.address + 8;
    paramCursor = placed.next;
  }

  // Parameter pass: every function's calling interface, fixed before any
  // lowering runs — a call site needs its target's addresses regardless of
  // which function gets lowered first (mos/AGENTS.md).
  const functionSites = new Map<string, FunctionSite>();
  for (const fn of ir.functions) {
    const params: { address: number; width: 1 | 2 }[] = [];
    for (const p of fn.params ?? []) {
      if (p.type === 'array') return { ok: false, error: `'${fn.name}(${p.name})': array parameters aren't lowered yet` };
      const width = storageBytes(p.type);
      if (width !== 1 && width !== 2) {
        return { ok: false, error: `'${fn.name}(${p.name})' is '${p.type}' (${width} bytes): only 8-bit and 16-bit parameters are lowered yet` };
      }
      const placed = placeZp(paramCursor, width, PET_ZP_BUDGET.zpCeiling, zpHoles);
      if (!placed.ok) {
        return { ok: false, error: `ran out of zero page assigning '${fn.name}(${p.name})' its parameter slot (${placed.remaining} byte(s) left, ${width} needed)` };
      }
      params.push({ address: placed.address, width });
      paramCursor = placed.next;
    }
    const returnType = fn.returnType ?? 'void';
    if (returnType !== 'void' && storageBytes(returnType) !== 1) {
      return { ok: false, error: `'${fn.name}' returns '${returnType}' (${storageBytes(returnType)} bytes): only an 8-bit or void return is lowered yet — 16-bit returns aren't lowered yet` };
    }
    functionSites.set(fn.name, { label: `__8bs_fn_${fn.name}`, params, returnType });
  }

  // Body pass: each function against its own fresh, non-overlapping locals
  // region, stacked after every function's own parameter region above.
  let localsCursor = paramCursor;
  const loweredFunctions: { name: string; label: string; program: Directive[]; isEntry: boolean }[] = [];
  for (const fn of ir.functions) {
    const site = functionSites.get(fn.name)!;
    const params = (fn.params ?? []).map((p, i) => ({ name: p.name, type: p.type, address: site.params[i].address }));
    const locals = new LocalAllocator(localsCursor, PET_ZP_BUDGET.zpCeiling, zpHoles);
    const lowered = lower(fn.body, { globals: globalBindings, locals, params, functions: functionSites, arrays });
    if (!lowered.ok) return { ok: false, error: `in '${fn.name}': ${lowered.error}` };
    localsCursor += locals.used;
    loweredFunctions.push({ name: fn.name, label: site.label, program: lowered.program, isEntry: fn.name === ir.entry });
  }

  // The entry runs first, falling straight through prologue -> body ->
  // epilogue back to BASIC (unchanged since milestone 1) — every other
  // function is a subroutine placed after it, never reached except by its
  // own JSR, and returns with a plain RTS rather than BASIC's epilogue.
  const entry = loweredFunctions.find((f) => f.isEntry)!;
  const others = loweredFunctions.filter((f) => !f.isEntry);
  const everyInstruction = loweredFunctions.flatMap((f) => f.program);
  // The string table and every const array, last: mos/data.ts's own header
  // explains why this rides inside the one program link() assembles as
  // `code` rather than its separate `data` section — code above already
  // references these labels (a string literal's address, an index()'s own
  // array label), and link() assembles code and data as two independent
  // passes that never see each other's labels.
  const dataSection = buildDataSection(ir.strings ?? [], constArrayGlobals);
  // The one-time calibration and the shared JSR target every waitFrame()
  // call site (lower/index.ts) resolves to — both empty when the program
  // never calls waitFrame() anywhere. Setup runs once, right after globals
  // are initialized and before the entry function's own body (which may
  // itself call waitFrame() first thing); the subroutine rides alongside
  // every other function's own body, after the entry falls through to BASIC.
  const waitFrameSetupProgram = needsWaitFrame ? waitFrameSetup(options.frameRate, waitFrameAcc, waitFrameNum, waitFrameTmp) : [];
  const waitFrameRoutineProgram = needsWaitFrame ? waitFrameRoutine(waitFrameAcc, waitFrameNum) : [];
  const combinedProgram: Directive[] = [
    ...prologue(usesDecimalSensitiveMath([...everyInstruction, ...waitFrameSetupProgram, ...waitFrameRoutineProgram])),
    ...globalInitProgram,
    ...waitFrameSetupProgram,
    ...entry.program,
    ...epilogue(),
    ...others.flatMap((f): Directive[] => [{ kind: 'label', name: f.label }, ...f.program, RTS]),
    ...waitFrameRoutineProgram,
    ...dataSection,
  ];

  const loadAddress = LOAD_ADDRESS.pet!;
  const { bytes: stub, codeStart } = basicStub(loadAddress);

  const ramSizeKib = options.hardware.build.defsym.__ram_size;
  if (typeof ramSizeKib !== 'number') {
    return { ok: false, error: 'the pet hardware sheet is missing defsym.__ram_size, the RAM ceiling the linker needs' };
  }

  const linked = link({
    codeOrigin: codeStart,
    ramCeiling: ramSizeKib * 1024,
    code: { kind: 'assembly', program: combinedProgram },
    zpOrigin: PET_ZP_BUDGET.zpOrigin,
    zpCeiling: PET_ZP_BUDGET.zpCeiling,
    // Globals (milestone 5) plus every function's own parameter region plus
    // the most zero page each function's own locals and expression
    // temporaries ever held live at once (LIFO, per function) — not the sum
    // of every local ever declared, and not shared across functions either
    // (mos/AGENTS.md's known-conservative choice).
    zp: localsCursor - PET_ZP_BUDGET.zpOrigin,
  });
  if (!linked.ok) return { ok: false, error: linked.error };

  const body = new Uint8Array(stub.length + linked.bytes.length);
  body.set(stub, 0);
  body.set(linked.bytes, stub.length);
  const bytes = prgBytes(loadAddress, body);

  await mkdir(dirname(options.outFile), { recursive: true });
  await writeFile(options.outFile, bytes);

  return { ok: true, bytes, memory: { variables: linked.memory.variables, program: bytes.length } };
}

// ---- waitFrame() pacing ----------------------------------------------------
//
// One hardware frame is NOT 1/60th of a second, and the machines don't even
// agree with each other or with the web host, which paces waitFrame() at a
// genuine fixed rate of real time (packages/cli/src/web-runtime.mjs). Tying
// waitFrame() 1:1 to vblank drifts a target away from that reference
// forever, so every machine below runs the same fixed-point scheme: an
// accumulator of *logical* frames owed — at whatever rate the project is
// configured for (`frameRate`, default 60; see 8bs.config.ts), the same rate
// on every target.
//
// What differs between machines is how a hardware frame boundary is
// *detected*, which splits them into two families:
//
//   'level' — the video chip exposes a live, free-running raster/line
//     counter as a plain memory location (VIC, VIC-II/VIC-IIe, ANTIC): no
//     acknowledgement needed, just compare against `topHalf`. NTSC/PAL
//     differ only in the two (num, den) pairs below, chosen at startup by
//     `palProbe` — a one-time runtime check, not a build-time flag, so one
//     binary adapts to either region.
//
//   'edge' — the chip instead exposes a flag that LATCHES once per frame
//     and must be explicitly acknowledged (a PIA/PPU/VERA interrupt-status
//     bit), because there is no continuously-live counter to poll. Two
//     sub-cases:
//       - fixed (num/den known ahead of time, from documented clock specs)
//       - calibrated (no such documented split exists — see PET below —
//         so cyclesPerFrame is *measured* once at startup against a known
//         CPU clock, via a hardware timer, rather than guessed)
//
// Machines whose default OS installs its own IRQ handler on the same flag
// (PET's KERNAL jiffy clock, possibly the X16's) would otherwise race this
// driver for it — an interrupt fires and acknowledges the flag before
// mainline code gets a chance to see it set, so this code always loses that
// race. `presync` disables interrupts before polling starts, for exactly
// the machines where that risk is real.

export interface RatioPair {
  num: number;
  den: number;
}

export interface LevelSync {
  kind: 'level';
  topHalf: string;
  palProbe: string;
  presync?: string;
  ntsc: RatioPair;
  pal: RatioPair;
}

export interface EdgeSyncFixed {
  kind: 'edge';
  pollFlag: string;
  ack: string;
  presync?: string;
  num: number;
  den: number;
  frameHook?: string;
}

export interface EdgeSyncCalibrated {
  kind: 'edge';
  pollFlag: string;
  ack: string;
  presync?: string;
  calibrate: (frameRate: number) => string;
}

export type FrameSync = LevelSync | EdgeSyncFixed | EdgeSyncCalibrated;

export const FRAME_SYNC: Record<Machine, FrameSync> = {
  // The video chip's raster line, read as a plain memory location — no IRQ,
  // no interrupt vector, just a byte (or two) that count scanlines and wrap
  // once a frame. This is what waitFrame() polls to find the top of each
  // frame — self-correcting, with no calibrated delay constant to get wrong
  // or to need a separate value per region. `topHalf` is true exactly when
  // the raster is in the TOP HALF of the frame. Not "at line 0": the loop
  // detects a new frame by seeing the condition go false (raster in the
  // bottom half) and then true again, which happens at the wrap to line 0
  // and nowhere else, since the raster only counts up. A narrow at-line-0
  // window — the obvious check, and what this used to be — loses whole
  // frames: the KERNAL's timer IRQ is still running, it is not
  // raster-synced, and its handler runs longer than the ~65-130 cycles
  // lines 0-1 last, so every time its phase drifts across the top of the
  // frame the polling loop sits inside the handler while the window passes
  // by, unobserved. Not hypothetical: measured under VICE (remote monitor +
  // cycle stopwatch) the narrow window lost ~0.08% of frames — 59.95Hz out
  // of an exact-by-construction 60 — and the half-frame window measured
  // 60.0000. An IRQ can still delay *noticing* the wrap by its handler's
  // length, but a half-frame window (thousands of cycles) means it can
  // never hide the wrap entirely, so the error is bounded jitter, never a
  // lost frame.
  vic20: {
    kind: 'level',
    // VIC-I: a different, non-obvious layout — not inferred from the C64's.
    // $9004 holds bits 8-1 of the 9-bit raster counter and only changes
    // every *second* line; the counter's own bit 0 lives by itself in
    // $9003 bit 7. Its own range tops out around 130 (NTSC) or 155 (PAL) —
    // nowhere near an 8-bit wraparound — so there is no line-256-style
    // aliasing to guard against, no 9th bit is needed, and one atomic byte
    // read decides the half. ($9004 < 64 is lines 0-127 on both regions.)
    // (https://github.com/cbmeeks/VIC-20/blob/master/6561.txt, CR3/CR4)
    topHalf: '(*(volatile uint8_t *)0x9004) < 64',
    // The bottom lines only exist on PAL — an NTSC VIC-20 never shows
    // $9004 >= 140 (tops out at 130), a PAL one reaches 155.
    palProbe: '(*(volatile uint8_t *)0x9004) >= 140',
    // The CPU clock is the video crystal divided by a small integer (NTSC:
    // 14318181Hz/14 — the same clock the C64 uses, which is why only the
    // line counts differ; PAL: 4433618Hz/4). num = cyclesPerFrame *
    // divisor, den = crystalHz — an exact integer fraction, not a rounded
    // decimal.
    ntsc: { num: 261 * 65 * 14, den: 14318181 },
    pal: { num: 312 * 71 * 4, den: 4433618 },
  },
  c64: {
    kind: 'level',
    // VIC-II: $D012 holds the raster line's low 8 bits, wrapping at 256 —
    // but the C64 has 312 lines (PAL) or 263 (NTSC), both *past* 256, so
    // $D012 alone reads low not only in the top half of the frame but
    // *again* from line 256 on. An earlier at-line-0 version of this check
    // learned that the hard way — $D012==0 alone fired twice a frame,
    // measured under VICE at almost exactly 2x the intended rate. $D011
    // bit 7 is the missing 9th bit (c64-wiki.com/wiki/VIC); requiring it
    // clear rules out the 256+ lines. The read ORDER matters too, which is
    // why $D012 comes first: reading $D011 first opens a race — bit 7
    // still clear at line 255, then $D012 already wrapped to 0 at line
    // 256 — that fakes a top-half reading at line 256. Reading $D012 first
    // closes it.
    topHalf: '(*(volatile uint8_t *)0xD012) < 128 && ((*(volatile uint8_t *)0xD011) & 0x80) == 0',
    // An NTSC C64 never shows $D012 >= 32 while $D011 bit 7 is set (it
    // tops out at line 262, $D012 == 6); a PAL one reaches line 311
    // ($D012 == 55).
    palProbe: '((*(volatile uint8_t *)0xD011) & 0x80) != 0 && (*(volatile uint8_t *)0xD012) >= 32',
    // The program owns the machine from the first waitFrame() on: the
    // KERNAL's IRQ (CIA1 timer A, ~60 times a second) scans the keyboard
    // matrix through CIA1's ports, and any scan @8bitscript/c64/keyboard
    // makes of the same ports would race it — a column select of the
    // KERNAL's landing between this program's write and its read. It also
    // updates the jiffy clock and blinks a cursor nothing here uses. With
    // interrupts off the ports read what the program selected, joystick
    // reads on $DC00/$DC01 see only the joystick, and the frame runtime
    // loses nothing (it polls a raster line, which no handler touches).
    // Consequence, as on the PET: a program that calls waitFrame() has no
    // KERNAL keyboard, and returning from main() into BASIC is off the
    // map (packages/c64/AGENTS.md). Interrupts stay off for the charset
    // copy @8bitscript/c64's video setup does with I/O banked out, too.
    // The exception is the raster list: raster.enable() silences both
    // CIAs, points the IRQ at the package's handler, sets interruptsOn,
    // and cli's. From then on this poll must leave I clear, or the
    // handler never runs and a split-border program shows one color
    // (measured: raster-probe's screenshot was solid blue at every
    // sample, with the green background that proves main() ran).
    presync: '__asm__ volatile("sei" ::: "memory");',
    ntsc: { num: 263 * 65 * 14, den: 14318181 },
    pal: { num: 312 * 63 * 18, den: 17734472 },
  },
  // The C128's VIC-IIe is register-compatible with the C64's VIC-II for
  // $D011/$D012 — the C128's VIC sits at $D000 with the same register
  // layout. Same registers, same reasoning, same numbers.
  c128: {
    kind: 'level',
    topHalf: '(*(volatile uint8_t *)0xD012) < 128 && ((*(volatile uint8_t *)0xD011) & 0x80) == 0',
    palProbe: '((*(volatile uint8_t *)0xD011) & 0x80) != 0 && (*(volatile uint8_t *)0xD012) >= 32',
    ntsc: { num: 263 * 65 * 14, den: 14318181 },
    pal: { num: 312 * 63 * 18, den: 17734472 },
  },
  // The MEGA65's VIC-IV exposes a VIC-II-compatible register view at
  // $D000 for exactly this reason. A PRG launched the ordinary way (SYS,
  // no unlock sequence for the VIC-IV's extended raster bits or the
  // 40MHz CPU mode) boots into that C64-compatible view and clock, so
  // this reuses the C64 entry verbatim. A program that switches the
  // MEGA65 into its native enhanced modes is outside what this target
  // supports.
  mega65: {
    kind: 'level',
    topHalf: '(*(volatile uint8_t *)0xD012) < 128 && ((*(volatile uint8_t *)0xD011) & 0x80) == 0',
    palProbe: '((*(volatile uint8_t *)0xD011) & 0x80) != 0 && (*(volatile uint8_t *)0xD012) >= 32',
    ntsc: { num: 263 * 65 * 14, den: 14318181 },
    pal: { num: 312 * 63 * 18, den: 17734472 },
  },
  // ANTIC: $D40B (VCOUNT) is a live half-line counter — it increments every
  // *second* scanline, the same style as the VIC-20's $9004, and lands on
  // almost the same numbers for the same reason (both count roughly a
  // 262/312-line NTSC/PAL frame in half-line steps): NTSC tops out around
  // 131, PAL around 156, so the VIC-20's exact thresholds (<64 for the top
  // half, >=140 as the PAL-only probe line) carry over unchanged.
  // cyclesPerFrame uses the widely-published nominal Atari CPU clocks
  // (1.79MHz NTSC / 1.77MHz PAL) and ANTIC's fixed 114 CPU cycles per
  // scanline — this project could not independently re-derive those from a
  // primary crystal datasheet the way the Commodore numbers above were, so
  // treat them as documented nominal values rather than measured ones.
  atari8: {
    kind: 'level',
    topHalf: '(*(volatile uint8_t *)0xD40B) < 64',
    palProbe: '(*(volatile uint8_t *)0xD40B) >= 140',
    ntsc: { num: 262 * 114, den: 1789790 },
    pal: { num: 312 * 114, den: 1773447 },
  },
  // The PET has no live raster counter to poll at all: its video hardware
  // predates the VIC/VIC-II and exposes no memory-mapped scanline position.
  // What it does have is documented and, unlike the level machines above,
  // was verified empirically in this project (VICE, remote monitor, a
  // hand-assembled probe watching real memory over ~4000 samples): PIA1's
  // CB1 line is wired to the vertical retrace signal, and its interrupt
  // flag — CRB bit 7, at $E813 — latches once per frame and stays set
  // until ORB ($E812) is read. The KERNAL's own default IRQ handler reads
  // ORB every frame as part of the jiffy clock, so it wins the race for
  // this flag before mainline code ever sees it set — `presync` disables
  // interrupts so this driver owns the flag instead.
  //
  // There is also no documented NTSC/PAL crystal split for the PET the way
  // there is for the Commodore/Atari video chips (its CPU clock is a flat,
  // region-independent 1MHz — video *refresh rate* is the only thing that
  // varies, and by how much isn't consistently documented per model). So
  // rather than guess, `calibrate` measures the actual cycles-per-frame
  // once at startup: time between two vsync edges, in real CPU cycles,
  // using VIA1's Timer 2 as a hardware stopwatch (immune to codegen
  // variance, unlike counting loop iterations would be). Verified under
  // VICE's default PAL PET model: measured ~19992 cycles/frame, 50.02Hz.
  // Which rate a run gets is the model's — the profile `8bs run pet`
  // launches: the no-CRTC 3xxx at VICE's ~60.1Hz, the CRTC models at their
  // 50Hz editor ROMs (the 60Hz editors make VICE refuse autostart). This
  // measurement is what makes that not matter to the program.
  pet: {
    kind: 'edge',
    pollFlag: '(*(volatile uint8_t *)0xE813) & 0x80',
    ack: '(void)(*(volatile uint8_t *)0xE812);',
    presync: '__asm__ volatile("sei" ::: "memory");',
    // A function of the configured `frameRate`, not a plain string: unlike
    // every other machine here, the PET's num/den pair is computed from a
    // runtime measurement, not a compile-time constant, so scaling by the
    // configured rate has to happen from the measured elapsed cycles
    // rather than being multiplied in once up front.
    calibrate: (frameRate) => [
      '    while (!((*(volatile uint8_t *)0xE813) & 0x80)) {}',
      '    (void)(*(volatile uint8_t *)0xE812);',
      '    *(volatile uint8_t *)0xE848 = 0xFFu;', // VIA1 T2C-L: low half of the one-shot latch
      '    *(volatile uint8_t *)0xE849 = 0xFFu;', // VIA1 T2C-H: loads T2 and starts it counting down
      '    while (!((*(volatile uint8_t *)0xE813) & 0x80)) {}',
      '    (void)(*(volatile uint8_t *)0xE812);',
      '    {',
      '        uint16_t __8bs_lo = *(volatile uint8_t *)0xE848;',
      '        uint16_t __8bs_hi = *(volatile uint8_t *)0xE849;',
      '        uint16_t __8bs_elapsed = 0xFFFFu - ((__8bs_hi << 8) | __8bs_lo);',
      `        __8bs_num = ${frameRate}u * (uint32_t)__8bs_elapsed;`,
      '        __8bs_den = 1000000u;', // the PET's real, region-independent 1MHz CPU clock
      '    }',
    ].join('\n'),
  },
  // PPUSTATUS ($2002) bit 7 sets once per frame at the start of vertical
  // blank and — unlike the machines above — clears itself as a side effect
  // of being READ, so the poll condition below is its own acknowledgement;
  // no separate ack statement, no interrupt to race against (an NES
  // cartridge boots straight into user code — there is no OS installing a
  // competing handler on this flag).
  //
  // NTSC-only: the NES's CPU clock is exactly documented (1789773Hz, from
  // the well-known 21.477272MHz master / 12), and one NTSC frame is exactly
  // 89341.5 PPU cycles on average across the well-known odd/even
  // frame-length alternation (one dot is skipped every other frame) — over
  // two frames that's exactly 178803 PPU cycles, or 59601 CPU cycles (PPU
  // runs 3x CPU), an exact integer. PAL NES runs a visibly different PPU
  // (extra idle scanlines most homebrew code doesn't target) and isn't
  // supported by this target yet.
  nes: {
    kind: 'edge',
    pollFlag: '(*(volatile uint8_t *)0x2002) & 0x80',
    ack: '',
    num: 59601,
    den: 2 * 1789773,
    // The NES package queues its screen writes (VRAM is the PPU's outside
    // vertical blank — see packages/nes/src/index.8bs) and this function,
    // when the linked program defines it, delivers them: the runtime calls
    // it right after every hardware frame edge, which on the NES is the
    // start of vertical blank. A program that links no NES package has no
    // such function and pays nothing.
    frameHook: 'nesVerticalBlank',
  },
  // VERA's ISR ($9F27) bit 0 is the VSYNC flag: set once per frame, cleared
  // by writing a 1 back to it (standard write-1-to-clear, same convention
  // as VERA's other interrupt-status bits). Unlike the PET, the X16 is a
  // single fixed hardware spec rather than a family of vintage machines
  // with region-dependent crystals — its CPU runs a documented, exact
  // 8MHz, and VERA's default output targets a standard ~60Hz display, close
  // enough to exactly 60Hz by hardware design (not a dual NTSC/PAL split
  // like the vintage machines above) that waitFrame() is simply one VSYNC
  // edge at the default frameRate rather than an accumulator built from a
  // video-clock figure this project could not independently verify — at 60
  // the 1:1 ratio folds away entirely. `num`/`den` here is 1/60, not 1/1:
  // real hardware fires at a fixed ~60Hz regardless of the configured
  // `frameRate`, so at any other rate the accumulator (fed `frameRate *
  // num`) scales between the two.
  // `presync` disables interrupts so this poll owns the flag. The KERNAL's
  // VSYNC IRQ would otherwise acknowledge $9F27 before the loop sees it
  // (and a later KERNAL call can `cli`, so sei is repeated every waitFrame,
  // not only once in the prologue). Mouse packets then have to be fetched
  // from poll() — see packages/cx16/src/mouse.8bs.
  cx16: {
    kind: 'edge',
    pollFlag: '(*(volatile uint8_t *)0x9F27) & 0x01',
    ack: '*(volatile uint8_t *)0x9F27 = 0x01;',
    presync: '__asm__ volatile("sei" ::: "memory");',
    num: 1,
    den: 60,
  },
};

// ---- the ratio, in sixteen bits -------------------------------------------
//
// The accumulator compares and adds num/den every frame, and on a 6502 a
// 32-bit add or compare is four times the code and cycles of a 16-bit one,
// with three times the zero page. The exact ratio (frameRate * cycles per
// hardware frame / crystal Hz) does not fit in 16 bits, but a fraction that
// does is as good as exact: the best p/q with p + q <= 65535 sits within
// about 1e-9 of the true ratio at 60Hz — under a hundredth of a frame a
// day. `p + q <= 65535` is the real bound, not p, q <= 65535: the
// accumulator is below den before every add, so acc + num never wraps.
const RATIO_LIMIT = 65535;

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Python's Fraction.limit_denominator, on a fraction already in lowest
// terms: the closest p/q to n/d with q <= maxDen, from the continued
// fraction's convergents and the last semiconvergent.
function limitDenominator(n: number, d: number, maxDen: number): [number, number] {
  if (d <= maxDen) return [n, d];
  let [p0, q0, p1, q1] = [0, 1, 1, 0];
  let [nn, dd] = [n, d];
  while (dd !== 0) {
    const a = Math.floor(nn / dd);
    const q2 = q0 + a * q1;
    if (q2 > maxDen) break;
    [p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
    [nn, dd] = [dd, nn - a * dd];
  }
  const k = Math.floor((maxDen - q0) / q1);
  const bound1: [number, number] = [p0 + k * p1, q0 + k * q1];
  const bound2: [number, number] = [p1, q1];
  const err = ([p, q]: [number, number]) => Math.abs(p / q - n / d);
  return err(bound2) <= err(bound1) ? bound2 : bound1;
}

/**
 * The best sixteen-bit stand-in for num/den: `{ num, den, error }` with
 * num + den <= 65535 and `error` the relative difference from the true
 * ratio (0 when it fits as it is).
 */
export function reduceRatio(num: number, den: number): { num: number; den: number; error: number } {
  const g = gcd(num, den);
  const [n, d] = [num / g, den / g];
  let maxDen = Math.floor(RATIO_LIMIT / (1 + n / d));
  for (;;) {
    const [p, q] = limitDenominator(n, d, maxDen);
    if (p + q <= RATIO_LIMIT) return { num: p, den: q, error: Math.abs(p / q - n / d) / (n / d) };
    maxDen = q - 1;
  }
}

// How far a sixteen-bit ratio may drift, in logical frames per day, before
// the runtime falls back to the exact 32-bit pair. The reduction is far
// inside this at any sane rate (1e-9 relative at 60Hz is 0.005 frames a
// day); it is here so a strange frameRate degrades to slower code, never to
// a clock that is visibly wrong.
const MAX_DRIFT_FRAMES_PER_DAY = 1;

export interface FrameRatio {
  type: 'uint16_t' | 'uint32_t';
  pairs: Record<string, RatioPair>;
}

/**
 * The num/den pairs the runtime uses for a machine at a rate, and the C
 * type that holds them: `{ type: 'uint16_t' | 'uint32_t', pairs }` where
 * `pairs` is `{ ntsc, pal }` for a level machine (runtime region probe)
 * or `{ fixed }` for an edge machine with a known ratio. The PET measures
 * its own ratio at startup, so it has no pairs and stays 32-bit.
 */
export function frameRatio(sync: FrameSync, frameRate: number): FrameRatio {
  if (sync.kind === 'edge' && 'calibrate' in sync) return { type: 'uint32_t', pairs: {} };
  const exact = sync.kind === 'level'
    ? { ntsc: sync.ntsc, pal: sync.pal }
    : { fixed: { num: sync.num, den: sync.den } };
  const reduced: Record<string, RatioPair> = {};
  for (const [region, { num, den }] of Object.entries(exact)) {
    const r = reduceRatio(frameRate * num, den);
    if (r.error * frameRate * 86400 > MAX_DRIFT_FRAMES_PER_DAY) {
      return {
        type: 'uint32_t',
        pairs: Object.fromEntries(Object.entries(exact).map(([k, v]) => [k, { num: frameRate * v.num, den: v.den }])),
      };
    }
    reduced[region] = { num: r.num, den: r.den };
  }
  return { type: 'uint16_t', pairs: reduced };
}
