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
// A string value is a pointer into linear memory at its constant,
// length-prefixed bytes — a static data segment asc lays out from
// STRING_DATA_BASE (see buildWasm), above the screen agreement in
// @8bitscript/web so a `clearScreen()` can never write over a label.
AS_TYPE.string = 'usize';
// An array parameter is the address of the array's first element, the same
// way a string parameter is: linear memory, indexed by elementAddress().
// The element type and the length live in the callee's own signature, so
// neither travels with the call.
AS_TYPE.array = 'usize';
// Bytes one element of each type takes in linear memory: the stride of an
// array, and what `memory.data(size)` reserves for a `let` array.
const AS_SIZE = Object.fromEntries(
  PRIMITIVE_INTEGER_TYPES.map((t) => [t.canonicalName, NATIVE_WIDTH[t.bits] / 8]),
);
AS_SIZE.bool = 1;

/** The address of element `index` of the array `expr.array`, as AssemblyScript. */
function elementAddress(expr, signatures) {
  const size = AS_SIZE[expr.elementType];
  const index = emitExpression(expr.index, signatures);
  return `<usize>(${emitExpression(expr.array, signatures)} + <usize>(${index})${size === 1 ? '' : ` * ${size}`})`;
}

const stringName = (index) => `__8bs_str_${index}`;

// Where asc places static data (`--memoryBase`): 0xE000, the top 8KB of
// the 64KB page — where a Commodore's ROM sits — so constant data never
// overlaps the character screen at the bottom (@8bitscript/web's
// WebRegisters agreement ends at 2003) nor anything a program is likely to
// memory.write() itself.
export const STRING_DATA_BASE = 0xE000;

// `memory.read`/`memory.write` map straight onto AssemblyScript's own
// linear-memory intrinsics: a byte at a runtime offset is exactly what
// `load<u8>`/`store<u8>` are for. This makes raw memory access target-
// symmetric — real hardware on native, a flat 64KB buffer standing in for it
// on the web, per the `--initialMemory 1` reservation in `buildWasm` below.
// `signatures` maps every function's name to its parameters' AssemblyScript
// types, so a call's arguments narrow to what the callee declared — the
// same wrap-at-assignment rule a store gets, since AssemblyScript widens
// arithmetic to i32 and refuses to pass a widened value to a `u8` on its
// own.
function emitCall(call, signatures) {
  const paramTypes = signatures.get(call.name) ?? [];
  const args = call.args.map((arg, i) => {
    const emitted = emitExpression(arg, signatures);
    return paramTypes[i] ? `<${paramTypes[i]}>${emitted}` : emitted;
  });
  return `${call.name}(${args.join(', ')})`;
}

function emitExpression(expr, signatures) {
  switch (expr.kind) {
    case 'const': return String(expr.value);
    case 'ref': return expr.name;
    case 'binop':
      return `(${emitExpression(expr.left, signatures)} ${expr.operator} ${emitExpression(expr.right, signatures)})`;
    case 'unop':
      return `(${expr.operator}${emitExpression(expr.argument, signatures)})`;
    case 'call':
      return emitCall(expr, signatures);
    case 'memoryRead':
      return `load<u8>(${emitExpression(expr.address, signatures)})`;
    case 'string':
      return stringName(expr.index);
    case 'stringLength':
      // Byte 0 is the length; the characters follow.
      return `load<u8>(${emitExpression(expr.string, signatures)})`;
    case 'stringByte':
      return `load<u8>(<usize>(${emitExpression(expr.string, signatures)} + 1 + ${emitExpression(expr.index, signatures)}))`;
    case 'index':
      return `load<${AS_TYPE[expr.elementType]}>(${elementAddress(expr, signatures)})`;
    default:
      throw new Error(`backend-web: unknown IR expression '${expr.kind}'`);
  }
}

