// Tap shim for resolver/index.mjs (see ../register.mjs).
import {
  findImports as realFindImports,
  nativeSourcesBeside as realNativeSourcesBeside,
  pathFormSpecifiers as realPathFormSpecifiers,
  resolveSpecifier as realResolveSpecifier,
} from '../../../../packages/compiler/src/resolver/index.mjs';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/resolver/index.mjs';
export const findImports = tapped('findImports', realFindImports);
export const pathFormSpecifiers = tapped('pathFormSpecifiers', realPathFormSpecifiers);
export const resolveSpecifier = tapped('resolveSpecifier', realResolveSpecifier);
export const nativeSourcesBeside = tapped('nativeSourcesBeside', realNativeSourcesBeside);
