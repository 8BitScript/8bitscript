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
// interrupt vector, just a byte that counts scanlines and wraps once a
// frame. This is what the frame()-driver loop below polls so a program's
// frame() runs once per real vertical blank: exactly 60Hz NTSC / 50Hz PAL,
// self-correcting, with no calibrated delay constant to get wrong or to
// need a separate value per region.
//
// C64 (VIC-II): $D012 holds the raster line's low 8 bits directly. A 9th
// bit (needed for lines >= 256) lives in $D011 bit 7 — irrelevant here,
// since line 0 always has that bit clear.
// (https://www.c64-wiki.com/wiki/VIC)
//
// VIC-20 (VIC-I): a different, non-obvious layout — not inferred from the
// C64's. $9004 holds bits 8-1 of the 9-bit raster counter and only changes
// every *second* line; the counter's own bit 0 lives by itself in $9003 bit
// 7. Reading $9004 alone is coarser — it reads 0 for both raster lines 0
// and 1 — but that is more than precise enough for "once near the top of
// the frame," so bit 0 is never read.
// (https://github.com/cbmeeks/VIC-20/blob/master/6561.txt, registers CR3/CR4)
const RASTER_ADDRESS = { vic20: 0x9004, c64: 0xd012 };

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
    const raster = RASTER_ADDRESS[machine];
    if (raster === undefined) {
      throw new Error(`backend-6502: a frame()-driven program needs a known machine to pace it, got '${machine}'`);
    }
    const addr = `0x${raster.toString(16).toUpperCase()}`;
    // Wait for the raster to LEAVE the top of the frame before waiting for
    // it to return there: without that first wait, a frame() cheap enough
    // to finish inside the same raster line it started on would see "still
    // at the top" and not actually have waited a frame at all.
    out += 'int main(void) {\n';
    out += `    ${cName('main')}();\n`;
    out += '    while (1) {\n';
    out += `        ${cName('frame')}();\n`;
    out += `        while (*(volatile uint8_t *)${addr} == 0) {}\n`;
    out += `        while (*(volatile uint8_t *)${addr} != 0) {}\n`;
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
