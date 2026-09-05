// The 6502 backend: IR in, machine code out.
//
// It emits C rather than assembly, on purpose: LLVM-MOS does register
// allocation, zero-page allocation, and instruction selection better than a
// first-generation backend would, so the work here is a faithful translation
// of the IR and nothing more. The generated C is deliberately boring — every
// construct maps one-to-one, so reading it against the source is easy.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PRIMITIVE_INTEGER_TYPES, entryOf } from '@8bitscript/compiler';

// C has no 24-bit integer, so mediumint/umediumint widen to the next native
// width up. The bits/signedness driving this table come from the compiler's
// own type registry — this file no longer keeps its own copy of what
// `utinyint` (or its `u8` alias) means.
const NATIVE_WIDTH = { 8: 8, 16: 16, 24: 32, 32: 32 };
const C_TYPE = Object.fromEntries(
  PRIMITIVE_INTEGER_TYPES.map((t) => [t.canonicalName, `${t.signed ? 'int' : 'uint'}${NATIVE_WIDTH[t.bits]}_t`]),
);
C_TYPE.bool = 'uint8_t';

// llvm-mos-sdk ships one driver binary per platform, confirmed against its
// own mos-platform/ tree (github.com/llvm-mos/llvm-mos-sdk). Atari 8-bit is
// the one machine with more than one driver: llvm-mos treats "Atari 8-bit"
// as a single target family and varies the *output format* rather than the
// CPU/ABI, so the driver depends on the chosen ATARI8_PROFILE, not on
// `machine` alone — see driverFor() below.
const DRIVER = {
  vic20: 'mos-vic20-clang',
  c64: 'mos-c64-clang',
  pet: 'mos-pet-clang',
  c128: 'mos-c128-clang',
  mega65: 'mos-mega65-clang',
  cx16: 'mos-cx16-clang',
  // NROM: the plainest NES mapper (32K PRG/8K CHR, no bank switching) —
  // llvm-mos also ships unrom/mmc1/mmc3/cnrom/gtrom/action53/unrom-512
  // drivers for bigger cartridges, not wired up here since nothing in this
  // project needs more than 32K yet.
  nes: 'mos-nes-nrom-clang',
};

// Atari 8-bit hardware profiles. LLVM-MOS's own linker scripts don't
// distinguish 800 from 800XL from 130XE at the link level — the 400/800/
// XL/XE/XEGS lineage shares one memory map and one DOS-compatible .XEX
// loader format (mos-atari8-dos-clang), so a profile only changes which
// driver/output-format is used (XEGS profile → cartridge ROM) and which
// atari800 machine model `8bs run` launches. 800XL is the reference/default
// profile: it's the machine most Atari homebrew targets today, and 65XE is
// its later, electrically-identical cost-reduced sibling (same OS, same
// driver). 130XE's extra 64K is bank-switched extended memory reached via
// PORTB ($D301), outside the linear address space the linker allocates
// into, so it needs no special linker flags either — a program that never
// touches banking builds identically on all five DOS-format profiles.
const ATARI8_PROFILES = new Set(['800xl', '65xe', '130xe', '800', '400', 'xegs']);
const ATARI8_DEFAULT_PROFILE = '800xl';

