// Tap shim for bx/check.mjs (see ../register.mjs).
import { checkBx as real } from '../../../../packages/compiler/src/bx/check.mjs';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/bx/check.mjs';
export const checkBx = tapped('checkBx', real);
