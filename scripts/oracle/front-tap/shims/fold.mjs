// Tap shim for fold/index.mjs (see ../register.mjs).
import { foldCompileTime as real } from '../../../../packages/compiler/src/fold/index.mjs';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/fold/index.mjs';
// `after` is the tree the call folded in place.
export const foldCompileTime = tapped('foldCompileTime', real, { after: ([ast]) => ast });