// VIC-20 RAM-expansion hardware profiles. The SDK's own link.ld (mos-
// platform/vic20/lib/link.ld) accepts exactly these five __memory_expansion
// values (0/3/8/16/24, in KB) and ASSERTs on anything else, so this set is
// copied from there rather than invented; the same five numbers are also
// exactly what VICE's `xvic -memory` accepts (none/3k/8k/16k/24k — see
// VIC20_MEMORY_ARG below). 'unexpanded' is the default and the machine
// 8BitScript has targeted since Phase 1: load address $1001, 3583 bytes free
// — the VIC-20 as sold, with no expansion cartridge plugged in.
//
// KNOWN GAP: @8bitscript/vic20's `screen` namespace pokes screen memory at a
// hardcoded $1E00 (the unexpanded/'3k' location — the 3K block at
// $0400-$0FFF doesn't reach $1E00, so screen memory doesn't move for it).
// On real hardware and VICE, an 8k/16k/24k VIC-20 relocates the default
// screen matrix to $1000 instead, to reclaim $1000-$1FFF as contiguous
// BASIC RAM. This target has no compile-time way yet to make one shared
// index.8bs branch on which profile it's being built for (see docs/roadmap.md
// — target predicates are a Phase 1 language feature still to build), so
// @8bitscript/vic20's `screen` namespace is not updated for those three
// profiles: use them for programs that only need more RAM for their own
// code/data (or that talk to `vicColor`/`screen.setColors` directly,
// which stays at $900F regardless of expansion), not ones that also call
// `text.putChar`/`putColor` — that would misdraw on real 8k+ hardware.
const VIC20_PROFILES = new Set(['unexpanded', '3k', '8k', '16k', '24k']);
const VIC20_DEFAULT_PROFILE = 'unexpanded';
const VIC20_MEMORY_EXPANSION = {
  unexpanded: 0, '3k': 3, '8k': 8, '16k': 16, '24k': 24,
};

// C64 RAM Expansion Unit sizes VICE's x64sc accepts via `-reusize` (128 KiB
// through 16 MiB — confirmed against `x64sc -help`). Unlike the VIC-20
// profiles above, attaching a REU changes nothing about the base C64 memory
// map or where a program's own code/data lives — a REU is a DMA peripheral
// reached through eight registers at $DF00-$DF0A (see @8bitscript/c64's `reu`
// namespace), not a relocation of RAM the linker needs to know about — so
// there is no linker flag here, only the emulator flag in run.mjs and the
// registers being real. 'stock' (no REU) is the default.
const C64_PROFILES = new Set([
  'stock', 'reu128', 'reu256', 'reu512', 'reu1m', 'reu2m', 'reu4m', 'reu8m', 'reu16m',
]);
const C64_DEFAULT_PROFILE = 'stock';
// KiB for `-reusize`, keyed by the profile names above (without the leading
// 'reu' and 'm'/no-suffix distinction spelled out again).
const C64_REU_SIZE_KIB = {
  reu128: 128, reu256: 256, reu512: 512, reu1m: 1024, reu2m: 2048, reu4m: 4096, reu8m: 8192, reu16m: 16384,
};

function driverFor(machine, atari8Profile) {
  if (machine === 'atari8') {
    return atari8Profile === 'xegs' ? 'mos-atari8-cart-xegs-clang' : 'mos-atari8-dos-clang';
  }
  return DRIVER[machine];
}

// The file extension the linker actually produces. Every Commodore/CX16/
// MEGA65 target keeps the traditional .prg (a 2-byte load address header
// the KERNAL's LOAD understands); NES cartridges are .nes (an iNES header
// + PRG/CHR banks); Atari DOS-format output is .xex (Atari DOS's own
// loader format), except the XEGS profile, which links a cartridge ROM
// image instead.
export function outputExtension(machine, atari8Profile) {
  if (machine === 'nes') return 'nes';
  if (machine === 'atari8') return atari8Profile === 'xegs' ? 'rom' : 'xex';
  return 'prg';
}

// Per-machine compile flags.
//
// The SDK's vic20 linker script defaults to a machine with 24K of RAM
// expansion (programs load at $1201). 8BitScript targets the UNEXPANDED
// VIC-20 by default — 3583 bytes, load address $1001, the machine as sold —
// but `--profile` (VIC20_PROFILES above) can pick 3k/8k/16k/24k instead, so
// vic20's __memory_expansion flag is computed in buildPrg() below rather than
// pinned here.
//
// The PET linker script instead exposes __ram_size (8/16/32, in KiB — see
// mos-platform/pet/link.ld), because unlike the VIC-20's expansion port a
// PET's RAM size changes where the top of memory (and so the stack) sits.
// Pinned to 32 (the common 32K PET) for the same reason the VIC-20 defaults
// unexpanded: it's the machine most surviving PETs and emulator defaults
// actually are.
const MACHINE_FLAGS = {
  vic20: [],
  c64: [],
  pet: ['-Wl,--defsym=__ram_size=32'],
  c128: [],
  mega65: [],
  cx16: [],
  nes: [],
  atari8: [],
};

