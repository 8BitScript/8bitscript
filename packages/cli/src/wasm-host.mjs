// Running a web-target program outside a browser.
//
// A .wasm built by packages/backend-web exports exactly one function — the
// program (the entry module's one export) — plus its globals and memory, and
// imports one thing at most: `env.waitFrame`, when the program calls
// waitFrame(). The browser host (web-runtime.mjs) blocks that import on the
// page's frame clock. A headless host has no frame clock, so it counts
// instead: a bounded waitFrame() lets a program that loops forever run for
// exactly N frames and then unwinds it, the only way out of a `while (true)`
// that a caller controls. Used by `8bs run web --screenshot` and the tests.
export class FrameLimitReached extends Error {
  constructor(frames) {
    super(`the program ran for ${frames} frame(s) and was stopped`);
    this.frames = frames;
  }
}

/**
 * A waitFrame() implementation that returns `limit` times and then throws
 * FrameLimitReached — which propagates out through the wasm frames to the
 * caller of the entry, ending a program that would otherwise never return.
 */
export function boundedWaitFrame(limit) {
  let frames = 0;
  return () => {
    frames += 1;
    if (frames > limit) throw new FrameLimitReached(limit);
  };
}

/**
 * Instantiate a program's .wasm with a host-supplied waitFrame().
 *
 * The import object always offers `env.waitFrame`; a program that never calls
 * waitFrame() simply doesn't import it, and an unused import is ignored. The
 * entry is found as the one exported function, not by name.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {{ waitFrame?: () => void }} [options]
 * @returns {Promise<{
 *   instance: WebAssembly.Instance, memory: WebAssembly.Memory,
 *   entry: () => void, entryName: string, usesWaitFrame: boolean,
 * }>}
 */
export async function instantiateProgram(bytes, { waitFrame = () => {} } = {}) {
  const module = await WebAssembly.compile(bytes);
  const usesWaitFrame = WebAssembly.Module.imports(module)
    .some((i) => i.module === 'env' && i.name === 'waitFrame');
  const instance = await WebAssembly.instantiate(module, { env: { waitFrame } });
  const functions = Object.entries(instance.exports).filter(([, v]) => typeof v === 'function');
  if (functions.length !== 1) {
    throw new Error(`8bs: a program exports exactly one function, this .wasm exports ${functions.length}`);
  }
  const [entryName, entry] = functions[0];
  return { instance, memory: instance.exports.memory, entry, entryName, usesWaitFrame };
}

/**
 * Run a program for at most `frames` logical frames: the entry is called and
 * either returns on its own or is unwound by the frame bound. Anything else
 * the program throws is a real error and propagates.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {{ frames: number }} options
 * @returns the instantiated program, after running
 */
export async function runProgram(bytes, { frames }) {
  const program = await instantiateProgram(bytes, { waitFrame: boundedWaitFrame(frames) });
  try {
    program.entry();
  } catch (error) {
    if (!(error instanceof FrameLimitReached)) throw error;
  }
  return program;
}
