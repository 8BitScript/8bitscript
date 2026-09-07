// The 6502 backend: IR in, machine code out.
//
// It emits C rather than assembly, on purpose: LLVM-MOS does register
// allocation, zero-page allocation, and instruction selection better than a
// first-generation backend would, so the work here is a faithful translation
// of the IR and nothing more. The generated C is deliberately boring — every
// construct maps one-to-one, so reading it against the source is easy.
import { spawn, execFile } from 'node:child_process';
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
// Bytes a variable of each type takes on the machine — what the zero-page
// budget below is counted in.
const C_SIZE = Object.fromEntries(
  PRIMITIVE_INTEGER_TYPES.map((t) => [t.canonicalName, NATIVE_WIDTH[t.bits] / 8]),
);
C_SIZE.bool = 1;
// A string value is a pointer to its constant, length-prefixed bytes (see
// the compiler's IR notes on strings); the bytes themselves are emitted as
// `static const` tables, which LLVM-MOS places in read-only data — PRG-ROM
// on a cartridge, part of the .prg on a Commodore.
C_TYPE.string = 'const uint8_t *';
// An array parameter is the array's address, not a copy: `t: array<u8, 4>`
// is `const uint8_t *t`, and C's own array-to-pointer decay means the call
// site passes the name and nothing is copied. Read-only, which is what the
// language allows through a parameter today — an element is read, never
// assigned through. The length is in the type, so it never travels.
const paramCType = (p) => (p.type === 'array' ? `const ${C_TYPE[p.elementType]} *` : C_TYPE[p.type]);

const stringName = (index) => `__8bs_str_${index}`;

// llvm-mos-sdk ships one driver binary per platform, confirmed against its
// own mos-platform/ tree (github.com/llvm-mos/llvm-mos-sdk). These are the
// stock drivers; a hardware value may name another (the Atari XEGS
// cartridge driver, an NES mapper's) through its catalog `build.driver` —
// see driverFor() below.
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
  atari8: 'mos-atari8-dos-clang',
};

// What a build's hardware changes here is read from the resolved hardware
// the CLI hands buildPrg() (packages/cli/src/hardware.mjs, from each
// machine package's "8bitscript".hardware catalog): `defsym` symbols for
// the SDK's link script (a VIC-20's `__memory_expansion`, a PET's
// `__ram_size` — both names the SDK's own link.ld provides and asserts
// on), an alternative `driver` (the Atari XEGS cartridge build), and the
// `output` extension that goes with it. Nothing about a particular
// machine's options is spelled here any more.

// The machines whose LLVM-MOS platform is built on the Commodore KERNAL
// (mos-platform/commodore, shared by these five) — and so whose libc carries
// the start-up character-set switch commodoreCharsetGuard() keeps out. The
// X16 is a Commodore-style KERNAL too, but its own platform switches to ISO
// mode instead, which @8bitscript/cx16/text relies on; it is not in this set.
const COMMODORE_KERNAL_MACHINES = new Set(['vic20', 'c64', 'pet', 'c128', 'mega65']);

// LLVM-MOS's Commodore libc (mos-platform/commodore/char-conv.c) prints
// PETSCII 14 through the KERNAL's CHROUT before main() — `shift:` in a
// `.init.250` section — switching the machine to its lower-case character
// set for C's stdio. That section lives in the same object as the weak
// `__from_ascii`/`__to_ascii` conversions, and the linker's speculative
// libcall pass extracts that object in every build (abort → fputs →
// stdio-minimal → __to_ascii, confirmed with `--why-extract`), after which
// the KEEP'd init section survives garbage collection even though nothing
// here prints through stdio. So every program used to start with one
// KERNAL call that flipped the character set behind the text packages'
// backs — which is why each of them re-selects the upper-case set on every
// run of text, and why an earlier reading of this project's own binaries
// mistook the switch for the ROM's boot state.
//
// Defining the two conversions here, strong, satisfies the references before
// the archive is searched, so the SDK's object — and its init section — is
// never linked. The bodies pass characters through unchanged: 8bitscript
// programs never use libc stdio, and if one ever did, "no PETSCII
// conversion" is the behaviour this project wants anyway. One documented
// consequence: an `asm6502` block that called libc's own `__putchar` or
// `printf` would now print unconverted ASCII — libc stdio through inline
// assembly is off the map on these targets, by design, not by accident.
// Both bodies are dead after garbage collection, so the guard costs no
// bytes on the machine. The
// machine starts in whatever character set its ROM booted (see
// packages/pet/AGENTS.md: the business PETs boot in lower-case), and the
// text packages select the set they need themselves.
function commodoreCharsetGuard() {
  return '/* Keep LLVM-MOS\'s libc from printing PETSCII 14 (lower-case set) before main():\n'
    + '   defining its weak char-conv symbols here leaves that object, and its .init.250\n'
    + '   section, out of the link. See COMMODORE_KERNAL_MACHINES in backend-6502. */\n'
    + 'int __from_ascii(char c, void *ctx, int (*write)(char c, void *ctx)) { return write(c, ctx); }\n'
    + 'int __to_ascii(void *ctx, int (*read)(void *ctx)) { return read(ctx); }\n\n';
}