// ---- waitFrame() pacing ----------------------------------------------------
//
// One hardware frame is NOT 1/60th of a second, and the machines don't even
// agree with each other or with the web host, which paces waitFrame() at a
// genuine fixed rate of real time (packages/cli/src/web-runtime.mjs). Tying
// waitFrame() 1:1 to vblank drifts a target away from that reference
// forever, so every machine below runs the same fixed-point scheme: an
// accumulator of *logical* frames owed — at whatever rate the project is
// configured for (`frameRate`, default 60; see 8bs.config.ts), the same rate
// on every target. `__8bs_wait_frame()` waits hardware frames, adding `num`
// per frame, until at least `den` is owed, then takes `den` off — so one
// hardware frame can satisfy 0, 1, or 2 waitFrame() calls, and the long-run
// rate is exactly `frameRate` logical frames per emulated second, by
// construction, with nothing ever rounded. All in a uint32 (values stay
// comfortably under 2^32 for any sane configured rate; emitC() rejects an
// implausibly large one rather than let it silently overflow). The tables
// below hold one raw hardware-frame period each, unscaled; the configured
// `frameRate` is multiplied in at emit time.
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
const FRAME_SYNC = {
  // The video chip's raster line, read as a plain memory location — no IRQ,
  // no interrupt vector, just a byte (or two) that count scanlines and wrap
  // once a frame. This is what `__8bs_wait_frame()` polls to find the
  // top of each frame — self-correcting, with no calibrated delay constant
  // to get wrong or to need a separate value per region. `topHalf` is a C
  // boolean expression, true exactly when the raster is in the TOP HALF of
  // the frame. Not "at line 0": the loop detects a new frame by seeing the
  // condition go false (raster in the bottom half) and then true again,
  // which happens at the wrap to line 0 and nowhere else, since the raster
  // only counts up. A narrow at-line-0 window — the obvious check, and what
  // this used to be — loses whole frames: the KERNAL's timer IRQ is still
  // running, it is not raster-synced, and its handler runs longer than the
  // ~65-130 cycles lines 0-1 last, so every time its phase drifts across
  // the top of the frame the polling loop sits inside the handler while the
  // window passes by, unobserved. Not hypothetical: measured under VICE
  // (remote monitor + cycle stopwatch) the narrow window lost ~0.08% of
  // frames — 59.95Hz out of an exact-by-construction 60 — and the
  // half-frame window measured 60.0000. An IRQ can still delay *noticing*
  // the wrap by its handler's length, but a half-frame window (thousands of
  // cycles) means it can never hide the wrap entirely, so the error is
  // bounded jitter, never a lost frame.
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
    // divisor (the configured `frameRate` is multiplied in at emit time),
    // den = crystalHz — an exact integer fraction, not a rounded decimal.
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
    // why $D012 comes first (C evaluates && left to right, and both reads
    // are volatile, so the compiler must keep that order): reading $D011
    // first opens a race — bit 7 still clear at line 255, then $D012
    // already wrapped to 0 at line 256 — that fakes a top-half reading at
    // line 256. Reading $D012 first closes it.
    topHalf: '(*(volatile uint8_t *)0xD012) < 128 && ((*(volatile uint8_t *)0xD011) & 0x80) == 0',
    // An NTSC C64 never shows $D012 >= 32 while $D011 bit 7 is set (it
    // tops out at line 262, $D012 == 6); a PAL one reaches line 311
    // ($D012 == 55).
    palProbe: '((*(volatile uint8_t *)0xD011) & 0x80) != 0 && (*(volatile uint8_t *)0xD012) >= 32',
    ntsc: { num: 263 * 65 * 14, den: 14318181 },
    pal: { num: 312 * 63 * 18, den: 17734472 },
  },
  // The C128's VIC-IIe is register-compatible with the C64's VIC-II for
  // $D011/$D012 — confirmed directly against llvm-mos-sdk's own c128.h,
  // which maps the C128's VIC at $D000 using the identical __vic2 struct
  // the c64 platform uses. Same registers, same reasoning, same numbers.
  c128: {
    kind: 'level',
    topHalf: '(*(volatile uint8_t *)0xD012) < 128 && ((*(volatile uint8_t *)0xD011) & 0x80) == 0',
    palProbe: '((*(volatile uint8_t *)0xD011) & 0x80) != 0 && (*(volatile uint8_t *)0xD012) >= 32',
    ntsc: { num: 263 * 65 * 14, den: 14318181 },
    pal: { num: 312 * 63 * 18, den: 17734472 },
  },
  // The MEGA65's VIC-IV exposes a VIC-II-compatible register view at
  // $D000 for exactly this reason — confirmed against llvm-mos-sdk's
  // mega65.h, which defines VICII as a __vic2 struct at the same address.
  // A PRG launched the ordinary way (SYS, no unlock sequence for the
  // VIC-IV's extended raster bits or the 40MHz CPU mode) boots into that
  // C64-compatible view and clock, so this reuses the C64 entry verbatim.
  // A program that switches the MEGA65 into its native enhanced modes is
  // outside what this target supports.
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
  pet: {
    kind: 'edge',
    pollFlag: '(*(volatile uint8_t *)0xE813) & 0x80',
    ack: '(void)(*(volatile uint8_t *)0xE812);',
    presync: '__asm__ volatile("sei" ::: "memory");',
    // A function of the configured `frameRate`, not a plain string: unlike
    // every other machine here, the PET's num/den pair is computed from a
    // runtime measurement (`__8bs_elapsed`), not a compile-time constant, so
    // scaling by the configured rate has to happen inside the emitted C
    // itself rather than being multiplied in once at emit time.
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
  // the 1:1 ratio folds away entirely (see isOneToOne). `num`/`den` here is
  // 1/60, not 1/1: real hardware fires at a fixed ~60Hz regardless of the
  // configured `frameRate`, so at any other rate the accumulator (fed
  // `frameRate * num`) scales between the two.
  // `presync` disables interrupts in case the KERNAL's own jiffy clock also
  // services this flag, the same risk PET's does.
  cx16: {
    kind: 'edge',
    pollFlag: '(*(volatile uint8_t *)0x9F27) & 0x01',
    ack: '*(volatile uint8_t *)0x9F27 = 0x01;',
    presync: '__asm__ volatile("sei" ::: "memory");',
    num: 1,
    den: 60,
  },
};

