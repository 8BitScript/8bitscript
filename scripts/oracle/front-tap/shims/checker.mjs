// Tap shim for checker/index.mjs (see ../register.mjs).
import { check as real } from '../../../../packages/compiler/src/checker/index.mjs';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/checker/index.mjs';
export const check = tapped('check', real);
