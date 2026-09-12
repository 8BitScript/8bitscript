// waitFrame() runtime support for the PET.
//
// This is NOT the FRAME_SYNC table just above it in mos/index.ts: that
// table (and its `calibrate` field's C-pseudocode strings) was written for
// an older, abandoned backend design — a synthesized driver that called a
// user-exported `frame()` callback zero, one, or two times per hardware
// frame (see mos/AGENTS.md's milestone 10 section for the git-history
// evidence). The current language's `waitFrame()` is a blocking statement
// a program calls from within its own loop, so the pacing logic here is a
// fresh translation of the same underlying idea (an accumulator of logical
// frames owed, measured once against a real hardware clock) onto that
// different shape: a one-time setup routine plus one shared subroutine
// every `waitFrame()` call site `JSR`s.
//
// ---- the design, grounded in the real PET package -------------------------
//
// packages/pet/src/index.8bs and keyboard.8bs document the real contract
// this has to honor: PIA1's CB1 edge flag ($E813 bit 7) latches once per
// vertical retrace and is acknowledged by reading port B ($E812); a program
// that calls waitFrame() anywhere runs with interrupts off from start-up
// (`presync`, a SEI first thing), because the KERNAL's own jiffy-clock IRQ
// reads the same port every frame and would win the race for the flag
// otherwise; and packages/pet/src/keyboard.8bs's own scan() reads that same
// port right after waitFrame() returns, when the edge was *just* consumed —
// reading it any earlier eats a frame the accumulator below would otherwise
// count.
//
// ---- calibration ------------------------------------------------------
//
// The PET has no documented NTSC/PAL crystal split (mos/index.ts's own
// FRAME_SYNC.pet comment), so num/den isn't a compile-time constant the way
// it is on every other machine: `waitFrameSetup` measures real
// cycles-per-frame once at start-up, using VIA1 Timer 2 ($E848/$E849) as a
// one-shot countdown stopwatch between two retrace edges, then multiplies
// by the configured `frameRate` (a compile-time constant). When the rate
// fits in a byte — every real project value — that multiply is a
// Russian-peasant loop: the rate in X, eight shifts in Y, one 32-bit add
// and one 32-bit shift in the body, reusing the accumulator as scratch.
// A rate wider than a byte still unrolls. `elapsed =
// 0xFFFF - timer` is computed as `EOR #$FF` on each byte rather than a
// subtract-with-borrow: subtracting from an all-ones value is exactly a
// bitwise complement, for any 16-bit `timer`.
//
// `den` is always exactly 1,000,000 — the PET's flat, region-independent
// 1MHz CPU clock (documented, not measured) — so it's never stored in zero
// page at all, just baked into the compare/subtract below as four immediate
// bytes.
import type { Directive } from '../asm/assemble.ts';
import type { AddressingMode } from '../asm/encode.ts';
import type { IrFunction } from '../lower/index.ts';
import type { Machine } from '../index.ts';

export const WAIT_FRAME_LABEL = '__8bs_wait_frame';

/** How much zero page waitFrame()'s own pacing state needs: a 4-byte accumulator and a 4-byte measured `num`. Setup measures elapsed into the accumulator, multiplies in place into `num`, then zeros the accumulator — no separate scratch cell. */
export const WAIT_FRAME_ZP_BYTES = 8;

const CB1_FLAG = 0xe813; // bit 7: the vertical-retrace edge, latched until PIA1 port B is read
const PIA1_PORT_B = 0xe812; // reading it acknowledges the CB1 flag — see packages/pet/src/index.8bs
const VIA1_T2_LO = 0xe848;
const VIA1_T2_HI = 0xe849; // writing it loads T2 from T2C-L and starts the one-shot countdown
const DEN = 1_000_000; // the PET's own real, region-independent 1MHz CPU clock



/**
 * True if any function in `functions` — the whole linked program, not just
 * the entry — calls `waitFrame()` anywhere in its own body, directly or
 * inside a nested block/if/loop. A generic, untyped structural walk, the
 * same discipline mos/index.ts's own collectCallNames() already uses for
 * the call graph: the real IR carries far more shape than this backend's
 * own narrow interfaces name, and a per-kind switch would go stale the day
 * a new statement kind can contain a nested statement this doesn't know
 * about yet.
 */
export function usesWaitFrame(functions: IrFunction[]): boolean {
  function walk(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(walk);
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (obj.kind === 'waitFrame') return true;
      return Object.values(obj).some(walk);
    }
    return false;
  }
  return functions.some((fn) => walk(fn.body));
}