// `memory.read`/`memory.write` cast a runtime address to a byte pointer and
// dereference it, `volatile` because the address is not known at compile
// time — it may well be a hardware register, and the compiler has no way to
// tell, so it gets the same protection an `@address` global gets.
function emitExpression(expr) {
  switch (expr.kind) {
    case 'const': return String(expr.value);
    case 'ref': return expr.name;
    case 'binop':
      return `(${emitExpression(expr.left)} ${expr.operator} ${emitExpression(expr.right)})`;
    case 'unop':
      return `(${expr.operator}${emitExpression(expr.argument)})`;
    case 'call':
      return `${expr.name}(${expr.args.map(emitExpression).join(', ')})`;
    case 'memoryRead':
      return `(*(volatile uint8_t *)${emitExpression(expr.address)})`;
    default:
      throw new Error(`backend-6502: unknown IR expression '${expr.kind}'`);
  }
}

function emitStatement(statement, indent) {
  const pad = '    '.repeat(indent);
  switch (statement.kind) {
    case 'assign':
      return `${pad}${statement.target} = ${emitExpression(statement.value)};\n`;
    case 'call':
      return `${pad}${statement.name}(${statement.args.map(emitExpression).join(', ')});\n`;
    case 'waitFrame':
      // The frame-sync runtime emitted by emitFrameRuntime(), present exactly
      // when a program contains at least one of these.
      return `${pad}__8bs_wait_frame();\n`;
    case 'memoryWrite':
      return `${pad}*(volatile uint8_t *)${emitExpression(statement.address)} = ${emitExpression(statement.value)};\n`;
    case 'memoryRead':
      // Only reachable as a bare statement; the byte read is discarded.
      return `${pad}${emitExpression(statement)};\n`;
    case 'if': {
      let out = `${pad}if (${emitExpression(statement.test)}) {\n`;
      out += statement.then.map((s) => emitStatement(s, indent + 1)).join('');
      if (statement.else) {
        out += `${pad}} else {\n`;
        out += statement.else.map((s) => emitStatement(s, indent + 1)).join('');
      }
      return `${out}${pad}}\n`;
    }
    case 'while': {
      let out = `${pad}while (${emitExpression(statement.test)}) {\n`;
      out += statement.body.map((s) => emitStatement(s, indent + 1)).join('');
      return `${out}${pad}}\n`;
    }
    case 'block': {
      let out = `${pad}{\n`;
      out += statement.body.map((s) => emitStatement(s, indent + 1)).join('');
      return `${out}${pad}}\n`;
    }
    case 'return':
      return statement.value ? `${pad}return ${emitExpression(statement.value)};\n` : `${pad}return;\n`;
    case 'break': return `${pad}break;\n`;
    case 'continue': return `${pad}continue;\n`;
    case 'asm':
      // Inline 6502, held verbatim since the lexer. LLVM-MOS accepts GNU-style
      // asm statements; the body's own newlines are preserved.
      return `${pad}__asm__ volatile(\n${statement.text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `${pad}    "${line.replace(/"/g, '\\"')}\\n"`)
        .join('\n')}\n${pad});\n`;
    default:
      throw new Error(`backend-6502: unknown IR statement '${statement.kind}'`);
  }
}

// "Wait for one hardware frame to pass", as C, per FRAME_SYNC kind. For a
// 'level' machine: wait for the raster to reach the BOTTOM half of the frame
// before waiting for it to wrap back into the top half — without that first
// wait, a caller cheap enough to come back while the raster is still in the
// top half would see "already there" and not actually have waited a frame.
// For an 'edge' machine the flag latches, so it's just "poll, then ack".
// `body` is C spliced into the wrap-wait (the level machines' region probe).
function waitOneHardwareFrame(sync, pad, body = '') {
  if (sync.kind === 'level') {
    return `${pad}while (${sync.topHalf}) {}\n`
      + `${pad}while (!(${sync.topHalf})) {${body}}\n`;
  }
  return `${pad}while (!(${sync.pollFlag})) {}\n`
    + (sync.ack ? `${pad}${sync.ack}\n` : '');
}

// Whether a machine's logical-to-hardware ratio is exactly 1:1 at this
// frameRate — known at emit time only for an 'edge' machine with a fixed
// num/den (cx16 at the default 60). Then there is nothing to accumulate:
// waitFrame() is one hardware frame, and the runtime is just the poll.
// Level machines choose num/den at runtime (the region probe) and the PET
// measures its own, so neither can fold.
function isOneToOne(sync, frameRate) {
  return sync.kind === 'edge' && !sync.calibrate && frameRate * sync.num === sync.den;
}

// Whether num/den are compile-time constants — an 'edge' machine without a
// runtime calibration. Then they are #defines, not variables: two fewer
// uint32s in RAM and no stores at startup. Level machines (runtime region
// probe) and the PET (runtime measurement) need real variables.
function hasConstantRatio(sync) {
  return sync.kind === 'edge' && !sync.calibrate;
}

// The frame-sync runtime: `__8bs_wait_frame()` and whatever state it needs.
// Emitted only when the program calls waitFrame() at least once — a program
// that never does pays nothing for any of this.
function emitFrameRuntime(sync, frameRate) {
  let out = '';
  if (isOneToOne(sync, frameRate)) {
    out += 'static void __8bs_wait_frame(void) {\n';
    out += waitOneHardwareFrame(sync, '    ');
    out += '}\n\n';
    return out;
  }
  if (hasConstantRatio(sync)) {
    out += `#define __8bs_num ${frameRate * sync.num}u\n`;
    out += `#define __8bs_den ${sync.den}u\n`;
  } else {
    out += 'static uint32_t __8bs_num, __8bs_den;\n';
  }
  out += 'static uint32_t __8bs_acc;\n';
  out += 'static void __8bs_wait_frame(void) {\n';
  out += '    while (__8bs_acc < __8bs_den) {\n';
  out += waitOneHardwareFrame(sync, '        ');
  out += '        __8bs_acc += __8bs_num;\n';
  out += '    }\n';
  out += '    __8bs_acc -= __8bs_den;\n';
  out += '}\n\n';
  return out;
}

