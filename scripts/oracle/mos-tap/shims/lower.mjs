// Tap shim for mos/lower/index.ts (see ../register.mjs).
import { lower as real, resetLabels as realReset } from '../../../../packages/compiler/src/mos/lower/index.ts';
import { tapped, tappedReset } from '../tap.mjs';

export * from '../../../../packages/compiler/src/mos/lower/index.ts';
export const resetLabels = tappedReset('lower', realReset);
// `after` is the allocator the call mutated: the next call starts from it.
export const lower = tapped('lower', real, ([, options]) => options.locals);
