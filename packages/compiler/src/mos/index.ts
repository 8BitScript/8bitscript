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

import { imageFor } from './image.ts';
import { arrayLabel, buildDataSection } from './data.ts';
import type { DataArrayGlobal, IrString } from './data.ts';
import { link } from './link/index.ts';
import { optimizeReachable } from '../linker/optimize.mjs';
import { lower } from './lower/index.ts';
import type { Directive, FunctionSite, IrFunction } from './lower/index.ts';
import { instructionBytes } from './asm/encode.ts';
import { LocalAllocator } from './lower/allocator.ts';
import { epilogue, prologue, usesDecimalSensitiveMath } from './startup/commodore.ts';
import { nesResetInit } from './startup/nes.ts';
import { WAIT_FRAME_ZP_BYTES, frameEdgeWait, usesWaitFrame, waitFrameKeepsInterrupts, waitFrameRoutine, waitFrameSetup } from './startup/waitframe.ts';
import { MULTIPLY_ZP_BYTES, multiplyCells, multiplyRoutine, usesMultiply } from './startup/multiply.ts';
import type { MultiplyCells } from './startup/multiply.ts';
import { storageBytes } from '../types/index.mjs';
import { allocate, placeZp } from './zp/index.ts';
import type { IrGlobal, ZpHole } from './zp/index.ts';
import { layoutFrames } from './zp/frames.ts';

/** The linked IR's top-level shape — the pieces `functions` (lower/index.ts), `globals` (zp/index.ts), and `strings` (mos/data.ts's own string-table half) each read. */
export interface IrProgram {
  entry: string;
  functions: IrFunction[];
  globals: IrGlobal[];
  /** ir.strings (ir/index.mjs) — every string literal the linked program declares, merged and deduplicated by the linker. Optional only so existing synthetic test fixtures that predate milestone 9 don't all need updating; real linked IR always sets it (possibly `[]`). */
  strings?: IrString[];
  /** ir.nativeSources (linker/index.mjs) — the absolute paths of every `"8bitscript".native` file the linked packages ship. Not IR: bytes a backend passes through to its own image untouched, which on the NES is the CHR-ROM character set (mos/image-nes.ts) and on every other machine here is nothing. */
  nativeSources?: string[];
}

export type Machine = 'vic20' | 'c64' | 'pet' | 'c128' | 'mega65' | 'cx16' | 'nes' | 'atari8';

/** What the CLI hands a build. `hardware` is the resolved object from packages/cli/src/hardware.mjs. `report`, when true, asks for `BuildResult`'s own `sizeReport` — the CLI's `--size` flag (packages/cli/src/build.mjs). */
export interface BuildOptions {
  machine: Machine;
  hardware: { build: { defsym: Record<string, number>; startup?: string; output?: string }; facts: Record<string, unknown> };
  outFile: string;
  frameRate: number;
  report?: boolean;
}

/** One named piece of the program `options.report` breaks a build's own size down into — a function, an inlined callee that now lives inside one, or a fixed-cost bucket (wait-frame setup vs the per-frame routine, the BASIC stub, …). Sorted largest first; every entry's `bytes` sums to the real, linked `bytes.length`. */
export interface SizeReportEntry {
  name: string;
  bytes: number;
}

export type BuildResult =
  | { ok: true; bytes: Uint8Array; memory: { variables: number; program: number }; sizeReport?: SizeReportEntry[] }
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

// Where a Commodore .prg's load address and boot stub go used to be a
// table here, one number per machine. It is a fact about the *hardware*,
// not about the backend — and on the VIC-20 it is not even constant per
// machine, since a RAM expansion moves BASIC's program area from $1001 to
// $1201 — so it comes in on the hardware sheet now, as
// `build.defsym.__load_address` (packages/<machine>/package.json's own
// "8bitscript".hardware.build, merged by packages/cli/src/hardware.mjs the
// same way `__ram_size` already was). A machine whose sheet does not carry
// one is refused by name below rather than silently assumed.

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

// A program that calls waitFrame() anywhere owns the machine outright —
// interrupts off from before its first store (the SEI build() now emits
// ahead of the global initializers), the KERNAL's keyboard and jiffy
// clock dead, and returning to BASIC already documented as off the map
// (packages/pet/AGENTS.md, FRAME_SYNC.pet's own presync) — so BASIC's and
// the KERNAL's zero page is no longer anyone else's: the budget widens to
// $02-$FF, no CHRGET hole (nothing will ever run CHRGET again), which is
// what lets a real program's call-graph frames (mos/zp/frames.ts) fit. A
// program with no waitFrame() still returns to BASIC's READY. and keeps
// the polite $8E-$FF budget above, CHRGET hole included.
const PET_OWNED_ZP_BUDGET = { zpOrigin: 0x02, zpCeiling: 0x100 };

// The C64 has no polite budget, and that is a fact about the machine
// rather than a decision taken here.
//
// BASIC owns $02-$8F and the KERNAL $90-$FF (packages/c64/AGENTS.md's
// memory map), leaving $F7-$FE — the four bytes neither uses, plus the four
// RS-232 buffer pointers — which is eight, against the seven
// `screen.blank()`'s own frame alone wants and the fourteen hello-world's
// full call chain wants. So the polite budget cannot carry a real program.
//
// It does not need to. @8bitscript/c64's own `setupVideo()` banks the
// KERNAL out ($01 = %101) and keeps it out, because the screen it sets up
// lives at $E000 under the KERNAL ROM (packages/c64/src/index.8bs says so
// at length). A C64 program that draws anything has therefore already
// taken the machine: BASIC's `READY.` is printed by a KERNAL that is no
// longer mapped, and there is nothing left to be polite to. Taking the
// whole page is the honest description of what such a program already is.
//
// The shape this does not distinguish yet is a C64 program that returns to
// BASIC *without ever drawing* — it would be safe on the eight bytes, and
// it is not a shape anything in this workspace has. When one exists, the
// trigger is the same kind of fact `usesWaitFrame` already is: a store to
// $01, read off the finished instruction stream.
const C64_ZP_BUDGET = PET_OWNED_ZP_BUDGET;

// The VIC-20 keeps the same KERNAL zero-page map as the C64 and, unlike the
// C64, its package never banks anything out — a VIC-20 program really does
// return to a working BASIC — so the polite shape is real here and worth
// keeping. It is still only $FB-$FE plus the RS-232 pointers.
const VIC20_ZP_BUDGET = { zpOrigin: 0xf7, zpCeiling: 0xff };

// The C128's zero page is the C64's shape again — $0A-$8F BASIC's, $90-$FF
// the KERNAL's (packages/c128/AGENTS.md's memory map) — with one machine
// of its own at the bottom: $00/$01 are the 8502's port and $02-$09 are the
// KERNAL's JMPFAR/JSRFAR parameters, which its own cross-bank calls use, so
// those nine bytes stay the machine's. Everything above them is this
// program's. That is not a new decision: this project's own pre-0.2.0 C128
// link map put the compiler's registers at $0A for the same reason, and the
// same row of AGENTS.md records it.
const C128_ZP_BUDGET = { zpOrigin: 0x0a, zpCeiling: 0x100 };