function emitStatement(statement, indent, types, returnType, signatures) {
  const pad = '    '.repeat(indent);
  switch (statement.kind) {
    case 'assign': {
      const type = types.get(statement.target) ?? 'i32';
      return `${pad}${statement.target} = <${type}>${emitExpression(statement.value, signatures)};\n`;
    }
    case 'local': {
      const type = AS_TYPE[statement.type];
      return `${pad}let ${statement.name}: ${type} = <${type}>${emitExpression(statement.init, signatures)};\n`;
    }
    case 'stringCopy':
      return `${pad}__8bs_string_copy(${emitExpression(statement.target, signatures)}, ${emitExpression(statement.source, signatures)}, ${statement.capacity});\n`;
    case 'for': {
      const clause = (s) => (s ? emitStatement(s, 0, types, returnType, signatures).trim().replace(/;$/, '') : '');
      let out = `${pad}for (${clause(statement.init)}; ${statement.test ? emitExpression(statement.test, signatures) : ''}; ${clause(statement.update)}) {\n`;
      out += statement.body.map((s) => emitStatement(s, indent + 1, types, returnType, signatures)).join('');
      return `${out}${pad}}\n`;
    }
    case 'storeIndex': {
      // The same narrowing a store to a scalar gets, to the element's width.
      const type = AS_TYPE[statement.elementType];
      return `${pad}store<${type}>(${elementAddress(statement, signatures)}, <${type}>${emitExpression(statement.value, signatures)});\n`;
    }
    case 'call':
      return `${pad}${emitCall(statement, signatures)};\n`;
    case 'waitFrame':
      // The host import declared at the top of the module (see
      // emitAssemblyScript) — the page's worker blocks it on the frame clock,
      // a headless host counts it. Not something the wasm can do alone.
      return `${pad}waitFrame();\n`;
    case 'memoryWrite':
      return `${pad}store<u8>(${emitExpression(statement.address, signatures)}, ${emitExpression(statement.value, signatures)});\n`;
    case 'memoryRead':
      // Only reachable as a bare statement; the byte read is discarded.
      return `${pad}${emitExpression(statement, signatures)};\n`;
    case 'if': {
      let out = `${pad}if (${emitExpression(statement.test, signatures)}) {\n`;
      out += statement.then.map((s) => emitStatement(s, indent + 1, types, returnType, signatures)).join('');
      if (statement.else) {
        out += `${pad}} else {\n`;
        out += statement.else.map((s) => emitStatement(s, indent + 1, types, returnType, signatures)).join('');
      }
      return `${out}${pad}}\n`;
    }
    case 'while': {
      let out = `${pad}while (${emitExpression(statement.test, signatures)}) {\n`;
      out += statement.body.map((s) => emitStatement(s, indent + 1, types, returnType, signatures)).join('');
      return `${out}${pad}}\n`;
    }
    case 'block': {
      let out = `${pad}{\n`;
      out += statement.body.map((s) => emitStatement(s, indent + 1, types, returnType, signatures)).join('');
      return `${out}${pad}}\n`;
    }
    case 'return':
      // Same wrap-at-assignment narrowing a store gets: AS widens arithmetic
      // to i32, so a returned expression is cast back to the declared width.
      return statement.value
        ? `${pad}return <${AS_TYPE[returnType]}>${emitExpression(statement.value, signatures)};\n`
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
      else if (s.kind === 'for') { if (s.init) visit(s.init); if (s.update) visit(s.update); walkBody(s.body); }
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
  // An array's name is its address (a `usize`), never assigned as a whole,
  // so it has no entry here; a store into it narrows to the element type.
  const types = new Map(ir.globals.filter((g) => !g.array).map((g) => [g.name, AS_TYPE[g.type]]));
  const signatures = new Map(ir.functions.map((fn) => [fn.name, fn.params.map((p) => AS_TYPE[p.type])]));
  let out = '// Generated by 8bs. Do not edit: the source of truth is the .8bs file.\n';

  let usesWaitFrame = false;
  let usesStringCopy = false;
  forEachStatement(ir.functions, (s) => {
    if (s.kind === 'waitFrame') usesWaitFrame = true;
    if (s.kind === 'stringCopy') usesStringCopy = true;
  });
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

  for (const [index, s] of (ir.strings ?? []).entries()) {
    out += `const ${stringName(index)}: usize = memory.data<u8>([${[s.bytes.length, ...s.bytes].join(', ')}]); // "${s.text}"\n`;
  }
  if (ir.strings?.length) out += '\n';
  if (usesStringCopy) {
    // `name = other` on a string<N>: length byte, then the characters, cut
    // to the capacity — the same helper the 6502 backend emits, in
    // AssemblyScript.
    out += 'function __8bs_string_copy(dst: usize, src: usize, capacity: u8): void {\n';
    out += '    let n: u8 = load<u8>(src);\n';
    out += '    if (n > capacity) n = capacity;\n';
    out += '    store<u8>(dst, n);\n';
    out += '    for (let i: u8 = 0; i < n; i++) store<u8>(dst + 1 + i, load<u8>(src + 1 + i));\n';
    out += '}\n\n';
  }

  for (const g of ir.globals) {
    if (g.array) {
      // An array is a static chunk of linear memory, laid out by asc above
      // STRING_DATA_BASE with the string constants: `const` with its
      // values, `let` zeroed (or with its values), and an `@address` array
      // N cells from that offset in the 64KB page — the web target has no
      // hardware there, but the memory exists, so a screen-RAM-shaped array
      // over the @8bitscript/web agreement is as real as on a Commodore.
      const type = AS_TYPE[g.type];
      const data = g.address !== null ? String(g.address)
        : g.init ? `memory.data<${type}>([${g.init.join(', ')}])`
          : `memory.data(${g.array * AS_SIZE[g.type]})`;
      out += `export const ${g.name}: usize = ${data};\n`;
      continue;
    }
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
      // A parameter is assignable like a global (`value = value / 10`), and
      // narrows back to its own width the same way; it shadows a same-named
      // global inside its function, as the linker's scoping already says.
      // Locals too: a store to one narrows to its declared width. Names
      // are function-wide here (a local shadows a global of the name in
      // every store after its declaration, which the linker's scoping
      // already guarantees is the only place it is named).
      const locals = [];
      forEachStatement([fn], (s) => { if (s.kind === 'local') locals.push([s.name, AS_TYPE[s.type]]); });
      const fnTypes = fn.params.length || locals.length
        ? new Map([...types, ...fn.params.map((p) => [p.name, AS_TYPE[p.type]]), ...locals])
        : types;
      out += `${fn.name === entry ? 'export ' : ''}function ${fn.name}(${params}): ${returnType} {\n`;
      out += fn.body.map((s) => emitStatement(s, 1, fnTypes, fn.returnType, signatures)).join('');
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
        // Static data (string constants) starts here — see STRING_DATA_BASE.
        '--memoryBase', String(STRING_DATA_BASE),
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
      if (code === 0) { resolvePromise({ ok: true, asFile }); return; }
      // Static data — arrays, string<N> variables, string constants — is
      // laid out from STRING_DATA_BASE to the end of the one 64KB page, so
      // there is room for about 8KB of it. asc reports going past the end
      // as needing a second page; that is the limit, in the program's terms.
      const overPage = /requires at least '\d+' pages of maximum memory/.test(stderr);
      const error = overPage
        ? `this program's arrays, strings, and string variables need more than the ${65536 - STRING_DATA_BASE} bytes of static data the web target has `
          + `(the top of its one 64KB page, from 0x${STRING_DATA_BASE.toString(16).toUpperCase()}). Smaller arrays bring it down.\nasc failed:\n${stderr}`
        : `asc failed:\n${stderr}`;
      resolvePromise({ ok: false, asFile, error });
    });
  });
}
