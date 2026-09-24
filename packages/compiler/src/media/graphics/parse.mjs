// `.8bg` parser. Never throws. Produces GIR: sprites with optional
// animation, plus empty slots (tiles, fonts) the later slices fill.
import { MediaTokenKind } from '../lexer.mjs';
import { cursor, parseName, parseString, parseNumber, parseBlock } from '../cursor.mjs';

const SPRITE_FIELDS = new Set(['source', 'size', 'transparent', 'animation']);
const ANIM_FIELDS = new Set(['frames', 'every']);

function parseSize(c) {
  const w = parseNumber(c, 'width');
  const next = c.at();
  if (next?.kind === MediaTokenKind.Identifier && /^x\d+$/i.test(next.text)) {
    const tok = c.eat(MediaTokenKind.Identifier);
    const height = Number(tok.text.slice(1));
    return {
      width: w.value,
      height,
      start: w.start,
      length: (tok.start + tok.length) - (w.start || 0),
      diagnostics: [...w.diagnostics],
    };
  }
  if (next?.kind === MediaTokenKind.Identifier && next.text.toLowerCase() === 'x') {
    c.eat(MediaTokenKind.Identifier);
    const h = parseNumber(c, 'height');
    return {
      width: w.value,
      height: h.value,
      start: w.start,
      length: (h.start + h.length) - (w.start || 0),
      diagnostics: [...w.diagnostics, ...h.diagnostics],
    };
  }
  const x = c.expect(MediaTokenKind.Punctuation, 'x', "'x'");
  const h = parseNumber(c, 'height');
  return {
    width: w.value,
    height: h.value,
    start: w.start,
    length: (h.start + h.length) - (w.start || 0),
    diagnostics: [...w.diagnostics, ...x.diagnostics, ...h.diagnostics],
  };
}

function parseFrames(c) {
  const frames = [];
  const diagnostics = [];
  const first = parseNumber(c, 'a frame index');
  diagnostics.push(...first.diagnostics);
  if (!first.diagnostics.length) frames.push(first.value);
  while (c.eat(MediaTokenKind.Punctuation, ',')) {
    const n = parseNumber(c, 'a frame index');
    diagnostics.push(...n.diagnostics);
    if (!n.diagnostics.length) frames.push(n.value);
  }
  return { frames, diagnostics };
}

function parseAnimation(c) {
  const name = parseName(c);
  const diagnostics = [...name.diagnostics];
  let frames = [];
  let every = 1;
  let everySpan = name;
  const block = parseBlock(c, (inner) => {
    const field = inner.eat(MediaTokenKind.Identifier);
    if (!field) {
      inner.skipTo(['}']);
      return { skip: true, diagnostics: [inner.report(inner.syntax, 'expected a field', inner.at())] };
    }
    if (!ANIM_FIELDS.has(field.text)) {
      inner.skipTo(['}', 'source', 'size', 'transparent', 'animation', 'frames', 'every']);
      return { skip: true, diagnostics: [inner.report(inner.unknown, `unknown field '${field.text}'`, field)] };
    }
    if (field.text === 'frames') return { kind: 'frames', ...parseFrames(inner) };
    if (field.text === 'every') {
      const n = parseNumber(inner, 'a frame interval');
      return { kind: 'every', value: n.value, start: n.start, length: n.length, diagnostics: n.diagnostics };
    }
    return { skip: true, diagnostics: [] };
  });
  diagnostics.push(...block.diagnostics);
  for (const item of block.body) {
    if (item.kind === 'frames') frames = item.frames;
    if (item.kind === 'every') {
      every = item.value;
      everySpan = item;
    }
  }
  return {
    name: name.name,
    frames,
    every,
    start: name.start,
    length: name.length,
    everyStart: everySpan.start,
    everyLength: everySpan.length,
    diagnostics,
  };
}

function parseSprite(c, keyword) {
  const name = parseName(c);
  const diagnostics = [...name.diagnostics];
  const sprite = {
    name: name.name,
    source: null,
    width: 0,
    height: 0,
    transparent: 'auto',
    animations: [],
    start: keyword.start,
    length: name.length,
    sourceStart: keyword.start,
    sourceLength: keyword.length,
    sizeStart: keyword.start,
    sizeLength: keyword.length,
  };
  const block = parseBlock(c, (inner) => {
    const field = inner.eat(MediaTokenKind.Identifier);
    if (!field) {
      inner.skipTo(['}']);
      return { skip: true, diagnostics: [inner.report(inner.syntax, 'expected a field', inner.at())] };
    }
    if (field.text === 'animation') return { kind: 'animation', ...parseAnimation(inner) };
    if (!SPRITE_FIELDS.has(field.text)) {
      return { skip: true, diagnostics: [inner.report(inner.unknown, `unknown field '${field.text}'`, field)] };
    }
    if (field.text === 'source') {
      const s = parseString(inner, 'a source path');
      return { kind: 'source', value: s.value, start: s.start, length: s.length, diagnostics: s.diagnostics };
    }
    if (field.text === 'size') {
      const s = parseSize(inner);
      return { kind: 'size', ...s };
    }
    if (field.text === 'transparent') {
      if (inner.at()?.kind === MediaTokenKind.Identifier && inner.at().text === 'auto') {
        const tok = inner.eat(MediaTokenKind.Identifier);
        return { kind: 'transparent', value: 'auto', start: tok.start, length: tok.length, diagnostics: [] };
      }
      const n = parseNumber(inner, 'a transparent index or auto');
      return { kind: 'transparent', value: n.value, start: n.start, length: n.length, diagnostics: n.diagnostics };
    }
    return { skip: true, diagnostics: [] };
  });
  diagnostics.push(...block.diagnostics);
  for (const item of block.body) {
    if (item.kind === 'source') {
      sprite.source = item.value;
      sprite.sourceStart = item.start;
      sprite.sourceLength = item.length;
    }
    if (item.kind === 'size') {
      sprite.width = item.width;
      sprite.height = item.height;
      sprite.sizeStart = item.start;
      sprite.sizeLength = item.length;
    }
    if (item.kind === 'transparent') sprite.transparent = item.value;
    if (item.kind === 'animation') sprite.animations.push(item);
  }
  sprite.diagnostics = diagnostics;
  return sprite;
}

/**
 * @returns {{ gir: object, diagnostics: object[] }}
 */
export function parseGraphics(tokens, text, file) {
  const c = cursor(tokens, text, file, '.8bg');
  const diagnostics = [];
  const sprites = [];
  while (!c.done()) {
    const kw = c.eat(MediaTokenKind.Identifier);
    if (!kw) {
      diagnostics.push(c.report(c.syntax, 'expected a declaration', c.at()));
      c.skipTo([]);
      break;
    }
    if (kw.text === 'sprite') {
      const sprite = parseSprite(c, kw);
      diagnostics.push(...sprite.diagnostics);
      delete sprite.diagnostics;
      sprites.push(sprite);
      continue;
    }
    diagnostics.push(c.report(c.unknown, `'${kw.text}' is not a graphics declaration in this slice (sprite)`, kw));
    c.skipTo(['sprite', 'tile', 'font']);
  }
  return {
    gir: { sprites, tiles: [], fonts: [] },
    diagnostics,
  };
}