// What runs once, before the entry function, when the program uses
// waitFrame(): pick (or measure) num/den, and sync to a frame boundary so
// the first waitFrame() waits a whole frame rather than the tail of one.
function emitFramePrologue(sync, frameRate) {
  let out = '';
  if (sync.kind === 'level') {
    out += waitOneHardwareFrame(sync, '    ');
    out += `    __8bs_num = ${frameRate * sync.ntsc.num}u;\n`;
    out += `    __8bs_den = ${sync.ntsc.den}u;\n`;
    // Region sweep: sync to the top of a frame, then watch one whole frame
    // go by; only a PAL raster ever reaches the probe line. Costs two
    // frames at startup, once.
    out += waitOneHardwareFrame(
      sync, '    ',
      ` if (${sync.palProbe}) { __8bs_num = ${frameRate * sync.pal.num}u; __8bs_den = ${sync.pal.den}u; } `,
    );
    return out;
  }
  if (sync.presync) out += `    ${sync.presync}\n`;
  if (sync.calibrate) {
    // Measures num/den itself and ends synced to a frame edge.
    out += `${sync.calibrate(frameRate)}\n`;
    return out;
  }
  out += waitOneHardwareFrame(sync, '    ');
  return out;
}

/** Every statement in every function, nested ones included. */
function forEachStatement(functions, visit) {
  const walkBody = (body) => {
    for (const s of body) {
      visit(s);
      if (s.kind === 'if') { walkBody(s.then); if (s.else) walkBody(s.else); }
      else if (s.kind === 'while' || s.kind === 'block') walkBody(s.body);
    }
  };
  for (const fn of functions) walkBody(fn.body);
}

