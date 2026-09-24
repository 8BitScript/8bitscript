import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { optimizeReachable } from '../linker/optimize.mjs';
import { lowerToOps } from './lower.ts';
import type { IsaEncode } from './ops.ts';

export interface BuildOptions {
  machine: string;
  hardware: { build: { defsym: Record<string, number>; output?: string }; facts: Record<string, unknown> };
  outFile: string;
  frameRate: number;
  report?: boolean;
}

export type BuildResult =
  | { ok: true; bytes: Uint8Array; memory: { variables: number; program: number } }
  | { ok: false; error: string };

export async function buildIsa(ir: {
  entry: string;
  functions: unknown[];
  globals?: unknown[];
  strings?: unknown[];
}, options: BuildOptions, isa: IsaEncode, wrap: (code: Uint8Array, origin: number, hardware: BuildOptions['hardware']) => Uint8Array, ramOrigin: number, origin: number): Promise<BuildResult> {
  // Strings ride with the IR the same way they do on MOS: without them
  // `s.length` / `s[i]` of a literal never fold, a print of `"Hello World!"`
  // stays a loop, and this lowerer refuses `stringLength`.
  const live = optimizeReachable({
    entry: ir.entry,
    functions: ir.functions as never[],
    globals: (ir.globals ?? []) as never[],
    strings: (ir.strings ?? []) as never[],
  });
  const lowered = lowerToOps({
    entry: ir.entry,
    functions: live.functions as never[],
    globals: (live.globals ?? ir.globals ?? []) as never[],
  }, ramOrigin);
  if (!lowered.ok) return lowered;
  const encoded = isa.encode(lowered.ops, origin);
  if (!encoded.ok) return encoded;
  const bytes = wrap(encoded.bytes, origin, options.hardware);
  await mkdir(dirname(options.outFile), { recursive: true });
  await writeFile(options.outFile, bytes);
  return { ok: true, bytes, memory: { variables: lowered.ramBytes, program: bytes.length } };
}

export function outputFromHardware(hardware: BuildOptions['hardware'] | undefined, fallback: string) {
  return hardware?.build?.output ?? fallback;
}
