// Front end for `.8bg` / `.8ba`: lex, parse, check. Host decode and
// machine lowering live in elaborate.mjs and run from the linker, which
// is the first stage that may open a PNG or WAV.
import { tokenizeMedia } from './lexer.mjs';
import { parseGraphics } from './graphics/parse.mjs';
import { checkGraphics } from './graphics/check.mjs';
import { parseAudio } from './audio/parse.mjs';
import { checkAudio } from './audio/check.mjs';

export { tokenizeMedia, MediaTokenKind } from './lexer.mjs';
export { parseGraphics } from './graphics/parse.mjs';
export { parseAudio } from './audio/parse.mjs';
export { checkGraphics } from './graphics/check.mjs';
export { checkAudio } from './audio/check.mjs';
export { elaborateMedia } from './elaborate.mjs';
export { isMediaKind } from './kinds.mjs';

/**
 * A media module as far as parseModule: tokens, GIR/AIR, no IR yet.
 */
export function parseMediaModule(file, text, diagnostics, sourceKind) {
  const result = analyzeMedia(text, file, { sourceKind });
  diagnostics.push(...result.diagnostics);
  return {
    file,
    text,
    tokens: result.tokens,
    ast: null,
    bound: { symbols: new Map(), diagnostics: [], imports: [] },
    media: { kind: sourceKind, gir: result.gir, air: result.air },
  };
}

/**
 * Analyse one media file: tokens, GIR/AIR, and front-end diagnostics.
 * Decode of the named PNG/WAV is opt-in (`decode: true`) because it
 * touches the disk; analyze() leaves it off so an unsaved buffer still
 * type-checks.
 *
 * @param {string} text
 * @param {string} file
 * @param {{ sourceKind: '.8bg'|'.8ba' }} options
 */
export function analyzeMedia(text, file, options) {
  const sourceKind = options.sourceKind;
  const { tokens, diagnostics: lexical } = tokenizeMedia(text, file, { sourceKind });
  if (sourceKind === '.8bg') {
    const { gir, diagnostics: syntax } = parseGraphics(tokens, text, file);
    const checked = checkGraphics(gir, file);
    return { tokens, gir, air: null, diagnostics: [...lexical, ...syntax, ...checked] };
  }
  const { air, diagnostics: syntax } = parseAudio(tokens, text, file);
  const checked = checkAudio(air, file);
  return { tokens, gir: null, air, diagnostics: [...lexical, ...syntax, ...checked] };
}
