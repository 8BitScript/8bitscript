// The 6502 backend: IR in, .prg out.
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

import { PRIMITIVE_INTEGER_TYPES } from '@8bitscript/compiler';

// C has no 24-bit integer, so mediumint/umediumint widen to the next native
// width up. The bits/signedness driving this table come from the compiler's
// own type registry — this file no longer keeps its own copy of what
// `utinyint` (or its `u8` alias) means.
const NATIVE_WIDTH = { 8: 8, 16: 16, 24: 32, 32: 32 };
const C_TYPE = Object.fromEntries(
  PRIMITIVE_INTEGER_TYPES.map((t) => [t.canonicalName, `${t.signed ? 'int' : 'uint'}${NATIVE_WIDTH[t.bits]}_t`]),
);
C_TYPE.bool = 'uint8_t';

const DRIVER = { vic20: 'mos-vic20-clang', c64: 'mos-c64-clang' };

// Per-machine compile flags.
//
// The SDK's vic20 linker script defaults to a machine with 24K of RAM
// expansion (programs load at $1201). 8BitScript targets the UNEXPANDED
// VIC-20 first — 3583 bytes, load address $1001, the machine as sold — so the
// expansion symbol is pinned to 0. Fitting the small machine is the point;
// expanded configurations can become an option once someone actually needs
// one.
const MACHINE_FLAGS = {
  vic20: ['-Wl,--defsym=__memory_expansion=0'],
  c64: [],
};

// The video chip's raster line, read as a plain memory location — no IRQ, no
// interrupt vector, just a byte (or two) that count scanlines and wrap once
// a frame. This is what the frame()-driver loop below polls to find the top
// of each frame — self-correcting, with no calibrated delay constant to get
// wrong or to need a separate value per region. Each entry is a C boolean
// expression, true exactly when the raster is in the TOP HALF of the frame.
// Not "at line 0": the loop detects a new frame by seeing the condition go
// false (raster in the bottom half) and then true again, which happens at
// the wrap to line 0 and nowhere else, since the raster only counts up. A
// narrow at-line-0 window — the obvious check, and what this used to be —
// loses whole frames: the KERNAL's timer IRQ is still running, it is not
// raster-synced, and its handler runs longer than the ~65-130 cycles lines
// 0-1 last, so every time its phase drifts across the top of the frame the
// polling loop sits inside the handler while the window passes by,
// unobserved. Not hypothetical: measured under VICE (remote monitor +
// cycle stopwatch) the narrow window lost ~0.08% of frames — 59.95Hz out
// of an exact-by-construction 60 — and the half-frame window measured
// 60.0000. An IRQ can still delay *noticing* the wrap by its handler's
// length, but a half-frame window (thousands of cycles) means it can never
// hide the wrap entirely, so the error is bounded jitter, never a lost
// frame.
//
// C64 (VIC-II): $D012 holds the raster line's low 8 bits, wrapping at 256 —
// but the C64 has 312 lines (PAL) or 263 (NTSC), both *past* 256, so $D012
// alone reads low not only in the top half of the frame but *again* from
// line 256 on. An earlier at-line-0 version of this check learned that the
// hard way — $D012==0 alone fired twice a frame, measured under VICE at
// almost exactly 2x the intended rate. $D011 bit 7 is the missing 9th bit
// (https://www.c64-wiki.com/wiki/VIC); requiring it clear rules out the
// 256+ lines. The read ORDER matters too, which is why $D012 comes first
// in the expression (C evaluates && left to right, and both reads are
// volatile, so the compiler must keep that order): the two registers can't
// be read in the same cycle, and reading $D011 first opens a race — bit 7
// still clear at line 255, then $D012 already wrapped to 0 at line 256 —
// that fakes a top-half reading at line 256. Reading $D012 first closes
// it: a small $D012 followed by "bit 7 set" is correctly rejected, and if
// the frame wraps between the two reads, the raster really is at the top.
//
// VIC-20 (VIC-I): a different, non-obvious layout — not inferred from the
// C64's. $9004 holds bits 8-1 of the 9-bit raster counter and only changes
// every *second* line; the counter's own bit 0 lives by itself in $9003 bit
// 7. Its own range tops out around 130 (NTSC) or 155 (PAL) — nowhere near
// an 8-bit wraparound — so there is no line-256-style aliasing to guard
// against, no 9th bit is needed, and one atomic byte read decides the
// half. ($9004 < 64 is lines 0-127 on both regions.)
// (https://github.com/cbmeeks/VIC-20/blob/master/6561.txt, registers CR3/CR4)
const RASTER_IN_TOP_HALF = {
  vic20: '(*(volatile uint8_t *)0x9004) < 64',
  c64: '(*(volatile uint8_t *)0xD012) < 128 && ((*(volatile uint8_t *)0xD011) & 0x80) == 0',
};

