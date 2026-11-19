// Tap shim for mos/zp/index.ts (see ../register.mjs).
import { allocate as real } from '../../../../packages/compiler/src/mos/zp/index.ts';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/mos/zp/index.ts';
export const allocate = tapped('allocate', real);