function instr(mnemonic: string, mode: AddressingMode, value?: number, labelName?: string): Directive {
  if (labelName !== undefined) return { kind: 'instruction', mnemonic, mode, operand: { kind: 'label', name: labelName } };
  if (value !== undefined) return { kind: 'instruction', mnemonic, mode, operand: { kind: 'value', value } };
  return { kind: 'instruction', mnemonic, mode };
}
const label = (name: string): Directive => ({ kind: 'label', name });
const branch = (mnemonic: string, target: string): Directive => instr(mnemonic, 'relative', undefined, target);
const jmp = (target: string): Directive => instr('JMP', 'absolute', undefined, target);
const ldaImm = (v: number): Directive => instr('LDA', 'immediate', v);
const ldaAbs = (v: number): Directive => instr('LDA', 'absolute', v);
const staAbs = (v: number): Directive => instr('STA', 'absolute', v);
const ldaZp = (a: number): Directive => instr('LDA', 'zeropage', a);
const staZp = (a: number): Directive => instr('STA', 'zeropage', a);

function byteOf(n: number, i: number): number {
  return Math.floor(n / 256 ** i) & 0xff;
}

/** dst (4 bytes, zero page) += src (4 bytes, zero page), in place. */
function add32(dst: number, src: number): Directive[] {
  const out: Directive[] = [instr('CLC', 'implied')];
  for (let i = 0; i < 4; i++) out.push(ldaZp(dst + i), instr('ADC', 'zeropage', src + i), staZp(dst + i));
  return out;
}

/** addr (4 bytes, zero page) <<= 1, in place — ASL the low byte, ROL the rest, carry propagating low to high. */
function shiftLeft32(addr: number): Directive[] {
  return [
    instr('ASL', 'zeropage', addr),
    instr('ROL', 'zeropage', addr + 1),
    instr('ROL', 'zeropage', addr + 2),
    instr('ROL', 'zeropage', addr + 3),
  ];
}

/**
 * The one-time program-start setup: disable interrupts (packages/pet's own
 * documented reason — see this file's header), measure real cycles/frame
 * against VIA1 Timer 2, multiply by `frameRate` to get `num`, and zero the
 * accumulator. Emitted once, before the entry function's own body, only
 * when `usesWaitFrame` says the program calls waitFrame() anywhere.
 */
// ---- the machines that poll a raster instead of an edge -------------------
//
// The PET has a retrace flag to wait on and no documented crystal, so it
// measures. Every other Commodore here has the opposite pair of facts: no
// flag, but a raster counter readable as a plain byte, and a frame that is
// an exact fraction of a known crystal. So the shape differs in two places
// and nowhere else — how a hardware frame is waited for, and how `num` is
// arrived at — while the accumulator, DEN, and the whole compare/subtract
// body below stay exactly as they are.
//
// Waiting: a frame is detected by watching the raster leave the top half of
// the frame and come back to it. Not by waiting for line 0 — mos/index.ts's
// FRAME_SYNC comment records why at length, with the measurement: a narrow
// at-line-0 window is missed whenever an interrupt handler happens to be
// running as it passes, and a half-frame window (thousands of cycles) never
// can be.
//
// The region: one .prg runs on a PAL machine and an NTSC one, so which it
// is cannot be a build flag. It is probed once at start-up by sampling the
// raster over a window comfortably longer than a frame and watching for a
// line only one of the two regions ever reaches.
interface RasterSync {
  /** Leaves "the raster is in the top half of the frame" in a flag. */
  topHalf: Directive[];
  /** The branch taken when that test says top half, and the one when it says not. */
  whenTop: string;
  whenNotTop: string;
  /** Samples the raster once and branches to `target` if this sample proves the machine is PAL. */
  palProbe: (target: string) => Directive[];
  /** Seconds per frame, exactly, as the integer fraction mos/index.ts's FRAME_SYNC records. */
  pal: { num: number; den: number };
  ntsc: { num: number; den: number };
}

