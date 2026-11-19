// Tap shim for mos/native.ts (see ../register.mjs).
import { readFileSync } from 'node:fs';

import { assembleNative as real } from '../../../../packages/compiler/src/mos/native.ts';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/mos/native.ts';
export const assembleNative = tapped('assembleNative', real);
// native.ts calls its own assembleNative, which no shim can see, so the file
// reading wrapper is repeated here (native.ts:303) to route through the tap.
export function nativePrograms(paths, referenced) {
  return assembleNative(paths.map((path) => ({ path, text: readFileSync(path, 'utf8') })), referenced);
}
