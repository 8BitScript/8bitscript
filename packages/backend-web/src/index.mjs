// The web backend: IR in, .wasm out.
//
// It emits AssemblyScript and hands it to asc. AssemblyScript's sized integer
// types match the machine types one-to-one, which is most of why it is the web
// target's language: `u8` means the same wrapped byte in both worlds. The one
// wrinkle is that AssemblyScript widens integer arithmetic to i32, so every
// store narrows back explicitly — `x = <u8>(x + 1)` — which is exactly the
// wrap-at-assignment semantics the design specifies for this target.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { PRIMITIVE_INTEGER_TYPES, entryOf } from '@8bitscript/compiler';

// AssemblyScript has no 24-bit integer either, so mediumint/umediumint widen
// the same way they do for the 6502 backend. Bits/signedness come from the
// compiler's shared type registry rather than a second hand-written table.
const NATIVE_WIDTH = { 8: 8, 16: 16, 24: 32, 32: 32 };
const AS_TYPE = Object.fromEntries(
  PRIMITIVE_INTEGER_TYPES.map((t) => [t.canonicalName, `${t.signed ? 'i' : 'u'}${NATIVE_WIDTH[t.bits]}`]),
);
AS_TYPE.bool = 'bool';

// `memory.read`/`memory.write` map straight onto AssemblyScript's own
// linear-memory intrinsics: a byte at a runtime offset is exactly what
// `load<u8>`/`store<u8>` are for. This makes raw memory access target-
// symmetric — real hardware on native, a flat 64KB buffer standing in for it
// on the web, per the `--initialMemory 1` reservation in `buildWasm` below.
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
      return `load<u8>(${emitExpression(expr.address)})`;
    default:
      throw new Error(`backend-web: unknown IR expression '${expr.kind}'`);
  }
}

