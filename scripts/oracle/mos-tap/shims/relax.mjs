// Tap shim for mos/asm/relax.ts (see ../register.mjs).
import { resetLabels as real } from '../../../../packages/compiler/src/mos/asm/relax.ts';
import { tappedReset } from '../tap.mjs';

export * from '../../../../packages/compiler/src/mos/asm/relax.ts';
export const resetLabels = tappedReset('relax', real);
