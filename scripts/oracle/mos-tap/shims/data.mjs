// Tap shim for mos/data.ts (see ../register.mjs).
import { buildDataSection as real } from '../../../../packages/compiler/src/mos/data.ts';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/mos/data.ts';
export const buildDataSection = tapped('buildDataSection', real);
