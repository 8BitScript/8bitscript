// Tap shim for i18n/index.mjs (see ../register.mjs).
import { applyCatalogCharset as realCharset, resolveCatalogSpecifier as realSpecifier } from '../../../../packages/compiler/src/i18n/index.mjs';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/i18n/index.mjs';
// `after` is the tree whose string literals the call rewrote.
export const applyCatalogCharset = tapped('applyCatalogCharset', realCharset, { after: ([ast]) => ast });
export const resolveCatalogSpecifier = tapped('resolveCatalogSpecifier', realSpecifier);
