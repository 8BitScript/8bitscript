// Module resolve hook of the mos tap. It runs on the loader thread and sends
// every import of a tapped module, except the shim's own import of the real
// one, to the shim.
const SRC = new URL('../../../packages/compiler/src/mos/', import.meta.url);
const SHIMS = new URL('./shims/', import.meta.url);

/** Real module path under mos/ to the shim file that wraps it. */
export const TAPPED = {
  'asm/relax.ts': 'relax.mjs',
  'data.ts': 'data.mjs',
  'link/index.ts': 'link.mjs',
  'lower/index.ts': 'lower.mjs',
  'native.ts': 'native.mjs',
  'zp/frames.ts': 'frames.mjs',
  'zp/index.ts': 'zp.mjs',
};

const shimOf = new Map(Object.entries(TAPPED).map(([real, shim]) => [
  new URL(real, SRC).href,
  new URL(shim, SHIMS).href,
]));

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const shim = shimOf.get(resolved.url);
  if (!shim || context.parentURL === shim) return resolved;
  return { ...resolved, url: shim, shortCircuit: true };
}