const RASTER: Partial<Record<Machine, RasterSync>> = {
  c64: {
    // $D012 is the raster's low 8 bits and $D011 bit 7 is its 9th, and the
    // C64 has more than 256 lines, so both are needed: ORing them together
    // and testing bit 7 says "under 128 and not past 255" in one go. $D012
    // is read FIRST — reading $D011 first opens the race FRAME_SYNC
    // describes, where bit 7 is still clear at line 255 and $D012 has
    // already wrapped to 0 at line 256.
    topHalf: [ldaAbs(0xd012), instr('ORA', 'absolute', 0xd011), instr('AND', 'immediate', 0x80)],
    whenTop: 'BEQ',
    whenNotTop: 'BNE',
    // An NTSC C64 never shows $D012 >= 32 while bit 7 is set (it tops out
    // at line 262, $D012 == 6); a PAL one reaches line 311, $D012 == 55.
    palProbe: (target: string) => {
      const skip = `${target}_skip`;
      return [
        ldaAbs(0xd011), instr('AND', 'immediate', 0x80), branch('BEQ', skip),
        ldaAbs(0xd012), instr('CMP', 'immediate', 32), branch('BCS', target),
        label(skip),
      ];
    },
    pal: { num: 312 * 63 * 18, den: 17734472 },
    ntsc: { num: 263 * 65 * 14, den: 14318181 },
  },
  // The MEGA65's VIC-IV answers $D011/$D012 the same way for this purpose,
  // and FRAME_SYNC records its ratios identically to the C64's.
  mega65: {
    topHalf: [ldaAbs(0xd012), instr('ORA', 'absolute', 0xd011), instr('AND', 'immediate', 0x80)],
    whenTop: 'BEQ',
    whenNotTop: 'BNE',
    palProbe: (target: string) => {
      const skip = `${target}_skip`;
      return [
        ldaAbs(0xd011), instr('AND', 'immediate', 0x80), branch('BEQ', skip),
        ldaAbs(0xd012), instr('CMP', 'immediate', 32), branch('BCS', target),
        label(skip),
      ];
    },
    pal: { num: 312 * 63 * 18, den: 17734472 },
    ntsc: { num: 263 * 65 * 14, den: 14318181 },
  },
  // The C128's VIC-IIe, in the 40-column mode this target boots into, is
  // the C64's VIC-II for this purpose: the same two registers, the same
  // 9-bit raster, and the same frame as an exact fraction of the same
  // crystal (mos/index.ts's FRAME_SYNC records the two entries identically).
  c128: {
    topHalf: [ldaAbs(0xd012), instr('ORA', 'absolute', 0xd011), instr('AND', 'immediate', 0x80)],
    whenTop: 'BEQ',
    whenNotTop: 'BNE',
    palProbe: (target: string) => {
      const skip = `${target}_skip`;
      return [
        ldaAbs(0xd011), instr('AND', 'immediate', 0x80), branch('BEQ', skip),
        ldaAbs(0xd012), instr('CMP', 'immediate', 32), branch('BCS', target),
        label(skip),
      ];
    },
    pal: { num: 312 * 63 * 18, den: 17734472 },
    ntsc: { num: 263 * 65 * 14, den: 14318181 },
  },
  vic20: {
    // The VIC-I's own layout, which is not the VIC-II's: $9004 holds bits
    // 8-1 of a 9-bit counter, so it changes every second line and its range
    // tops out around 130 (NTSC) or 155 (PAL) — nowhere near a wrap, so one
    // byte decides the half on its own.
    topHalf: [ldaAbs(0x9004), instr('CMP', 'immediate', 64)],
    whenTop: 'BCC',
    whenNotTop: 'BCS',
    // Those bottom lines only exist on PAL.
    palProbe: (target: string) => [ldaAbs(0x9004), instr('CMP', 'immediate', 140), branch('BCS', target)],
    pal: { num: 312 * 71 * 4, den: 4433618 },
    ntsc: { num: 261 * 65 * 14, den: 14318181 },
  },
};

// ---- the machine that polls a flag instead of a raster --------------------
//
// The X16 has neither the PET's problem nor the raster machines'. VERA
// raises a VSYNC bit in its ISR at the top of every frame and the bit is
// acknowledged by writing it back, which is an edge the way the PET's
// retrace flag is an edge — but unlike the PET it needs no calibration,
// because the X16's frame is exactly 1/60th of a second on every machine
// there is. No region probe, and at the default frameRate of 60 the credit
// is exactly DEN, so one VSYNC is one logical frame and the accumulator
// never carries anything between frames (packages/cx16/AGENTS.md says the
// same about this runtime).
interface FlagSync {
  /** Polls until the flag is set, then acknowledges it. */
  wait: Directive[];
  /** Seconds per frame, exactly. */
  ratio: { num: number; den: number };
}

const VERA_ISR = 0x9f27;

const FLAG: Partial<Record<Machine, FlagSync>> = {
  cx16: {
    wait: [],           // filled in below, where the label helper is in scope
    ratio: { num: 1, den: 60 },
  },
};

