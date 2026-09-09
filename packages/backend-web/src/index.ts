// The web backend: IR in, .wasm out.
//
// Not implemented yet (Bare Metal, section 09). When it is, the module must
// satisfy the ABI packages/cli/src/wasm-host.mjs already hosts: exactly one
// exported function (the entry), exported memory and globals, and at most
// one import, `env.waitFrame`. This file records that contract; it does
// not implement it.
import type { IrProgram } from '@8bitscript/compiler';

export interface BuildOptions {
  outFile: string;
  frameRate: number;
}

export type BuildResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string };

const NOT_IMPLEMENTED =
  'the native WebAssembly backend is not implemented yet (Bare Metal, section 09): nothing can be built for web until it is';

/** Lowers `ir` to WebAssembly, writes `outFile`, and returns the bytes. */
export async function build(_ir: IrProgram, _options: BuildOptions): Promise<BuildResult> {
  return { ok: false, error: NOT_IMPLEMENTED };
}
