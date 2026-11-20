// Tap shim for templates/index.mjs (see ../register.mjs).
import { layoutTemplate as realLayout, scanDeclaredTypes as realScan } from '../../../../packages/compiler/src/templates/index.mjs';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/templates/index.mjs';
export const scanDeclaredTypes = tapped('scanDeclaredTypes', realScan);
export const layoutTemplate = tapped('layoutTemplate', realLayout);