function driverFor(machine, hardware) {
  return hardware?.build?.driver ?? DRIVER[machine];
}

// The file extension the linker actually produces. Every Commodore/CX16/
// MEGA65 target keeps the traditional .prg (a 2-byte load address header
// the KERNAL's LOAD understands); NES cartridges are .nes (an iNES header
// + PRG/CHR banks); Atari DOS-format output is .xex (Atari DOS's own
// loader format). A hardware value that links something else says so
// (`build.output`: the XEGS cartridge is a .rom).
export function outputExtension(machine, hardware) {
  if (hardware?.build?.output) return hardware.build.output;
  if (machine === 'nes') return 'nes';
  if (machine === 'atari8') return 'xex';
  return 'prg';
}

// The link symbols that make a build with no hardware named the machine
// as sold: the SDK's vic20 link script defaults to a 24K-expanded machine
// (programs at $1201) and its pet script to 32K, so these pin the
// unexpanded VIC-20 ($1001, 3583 bytes) and the 32K PET. A hardware's own
// `build.defsym` (the catalog's `ram`/`model` values) overrides them.
const STOCK_DEFSYM = {
  vic20: { __memory_expansion: 0 },
  pet: { __ram_size: 32 },
};

// Per-machine compile flags beyond the link symbols; none today.
const MACHINE_FLAGS = {
  vic20: [],
  c64: [],
  pet: [],
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
    presync: '__asm__ volatile("sei" ::: "memory");',
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
  // Which rate a run gets is the model's — the profile `8bs run pet`
  // launches (PET_PROFILES above, PET_MODEL_ARGS in the CLI): the no-CRTC
  // 3xxx at VICE's ~60.1Hz, the CRTC models at their 50Hz editor ROMs
  // (the 60Hz editors make VICE refuse autostart). This measurement is
  // what makes that not matter to the program.
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
  // the 1:1 ratio folds away entirely (see isOneToOne). `num`/`den` here is
  // 1/60, not 1/1: real hardware fires at a fixed ~60Hz regardless of the
  // configured `frameRate`, so at any other rate the accumulator (fed
  // `frameRate * num`) scales between the two.
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
    case 'string':
      return stringName(expr.index);
    case 'stringLength':
      // Byte 0 is the length; the characters follow.
      return `${emitExpression(expr.string)}[0]`;
    case 'stringByte':
      return `${emitExpression(expr.string)}[1 + ${emitExpression(expr.index)}]`;
    case 'index':
      return `${emitExpression(expr.array)}[${emitExpression(expr.index)}]`;
    default:
      throw new Error(`backend-6502: unknown IR expression '${expr.kind}'`);
  }
}

