// Tap shim for binder/index.mjs (see ../register.mjs).
import { bind as realBind, bindImportedComponents as realBindImports } from '../../../../packages/compiler/src/binder/index.mjs';
import { noteBound, tapped, tappedBindImports } from '../tap.mjs';

export * from '../../../../packages/compiler/src/binder/index.mjs';
const tappedBind = tapped('bind', realBind);
// The tap numbers the nodes a bound result points at through the tree it came from.
export function bind(...args) {
  const bound = tappedBind(...args);
  if (process.env.EIGHTBS_FRONT_TAP) noteBound(bound, args[0]);
  return bound;
}
// bindImports is the same function under its newer name; callers import this one.
export const bindImportedComponents = tappedBindImports('bindImportedComponents', realBindImports);
