import { buildIsa, outputFromHardware } from '../isa/build.ts';
import type { BuildOptions, BuildResult } from '../isa/build.ts';
import { F8 } from './encode.ts';

function wrap(code: Uint8Array, origin: number, hardware: BuildOptions['hardware']) {
  const size = hardware.build.defsym.__rom_size ?? 2048;
  const rom = new Uint8Array(size);
  rom.set(code.subarray(0, Math.min(code.length, size - origin)), origin);
  return rom;
}

export function outputExtension(_machine: string, hardware?: BuildOptions['hardware']) {
  return outputFromHardware(hardware, 'bin');
}

export async function build(ir: { entry: string; functions: unknown[]; globals?: unknown[] }, options: BuildOptions): Promise<BuildResult> {
  const origin = options.hardware.build.defsym.__load_address ?? 0;
  return buildIsa(ir, options, F8, wrap, 0x10, origin);
}

export type { BuildOptions, BuildResult };
