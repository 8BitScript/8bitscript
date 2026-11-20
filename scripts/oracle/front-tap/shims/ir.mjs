// Tap shim for ir/index.mjs (see ../register.mjs).
import { lower as real } from '../../../../packages/compiler/src/ir/index.mjs';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/ir/index.mjs';
export const lower = tapped('lower', real);