// The X16 is the one machine here with a zero-page window meant for a
// program rather than borrowed from a ROM: $00-$21 is the KERNAL's and
// BASIC's, $22-$7F is the user's, and $80 up is the KERNAL's again — which
// is why packages/cx16/AGENTS.md can say of the mouse KERNAL's $80-$84
// that it is "past BASIC's zero-page end, so a linker will not put a
// variable there". Ninety-four bytes, and nothing has to be taken from
// anyone to get them.
const CX16_ZP_BUDGET = { zpOrigin: 0x22, zpCeiling: 0x80 };

// And what a program that is never handing BASIC back may take on top: 87
// more bytes at $A9-$FF, which is the Math library's and BASIC's.
//
// This is a proof rather than an inference, and it comes from the ROM's own
// ld65 configuration rather than from the docs' summary table. cfg/x16.cfginc
// declares ZPKERNAL at $80 size $11, ZPDOS at $91, ZPAUDIO at $A7, ZPMATH at
// $A9 and ZPBASIC at $D4 — and cfg/kernal-x16.cfgtpl loads every one of the
// KERNAL bank's four zero-page segments into ZPKERNAL, while no other bank's
// cfgtpl declares zero page at all. So no KERNAL routine can reach $A9-$FF,
// whatever it is asked to do. The reference manual says the same in prose:
// "Machine code applications are free to reuse the BASIC area, and if they
// don't use the Math library, also that area."
//
// The hole is $80-$A9: ZPKERNAL and ZPDOS, whose routines this package calls
// every frame; the cfginc's own commented "reserved for DOS or BASIC growth"
// at $9C-$A6; and ZPAUDIO, which a future audio package will want.
//
// $02-$21 stays out under both budgets even though 2048 would fit inside the
// existing ceiling if it were taken: those are r0-r15, the KERNAL API's
// caller-supplied 16-bit argument registers (inc/regs.inc), live scratch for
// any routine taking 16-bit arguments — extapi's mouse_sprite_offset does
// `MoveW r0, ...` and this package calls extapi. Worse, "does this program
// call such a routine" is not a fact readable off the finished instruction
// stream the way usesWaitFrame is, because the calls sit inside opaque
// asm6502 blocks. $A9-$FF is provably untouchable; $02-$21 is provably
// touched. (packages/cx16/AGENTS.md records all of this.)
const CX16_OWNED_ZP_BUDGET = { zpOrigin: 0x22, zpCeiling: 0x100, holes: [{ start: 0x80, end: 0xa9 }] };

// The MEGA65's own start-up (packages/mega65/AGENTS.md's start-up row)
// disables interrupts at _start and keeps them off until exit, so a
// program here already owns the machine while it runs. $00/$01 are the
// port; everything above is the program's. Nothing in the workspace
// documents a free window inside BASIC 10's own zero page the way the
// X16's is documented, so this does not pretend to one.
const MEGA65_ZP_BUDGET = { zpOrigin: 0x02, zpCeiling: 0x100 };

// The Atari 8-bit is the first machine here whose two budgets are
// deliberately the SAME object, because it is the first whose program
// cannot take the machine at all.
//
// packages/atari8/AGENTS.md records no zero-page budget of its own — that
// was checked, and the negative result is why the rest of this comment
// argues from the facts it does record rather than citing a row. Two of
// them decide it:
//
//   - Every page-zero location that file names as the OS's is below $80:
//     RTCLOK $12-$14, ATRACT $4D, SAVMSC $58, RAMTOP $6A (its "OS
//     locations" row). Everything else it lists there — the vectors, the
//     shadow registers, RUNAD, MEMTOP/MEMLO — lives from $0200 up, not in
//     page zero at all. $80 and above is named by nothing the OS owns.
//   - This project's own pre-0.2.0 `.xex` link map put a compiled
//     program's imaginary registers at $80-$9F and its zero-page variables
//     from $A0 (the same row's neighbour, measured from a real DOS link
//     map). So $80-$FF is not general knowledge applied hopefully: it is
//     where this repo's own Atari builds already lived.
//
//   That window is the user area only while BASIC is out of the map —
//   Atari BASIC's own variables are $80-$FF. A `.xex` is loaded by DOS
//   with BASIC held off (atari800's own DISABLE_BASIC, and the OPTION key
//   on real XL/XE hardware), which is the configuration this target
//   builds for and the one `8bs run atari8` launches.
//
// 128 bytes, and no wider shape to escalate to. On every Commodore above,
// `owned` widens past the polite budget on the strength of a waitFrame()
// program having switched interrupts off and abandoned the interpreter.
// That trade is not available here, and taking it would break the program
// rather than free anything:
//
//   - @8bitscript/atari8/text and /screen both find screen memory by
//     reading SAVMSC ($58/$59) on every run of text — the Atari has no
//     fixed screen address, only wherever the OS's display list points
//     (packages/atari8/src/text.8bs says so at length). Overwriting $58
//     would point every subsequent draw at nothing.
//   - screen.8bs writes each color to its OS shadow *and* to the hardware
//     register, precisely so the color survives the OS's next vertical
//     blank — it is the OS's VBI that copies the shadows down. A program
//     that silences the OS to claim its zero page also silences the thing
//     keeping its own colors on screen.
//
// So the Atari's program is a guest of a live OS for as long as it runs,
// and both budgets are the guest's budget. See waitframe.ts's own
// `keepsInterrupts` for the other half of the same decision.
const ATARI8_ZP_BUDGET = { zpOrigin: 0x80, zpCeiling: 0x100 };

// The NES is the opposite of the Atari above: its two budgets are the same
// object because there is nobody to be polite TO. Three facts, each
// checked rather than assumed:
//
//   - There is no loader and no OS. A cartridge boots straight into the
//     program through the 6502's own reset vector (mos/image-nes.ts, and
//     packages/nes/AGENTS.md's start-up row), so there is no interpreter
//     whose zero page has to survive and no READY. to come back to —
//     main() ending halts the machine rather than returning to anything.
//   - There is no CPU port at $00/$01. That pair is the 6510's and 8502's
//     on-chip I/O register, which is why every Commodore budget above
//     starts at $02; the 2A03 (CPU.nes's own `core`) has no such register,
//     and on this machine $00 and $01 are two ordinary bytes of the 2 KiB
//     of internal RAM that the zero page is merely the first page of.
//   - Nothing else claims a cell of it. @8bitscript/nes reaches the PPU
//     through its ports at $2000-$2007 and the pads at $4016/$4017 and
//     never through a fixed zero-page location, and NROM has no mapper
//     registers at all (packages/nes/AGENTS.md's mapper row).
//
// So the whole page is the program's, $00-$FF. The CPU stack still lives
// at $0100-$01FF and mutable arrays at $0200 up (the sheet's
// __bss_origin) — both outside this page, and neither this budget's
// business.
const NES_ZP_BUDGET = { zpOrigin: 0x00, zpCeiling: 0x100 };

// Per machine: the budget a program that returns to BASIC may take, and
// the one a program that never does may take. The second is the whole page
// on every Commodore here, for the same reason each time — interrupts off,
// the interpreter never resumed — so only the polite one really differs.
/** The machines with a waitFrame() runtime of their own (mos/startup/waitframe.ts: a raster poll, the X16's VSYNC flag, or the NES's PPUSTATUS vertical-blank bit). */
const RASTER_MACHINES = new Set<Machine>(['c64', 'vic20', 'c128', 'cx16', 'mega65', 'nes', 'atari8']);

type ZpBudget = { zpOrigin: number; zpCeiling: number; holes?: ZpHole[] };

