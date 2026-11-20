// Module resolve hook of the front tap. It runs on the loader thread and sends
// every import of a tapped module, except the shim's own import of the real
// one, to the shim.
const SRC = new URL('../../../packages/compiler/src/', import.meta.url);
const SHIMS = new URL('./shims/', import.meta.url);

/** Real module path under compiler/src/ to the shim file that wraps it. */
export const TAPPED = {
  'binder/index.mjs': 'binder.mjs',
  'bx/check.mjs': 'bx-check.mjs',
  'bx/elaborate.mjs': 'bx-elaborate.mjs',
  'checker/index.mjs': 'checker.mjs',
  'fold/index.mjs': 'fold.mjs',
  'i18n/index.mjs': 'i18n.mjs',
  'ir/index.mjs': 'ir.mjs',
  'media/index.mjs': 'media.mjs',
  'resolver/index.mjs': 'resolver.mjs',
  'templates/index.mjs': 'templates.mjs',
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
