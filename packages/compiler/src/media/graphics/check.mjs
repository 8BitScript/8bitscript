// GIR checker: required fields, unique names, size sanity. Host decode
// (missing PNG, too-small image) happens later in the linker, which can
// open the disk. This pass is what analyze() runs on a buffer.
import { Codes, diagnostic } from '../../diagnostics/index.mjs';

export function checkGraphics(gir, file) {
  const diagnostics = [];
  const names = new Set();
  for (const sprite of gir.sprites ?? []) {
    const at = (code, message, start, length, severity = 'error') => {
      diagnostics.push(diagnostic(code, message, file, start ?? sprite.start ?? 0, length ?? sprite.length ?? 0, severity));
    };
    if (!sprite.name) continue;
    if (names.has(sprite.name)) at(Codes.GFX_DUPLICATE_NAME, `'${sprite.name}' is already declared`);
    names.add(sprite.name);
    if (!sprite.source) at(Codes.GFX_MISSING_FIELD, `sprite '${sprite.name}' needs a source "...png"`);
    if (sprite.width === 0 && sprite.height === 0) {
      at(Codes.GFX_MISSING_FIELD, `sprite '${sprite.name}' needs size WxH`, sprite.sizeStart, sprite.sizeLength);
    } else if (sprite.width < 1 || sprite.height < 1 || sprite.width > 64 || sprite.height > 64) {
      at(Codes.GFX_INVALID_SIZE, `sprite '${sprite.name}' size ${sprite.width}x${sprite.height} is not 1x1..64x64`, sprite.sizeStart, sprite.sizeLength);
    }
    for (const anim of sprite.animations ?? []) {
      if (!anim.frames?.length) {
        at(Codes.GFX_MISSING_FIELD, `animation '${anim.name}' needs frames`, anim.start, anim.length);
      }
      if (!Number.isInteger(anim.every) || anim.every < 1) {
        at(Codes.GFX_SYNTAX, `'every' is a frame count of 1 or more, not ${anim.every}`, anim.everyStart, anim.everyLength);
      }
    }
  }
  return diagnostics;
}