function flagWait(): Directive[] {
  const poll = `${WAIT_FRAME_LABEL}_vsync`;
  return [
    label(poll),
    ldaAbs(VERA_ISR), instr('AND', 'immediate', 0x01), branch('BEQ', poll),
    // Writing the bit back is what clears it; anything else in the ISR is
    // left alone, which is why this writes $01 rather than the byte it read.
    ldaImm(0x01), staAbs(VERA_ISR),
  ];
}

/** Logical frames owed per hardware frame, scaled by DEN — `frameRate` seconds-per-frame, as an integer. */
function frameCredit(frameRate: number, ratio: { num: number; den: number }): number {
  return Math.round((frameRate * ratio.num * DEN) / ratio.den);
}

/** Stores a 32-bit constant into the four `num` cells. */
function storeNum(num: number, value: number): Directive[] {
  const out: Directive[] = [];
  for (let i = 0; i < 4; i++) out.push(ldaImm(byteOf(value, i)), staZp(num + i));
  return out;
}

/**
 * Zero the accumulator, find out which region this machine is, and take
 * that region's per-frame credit. The sample window is 16 * 256 reads —
 * comfortably longer than a frame on either region and on either machine,
 * so a line only PAL reaches cannot be missed.
 */
function rasterSetup(frameRate: number, acc: number, num: number, sync: RasterSync): Directive[] {
  const out: Directive[] = [];
  const outer = '__8bs_wf_probe_outer';
  const inner = '__8bs_wf_probe_inner';
  const isPal = '__8bs_wf_probe_pal';
  const done = '__8bs_wf_probe_done';

  out.push(instr('SEI', 'implied'));
  out.push(ldaImm(0), staZp(acc), staZp(acc + 1), staZp(acc + 2), staZp(acc + 3));

  out.push(instr('LDY', 'immediate', 16), label(outer), instr('LDX', 'immediate', 0), label(inner));
  out.push(...sync.palProbe(isPal));
  out.push(instr('DEX', 'implied'), branch('BNE', inner));
  out.push(instr('DEY', 'implied'), branch('BNE', outer));

  out.push(...storeNum(num, frameCredit(frameRate, sync.ntsc)));
  out.push(jmp(done));
  out.push(label(isPal));
  out.push(...storeNum(num, frameCredit(frameRate, sync.pal)));
  out.push(label(done));
  return out;
}

/** Zero the accumulator and take this machine's fixed per-frame credit — there is no region to find out about. */
function flagSetup(frameRate: number, acc: number, num: number, sync: FlagSync): Directive[] {
  const out: Directive[] = [instr('SEI', 'implied')];
  out.push(ldaImm(0), staZp(acc), staZp(acc + 1), staZp(acc + 2), staZp(acc + 3));
  out.push(...storeNum(num, frameCredit(frameRate, sync.ratio)));
  return out;
}

/** Blocks until the raster leaves the top half of the frame and comes back to it. */
function rasterWait(sync: RasterSync): Directive[] {
  const leaving = `${WAIT_FRAME_LABEL}_leaving`;
  const returning = `${WAIT_FRAME_LABEL}_returning`;
  return [
    label(leaving), ...sync.topHalf, branch(sync.whenTop, leaving),
    label(returning), ...sync.topHalf, branch(sync.whenNotTop, returning),
  ];
}