function emitStatement(statement, indent) {
  const pad = '    '.repeat(indent);
  switch (statement.kind) {
    case 'assign':
      return `${pad}${statement.target} = ${emitExpression(statement.value)};\n`;
    case 'storeIndex':
      return `${pad}${emitExpression(statement.array)}[${emitExpression(statement.index)}] = ${emitExpression(statement.value)};\n`;
    case 'local':
      return `${pad}${C_TYPE[statement.type]} ${statement.name} = ${emitExpression(statement.init)};\n`;
    case 'stringCopy':
      return `${pad}__8bs_string_copy(${emitExpression(statement.target)}, ${emitExpression(statement.source)}, ${statement.capacity});\n`;
    case 'for': {
      // The initialiser and update are statements; inside the parentheses
      // they lose their line ending.
      const clause = (s) => (s ? emitStatement(s, 0).trim().replace(/;$/, '') : '');
      let out = `${pad}for (${clause(statement.init)}; ${statement.test ? emitExpression(statement.test) : ''}; ${clause(statement.update)}) {\n`;
      out += statement.body.map((s) => emitStatement(s, indent + 1)).join('');
      return `${out}${pad}}\n`;
    }
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
  // Repeat sei every hardware frame on machines that asked for it: a
  // KERNAL call between waitFrame()s can restore I, and the IRQ would
  // steal the edge this poll is waiting for.
  const lock = sync.presync ? `${pad}${sync.presync}\n` : '';
  if (sync.kind === 'level') {
    return lock
      + `${pad}while (${sync.topHalf}) {}\n`
      + `${pad}while (!(${sync.topHalf})) {${body}}\n`;
  }
  return lock
    + `${pad}while (!(${sync.pollFlag})) {}\n`
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

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Python's Fraction.limit_denominator, on a fraction already in lowest
// terms: the closest p/q to n/d with q <= maxDen, from the continued
// fraction's convergents and the last semiconvergent.
function limitDenominator(n, d, maxDen) {
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
  const bound1 = [p0 + k * p1, q0 + k * q1];
  const bound2 = [p1, q1];
  const err = ([p, q]) => Math.abs(p / q - n / d);
  return err(bound2) <= err(bound1) ? bound2 : bound1;
}

/**
 * The best sixteen-bit stand-in for num/den: `{ num, den, error }` with
 * num + den <= 65535 and `error` the relative difference from the true
 * ratio (0 when it fits as it is).
 */
export function reduceRatio(num, den) {
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

/**
 * The num/den pairs the runtime uses for a machine at a rate, and the C
 * type that holds them: `{ type: 'uint16_t' | 'uint32_t', pairs }` where
 * `pairs` is `{ ntsc, pal }` for a level machine (runtime region probe)
 * or `{ fixed }` for an edge machine with a known ratio. The PET measures
 * its own ratio at startup, so it has no pairs and stays 32-bit.
 */
export function frameRatio(sync, frameRate) {
  if (sync.calibrate) return { type: 'uint32_t', pairs: {} };
  const exact = sync.kind === 'level'
    ? { ntsc: sync.ntsc, pal: sync.pal }
    : { fixed: { num: sync.num, den: sync.den } };
  const reduced = {};
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

// The frame-sync runtime: `__8bs_wait_frame()` and whatever state it needs.
// Emitted only when the program calls waitFrame() at least once — a program
// that never does pays nothing for any of this. The state lives in
// `.zp.noinit` and is set by the prologue in main(), like every other
// variable (see emitC): no start-up code, no copy.
function emitFrameRuntime(sync, frameRate, hook = null) {
  let out = '';
  const edge = (pad) => waitOneHardwareFrame(sync, pad) + (hook ? `${pad}${hook}();\n` : '');
  if (isOneToOne(sync, frameRate)) {
    out += 'static void __8bs_wait_frame(void) {\n';
    out += edge('    ');
    out += '}\n\n';
    return out;
  }
  const ratio = frameRatio(sync, frameRate);
  if (hasConstantRatio(sync)) {
    out += `#define __8bs_num ${ratio.pairs.fixed.num}u\n`;
    out += `#define __8bs_den ${ratio.pairs.fixed.den}u\n`;
  } else {
    out += `static ${ratio.type} __8bs_num __attribute__((section(".zp.noinit.__8bs_num")));\n`;
    out += `static ${ratio.type} __8bs_den __attribute__((section(".zp.noinit.__8bs_den")));\n`;
  }
  out += `static ${ratio.type} __8bs_acc __attribute__((section(".zp.noinit.__8bs_acc")));\n`;
  out += 'static void __8bs_wait_frame(void) {\n';
  out += '    while (__8bs_acc < __8bs_den) {\n';
  out += edge('        ');
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
  // Interrupts off before the first poll, on the machines whose entry asks
  // for it — level drivers included: the C64's reason is not a race on the
  // flag (a raster line is read, not acknowledged) but ownership of CIA1,
  // see FRAME_SYNC.c64.
  if (sync.presync) out += `    ${sync.presync}\n`;
  if (!isOneToOne(sync, frameRate)) out += '    __8bs_acc = 0;\n';
  if (sync.kind === 'level') {
    const { ntsc, pal } = frameRatio(sync, frameRate).pairs;
    out += waitOneHardwareFrame(sync, '    ');
    out += `    __8bs_num = ${ntsc.num}u;\n`;
    out += `    __8bs_den = ${ntsc.den}u;\n`;
    // Region sweep: sync to the top of a frame, then watch one whole frame
    // go by; only a PAL raster ever reaches the probe line. Costs two
    // frames at startup, once.
    out += waitOneHardwareFrame(
      sync, '    ',
      ` if (${sync.palProbe}) { __8bs_num = ${pal.num}u; __8bs_den = ${pal.den}u; } `,
    );
    return out;
  }
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
      else if (s.kind === 'for') { if (s.init) visit(s.init); if (s.update) visit(s.update); walkBody(s.body); }
    }
  };
  for (const fn of functions) walkBody(fn.body);
}

// A mistyped config value (`frameRate: 6000`) fails the build loudly
// instead of silently producing a wrong-rate binary. The cap also keeps
// the exact 32-bit fallback pair in range: the tightest FRAME_SYNC entry
// (c64/c128/mega65 PAL: num = 312*63*18 = 353808) would overflow uint32_t
// once frameRate * num passed 2^32, around frameRate ~12,147.
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
  if (COMMODORE_KERNAL_MACHINES.has(machine)) out += commodoreCharsetGuard();

  // The program is its entry function (the entry module's one export — see
  // the linker's checkEntryExports and the compiler's entryOf), called once
  // from a synthesised C `main`. There is no other convention: a program
  // that runs forever loops itself, calling waitFrame() each pass, and one
  // that finishes returns. The frame-sync runtime exists exactly when
  // waitFrame() is used somewhere — the machine and rate only matter then.
  const entry = entryOf(ir);
  let usesWaitFrame = false;
  let usesStringCopy = false;
  let asmText = '';
  forEachStatement(ir.functions, (s) => {
    if (s.kind === 'waitFrame') usesWaitFrame = true;
    if (s.kind === 'stringCopy') usesStringCopy = true;
    if (s.kind === 'asm') asmText += `${s.text}\n`;
  });

  // ---- where every byte lives ------------------------------------------------
  //
  // Each global names its section, so nothing is left to the SDK's start-up
  // code: a `.data`/`.bss` variable would pull in memcpy and memset and the
  // routines that call them — 130 bytes of program before main() runs — and
  // LLVM-MOS would copy small const tables into zero page, counting data as
  // RAM. Instead:
  //
  //   const arrays, strings   .rodata.<name>   in the program, read in place
  //   let arrays with values  .data.<name>     loaded where they live (a disk
  //                                            or tape image); on a cartridge
  //                                            (NES) the values are a .rodata
  //                                            twin copied by main()
  //   let arrays, no values   .noinit.<name>   RAM, zeroed by main()
  //   scalars                 .zp.noinit.<name> zero page while the budget
  //                                            lasts, then .noinit; main()
  //                                            stores the starting value
  //
  // `noinit` sections are exactly that — the linker drops an initialiser
  // on one silently — so main() begins with the stores below, before the
  // frame prologue and the entry function.
  const section = (name) => `__attribute__((section("${name}")))`;
  const loadsInPlace = machine !== 'nes';
  // Zero page the scalars may take, in bytes: the smallest platform (cx16)
  // has 94 above LLVM-MOS's imaginary registers, and LLVM spills into the
  // same region — 16 bytes in one measured program. 48 leaves it room.
  const ZP_BUDGET = 48;
  let zpBytes = usesWaitFrame ? 6 : 0; // the frame accumulator and its ratio
  const init = [];

  for (const [index, s] of (ir.strings ?? []).entries()) {
    const name = stringName(index);
    out += `static const uint8_t ${name}[] ${section(`.rodata.${name}`)} = { ${[s.bytes.length, ...s.bytes].join(', ')} }; /* "${s.text}" */\n`;
  }
  if (ir.strings?.length) out += '\n';

  for (const g of ir.globals) {
    const type = C_TYPE[g.type];
    if (g.array) {
      const counter = g.array > 255 ? 'uint16_t' : 'uint8_t';
      if (g.address !== null) {
        // N cells of hardware from a fixed location.
        out += `#define ${g.name} ((volatile ${type} *)0x${g.address.toString(16).toUpperCase()})\n`;
      } else if (g.constant) {
        out += `static const ${type} ${g.name}[${g.array}] ${section(`.rodata.${g.name}`)} = { ${g.init.join(', ')} };\n`;
      } else if (g.init && loadsInPlace) {
        out += `${type} ${g.name}[${g.array}] ${section(`.data.${g.name}`)} = { ${g.init.join(', ')} };\n`;
      } else if (g.init) {
        out += `static const ${type} __8bs_init_${g.name}[${g.array}] ${section(`.rodata.__8bs_init_${g.name}`)} = { ${g.init.join(', ')} };\n`;
        out += `${type} ${g.name}[${g.array}] ${section(`.noinit.${g.name}`)};\n`;
        init.push(`for (${counter} i = 0; i < ${g.array}; i++) ${g.name}[i] = __8bs_init_${g.name}[i];`);
      } else {
        out += `${type} ${g.name}[${g.array}] ${section(`.noinit.${g.name}`)};\n`;
        init.push(`for (${counter} i = 0; i < ${g.array}; i++) ${g.name}[i] = 0;`);
      }
      continue;
    }
    if (g.address !== null) {
      // A hardware register: a name for a fixed location, not storage.
      out += `#define ${g.name} (*(volatile ${type} *)0x${g.address.toString(16).toUpperCase()})\n`;
      continue;
    }
    const size = C_SIZE[g.type] ?? 1;
    const zp = zpBytes + size <= ZP_BUDGET;
    if (zp) zpBytes += size;
    out += `${g.volatile ? 'volatile ' : ''}${type} ${g.name} ${section(`${zp ? '.zp' : ''}.noinit.${g.name}`)};\n`;
    init.push(`${g.name} = ${g.init};`);
  }
  out += '\n';
  if (usesStringCopy) {
    // `name = other` on a string<N>: the length byte and then the
    // characters, cut to the capacity. Present exactly when a program
    // assigns a string variable.
    out += 'static void __8bs_string_copy(uint8_t *dst, const uint8_t *src, uint8_t capacity) {\n';
    out += '    uint8_t n = src[0];\n';
    out += '    if (n > capacity) n = capacity;\n';
    out += '    dst[0] = n;\n';
    out += '    for (uint8_t i = 0; i < n; i++) dst[1 + i] = src[1 + i];\n';
    out += '}\n\n';
  }

  let sync = null;
  if (usesWaitFrame) {
    sync = FRAME_SYNC[machine];
    if (sync === undefined) {
      throw new Error(`backend-6502: a program that calls waitFrame() needs a known machine to pace it, got '${machine}'`);
    }
    if (!Number.isInteger(frameRate) || frameRate <= 0 || frameRate > MAX_FRAME_RATE) {
      throw new Error(`backend-6502: frameRate must be a positive integer no greater than ${MAX_FRAME_RATE}, got ${frameRate}`);
    }
    // The machine's frame hook, if this program links the function that
    // is it (FRAME_SYNC.nes.frameHook); the linker keeps a package's own
    // names unless they clash with the entry module's, so the lookup is by
    // the name the package gave it.
    const hook = sync.frameHook && ir.functions.some((fn) => fn.name === sync.frameHook) ? sync.frameHook : null;
    if (hook) out += `static void ${hook}(void);\n`; // defined with the program's functions, below
    out += emitFrameRuntime(sync, frameRate, hook);
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
    fn.params.length ? fn.params.map((p) => `${paramCType(p)} ${p.name}`).join(', ') : 'void'
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
    for (const statement of init) out += `    ${statement}\n`;
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
 * flag, so the backend only ever needs to know the machine and what its
 * hardware asks of the linker.
 *
 * @param {object} ir
 * @param {{
 *   machine: keyof typeof DRIVER,
 *   hardware?: { build?: { defsym?: object, driver?: string, output?: string }, label?: string },
 *   outFile: string, frameRate?: number,
 * }} options `hardware` is the resolved hardware from packages/cli/src/
 *   hardware.mjs (its `build` block is all this reads); none means the
 *   stock machine with the SDK's own link defaults.
 * @returns {Promise<{ ok: boolean, cFile?: string, error?: string }>}
 */
export async function buildPrg(ir, {
  machine, hardware, outFile, frameRate = 60,
}) {
  if (ir.imports?.length) {
    // Unresolved imports mean the caller skipped the linker. Refusing here is
    // what keeps a lower→backend shortcut from silently dropping modules.
    return { ok: false, error: 'the IR still has unresolved imports: link() it before the backend' };
  }
  const driverName = driverFor(machine, hardware);
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

  // The hardware's link symbols, if any: `-Wl,--defsym=NAME=VALUE` each,
  // straight from the catalog value's `build.defsym`.
  const defsym = { ...(STOCK_DEFSYM[machine] ?? {}), ...(hardware?.build?.defsym ?? {}) };
  const machineFlags = [
    ...(MACHINE_FLAGS[machine] ?? []),
    ...Object.entries(defsym).map(([name, value]) => `-Wl,--defsym=${name}=${value}`),
  ];

  // A package's "8bitscript".native files ride along after the generated C,
  // untouched: the clang driver assembles a .s and links the object like any
  // other input. @8bitscript/nes's CHR-ROM font is the first — data that
  // lands in the .nes image's CHR bank through the SDK's `.chr_rom` linker
  // section, which no construct in the generated C could reach.
  const nativeSources = ir.nativeSources ?? [];

  // -fno-builtin: without it LLVM turns main()'s zeroing loops back into
  // the memset call they were written to avoid.
  const compile = (level) => new Promise((resolvePromise) => {
    const child = spawn(
      driver,
      [level, '-fno-builtin', ...machineFlags, '-o', outFile, cFile, ...nativeSources],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      resolvePromise(code === 0
        ? { ok: true, cFile }
        : { ok: false, cFile, error: `${driverName} failed:\n${stderr}`, stderr });
    });
  });

  // Build the program at both of LLVM's size levels and keep whichever came
  // out smaller. Neither wins everywhere — measured over three programs on
  // all eight 6502 targets, `-Oz` was smaller on eighteen and *larger* on
  // six, by as much as 56 bytes — and there is no way to tell which from
  // the source, so the honest answer is to compile it and look. The cost is
  // one more pass of a compiler that takes a fraction of a second; the
  // benefit is that no program is ever built at the worse of the two. See
  // AGENTS.md, "the rule that decides where work happens".
  let built = await compile('-Os');
  let level = '-Os';
  if (built.ok) {
    const first = await measureElf(`${outFile}.elf`);
    const second = await compile('-Oz');
    if (second.ok) {
      const other = await measureElf(`${outFile}.elf`);
      // No measurement (no llvm-size) means no basis to choose: keep -Os,
      // which is what every earlier build of this project used.
      if (first && other && other.program < first.program) {
        level = '-Oz';
      } else {
        built = await compile('-Os');
      }
    }
  }
  if (!built.ok) {
    // The SDK's linker script knows each machine's RAM, and refuses a
    // program that does not fit — the honest limit, stated in the
    // machine's own terms before the raw linker text.
    const overflow = /will not fit in region '(\w+)': overflowed by (\d+) bytes/.exec(built.stderr);
    if (overflow) {
      const fitted = hardware?.label && hardware.label !== 'stock' ? ` (${hardware.label})` : '';
      const region = { ram: 'RAM', zp: 'zero page' }[overflow[1]] ?? overflow[1];
      built.error = `this program needs ${overflow[2]} more bytes of ${region} than the ${machine}${fitted} has. `
        + 'Fewer or smaller variables and arrays, or a const array for data that never changes, brings it down.\n'
        + built.error;
    }
    return built;
  }
  const memory = await measureElf(`${outFile}.elf`);
  return memory ? { ...built, memory, level } : { ...built, level };
}

/**
 * What the linked program actually holds, from the ELF the SDK's linker
 * writes beside the output: `program` is what is loaded or burned (code,
 * constant data, initial values), `variables` is RAM the program's
 * variables take once running (zero-page ones included). Measured with
 * the SDK's own llvm-size, so a variable LLVM dropped for being unread is
 * not counted. Null when the tool is not there.
 *
 * @returns {Promise<{ program: number, variables: number } | null>}
 */
async function measureElf(elfFile) {
  const size = join(process.env.LLVM_MOS_HOME ?? '', 'bin', 'llvm-size');
  if (!process.env.LLVM_MOS_HOME || !existsSync(size)) return null;
  const listing = await new Promise((resolvePromise) => {
    execFile(size, ['-A', elfFile], (error, stdout) => resolvePromise(error ? null : stdout));
  });
  if (!listing) return null;
  const sections = new Map();
  for (const line of listing.split('\n')) {
    const m = /^(\S+)\s+(\d+)\s+\d+$/.exec(line.trim());
    if (m) sections.set(m[1], Number(m[2]));
  }
  const sum = (...names) => names.reduce((n, name) => n + (sections.get(name) ?? 0), 0);
  return {
    program: sum('.basic_header', '.text', '.rodata', '.data', '.zp.data'),
    variables: sum('.data', '.zp.data', '.bss', '.noinit', '.zp.bss', '.zp'),
  };
}

export {
  DRIVER,
  FRAME_SYNC,
};