const ZP_BUDGETS: Partial<Record<Machine, { polite: ZpBudget; owned: ZpBudget }>> = {
  pet: { polite: PET_ZP_BUDGET, owned: PET_OWNED_ZP_BUDGET },
  c64: { polite: C64_ZP_BUDGET, owned: C64_ZP_BUDGET },
  vic20: { polite: VIC20_ZP_BUDGET, owned: PET_OWNED_ZP_BUDGET },
  c128: { polite: C128_ZP_BUDGET, owned: C128_ZP_BUDGET },
  cx16: { polite: CX16_ZP_BUDGET, owned: CX16_OWNED_ZP_BUDGET },
  mega65: { polite: MEGA65_ZP_BUDGET, owned: MEGA65_ZP_BUDGET },
  atari8: { polite: ATARI8_ZP_BUDGET, owned: ATARI8_ZP_BUDGET },
  nes: { polite: NES_ZP_BUDGET, owned: NES_ZP_BUDGET },
};

function chrgetZpHoles(facts: Record<string, unknown>, budget: { zpOrigin: number; zpCeiling: number }): ZpHole[] {
  const chrget = facts['memory.chrget'];
  if (typeof chrget !== 'number') return [];
  const start = chrget;
  const end = chrget + CHRGET_BYTES;
  if (end <= budget.zpOrigin || start >= budget.zpCeiling) return [];
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

/**
 * Zeroes `[origin, end)`, the RAM window mutable arrays were placed in on
 * a machine whose image is a ROM (see build()'s own comment on that
 * window). A .prg needs nothing like this — its arrays' bytes arrive with
 * the load — but a cartridge's RAM at power-on holds whatever it holds,
 * and the same class of bug that produced two different PET screenshots
 * from one build (mos/index.ts's global-initializer comment) is waiting
 * here on a much bigger scale: @8bitscript/nes's own write queue reading
 * back garbage would deliver garbage to the PPU.
 *
 * Whole pages first, each an `STA base,X` walked by an X that wraps back to
 * zero on its own — 256 stores for seven bytes of code — and then whatever
 * is left over, counted down so the loop's exit test is free. The window is
 * contiguous by construction (one bump allocator, no holes), so the two
 * loops together are exactly the bytes that were handed out and not one
 * more: this never writes past the ceiling the sheet named.
 */
function clearRam(origin: number, end: number): Directive[] {
  const size = end - origin;
  if (size <= 0) return [];
  const out: Directive[] = [ldaImm(0)];
  const pages = Math.floor(size / 256);
  for (let page = 0; page < pages; page++) {
    const loop = `__8bs_ram_clear_${page}`;
    out.push(
      { kind: 'instruction', mnemonic: 'LDX', mode: 'immediate', operand: { kind: 'value', value: 0 } },
      { kind: 'label', name: loop },
      { kind: 'instruction', mnemonic: 'STA', mode: 'absolute,x', operand: { kind: 'value', value: origin + page * 256 } },
      { kind: 'instruction', mnemonic: 'INX', mode: 'implied' },
      { kind: 'instruction', mnemonic: 'BNE', mode: 'relative', operand: { kind: 'label', name: loop } },
    );
  }
  const tail = size - pages * 256;
  if (tail > 0) {
    // X counts down from `tail`, so the store at offset 0 is the last one
    // and the BNE that follows it is the one that falls through — no
    // separate compare, and no 257th store.
    const loop = '__8bs_ram_clear_tail';
    out.push(
      { kind: 'instruction', mnemonic: 'LDX', mode: 'immediate', operand: { kind: 'value', value: tail } },
      { kind: 'label', name: loop },
      { kind: 'instruction', mnemonic: 'DEX', mode: 'implied' },
      { kind: 'instruction', mnemonic: 'STA', mode: 'absolute,x', operand: { kind: 'value', value: origin + pages * 256 } },
      { kind: 'instruction', mnemonic: 'BNE', mode: 'relative', operand: { kind: 'label', name: loop } },
    );
  }
  return out;
}

/**
 * Copies `size` bytes from the label `from` into RAM at `to` — the
 * start-up half of a mutable array that has a real initializer and lives on
 * a machine whose image is a ROM. The bytes themselves stay in the image,
 * once, and this is what puts a working copy somewhere the program can
 * write to; on every loaded machine the two are the same bytes and none of
 * this exists.
 *
 * Whole pages first (X wraps to zero on its own), then a counted tail.
 * `LDA` clobbers the flags `DEX` would have set, so the tail counts UP and
 * ends on a `CPX` rather than counting down — two bytes more than
 * clearRam's tail loop, and the reason the two are not one function.
 */
function copyToRam(from: string, to: number, size: number, tag: string): Directive[] {
  const out: Directive[] = [];
  const pages = Math.floor(size / 256);
  const move = (loop: string, offset: number, end: Directive[]): void => {
    out.push(
      { kind: 'instruction', mnemonic: 'LDX', mode: 'immediate', operand: { kind: 'value', value: 0 } },
      { kind: 'label', name: loop },
      { kind: 'instruction', mnemonic: 'LDA', mode: 'absolute,x', operand: { kind: 'label', name: from, offset } },
      { kind: 'instruction', mnemonic: 'STA', mode: 'absolute,x', operand: { kind: 'value', value: to + offset } },
      { kind: 'instruction', mnemonic: 'INX', mode: 'implied' },
      ...end,
      { kind: 'instruction', mnemonic: 'BNE', mode: 'relative', operand: { kind: 'label', name: loop } },
    );
  };
  for (let page = 0; page < pages; page++) move(`${tag}_${page}`, page * 256, []);
  const tail = size - pages * 256;
  if (tail > 0) {
    move(`${tag}_tail`, pages * 256, [{ kind: 'instruction', mnemonic: 'CPX', mode: 'immediate', operand: { kind: 'value', value: tail } }]);
  }
  return out;
}

const RTS: Directive = { kind: 'instruction', mnemonic: 'RTS', mode: 'implied' };
const ldaImm = (value: number): Directive => ({ kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value } });
const staZp = (address: number): Directive => ({ kind: 'instruction', mnemonic: 'STA', mode: 'zeropage', operand: { kind: 'value', value: address } });

/** A `Directive[]`'s own byte length — instructionBytes() per instruction (the addressing mode alone decides it, asm/encode.ts's own header), a `byte` directive's own value count, nothing for a label. Used only for `options.report`'s size breakdown; the real bytes still come from `assembleRelaxed` via `link()`. */
function directiveBytes(program: Directive[]): number {
  let total = 0;
  for (const d of program) {
    if (d.kind === 'label' || d.kind === 'equate') continue;
    if (d.kind === 'byte') { total += d.values.length; continue; }
    total += instructionBytes(d.mode);
  }
  return total;
}

function functionSizeEntries(fn: { name: string; parts: { origin: string | null; program: Directive[] }[]; isEntry: boolean }): SizeReportEntry[] {
  const merged = new Map<string, number>();
  for (const part of fn.parts) {
    const name = part.origin ?? fn.name;
    merged.set(name, (merged.get(name) ?? 0) + directiveBytes(part.program));
  }
  // Non-entry functions append a one-byte RTS after the body; the entry's
  // RTS lives in epilogue() and is counted with the stub.
  if (!fn.isEntry) merged.set(fn.name, (merged.get(fn.name) ?? 0) + 1);
  return [...merged].map(([name, bytes]) => ({ name, bytes }));
}