export function waitFrameSetup(frameRate: number, acc: number, num: number, machine: Machine = 'pet'): Directive[] {
  const sync = RASTER[machine];
  if (sync) return rasterSetup(frameRate, acc, num, sync);
  const flag = FLAG[machine];
  if (flag) return flagSetup(frameRate, acc, num, flag);
  const out: Directive[] = [];
  const waitEdge = (tag: string) => {
    const poll = `__8bs_wf_setup_${tag}`;
    out.push(label(poll), ldaAbs(CB1_FLAG), instr('AND', 'immediate', 0x80), branch('BEQ', poll));
    out.push(ldaAbs(PIA1_PORT_B)); // ack
  };

  out.push(instr('SEI', 'implied'));

  waitEdge('start');
  out.push(ldaImm(0xff), staAbs(VIA1_T2_LO));
  out.push(ldaImm(0xff), staAbs(VIA1_T2_HI)); // loads T2 from T2C-L and starts the countdown
  waitEdge('end');

  // elapsed = 0xFFFF - timer == ~timer (see this file's header) — landed
  // in acc as a 16-bit value, top two bytes 0. Setup then multiplies that
  // into num and zeros acc, so the running program never sees the sample.
  out.push(ldaAbs(VIA1_T2_LO), instr('EOR', 'immediate', 0xff), staZp(acc));
  out.push(ldaAbs(VIA1_T2_HI), instr('EOR', 'immediate', 0xff), staZp(acc + 1));
  out.push(ldaImm(0), staZp(acc + 2), staZp(acc + 3));
  out.push(ldaImm(0), staZp(num), staZp(num + 1), staZp(num + 2), staZp(num + 3));

  const rate = Math.floor(frameRate);
  if (rate > 0 && rate <= 255) {
    // Russian peasant: X holds the remaining rate bits, Y counts 8 shifts.
    // add32/shiftLeft32 clobber A only, so X and Y survive the body.
    const loop = '__8bs_wf_mul';
    const skip = '__8bs_wf_mul_skip';
    out.push(instr('LDX', 'immediate', rate));
    out.push(instr('LDY', 'immediate', 8));
    out.push(label(loop));
    out.push(instr('TXA', 'implied'), instr('LSR', 'accumulator'), instr('TAX', 'implied'));
    out.push(branch('BCC', skip));
    out.push(...add32(num, acc));
    out.push(label(skip));
    out.push(...shiftLeft32(acc));
    out.push(instr('DEY', 'implied'), branch('BNE', loop));
  } else if (rate > 255) {
    const bits = Math.floor(Math.log2(rate)) + 1;
    for (let bit = 0; bit < bits; bit++) {
      if ((rate >>> bit) & 1) out.push(...add32(num, acc));
      if (bit + 1 < bits) out.push(...shiftLeft32(acc));
    }
  }

  out.push(ldaImm(0), staZp(acc), staZp(acc + 1), staZp(acc + 2), staZp(acc + 3));

  return out;
}

/**
 * The shared subroutine every `waitFrame()` call site `JSR`s
 * (WAIT_FRAME_LABEL): drain existing credit first (so a call right after
 * setup, or after a slow logical frame, doesn't wait on hardware it doesn't
 * need to), otherwise block on the next retrace edge, add this machine's
 * measured `num` to the accumulator, and try again. `den` is always exactly
 * 1,000,000 (this file's own header) — never stored, just four immediate
 * bytes in the compare and the subtract below.
 *
 * The comparison is unrolled byte-by-byte, most significant first, with
 * every branch target close by (the next few bytes) rather than a shared
 * label at the bottom of a ~90-byte routine: 6502 conditional branches are
 * relative with a signed 8-bit range, and this shape keeps every one of
 * them well inside it by construction, not by measuring after the fact.
 */
export function waitFrameRoutine(acc: number, num: number, machine: Machine = 'pet'): Directive[] {
  const sync = RASTER[machine];
  const flag = FLAG[machine];
  const out: Directive[] = [];
  const GE = `${WAIT_FRAME_LABEL}_ge`;
  const WAIT = `${WAIT_FRAME_LABEL}_wait`;
  const POLL = `${WAIT_FRAME_LABEL}_poll`;
  const LOOP = `${WAIT_FRAME_LABEL}_loop`;

  out.push(label(WAIT_FRAME_LABEL), label(LOOP));

  for (let i = 3; i >= 1; i--) {
    out.push(ldaZp(acc + i), instr('CMP', 'immediate', byteOf(DEN, i)));
    out.push(branch('BCC', WAIT)); // this byte alone says acc < DEN
    out.push(branch('BNE', GE)); // this byte alone says acc > DEN; equal falls through to the next (lower) byte
  }
  out.push(ldaZp(acc), instr('CMP', 'immediate', byteOf(DEN, 0)));
  out.push(branch('BCC', WAIT)); // every higher byte was equal; this one decides it
  // Falls straight through into GE: every higher byte equal and the low
  // byte >= DEN's own low byte is exactly acc >= DEN.

  out.push(label(GE));
  out.push(instr('SEC', 'implied'));
  for (let i = 0; i < 4; i++) out.push(ldaZp(acc + i), instr('SBC', 'immediate', byteOf(DEN, i)), staZp(acc + i));
  out.push(instr('RTS', 'implied'));

  out.push(label(WAIT));
  if (sync) {
    out.push(...rasterWait(sync));
  } else if (flag) {
    out.push(...flagWait());
  } else {
    out.push(label(POLL));
    out.push(ldaAbs(CB1_FLAG), instr('AND', 'immediate', 0x80), branch('BEQ', POLL));
    out.push(ldaAbs(PIA1_PORT_B)); // ack — packages/pet/src/index.8bs's own documented side effect
  }
  out.push(...add32(acc, num));
  out.push(jmp(LOOP));

  return out;
}
