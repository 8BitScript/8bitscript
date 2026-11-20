// Tap shim for bx/elaborate.mjs (see ../register.mjs).
import { elaborateBx as real } from '../../../../packages/compiler/src/bx/elaborate.mjs';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/bx/elaborate.mjs';
// `after` is the tree the call rewrote in place.
export const elaborateBx = tapped('elaborateBx', real, { after: ([ast]) => ast });