// One hardware frame is NOT 1/60th of a second, and the machines don't even
// agree with each other: the video chips draw a different number of raster
// lines per frame, so "once per vertical blank" means 59.826Hz on an NTSC
// C64 (263 lines x 65 cycles), 60.286Hz on an NTSC VIC-20 (261 x 65),
// 50.125Hz / 50.036Hz on their PAL versions — while the web host runs
// frame() at a genuine 60Hz of real time (packages/cli/src/web-runtime.mjs).
// Tying frame() 1:1 to vblank therefore drifts the targets apart by about a
// frame every couple of seconds, visibly, forever. So the driver loop below
// does exactly what the web host does: it still waits for the raster (that
// part keeps screen updates inside the blank and needs no calibration), but
// it runs frame() 0, 1, or 2 times per hardware frame, draining a
// fixed-point accumulator of *logical* 60Hz frames owed.
//
// The bookkeeping is exact, not approximate. Each hardware frame lasts
// cyclesPerFrame / cpuHz seconds, and both numbers are known rationals: the
// CPU clock is the video crystal divided by a small integer (NTSC C64 and
// VIC-20: 14318181Hz/14 — the same clock, which is why only the line counts
// differ; PAL C64: 17734472Hz/18; PAL VIC-20: 4433618Hz/4). So the logical
// frames owed per hardware frame, 60 * cyclesPerFrame / cpuHz, is the exact
// integer fraction num/den with num = 60 * cyclesPerFrame * divisor and
// den = crystalHz. The loop keeps `acc += num; while (acc >= den) frame();`
// in a uint32 (values stay under 2^25) and the remainder carries over, so
// nothing is ever rounded and the long-run rate is exactly 60 logical
// frames per emulated second on every machine, both regions — the drift
// against the web target is zero by construction, not merely small.
//
// NTSC vs PAL changes the constants but stays out of codegen, same as ever
// (region is a VICE run-time flag, not a build flag): the loop picks the
// pair at startup by watching one full frame and checking how far down the
// raster counter gets. The bottom lines only exist on PAL — an NTSC C64
// never shows $D012 >= 32 while $D011 bit 7 is set (it tops out at line
// 262, $D012 == 6), a PAL one reaches line 311 ($D012 == 55); an NTSC
// VIC-20 never shows $9004 >= 140 (tops out at 130), a PAL one reaches 155.
const FRAME_PACING = {
  vic20: {
    palProbe: '(*(volatile uint8_t *)0x9004) >= 140',
    ntsc: { num: 60 * 261 * 65 * 14, den: 14318181 },
    pal: { num: 60 * 312 * 71 * 4, den: 4433618 },
  },
  c64: {
    palProbe: '((*(volatile uint8_t *)0xD011) & 0x80) != 0 && (*(volatile uint8_t *)0xD012) >= 32',
    ntsc: { num: 60 * 263 * 65 * 14, den: 14318181 },
    pal: { num: 60 * 312 * 63 * 18, den: 17734472 },
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

/**
 * Generate the C translation unit for an IR program.
 *
 * @param {object} ir
 * @param {{ machine?: 'vic20'|'c64' }} [options] Required when the module
 *   exports `frame` — the frame()-driver loop needs to know which raster
 *   register to poll. Unused otherwise.
 */
export function emitC(ir, { machine } = {}) {
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

  // A module exporting both `main` and `frame` gets the same portable
  // calling convention the web host already gives one: `main` sets up once
  // and `frame` runs once per tick, forever — nothing in the program's own
  // source drives that loop. On the web that loop lives in the host's
  // requestAnimationFrame callback (packages/cli/src/web-runtime.mjs);
  // here it is synthesised below as C's own `main`, so the user's
  // `main`/`frame` are renamed rather than becoming those literal C names.
  // A module with no `frame` keeps the old contract exactly: its `main` IS
  // the C entry point, expected to loop forever on its own (`examples/
  // counter`, `examples/step1-main-loop`).
  const hasFrame = ir.functions.some((fn) => fn.name === 'frame');
  const cName = (name) => {
    if (!hasFrame) return name;
    if (name === 'main') return '__8bs_setup';
    if (name === 'frame') return '__8bs_frame';
    return name;
  };

  // `main` is a C entry point regardless of what the source declared (when
  // there is no `frame` to change that): C mandates `int main(void)`, so
  // that impedance mismatch is absorbed here rather than by asking every
  // program to write a C-shaped `main`.
  const signature = (fn) => (fn.name === 'main' && !hasFrame
    ? 'int main(void)'
    : `${fn.returnType === 'void' ? 'void' : C_TYPE[fn.returnType]} ${cName(fn.name)}(${
      fn.params.length ? fn.params.map((p) => `${C_TYPE[p.type]} ${p.name}`).join(', ') : 'void'
    })`);

  // Prototypes before any definition: the linker puts the entry module's
  // functions first, so one may call a function defined below it. Skipped
  // only for the literal C `main` (nothing calls it — the CRT does), which
  // is exactly the one case `hasFrame` rules out.
  for (const fn of ir.functions) {
    if (fn.name !== 'main' || hasFrame) out += `${signature(fn)};\n`;
  }
  out += '\n';

  for (const fn of ir.functions) {
    out += `${signature(fn)} {\n`;
    out += fn.body.map((s) => emitStatement(s, 1)).join('');
    if (fn.name === 'main' && !hasFrame) out += '    return 0;\n';
    out += '}\n\n';
  }

  if (hasFrame) {
    const topHalf = RASTER_IN_TOP_HALF[machine];
    const pacing = FRAME_PACING[machine];
    if (topHalf === undefined || pacing === undefined) {
      throw new Error(`backend-6502: a frame()-driven program needs a known machine to pace it, got '${machine}'`);
    }
    // Wait for the raster to reach the BOTTOM half of the frame before
    // waiting for it to wrap back into the top half: without that first
    // wait, a loop body cheap enough to finish while the raster is still in
    // the top half would see "already there" and not actually have waited a
    // frame at all. Used once to reach a known point before the region
    // sweep, then once per hardware frame forever.
    const waitOneFrame = (pad, body = '') => (
      `${pad}while (${topHalf}) {}\n`
      + `${pad}while (!(${topHalf})) {${body}}\n`
    );
    out += 'int main(void) {\n';
    out += `    uint32_t __8bs_num = ${pacing.ntsc.num}u;\n`;
    out += `    uint32_t __8bs_den = ${pacing.ntsc.den}u;\n`;
    out += '    uint32_t __8bs_acc;\n';
    out += `    ${cName('main')}();\n`;
    // Region sweep (see FRAME_PACING): sync to the top of a frame, then
    // watch one whole frame go by; only a PAL raster ever reaches the probe
    // line. Costs two frames at startup, once.
    out += waitOneFrame('    ');
    out += waitOneFrame('    ', ` if (${pacing.palProbe}) { __8bs_num = ${pacing.pal.num}u; __8bs_den = ${pacing.pal.den}u; } `);
    // Start with one logical frame of credit so the very first hardware
    // frame runs frame() at least once instead of showing setup output for
    // a frame — a constant head start, which cannot affect the long-run
    // rate the way a per-frame rounding would.
    out += '    __8bs_acc = __8bs_den;\n';
    out += '    while (1) {\n';
    out += '        __8bs_acc += __8bs_num;\n';
    out += '        while (__8bs_acc >= __8bs_den) {\n';
    out += '            __8bs_acc -= __8bs_den;\n';
    out += `            ${cName('frame')}();\n`;
    out += '        }\n';
    out += waitOneFrame('        ');
    out += '    }\n';
    out += '    return 0;\n';
    out += '}\n';
  }

  return out;
}

/**
 * Compile IR to a .prg via LLVM-MOS.
 *
 * Region (NTSC/PAL) plays no part here: it changes VICE's machine model at
 * run time, not codegen, so the backend only ever needs to know the machine.
 *
 * @param {object} ir
 * @param {{ machine: 'vic20'|'c64', outFile: string }} options
 * @returns {Promise<{ ok: boolean, cFile?: string, error?: string }>}
 */
export async function buildPrg(ir, { machine, outFile }) {
  if (ir.imports?.length) {
    // Unresolved imports mean the caller skipped the linker. Refusing here is
    // what keeps a lower→backend shortcut from silently dropping modules.
    return { ok: false, error: 'the IR still has unresolved imports: link() it before the backend' };
  }
  const driverName = DRIVER[machine];
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

  const cFile = outFile.replace(/\.prg$/, '.c');
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(cFile, emitC(ir, { machine }), 'utf8');

  return new Promise((resolvePromise) => {
    const child = spawn(
      driver,
      ['-Os', ...MACHINE_FLAGS[machine], '-o', outFile, cFile],
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