// The tightest FRAME_SYNC entry (c64/c128/mega65 PAL: num = 312*63*18 =
// 353808) overflows uint32_t once frameRate * num exceeds 2^32 — around
// frameRate ~12,147 for that entry. This cap is comfortably below that for
// every table entry, so a mistyped config value (`frameRate: 6000`) fails
// the build loudly instead of silently producing a wrong-rate binary.
const MAX_FRAME_RATE = 1000;

/**
 * Generate the C translation unit for an IR program.
 *
 * @param {object} ir
 * @param {{ machine?: keyof typeof FRAME_SYNC, frameRate?: number }} [options]
 *   Both matter only when the program calls waitFrame(): `machine` picks the
 *   frame-sync strategy, `frameRate` is the logical Hz waitFrame() runs at
 *   (default 60, see 8bs.config.ts).
 */
export function emitC(ir, { machine, frameRate = 60 } = {}) {
  let out = '/* Generated by 8bs. Do not edit: the source of truth is the .8bs file. */\n';
  out += '#include <stdint.h>\n\n';

  for (const g of ir.globals) {
    const type = C_TYPE[g.type];
    if (g.address !== null) {
      // A hardware register: a name for a fixed location, not storage.
      out += `#define ${g.name} (*(volatile ${type} *)0x${g.address.toString(16).toUpperCase()})\n`;
    } else {
      out += `${g.volatile ? 'volatile ' : ''}${type} ${g.name} = ${g.init};\n`;
    }
  }
  out += '\n';

  // The program is its entry function (the entry module's one export — see
  // the linker's checkEntryExports and the compiler's entryOf), called once
  // from a synthesised C `main`. There is no other convention: a program
  // that runs forever loops itself, calling waitFrame() each pass, and one
  // that finishes returns. The frame-sync runtime exists exactly when
  // waitFrame() is used somewhere — the machine and rate only matter then.
  const entry = entryOf(ir);
  let usesWaitFrame = false;
  let asmText = '';
  forEachStatement(ir.functions, (s) => {
    if (s.kind === 'waitFrame') usesWaitFrame = true;
    if (s.kind === 'asm') asmText += `${s.text}\n`;
  });

  let sync = null;
  if (usesWaitFrame) {
    sync = FRAME_SYNC[machine];
    if (sync === undefined) {
      throw new Error(`backend-6502: a program that calls waitFrame() needs a known machine to pace it, got '${machine}'`);
    }
    if (!Number.isInteger(frameRate) || frameRate <= 0 || frameRate > MAX_FRAME_RATE) {
      throw new Error(`backend-6502: frameRate must be a positive integer no greater than ${MAX_FRAME_RATE}, got ${frameRate}`);
    }
    out += emitFrameRuntime(sync, frameRate);
  }

  // Every user function is `static`: this is one translation unit, so LLVM
  // can inline a single-call function (the entry, above all) and drop a dead
  // one. The exception is a function an asm6502 block names — LLVM does not
  // read inline-assembly text, so it would see no caller and remove it,
  // then fail to link. `main` is C's own entry point, so a user function by
  // that name (the usual name for the entry) gets a prefix.
  const cName = (name) => (name === 'main' ? '__8bs_main' : name);
  const namedInAsm = (name) => new RegExp(`\\b${name}\\b`).test(asmText);
  const signature = (fn) => `${namedInAsm(fn.name) ? '' : 'static '}${
    fn.returnType === 'void' ? 'void' : C_TYPE[fn.returnType]} ${cName(fn.name)}(${
    fn.params.length ? fn.params.map((p) => `${C_TYPE[p.type]} ${p.name}`).join(', ') : 'void'
  })`;

  // Prototypes before any definition: the linker puts the entry module's
  // functions first, so one may call a function defined below it.
  for (const fn of ir.functions) out += `${signature(fn)};\n`;
  out += '\n';

  for (const fn of ir.functions) {
    out += `${signature(fn)} {\n`;
    out += fn.body.map((s) => emitStatement(s, 1)).join('');
    out += '}\n\n';
  }

  if (entry !== null) {
    out += 'int main(void) {\n';
    if (usesWaitFrame) out += emitFramePrologue(sync, frameRate);
    out += `    ${cName(entry)}();\n`;
    out += '    return 0;\n';
    out += '}\n';
  }

  return out;
}