function emitStatement(statement, indent, types, returnType) {
  const pad = '    '.repeat(indent);
  switch (statement.kind) {
    case 'assign': {
      const type = types.get(statement.target) ?? 'i32';
      return `${pad}${statement.target} = <${type}>${emitExpression(statement.value)};\n`;
    }
    case 'call':
      return `${pad}${statement.name}(${statement.args.map(emitExpression).join(', ')});\n`;
    case 'waitFrame':
      // The host import declared at the top of the module (see
      // emitAssemblyScript) — the page's worker blocks it on the frame clock,
      // a headless host counts it. Not something the wasm can do alone.
      return `${pad}waitFrame();\n`;
    case 'memoryWrite':
      return `${pad}store<u8>(${emitExpression(statement.address)}, ${emitExpression(statement.value)});\n`;
    case 'memoryRead':
      // Only reachable as a bare statement; the byte read is discarded.
      return `${pad}${emitExpression(statement)};\n`;
    case 'if': {
      let out = `${pad}if (${emitExpression(statement.test)}) {\n`;
      out += statement.then.map((s) => emitStatement(s, indent + 1, types, returnType)).join('');
      if (statement.else) {
        out += `${pad}} else {\n`;
        out += statement.else.map((s) => emitStatement(s, indent + 1, types, returnType)).join('');
      }
      return `${out}${pad}}\n`;
    }
    case 'while': {
      let out = `${pad}while (${emitExpression(statement.test)}) {\n`;
      out += statement.body.map((s) => emitStatement(s, indent + 1, types, returnType)).join('');
      return `${out}${pad}}\n`;
    }
    case 'block': {
      let out = `${pad}{\n`;
      out += statement.body.map((s) => emitStatement(s, indent + 1, types, returnType)).join('');
      return `${out}${pad}}\n`;
    }
    case 'return':
      // Same wrap-at-assignment narrowing a store gets: AS widens arithmetic
      // to i32, so a returned expression is cast back to the declared width.
      return statement.value
        ? `${pad}return <${AS_TYPE[returnType]}>${emitExpression(statement.value)};\n`
        : `${pad}return;\n`;
    case 'break': return `${pad}break;\n`;
    case 'continue': return `${pad}continue;\n`;
    case 'asm':
      throw Object.assign(
        new Error('asm6502 blocks are 6502 code and cannot run on the web target'),
        { targetLimitation: true },
      );
    default:
      throw new Error(`backend-web: unknown IR statement '${statement.kind}'`);
  }
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

/**
 * Generate the AssemblyScript module for an IR program.
 *
 * `usesWaitFrame` tells buildWasm() to build with shared memory: the page
 * runs a waitFrame() program in a worker that blocks on the frame clock,
 * and paints its memory from the main thread.
 *
 * @returns {{ ok: true, source: string, usesWaitFrame: boolean } | { ok: false, error: string }}
 */
export function emitAssemblyScript(ir) {
  const types = new Map(ir.globals.map((g) => [g.name, AS_TYPE[g.type]]));
  let out = '// Generated by 8bs. Do not edit: the source of truth is the .8bs file.\n';

  let usesWaitFrame = false;
  forEachStatement(ir.functions, (s) => { if (s.kind === 'waitFrame') usesWaitFrame = true; });
  if (usesWaitFrame) {
    // A host import: the wasm cannot wait on its own (a browser needs the
    // thread back to paint), so "block until the next logical frame" is the
    // one thing the host supplies — see packages/cli/src/web-runtime.mjs
    // (worker + Atomics.wait) and packages/cli/src/wasm-host.mjs (a counter).
    out += '// @ts-ignore: decorator\n';
    out += '@external("env", "waitFrame")\n';
    out += 'declare function waitFrame(): void;\n';
  }
  out += '\n';

  for (const g of ir.globals) {
    if (g.address !== null) {
      return {
        ok: false,
        error: `'${g.name}' is mapped to hardware address 0x${g.address.toString(16)} with @address; ` +
          'there is no such hardware on the web target',
      };
    }
    // Exported so a host can observe the program's state; wasm mutable-global
    // exports are exactly this use case.
    out += `export let ${g.name}: ${AS_TYPE[g.type]} = ${g.init};\n`;
  }
  out += '\n';

  // Only the entry is a wasm export — the artifact mirrors the language rule
  // (the entry module's one export is the program), and a host finds the
  // program as "the exported function" rather than by a magic name.
  const entry = entryOf(ir);
  try {
    for (const fn of ir.functions) {
      const params = fn.params.map((p) => `${p.name}: ${AS_TYPE[p.type]}`).join(', ');
      const returnType = fn.returnType === 'void' ? 'void' : AS_TYPE[fn.returnType];
      out += `${fn.name === entry ? 'export ' : ''}function ${fn.name}(${params}): ${returnType} {\n`;
      out += fn.body.map((s) => emitStatement(s, 1, types, fn.returnType)).join('');
      out += '}\n\n';
    }
  } catch (error) {
    if (error.targetLimitation) return { ok: false, error: error.message };
    throw error;
  }
  return { ok: true, source: out, usesWaitFrame };
}

/** The asc binary, from this package's own dependencies. */
function findAsc() {
  const require = createRequire(import.meta.url);
  return require.resolve('assemblyscript/bin/asc.js');
}

/**
 * Compile IR to a .wasm via asc.
 *
 * @param {object} ir
 * @param {{ outFile: string }} options
 * @returns {Promise<{ ok: boolean, asFile?: string, error?: string }>}
 */
export async function buildWasm(ir, { outFile }) {
  if (ir.imports?.length) {
    // Unresolved imports mean the caller skipped the linker. Refusing here is
    // what keeps a lower→backend shortcut from silently dropping modules.
    return { ok: false, error: 'the IR still has unresolved imports: link() it before the backend' };
  }
  const emitted = emitAssemblyScript(ir);
  if (!emitted.ok) return { ok: false, error: emitted.error };

  const asFile = outFile.replace(/\.wasm$/, '.ts');
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(asFile, emitted.source, 'utf8');

  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        findAsc(), asFile, '-o', outFile, '-O3', '--runtime', 'stub',
        // One page (64KB) reserved unconditionally, matching the 6502's own
        // 16-bit address space — what memory.read/write address on the web
        // target when a program uses them.
        '--initialMemory', '1',
        // A waitFrame() program's memory is shared: it runs in a worker that
        // blocks on the frame clock while the page paints the same bytes
        // from the main thread. Shared memory needs a maximum, and atomics
        // are behind the threads feature flag. Memory stays exported either
        // way, so every host reads `instance.exports.memory` regardless.
        ...(emitted.usesWaitFrame
          ? ['--maximumMemory', '1', '--sharedMemory', '--enable', 'threads']
          : []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      resolvePromise(code === 0
        ? { ok: true, asFile }
        : { ok: false, asFile, error: `asc failed:\n${stderr}` });
    });
  });
}