function collectStringIndexes(node: unknown, out: Set<number>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectStringIndexes(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as { kind?: string; index?: unknown };
    if (obj.kind === 'string' && typeof obj.index === 'number') out.add(obj.index);
    for (const value of Object.values(node)) collectStringIndexes(value, out);
  }
}

/** Lowers `ir` to machine code, writes `outFile`, and returns the bytes and a size report. */
export async function build(ir: IrProgram, options: BuildOptions): Promise<BuildResult> {
  const budgets = ZP_BUDGETS[options.machine];
  if (!budgets) {
    return {
      ok: false,
      error: `the ${options.machine} is not a target this backend builds yet: it has no zero-page budget on the sheet, so there is nowhere to put a program's globals. The native 6502 backend is being brought up one machine at a time — ${Object.keys(ZP_BUDGETS).join(', ')} so far`,
    };
  }
  const loadAddress = options.hardware.build.defsym.__load_address;
  if (typeof loadAddress !== 'number') {
    return {
      ok: false,
      error: `the ${options.machine} hardware sheet is missing defsym.__load_address, the address its .prg loads at and the BASIC stub's SYS jumps into`,
    };
  }

  // A catalog value may ask for a start-up driver instead of the machine's
  // default one, and the Atari 8-bit's thirteen cartridge media values all
  // do: `build.startup` is 'cart-std', 'cart-xegs' or 'cart-megacart' in
  // packages/atari8's own hardware sheet, and each names a completely
  // different image — ROM at $A000 or $8000 with the cartridge vector at
  // $BFFA, a bank-select write to $D5xx, and RAM for the program at
  // $0700-$1FFF instead of the $2000-$BFFF this backend's `__load_address`
  // and `__ram_ceiling` describe. None of that is written, so such a build
  // is REFUSED BY NAME here rather than reaching imageFor(), which would
  // wrap the bytes in a `.xex` container exactly as if they were a disk
  // executable, write the result under the `.rom` extension
  // `build.output` asks for, and produce a file no emulator can load. The
  // `cart-` prefix is the test rather than the machine, because that prefix
  // is what a cartridge driver is named in every catalog that has one; a
  // machine whose ONLY shape is a cartridge (the NES's 'nrom') is not this
  // case and passes through.
  const startupDriver = options.hardware.build.startup;
  if (typeof startupDriver === 'string' && startupDriver.startsWith('cart-')) {
    return {
      ok: false,
      error: `this ${options.machine} build asks for the '${startupDriver}' cartridge start-up driver, and the native 6502 backend has none: it builds the one shape the machine's disk media has, loaded at $${loadAddress.toString(16).toUpperCase()}. Pick a media value that loads rather than one that plugs in`,
    };
  }

  const entryFn = ir.functions.find((fn) => fn.name === ir.entry);
  if (!entryFn) return { ok: false, error: `the linked entry point '${ir.entry}' names no function in ir.functions` };

  // Everything from here on compiles only what the entry can actually
  // reach — link() itself still returns every module's own functions and
  // globals whether called/read or not (see linker/reachability.mjs).
  // optimizeReachable prunes, folds compile-time work, then prunes again.
  const { functions, globals } = optimizeReachable(ir);

  const cycle = findCallCycle(functions);
  if (cycle) return { ok: false, error: `recursion isn't lowered yet: ${cycle.join(' -> ')} -> ${cycle[0]} calls itself, directly or through another function` };

  // The zero-page budget depends on which of the two program shapes this
  // is (see PET_OWNED_ZP_BUDGET above): a waitFrame() program owns the
  // whole machine and gets $02-$FF hole-free, anything else stays polite
  // and returns to BASIC. Decided before anything is placed, because
  // everything below places into it.
  const needsWaitFrame = usesWaitFrame(functions);
  // waitFrame()'s runtime is the PET's VIA/PIA one (mos/startup/waitframe.ts):
  // a retrace flag to poll and a Timer 2 stopwatch to calibrate against.
  // Every other machine here needs its own — the C64 polls VIC-II's raster
  // ($D012 plus $D011 bit 7) and needs no calibration, since its frame is an
  // exact fraction of a known crystal (FRAME_SYNC below). Until that is
  // written, a program that calls waitFrame() on one of those machines is
  // refused by name rather than built against the wrong chip.
  if (needsWaitFrame && !RASTER_MACHINES.has(options.machine) && options.machine !== 'pet') {
    return {
      ok: false,
      error: `waitFrame() has no runtime on the ${options.machine} yet: its frame sync is the PET's VIA retrace flag, and the ${options.machine}'s own raster poll is not written. A program that draws once and returns builds today; one that paces itself does not`,
    };
  }
  const zpBudget = needsWaitFrame ? budgets.owned : budgets.polite;

  // Globals first: every function's own parameters, then every function's
  // own locals and expression temporaries, bump-allocate from whatever zero
  // page globals didn't take, so each pass below needs to know where the
  // previous one's remainder starts before it can run.
  // A budget may carry holes of its own — bytes inside its range that
  // belong to someone else whatever the program does (the X16's KERNAL and
  // DOS window). Those survive into every program. The PET's CHRGET hole is
  // the other kind: it exists only because a returning program leaves
  // BASIC's interpreter running, so a program that never returns drops it.
  const zpHoles = [
    ...(zpBudget.holes ?? []),
    ...(needsWaitFrame ? [] : chrgetZpHoles(options.hardware.facts, zpBudget)),
  ];
  const zp = allocate(globals, { ...zpBudget, holes: zpHoles });
  if (!zp.ok) return { ok: false, error: zp.error };

  const globalTypes = new Map(globals.map((g) => [g.name, g.type]));
  const globalBindings = new Map(zp.globals.map((g) => [g.name, { address: g.address, type: globalTypes.get(g.name)! }]));
  const globalInits = new Map(globals.map((g) => [g.name, typeof g.init === 'number' ? g.init : 0]));

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
  // Grouped by byte value — most globals start at 0, and one LDA #0
  // serving every one of their STAs is strictly smaller (and faster) than
  // reloading the same immediate per global. Store order among plain RAM
  // bytes that nothing has read yet is unobservable.
  const initStores = new Map<number, number[]>();
  const initStore = (value: number, address: number): void => {
    const list = initStores.get(value) ?? [];
    list.push(address);
    initStores.set(value, list);
  };
  for (const g of zp.globals) {
    if (g.storage !== 'zp') continue;
    const init = globalInits.get(g.name) ?? 0;
    const width = storageBytes(globalTypes.get(g.name)!);
    initStore(init & 0xff, g.address);
    if (width === 2) initStore((init >> 8) & 0xff, g.address + 1);
  }
  const globalInitProgram: Directive[] = [];
  for (const [value, addresses] of initStores) {
    globalInitProgram.push(ldaImm(value));
    for (const address of addresses) globalInitProgram.push(staZp(address));
  }

  // How this machine's programs look as a FILE (mos/image.ts). Read here
  // rather than at the link step below because two things that come first
  // depend on it: whether a mutable array may live inside the image, and
  // whether main() ending has anywhere to return to.
  const image = imageFor(options.machine);

  // ---- mutable arrays on a machine whose image is a ROM -------------------
  //
  // "A mutable array's bytes ride inside the program and the load itself is
  // the initializer" (the paragraph just below, and mos/zp/index.ts's own
  // note) is true of every machine this backend has built for so far, and
  // for one reason: a .prg is COPIED INTO RAM before it runs, so the image
  // and the program's memory are the same bytes. A cartridge is not. On the
  // NES the image is PRG-ROM at $8000, and an `STA` into an array that
  // lives there does not fail — it does nothing, silently, and the array
  // reads back its initializer forever. @8bitscript/nes's own 112-byte
  // write queue is exactly such an array, so this is not a corner case: it
  // is the difference between the NES printing and the NES printing
  // nothing.
  //
  // So an image that says `writableImage: false` gets its mutable arrays in
  // real RAM instead, bump-allocated from the window the hardware sheet
  // names with `__bss_origin`/`__bss_ceiling` (the NES's is $0200-$07FF —
  // the 1536 bytes beside the zero page and the stack that
  // packages/nes/package.json's own `memory.ram` fact reports). The
  // mechanism is one that already exists: an `@address` array is bound to
  // an absolute address with an `equate` and reaches index()/storeIndex()
  // through exactly the same label a data-section array does, so a
  // RAM-placed array is an `@address` array whose address this allocator
  // picked. Const arrays and the string table stay in ROM, where they
  // belong and cost no RAM.
  //
  // Two things this deliberately does not do yet, both refused by name
  // below rather than half-done: a mutable array with a non-zero
  // initializer (which would need a ROM-to-RAM copy at start-up, and no
  // program in this workspace has one), and a RAM window the sheet does
  // not describe.
  const bssOrigin = options.hardware.build.defsym.__bss_origin;
  const bssCeiling = options.hardware.build.defsym.__bss_ceiling;
  let bssCursor = typeof bssOrigin === 'number' ? bssOrigin : 0;
  /** The initializers of RAM-placed arrays that have one: the bytes stay in the image under `label`, and start-up copies them down. */
  const ramInits: { label: string; address: number; values: number[] }[] = [];

  // Every array global — const data and, as of 0.2.2, mutable `let`
  // arrays and string<N> buffers too — placed in the data section below,
  // never in zero page: a loaded .prg's image is ordinary RAM on these
  // machines, so a mutable array's bytes ride inside the program and the
  // load itself is the initializer (an initializer-less `let` array gets
  // its declared all-zero start the same way). An `@address` array maps
  // hardware, not program bytes, and is refused by name. Only a 1- or
  // 2-byte element is lowered (index()/storeIndex()'s own width,
  // mos/lower/index.ts): wider ones are refused here, by name, rather
  // than mis-encoded by data.ts.
  const dataArrayGlobals: DataArrayGlobal[] = [];
  const pinnedArrays: Directive[] = [];
  const arrays = new Map<string, { elementType: string; mutable: boolean }>();
  for (const g of globals) {
    if (g.array === undefined) continue;
    const width = storageBytes(g.type);
    if (width !== 1 && width !== 2) {
      return { ok: false, error: `'${g.name}' is an array<${g.type}, ${g.array}>: only a 1- or 2-byte element is lowered yet` };
    }
    if (g.address !== null) {
      // An `@address` array maps hardware — the C64's `screenRam` over the
      // VIC's 1000 cells, a chip's register block — so it has no bytes in
      // the program image and no initializer: the machine already is the
      // storage. It still goes through index()/storeIndex() exactly as a
      // data-section array does, because the only thing those need is a
      // label to address from; this binds that label to the pinned address
      // instead of to a position in the data section (mos/asm/assemble.ts's
      // `equate`). An initializer would be a lie about hardware, and the
      // checker does not allow one.
      pinnedArrays.push({ kind: 'equate', name: arrayLabel(g.name), value: g.address });
      arrays.set(g.name, { elementType: g.type, mutable: !g.constant });
      continue;
    }
    const init = (g.init as number[] | null) ?? new Array<number>(g.array).fill(0);
    if (image.writableImage === false && !g.constant) {
      // See the RAM-window comment above the loop: on a ROM image this
      // array cannot live in the program's own bytes.
      if (typeof bssOrigin !== 'number' || typeof bssCeiling !== 'number') {
        return { ok: false, error: `'${g.name}' is a mutable array and the ${options.machine}'s image is a ROM, so it needs real RAM — but the hardware sheet names no RAM window (defsym.__bss_origin/__bss_ceiling)` };
      }
      const size = width * g.array;
      if (bssCursor + size > bssCeiling) {
        return { ok: false, error: `'${g.name}' needs ${size} byte(s) of the ${options.machine}'s RAM but only ${Math.max(0, bssCeiling - bssCursor)} byte(s) remain ($${bssCursor.toString(16).toUpperCase()}..$${(bssCeiling - 1).toString(16).toUpperCase()})` };
      }
      pinnedArrays.push({ kind: 'equate', name: arrayLabel(g.name), value: bssCursor });
      if (init.some((value) => value !== 0)) {
        // A real initializer: its bytes ride in the image the way a const
        // array's do, under a label of their own, and start-up copies them
        // into the RAM this array was just given. 2048's `let blank:
        // string<5> = "     "` is the one in this workspace — a buffer the
        // program rewrites (`blank = "    "` on a narrow screen) whose
        // starting content still matters.
        const values: number[] = [];
        for (const element of init) {
          values.push(element & 0xff);
          if (width === 2) values.push((element >> 8) & 0xff);
        }
        ramInits.push({ label: `__8bs_rominit_${g.name}`, address: bssCursor, values });
      }
      bssCursor += size;
      arrays.set(g.name, { elementType: g.type, mutable: true });
      continue;
    }
    dataArrayGlobals.push({ name: g.name, type: g.type, array: g.array, init });
    arrays.set(g.name, { elementType: g.type, mutable: !g.constant });
  }

  // The RAM those arrays were just placed in, zeroed before anything runs.
  // Empty on every machine whose image is its own RAM, where the load did
  // this already; empty too on a ROM machine whose program declared no
  // mutable array.
  const ramClearProgram: Directive[] = typeof bssOrigin === 'number'
    ? [
      ...clearRam(bssOrigin, bssCursor),
      // After the clear, never before: the clear covers the whole window in
      // one sweep, including the bytes about to be overwritten here, which
      // is smaller than clearing around them.
      ...ramInits.flatMap((init, i) => copyToRam(init.label, init.address, init.values.length, `__8bs_ram_init_${i}`)),
    ]
    : [];
  /** Those initializers' own bytes, appended to the image beside the string table. */
  const ramInitData: Directive[] = ramInits.flatMap((init): Directive[] => [{ kind: 'label', name: init.label }, { kind: 'byte', values: init.values }]);

  // waitFrame()'s own pacing state — an accumulator and a measured `num`
  // (mos/startup/waitframe.ts) — claims its zero page right after globals,
  // the same way a function's parameters do below, and only when the linked
  // program calls waitFrame() anywhere (entry or any function it can reach):
  // a program that never does pays nothing for state it never needs.
  let paramCursor = zpBudget.zpOrigin + zp.zpUsed;
  let waitFrameAcc = 0, waitFrameNum = 0;
  if (needsWaitFrame) {
    const placed = placeZp(paramCursor, WAIT_FRAME_ZP_BYTES, zpBudget.zpCeiling, zpHoles);
    if (!placed.ok) {
      return { ok: false, error: `waitFrame() needs ${WAIT_FRAME_ZP_BYTES} bytes of zero page for its own pacing state but only ${placed.remaining} byte(s) remain` };
    }
    waitFrameAcc = placed.address;
    waitFrameNum = placed.address + 4;
    paramCursor = placed.next;
  }

  // `*`'s shared routine claims its operand/result cells the same way —
  // and only when a runtime multiply survived the optimizer's own strength
  // reduction anywhere in the program (mos/startup/multiply.ts).
  const needsMultiply = usesMultiply(functions);
  let multiply: MultiplyCells | null = null;
  if (needsMultiply) {
    const placed = placeZp(paramCursor, MULTIPLY_ZP_BYTES, zpBudget.zpCeiling, zpHoles);
    if (!placed.ok) {
      return { ok: false, error: `the '*' routine needs ${MULTIPLY_ZP_BYTES} bytes of zero page for its operands but only ${placed.remaining} byte(s) remain` };
    }
    multiply = multiplyCells(placed.address);
    paramCursor = placed.next;
  }

  // ---- zero-page frames: measure, lay out, then lower for real ----------
  //
  // Every function's parameters, 16-bit return slot, and locals form one
  // contiguous FRAME, and frames overlay by call depth (mos/zp/frames.ts:
  // two functions never live at once share the same bytes). A frame's
  // size includes its locals' high-water mark, which is only knowable by
  // lowering the body — and lowering needs every callee's own addresses —
  // so the body is lowered twice: once at provisional addresses purely to
  // measure, then again at the real ones. Lowering is a pure function of
  // the IR and the addresses, so the second pass is the first with only
  // the numbers changed.
  const frameOrigin = paramCursor;

  interface FrameShape { paramWidths: (1 | 2)[]; returnWidth: 0 | 2; }
  const shapes = new Map<string, FrameShape>();
  const provisionalSites = new Map<string, FunctionSite>();
  for (const fn of functions) {
    const widths: (1 | 2)[] = [];
    for (const p of fn.params ?? []) {
      if (p.type === 'array') return { ok: false, error: `'${fn.name}(${p.name})': array parameters aren't lowered yet` };
      const width = storageBytes(p.type);
      if (width !== 1 && width !== 2) {
        return { ok: false, error: `'${fn.name}(${p.name})' is '${p.type}' (${width} bytes): only 8-bit and 16-bit parameters are lowered yet` };
      }
      widths.push(width);
    }
    const returnType = fn.returnType ?? 'void';
    const returnBytes = returnType === 'void' ? 0 : storageBytes(returnType);
    if (returnBytes > 2) {
      return { ok: false, error: `'${fn.name}' returns '${returnType}' (${returnBytes} bytes): only an 8-bit, 16-bit, or void return is lowered yet` };
    }
    // A 16-bit return value can't ride in A (one byte), so it gets a
    // fixed zero-page pair inside the frame, right after the parameters —
    // the callee's `return` writes it, the call site copies it out
    // (lower/index.ts's expr16 'call' case).
    shapes.set(fn.name, { paramWidths: widths, returnWidth: returnBytes === 2 ? 2 : 0 });
    let cursor = frameOrigin;
    const params: { address: number; width: 1 | 2 }[] = widths.map((width) => {
      const address = cursor;
      cursor += width;
      return { address, width };
    });
    const returnPair = returnBytes === 2 ? cursor : undefined;
    provisionalSites.set(fn.name, { label: `__8bs_fn_${fn.name}`, params, returnType, ...(returnPair !== undefined ? { returnPair } : {}) });
  }

  // Measurement pass: provisional addresses (every frame at frameOrigin,
  // overlapping — the output is discarded), an effectively unlimited
  // ceiling so only real lowering errors surface, and no holes, so the
  // measured high-water mark is the frame's true contiguous need.
  const frameNeeds = new Map<string, { bytes: number }>();
  for (const fn of functions) {
    const site = provisionalSites.get(fn.name)!;
    const params = (fn.params ?? []).map((p, i) => ({ name: p.name, type: p.type, address: site.params[i].address }));
    const scratchBase = frameOrigin + site.params.reduce((a, p) => a + p.width, 0) + (site.returnPair !== undefined ? 2 : 0);
    const locals = new LocalAllocator(scratchBase, 0x10000);
    const lowered = lower(fn.body, { globals: globalBindings, locals, params, functions: provisionalSites, arrays, multiply, returnPair: site.returnPair });
    if (!lowered.ok) return { ok: false, error: `in '${fn.name}': ${lowered.error}` };
    frameNeeds.set(fn.name, { bytes: scratchBase - frameOrigin + locals.used });
  }

  const layout = layoutFrames(functions, ir.entry, frameNeeds, frameOrigin, zpBudget.zpCeiling, zpHoles);
  if (!layout.ok) return { ok: false, error: layout.error };

  // Real sites from the laid-out frame starts, then the real body pass.
  const functionSites = new Map<string, FunctionSite>();
  for (const fn of functions) {
    const shape = shapes.get(fn.name)!;
    let cursor = layout.starts.get(fn.name)!;
    const params: { address: number; width: 1 | 2 }[] = shape.paramWidths.map((width) => {
      const address = cursor;
      cursor += width;
      return { address, width };
    });
    const returnPair = shape.returnWidth === 2 ? cursor : undefined;
    functionSites.set(fn.name, { label: `__8bs_fn_${fn.name}`, params, returnType: fn.returnType ?? 'void', ...(returnPair !== undefined ? { returnPair } : {}) });
  }

  const loweredFunctions: { name: string; label: string; program: Directive[]; parts: { origin: string | null; program: Directive[] }[]; isEntry: boolean }[] = [];
  for (const fn of functions) {
    const site = functionSites.get(fn.name)!;
    const shape = shapes.get(fn.name)!;
    const params = (fn.params ?? []).map((p, i) => ({ name: p.name, type: p.type, address: site.params[i].address }));
    const scratchBase = site.params.reduce((a, p) => a + p.width, layout.starts.get(fn.name)!) + shape.returnWidth;
    // The frame is hole-free by construction (layoutFrames bumps a frame
    // wholly past any hole), so the allocator needs no holes here and
    // uses exactly the bytes the measurement pass observed.
    const locals = new LocalAllocator(scratchBase, layout.starts.get(fn.name)! + frameNeeds.get(fn.name)!.bytes);
    const lowered = lower(fn.body, { globals: globalBindings, locals, params, functions: functionSites, arrays, multiply, returnPair: site.returnPair });
    if (!lowered.ok) return { ok: false, error: `in '${fn.name}': ${lowered.error}` };
    loweredFunctions.push({ name: fn.name, label: site.label, program: lowered.program, parts: lowered.parts, isEntry: fn.name === ir.entry });
  }
  const localsCursor = layout.floor;

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
  const usedStrings = new Set<number>();
  for (const fn of functions) collectStringIndexes(fn.body, usedStrings);
  const dataSection = buildDataSection(ir.strings ?? [], dataArrayGlobals, usedStrings);
  // The one-time calibration and the shared JSR target every waitFrame()
  // call site (lower/index.ts) resolves to — both empty when the program
  // never calls waitFrame() anywhere. Setup runs once, right after globals
  // are initialized and before the entry function's own body (which may
  // itself call waitFrame() first thing); the subroutine rides alongside
  // every other function's own body, after the entry falls through to BASIC.
  // The work this machine's own package can only do inside the hardware
  // frame edge waitFrame() just waited for — FRAME_SYNC's `frameHook`,
  // resolved from a function NAME (which is a fact about the machine, and
  // so belongs in that table) to the LABEL the linked program gave it
  // (which is a fact about this build). Null unless the linked program
  // really defines that function: the NES's hook is nesVerticalBlank(),
  // which arrives only by importing @8bitscript/nes or one of the portable
  // surfaces built on it, and a program that imports neither pays nothing.
  // `loweredFunctions` is post-optimizeReachable, so a hook the program
  // cannot reach is correctly absent rather than pinned alive.
  const sync = FRAME_SYNC[options.machine];
  const frameHookName = sync.kind === 'edge' && 'frameHook' in sync ? sync.frameHook : undefined;
  const frameHookLabel = frameHookName
    ? loweredFunctions.find((f) => f.name === frameHookName && !f.isEntry)?.label ?? null
    : null;
  // It is not enough for the hook to be in the linked IR: it has to have
  // survived as a CALLABLE function. A no-parameter void function with no
  // `return` in it is inlined into all of its call sites and then pruned
  // (linker/optimize.mjs's inlineVoidCall), which is exactly right for an
  // ordinary helper and exactly wrong for this one, whose most important
  // caller is this backend and therefore invisible to that pass. The
  // failure it produces is silent and total — the queue fills and is never
  // delivered, so a correct program shows a blank screen with the right
  // bytes sitting in RAM — so it is refused here by name instead.
  if (frameHookName && !frameHookLabel && ir.functions.some((fn) => fn.name === frameHookName)) {
    return {
      ok: false,
      error: `the ${options.machine}'s frame runtime calls ${frameHookName}() after every hardware frame, but the linked program no longer has it as a callable function — it was inlined into its call sites and pruned. A void function the backend calls has to end with an explicit 'return;' to stay one (see packages/nes/src/index.8bs)`,
    };
  }
  const waitFrameSetupProgram = needsWaitFrame ? waitFrameSetup(options.frameRate, waitFrameAcc, waitFrameNum, options.machine) : [];
  const waitFrameRoutineProgram = needsWaitFrame ? waitFrameRoutine(waitFrameAcc, waitFrameNum, options.machine, frameHookLabel) : [];
  const multiplyProgram = multiply ? multiplyRoutine(multiply) : [];
  const needsCld = usesDecimalSensitiveMath([...everyInstruction, ...waitFrameSetupProgram, ...waitFrameRoutineProgram, ...multiplyProgram]);
  // A waitFrame() program's zero-page budget includes bytes the KERNAL's
  // own IRQ handler still updates (the jiffy clock) until interrupts go
  // off — so off they go before the first global initializer's store,
  // not merely inside waitFrameSetup (whose own SEI stays, harmlessly,
  // for the setup's documented flag-race reason).
  // ...except where the OS is not someone else's any more but this
  // program's own dependency. The Atari 8-bit has no KERNAL-shaped bargain
  // to break: its OS's vertical-blank routine is what copies the color
  // shadows @8bitscript/atari8/screen writes down onto GTIA, and its OS is
  // what maintains SAVMSC, the pointer every run of text on that machine
  // reads to find screen memory. Its zero-page budget is the same $80-$FF
  // either way (ATARI8_ZP_BUDGET above) precisely because there is nothing
  // to be bought by silencing it. waitframe.ts's own rasterSetup() skips
  // its SEI for the same machine and the same reason; asking it keeps the
  // two decisions from drifting apart.
  const ownMachineProgram: Directive[] = needsWaitFrame && !waitFrameKeepsInterrupts(options.machine)
    ? [{ kind: 'instruction', mnemonic: 'SEI', mode: 'implied' }]
    : [];

  // The X16 boots its screen editor in PETSCII, where a tile index is a
  // PETSCII screen code and 'A' is 1. @8bitscript/cx16/text writes ASCII
  // straight through to VERA instead — `text.putChar` takes ASCII on every
  // machine, and on this one the hardware can take it directly — which is
  // true only in ISO mode, where the tile index IS the character code.
  // CHR$(15) through CHROUT is what switches it, and the KERNAL clears the
  // screen as part of the switch, so it has to happen before anything is
  // drawn. packages/cx16/src/index.8bs describes both consequences at
  // length and notes that the native backend did not emit this yet; this is
  // it. Two instructions, and only on the machine that needs them.
  const isoModeProgram: Directive[] = options.machine === 'cx16'
    ? [
      { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 0x0f } },
      { kind: 'instruction', mnemonic: 'JSR', mode: 'absolute', operand: { kind: 'value', value: 0xffd2 } },
    ]
    : [];

  // main() ending, on a machine that has nowhere to end TO.
  //
  // Every machine this backend built for before the NES is started by a
  // loader: BASIC's `SYS` pushed a return address, epilogue()'s RTS pops
  // it, and `READY.` comes back. `entryIsVectored` (mos/image.ts) names
  // exactly the machines where that is false — the hardware jumped to the
  // entry through a reset vector and pushed nothing — so an RTS there
  // returns to whatever two bytes the stack pointer happens to be sitting
  // on at power-on and executes them. main() ending has to STOP instead,
  // and "stop" on a 6502 with no HLT is a branch to itself.
  //
  // It is not quite nothing, though, on a machine whose picture is
  // assembled by a frame runtime. @8bitscript/nes does not write the PPU
  // when a program prints — it queues the bytes, because VRAM belongs to
  // the PPU at every moment outside vertical blank (that package's own
  // rule 2), and the frame hook above is what delivers them. A program
  // that draws once and ends, which is exactly what hello-world is, still
  // has its greeting sitting in that queue when main() returns. So where
  // there is both a frame edge to wait for and a hook to call, the halt is
  // that pair, forever: the program is over, the picture is not. Without
  // either, it is the bare two-byte spin.
  const haltLabel = '__8bs_halt';
  const haltEdge = image.entryIsVectored && frameHookLabel ? frameEdgeWait(options.machine, haltLabel) : null;
  // `endsByHalting` is the second way to arrive here, and it is the Atari
  // 8-bit's: DOS really did JSR through RUNAD, so an RTS is safe — it just
  // lands in an environment that resets the OS color shadows and clears the
  // screen before anyone can look at what the program drew (measured under
  // atari800 7.1.2: identical result with `-basic`, with `-nobasic`, and
  // with the stock config, and the same greeting stays up indefinitely when
  // the program does not return). Halting is three bytes and is the only
  // way a program that draws once and ends shows what it drew.
  const endProgram: Directive[] = image.entryIsVectored || image.endsByHalting
    ? [
      { kind: 'label', name: haltLabel },
      ...(haltEdge ?? []),
      ...(haltEdge && frameHookLabel ? [{ kind: 'instruction', mnemonic: 'JSR', mode: 'absolute', operand: { kind: 'label', name: frameHookLabel } } as Directive] : []),
      { kind: 'instruction', mnemonic: 'JMP', mode: 'absolute', operand: { kind: 'label', name: haltLabel } },
    ]
    : epilogue();

  // The NES is the only machine here that boots from nothing: no loader has
  // set a stack pointer, silenced an interrupt source or waited out the
  // PPU's power-on interval before this code runs, so its reset handler has
  // to do all of that itself before a single byte of the program's own work
  // (mos/startup/nes.ts, where each line's reason is written down). It goes
  // FIRST — ahead of even the CLD prologue — because one of the things it
  // establishes is the stack every JSR below depends on.
  const machineStartupProgram: Directive[] = options.machine === 'nes' ? nesResetInit() : [];

  const combinedProgram: Directive[] = [
    ...machineStartupProgram,
    ...prologue(needsCld),
    ...isoModeProgram,
    ...ownMachineProgram,
    ...ramClearProgram,
    ...globalInitProgram,
    ...waitFrameSetupProgram,
    ...entry.program,
    ...endProgram,
    ...others.flatMap((f): Directive[] => [{ kind: 'label', name: f.label }, ...f.program, RTS]),
    ...waitFrameRoutineProgram,
    ...multiplyProgram,
    ...pinnedArrays,
    ...ramInitData,
    ...dataSection,
  ];


  // How this machine's programs look as a file — a Commodore .prg with a
  // BASIC stub, or whatever else the machine boots (mos/image.ts). `image`
  // itself was read far above: what a mutable array may do and what main()
  // ending does both depend on it.
  const { bytes: stub, codeStart } = image.prelude(loadAddress);

  // The ceiling the linker measures against, in one of two spellings. A
  // machine whose usable RAM ends on a whole number of KiB says so with
  // `__ram_size` and always has (the PET's screen sits exactly there); a
  // machine whose does not says `__ram_ceiling` outright. The VIC-20 is the
  // second kind and is why the second spelling exists: unexpanded, BASIC's
  // program area ends at $1E00, where the screen starts, which is 7.5 KiB.
  const ramCeilingBytes = options.hardware.build.defsym.__ram_ceiling;
  const ramSizeKib = options.hardware.build.defsym.__ram_size;
  if (typeof ramCeilingBytes !== 'number' && typeof ramSizeKib !== 'number') {
    return { ok: false, error: `the ${options.machine} hardware sheet is missing defsym.__ram_ceiling (or defsym.__ram_size), the RAM ceiling the linker needs` };
  }

  const linked = link({
    codeOrigin: codeStart,
    ramCeiling: typeof ramCeilingBytes === 'number' ? ramCeilingBytes : ramSizeKib * 1024,
    code: { kind: 'assembly', program: combinedProgram },
    zpOrigin: zpBudget.zpOrigin,
    zpCeiling: zpBudget.zpCeiling,
    // Globals (milestone 5) plus every function's own parameter region plus
    // the most zero page each function's own locals and expression
    // temporaries ever held live at once (LIFO, per function) — not the sum
    // of every local ever declared, and not shared across functions either
    // (mos/AGENTS.md's known-conservative choice).
    zp: localsCursor - zpBudget.zpOrigin,
  });
  if (!linked.ok) return { ok: false, error: linked.error };

  const body = new Uint8Array(stub.length + linked.bytes.length);
  body.set(stub, 0);
  body.set(linked.bytes, stub.length);
  // A format that has to assemble something of its own out of the
  // program's native sources — the NES's CHR-ROM is the only one today,
  // and the NES is also the only machine that cannot show a single
  // character without it — raises what it cannot do as an exception rather
  // than by returning bytes, because there are no bytes to return. Turned
  // back into this backend's ordinary refuse-by-name here, so a caller sees
  // one shape of failure however far down it happened.
  let bytes: Uint8Array;
  try {
    bytes = image.file(loadAddress, body, codeStart, { nativeSources: ir.nativeSources ?? [] });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  await mkdir(dirname(options.outFile), { recursive: true });
  await writeFile(options.outFile, bytes);

  let sizeReport: SizeReportEntry[] | undefined;
  if (options.report) {
    const entries: SizeReportEntry[] = loweredFunctions.flatMap(functionSizeEntries);
    entries.push(
      { name: '(wait-frame setup)', bytes: directiveBytes(waitFrameSetupProgram) },
      { name: '(wait-frame routine)', bytes: directiveBytes(waitFrameRoutineProgram) },
      { name: '(multiply routine)', bytes: directiveBytes(multiplyProgram) },
      { name: '(global initializers)', bytes: directiveBytes(globalInitProgram) },
      { name: '(string/const-array data)', bytes: directiveBytes(dataSection) },
      // Everything in the FILE that is not linked code: whatever prelude
      // the image puts in front of it plus whatever header, trailer or
      // padding image.file() wraps around it. Derived as the difference
      // rather than spelled out, because spelling it out means knowing the
      // format — this used to read `2 + stub.length`, which is exactly a
      // `.prg`'s load-address word and its BASIC stub and nothing else, and
      // was silently wrong for every format that is not a `.prg`: 10 bytes
      // short on an Atari `.xex` (a $FFFF marker and two four-byte segment
      // headers against a prelude of none) and short by the iNES header
      // plus the ROM padding on a `.nes`. The difference is right for all
      // three by construction, which is what SizeReportEntry's own JSDoc
      // promises: every entry sums to the real bytes.length.
      { name: '(image header + prologue/epilogue)', bytes: (bytes.length - linked.bytes.length) + directiveBytes(prologue(needsCld)) + directiveBytes(isoModeProgram) + directiveBytes(machineStartupProgram) + directiveBytes(ownMachineProgram) + directiveBytes(ramClearProgram) + directiveBytes(endProgram) },
    );
    sizeReport = entries.filter((e) => e.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  }

  return { ok: true, bytes, memory: { variables: linked.memory.variables, program: bytes.length }, ...(sizeReport ? { sizeReport } : {}) };
}

// ---- waitFrame() pacing ----------------------------------------------------
//
// One hardware frame is NOT 1/60th of a second, and the machines don't even
// agree with each other or with the web host, which paces waitFrame() at a
// genuine fixed rate of real time (packages/cli/src/web-runtime.mjs). Tying
// waitFrame() 1:1 to vblank drifts a target away from that reference
// forever, so every machine below runs the same fixed-point scheme: an
// accumulator of *logical* frames owed — at whatever rate the project is
// configured for (`frameRate`, default 60; see 8bitscript.config.ts), the same rate
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
  // two frames that's exactly 178683 PPU cycles, or 59561 CPU cycles (PPU
  // runs 3x CPU), an exact integer. PAL NES runs a visibly different PPU
  // (extra idle scanlines most homebrew code doesn't target) and isn't
  // supported by this target yet.
  //
  // Those two numbers read 178803 and 59601 until the native backend
  // actually needed them (2026-09-12). They were wrong, by a transposed
  // pair of digits rather than by a wrong model: 341 dots x 261 lines +
  // 340.5 for the pre-render line that is a dot shorter on odd frames is
  // 89341.5, and twice that is 178683, not 178803. The giveaway is that
  // the ratio has a published value to check against — 1789773 / 29780.5 =
  // 60.0985Hz, NESdev's own "60.0988 Hz" for NTSC
  // (nesdev.org/wiki/Cycle_reference_chart, re-read 2026-09-12), where
  // 59601 gives 60.0585Hz. 0.067% is invisible in a screenshot and is
  // about 58 logical frames of drift a day against the web host's real
  // 60Hz, which is what this whole accumulator exists to prevent.
  nes: {
    kind: 'edge',
    pollFlag: '(*(volatile uint8_t *)0x2002) & 0x80',
    ack: '',
    num: 59561,
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