/**
 * Compile IR to machine code via LLVM-MOS.
 *
 * Region (NTSC/PAL) plays no part here: for the machines with a live raster
 * counter it's a runtime probe generated straight into the C, not a build
 * flag, so the backend only ever needs to know the machine (and, for the
 * Atari 8-bit family, which output profile).
 *
 * @param {object} ir
 * @param {{
 *   machine: keyof typeof DRIVER | 'atari8',
 *   atari8Profile?: string, vic20Profile?: string, c64Profile?: string,
 *   outFile: string, frameRate?: number,
 * }} options
 * @returns {Promise<{ ok: boolean, cFile?: string, error?: string }>}
 */
export async function buildPrg(ir, {
  machine, atari8Profile, vic20Profile, c64Profile, outFile, frameRate = 60,
}) {
  if (ir.imports?.length) {
    // Unresolved imports mean the caller skipped the linker. Refusing here is
    // what keeps a lower→backend shortcut from silently dropping modules.
    return { ok: false, error: 'the IR still has unresolved imports: link() it before the backend' };
  }
  const profile = atari8Profile ?? ATARI8_DEFAULT_PROFILE;
  if (machine === 'atari8' && !ATARI8_PROFILES.has(profile)) {
    return {
      ok: false,
      error: `backend-6502: unknown atari8 profile '${profile}' (expected one of ${[...ATARI8_PROFILES].join(', ')})`,
    };
  }
  const vic20ProfileResolved = vic20Profile ?? VIC20_DEFAULT_PROFILE;
  if (machine === 'vic20' && !VIC20_PROFILES.has(vic20ProfileResolved)) {
    return {
      ok: false,
      error: `backend-6502: unknown vic20 profile '${vic20ProfileResolved}' (expected one of ${[...VIC20_PROFILES].join(', ')})`,
    };
  }
  const c64ProfileResolved = c64Profile ?? C64_DEFAULT_PROFILE;
  if (machine === 'c64' && !C64_PROFILES.has(c64ProfileResolved)) {
    return {
      ok: false,
      error: `backend-6502: unknown c64 profile '${c64ProfileResolved}' (expected one of ${[...C64_PROFILES].join(', ')})`,
    };
  }
  const driverName = driverFor(machine, profile);
  if (!driverName) return { ok: false, error: `backend-6502 has no driver for machine '${machine}'` };

  const home = process.env.LLVM_MOS_HOME;
  if (!home) {
    return {
      ok: false,
      error: "LLVM_MOS_HOME is not set. Run '8bs doctor' — docs/setup/llvm-mos.md covers the install.",
    };
  }
  const driver = join(home, 'bin', driverName);
  if (!existsSync(driver)) {
    return { ok: false, error: `${driver} does not exist. Run '8bs doctor'.` };
  }

  const cFile = outFile.replace(/\.(prg|xex|rom|nes)$/, '.c');
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(cFile, emitC(ir, { machine, frameRate }), 'utf8');

  // c64 has no per-profile linker flag (see C64_PROFILES above) — only vic20
  // computes one, from whichever RAM-expansion profile was resolved.
  const machineFlags = machine === 'vic20'
    ? [`-Wl,--defsym=__memory_expansion=${VIC20_MEMORY_EXPANSION[vic20ProfileResolved]}`]
    : (MACHINE_FLAGS[machine] ?? []);

  // A package's "8bitscript".native files ride along after the generated C,
  // untouched: the clang driver assembles a .s and links the object like any
  // other input. @8bitscript/nes's CHR-ROM font is the first — data that
  // lands in the .nes image's CHR bank through the SDK's `.chr_rom` linker
  // section, which no construct in the generated C could reach.
  const nativeSources = ir.nativeSources ?? [];

  return new Promise((resolvePromise) => {
    const child = spawn(
      driver,
      ['-Os', ...machineFlags, '-o', outFile, cFile, ...nativeSources],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      resolvePromise(code === 0
        ? { ok: true, cFile }
        : { ok: false, cFile, error: `${driverName} failed:\n${stderr}` });
    });
  });
}

export {
  ATARI8_PROFILES, ATARI8_DEFAULT_PROFILE,
  VIC20_PROFILES, VIC20_DEFAULT_PROFILE,
  C64_PROFILES, C64_DEFAULT_PROFILE, C64_REU_SIZE_KIB,
};
