import { buildIsa, outputFromHardware } from '../isa/build.ts';
import type { BuildOptions, BuildResult } from '../isa/build.ts';
import { SM83 } from './encode.ts';

const LOGO = Uint8Array.from([
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d,
  0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
  0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
]);

function wrapGb(code: Uint8Array, origin: number, hardware: BuildOptions['hardware']) {
  const size = hardware.build.defsym.__rom_size ?? 32768;
  const rom = new Uint8Array(size);
  rom[0x100] = 0x00; // NOP
  rom[0x101] = 0xc3; // JP origin
  rom[0x102] = origin & 0xff;
  rom[0x103] = (origin >>> 8) & 0xff;
  rom.set(LOGO, 0x104);
  const title = '8BITSCRIPT';
  for (let i = 0; i < title.length && i < 15; i++) rom[0x134 + i] = title.charCodeAt(i);
  rom[0x147] = 0x00; // ROM only
  rom[0x148] = size >= 65536 ? 1 : 0;
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++) checksum = (checksum - rom[i] - 1) & 0xff;
  rom[0x14d] = checksum;
  const copy = Math.min(code.length, size - origin);
  rom.set(code.subarray(0, copy), origin);
  return rom;
}

export function outputExtension(_machine: string, hardware?: BuildOptions['hardware']) {
  return outputFromHardware(hardware, 'gb');
}

export async function build(ir: { entry: string; functions: unknown[]; globals?: unknown[] }, options: BuildOptions): Promise<BuildResult> {
  const origin = options.hardware.build.defsym.__load_address ?? 0x0150;
  return buildIsa(ir, options, SM83, wrapGb, 0xc000, origin);
}

export type { BuildOptions, BuildResult };
