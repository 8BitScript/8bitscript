// Tap shim for mos/zp/frames.ts (see ../register.mjs).
import { layoutFrames as real } from '../../../../packages/compiler/src/mos/zp/frames.ts';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/mos/zp/frames.ts';
export const layoutFrames = tapped('layoutFrames', real);
