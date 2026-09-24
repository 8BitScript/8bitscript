import { buildIsa, outputFromHardware } from '../isa/build.ts';
import type { BuildOptions, BuildResult } from '../isa/build.ts';
import { Z80 } from './encode.ts';
import { segaCartSize, segaCodeOrigin, stampSegaCrt0 } from './sega-crt0.ts';

function wrapRom(code: Uint8Array, origin: number, hardware: BuildOptions['hardware']) {
  const size = segaCartSize(origin, code.length, hardware);
  const rom = new Uint8Array(size);
  rom.set(code.subarray(0, Math.min(code.length, size - origin)), origin);
  if (hardware.build.output === 'gg') stampSegaCrt0(rom, origin);
  return rom;
}

export function outputExtension(_machine: string, hardware?: BuildOptions['hardware']) {
  return outputFromHardware(hardware, 'rom');
}

export async function build(ir: { entry: string; functions: unknown[]; globals?: unknown[] }, options: BuildOptions): Promise<BuildResult> {
  const origin = segaCodeOrigin(options.hardware);
  return buildIsa(ir, options, Z80, wrapRom, 0xc000, origin);
}

export type { BuildOptions, BuildResult };
