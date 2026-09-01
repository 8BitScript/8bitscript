// `8bs build` — compile a program for a target.
//
//     8bs build --target vic20-ntsc [entry.8bs]
//     8bs build --target web        [entry.8bs]
//
// The entry defaults to src/main.8bs, or to the `entry` in 8bs.config.ts when
// the project has one. Output lands in dist/: <name>.prg for the Commodore
// targets, <name>.wasm for the web, with the generated C or AssemblyScript
// beside it so what the compiler did is never a mystery.
//
// vic20/c64 are never bare: NTSC and PAL machines have different VIC/VIC-II
// timing and screen geometry, so the target names it explicitly rather than
// defaulting one way and leaving the other implicit. See parseMachineTarget
// in @8bitscript/backend-6502 for how a target splits into machine + region.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { link, positionAt } from '@8bitscript/compiler';

const TARGETS = new Set(['vic20-ntsc', 'vic20-pal', 'c64-ntsc', 'c64-pal', 'web']);

/**
 * The project's 8bs.config.ts, if present. Node 26 imports TypeScript with
 * type stripping, so the config is an ordinary module, not a parsed format.
 */
async function loadConfig(dir) {
  const path = join(dir, '8bs.config.ts');
  if (!existsSync(path)) return null;
  try {
    const module = await import(pathToFileURL(path).href);
    return module.default ?? null;
  } catch (error) {
    process.stderr.write(`8bs build: cannot load 8bs.config.ts: ${error.message}\n`);
    return null;
  }
}

// Diagnostics may come from any module in the import graph, so each one is
// rendered against its own file's text, not the entry's.
function printDiagnostics(diagnostics, sources) {
  for (const d of diagnostics) {
    const { line, column } = positionAt(sources.get(d.file) ?? '', d.start);
    process.stdout.write(`${basename(d.file)}:${line}:${column}\n`);
    process.stdout.write(`${d.severity} ${d.code}: ${d.message}\n\n`);
  }
}

/**
 * Compile one entry file for one target.
 *
 * @returns {Promise<{ ok: boolean, outFile?: string }>}
 */
export async function compile(target, entryArg) {
  const config = await loadConfig(process.cwd());

  if (!TARGETS.has(target)) {
    process.stderr.write(
      `8bs build: unknown target '${target}'. Targets: ${[...TARGETS].join(', ')}\n`,
    );
    return { ok: false };
  }
  if (config?.targets && !config.targets.includes(target)) {
    process.stderr.write(
      `8bs build: this project's 8bs.config.ts does not list '${target}' ` +
      `(targets: ${config.targets.join(', ')})\n`,
    );
    return { ok: false };
  }

  const entry = resolve(entryArg ?? config?.entry ?? 'src/main.8bs');
  if (!existsSync(entry)) {
    process.stderr.write(`8bs build: entry ${entry} does not exist\n`);
    return { ok: false };
  }

  const text = await readFile(entry, 'utf8');

  // The linker runs the full front end over the entry and everything it
  // imports, then merges the graph into one program. Any error in any module
  // means no build. The machine half of the target rides along so packages
  // with target-conditional entries resolve to this machine's implementation.
  const machine = target === 'web' ? 'web' : target.split('-')[0];
  const { ir, diagnostics, sources } = link(text, entry, { machine });
  if (diagnostics.length > 0) {
    printDiagnostics(diagnostics, sources);
    process.stdout.write(`${diagnostics.length} problem(s); not building.\n`);
    return { ok: false };
  }

  const stem = basename(entry, '.8bs');
  if (target === 'web') {
    const { buildWasm } = await import('@8bitscript/backend-web');
    const outFile = resolve('dist', `${stem}.wasm`);
    const result = await buildWasm(ir, { outFile });
    if (!result.ok) {
      process.stderr.write(`8bs build: ${result.error}\n`);
      return { ok: false };
    }
    process.stdout.write(`built ${outFile}\n(generated AssemblyScript: ${result.asFile})\n`);
    return { ok: true, outFile };
  }

  const { buildPrg } = await import('@8bitscript/backend-6502');
  const outFile = resolve('dist', `${stem}-${target}.prg`);
  const result = await buildPrg(ir, { target, outFile });
  if (!result.ok) {
    process.stderr.write(`8bs build: ${result.error}\n`);
    return { ok: false };
  }
  process.stdout.write(`built ${outFile}\n(generated C: ${result.cFile})\n`);
  return { ok: true, outFile };
}

/** @returns {Promise<number>} exit code */
export async function build(args) {
  const targetIndex = args.indexOf('--target');
  const target = targetIndex >= 0 ? args[targetIndex + 1] : args[0];
  const rest = args.filter((a, i) => i !== targetIndex && i !== targetIndex + 1 && !a.startsWith('-'));
  const entry = targetIndex >= 0 ? rest[0] : rest[1];

  if (!target) {
    process.stderr.write(
      'Usage: 8bs build --target <vic20-ntsc|vic20-pal|c64-ntsc|c64-pal|web> [entry.8bs]\n',
    );
    return 2;
  }
  const { ok } = await compile(target, entry);
  return ok ? 0 : 1;
}
