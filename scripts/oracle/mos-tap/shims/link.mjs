// Tap shim for mos/link/index.ts (see ../register.mjs).
import { link as real } from '../../../../packages/compiler/src/mos/link/index.ts';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/mos/link/index.ts';
export const link = tapped('link', real);
