// `.8ba` parser. Never throws. Produces AIR: instruments, samples, songs,
// plus empty slots (parts, voiceGroups) the later slices fill.
import { Codes } from '../../diagnostics/index.mjs';
import { MediaTokenKind } from '../lexer.mjs';
import { cursor, parseName, parseString, parseNumber, parseBlock } from '../cursor.mjs';

const WAVEFORMS = new Set(['pulse', 'triangle', 'saw', 'noise']);
const NOTES = (() => {
  const names = ['C', 'CS', 'D', 'DS', 'E', 'F', 'FS', 'G', 'GS', 'A', 'AS', 'B'];
  const map = new Map();
  for (let oct = 0; oct <= 6; oct += 1) {
    names.forEach((n, s) => map.set(`${n}${oct}`, oct * 12 + s));
  }
  return map;
})();

function parseWaveform(c) {
  const tok = c.eat(MediaTokenKind.Identifier);
  if (!tok) {
    return { value: 'pulse', diagnostics: [c.report(c.syntax, 'expected a waveform', c.at())] };
  }
  if (!WAVEFORMS.has(tok.text)) {
    return {
      value: 'pulse',
      diagnostics: [c.report(Codes.AUD_UNKNOWN_WAVEFORM, `unknown waveform '${tok.text}'`, tok)],
      start: tok.start,
      length: tok.length,
    };
  }
  return { value: tok.text, start: tok.start, length: tok.length, diagnostics: [] };
}

function parseInstrument(c, keyword) {
  const name = parseName(c);
  const diagnostics = [...name.diagnostics];
  const inst = {
    name: name.name,
    waveform: 'pulse',
    polyphony: 1,
    start: keyword.start,
    length: name.length,
  };
  const block = parseBlock(c, (inner) => {
    const field = inner.eat(MediaTokenKind.Identifier);
    if (!field) {
      inner.skipTo(['}']);
      return { skip: true, diagnostics: [inner.report(inner.syntax, 'expected a field', inner.at())] };
    }
    if (field.text === 'waveform') {
      const w = parseWaveform(inner);
      return { kind: 'waveform', ...w };
    }
    if (field.text === 'polyphony') {
      const n = parseNumber(inner, 'polyphony');
      return { kind: 'polyphony', value: n.value, diagnostics: n.diagnostics };
    }
    return { skip: true, diagnostics: [inner.report(inner.unknown, `unknown field '${field.text}'`, field)] };
  });
  diagnostics.push(...block.diagnostics);
  for (const item of block.body) {
    if (item.kind === 'waveform') inst.waveform = item.value;
    if (item.kind === 'polyphony') inst.polyphony = item.value;
  }
  inst.diagnostics = diagnostics;
  return inst;
}

function parseFallback(c) {
  const diagnostics = [];
  const open = c.expect(MediaTokenKind.Punctuation, '{', "'{'");
  diagnostics.push(...open.diagnostics);
  let synth = 'noise';
  if (c.at()?.kind === MediaTokenKind.Identifier && c.at().text === 'synth') {
    c.eat(MediaTokenKind.Identifier);
    const w = parseWaveform(c);
    diagnostics.push(...w.diagnostics);
    synth = w.value;
  } else if (!c.done() && c.at().text !== '}') {
    diagnostics.push(c.report(c.syntax, "expected 'synth <waveform>'", c.at()));
  }
  const close = c.expect(MediaTokenKind.Punctuation, '}', "'}'");
  diagnostics.push(...close.diagnostics);
  return { synth, diagnostics, start: open.tok.start, length: (close.tok.length ?? 0) };
}

function parseSample(c, keyword) {
  const name = parseName(c);
  const diagnostics = [...name.diagnostics];
  const sample = {
    name: name.name,
    source: null,
    fallback: null,
    start: keyword.start,
    length: name.length,
    sourceStart: keyword.start,
    sourceLength: keyword.length,
    fallbackStart: keyword.start,
    fallbackLength: keyword.length,
  };
  const block = parseBlock(c, (inner) => {
    const field = inner.eat(MediaTokenKind.Identifier);
    if (!field) {
      inner.skipTo(['}']);
      return { skip: true, diagnostics: [inner.report(inner.syntax, 'expected a field', inner.at())] };
    }
    if (field.text === 'source') {
      const s = parseString(inner, 'a source path');
      return { kind: 'source', value: s.value, start: s.start, length: s.length, diagnostics: s.diagnostics };
    }
    if (field.text === 'fallback') {
      const f = parseFallback(inner);
      return { kind: 'fallback', synth: f.synth, start: field.start, length: field.length, diagnostics: f.diagnostics };
    }
    return { skip: true, diagnostics: [inner.report(inner.unknown, `unknown field '${field.text}'`, field)] };
  });
  diagnostics.push(...block.diagnostics);
  for (const item of block.body) {
    if (item.kind === 'source') {
      sample.source = item.value;
      sample.sourceStart = item.start;
      sample.sourceLength = item.length;
    }
    if (item.kind === 'fallback') {
      sample.fallback = { synth: item.synth };
      sample.fallbackStart = item.start;
      sample.fallbackLength = item.length;
    }
  }
  sample.diagnostics = diagnostics;
  return sample;
}

function parseNote(c) {
  const tok = c.eat(MediaTokenKind.Identifier);
  if (!tok) {
    return { value: 0, diagnostics: [c.report(c.syntax, 'expected a note (C4, G4, …)', c.at())] };
  }
  const value = NOTES.get(tok.text.toUpperCase());
  if (value === undefined) {
    return {
      value: 0,
      start: tok.start,
      length: tok.length,
      diagnostics: [c.report(Codes.AUD_UNKNOWN_NOTE, `unknown note '${tok.text}'`, tok)],
    };
  }
  return { value, start: tok.start, length: tok.length, diagnostics: [] };
}

function parseRow(c) {
  const n = parseNumber(c, 'a row number');
  const diagnostics = [...n.diagnostics];
  const row = { row: n.value, note: null, instrument: null, start: n.start, length: n.length };
  const block = parseBlock(c, (inner) => {
    const field = inner.eat(MediaTokenKind.Identifier);
    if (!field) {
      inner.skipTo(['}']);
      return { skip: true, diagnostics: [inner.report(inner.syntax, 'expected a field', inner.at())] };
    }
    if (field.text === 'note') {
      const note = parseNote(inner);
      inner.eat(MediaTokenKind.Punctuation, ';');
      return { kind: 'note', value: note.value, start: note.start, length: note.length, diagnostics: note.diagnostics };
    }
    if (field.text === 'instrument') {
      const name = parseName(inner);
      inner.eat(MediaTokenKind.Punctuation, ';');
      return { kind: 'instrument', value: name.name, start: name.start, length: name.length, diagnostics: name.diagnostics };
    }
    return { skip: true, diagnostics: [inner.report(inner.unknown, `unknown field '${field.text}'`, field)] };
  });
  diagnostics.push(...block.diagnostics);
  for (const item of block.body) {
    if (item.kind === 'note') row.note = item.value;
    if (item.kind === 'instrument') row.instrument = item.value;
  }
  row.diagnostics = diagnostics;
  return row;
}

function parseTrack(c) {
  const name = parseName(c);
  const diagnostics = [...name.diagnostics];
  const rows = [];
  const block = parseBlock(c, (inner) => {
    const field = inner.eat(MediaTokenKind.Identifier);
    if (!field) {
      inner.skipTo(['}']);
      return { skip: true, diagnostics: [inner.report(inner.syntax, 'expected a field', inner.at())] };
    }
    if (field.text === 'row') return { kind: 'row', ...parseRow(inner) };
    return { skip: true, diagnostics: [inner.report(inner.unknown, `unknown field '${field.text}'`, field)] };
  });
  diagnostics.push(...block.diagnostics);
  for (const item of block.body) {
    if (item.kind === 'row') {
      diagnostics.push(...(item.diagnostics ?? []));
      rows.push(item);
    }
  }
  return { name: name.name, rows, start: name.start, length: name.length, diagnostics };
}

function parsePattern(c) {
  const name = parseName(c);
  const diagnostics = [...name.diagnostics];
  let length = 16;
  if (c.at()?.kind === MediaTokenKind.Identifier && c.at().text === 'length') {
    c.eat(MediaTokenKind.Identifier);
    const n = parseNumber(c, 'pattern length');
    diagnostics.push(...n.diagnostics);
    length = n.value;
  }
  const tracks = [];
  const block = parseBlock(c, (inner) => {
    const field = inner.eat(MediaTokenKind.Identifier);
    if (!field) {
      inner.skipTo(['}']);
      return { skip: true, diagnostics: [inner.report(inner.syntax, 'expected a field', inner.at())] };
    }
    if (field.text === 'track') return { kind: 'track', ...parseTrack(inner) };
    return { skip: true, diagnostics: [inner.report(inner.unknown, `unknown field '${field.text}'`, field)] };
  });
  diagnostics.push(...block.diagnostics);
  for (const item of block.body) {
    if (item.kind === 'track') {
      diagnostics.push(...(item.diagnostics ?? []));
      tracks.push(item);
    }
  }
  return { name: name.name, length, tracks, start: name.start, lengthSpan: name.length, diagnostics };
}

function parseOrder(c) {
  const diagnostics = [];
  const names = [];
  const open = c.expect(MediaTokenKind.Punctuation, '{', "'{'");
  diagnostics.push(...open.diagnostics);
  while (!c.done() && c.at().text !== '}') {
    const n = parseName(c);
    diagnostics.push(...n.diagnostics);
    if (n.name) names.push(n.name);
    c.eat(MediaTokenKind.Punctuation, ',');
  }
  const close = c.expect(MediaTokenKind.Punctuation, '}', "'}'");
  diagnostics.push(...close.diagnostics);
  return { names, diagnostics };
}

function parseSong(c, keyword) {
  const name = parseName(c);
  const diagnostics = [...name.diagnostics];
  const song = {
    name: name.name,
    tempo: 120,
    speed: 6,
    order: [],
    patterns: [],
    start: keyword.start,
    length: name.length,
  };
  const block = parseBlock(c, (inner) => {
    const field = inner.eat(MediaTokenKind.Identifier);
    if (!field) {
      inner.skipTo(['}']);
      return { skip: true, diagnostics: [inner.report(inner.syntax, 'expected a field', inner.at())] };
    }
    if (field.text === 'tempo') {
      const n = parseNumber(inner, 'tempo');
      return { kind: 'tempo', value: n.value, diagnostics: n.diagnostics };
    }
    if (field.text === 'speed') {
      const n = parseNumber(inner, 'speed');
      return { kind: 'speed', value: n.value, diagnostics: n.diagnostics };
    }
    if (field.text === 'order') return { kind: 'order', ...parseOrder(inner) };
    if (field.text === 'pattern') return { kind: 'pattern', ...parsePattern(inner) };
    return { skip: true, diagnostics: [inner.report(inner.unknown, `unknown field '${field.text}'`, field)] };
  });
  diagnostics.push(...block.diagnostics);
  for (const item of block.body) {
    if (item.kind === 'tempo') song.tempo = item.value;
    if (item.kind === 'speed') song.speed = item.value;
    if (item.kind === 'order') song.order = item.names;
    if (item.kind === 'pattern') {
      diagnostics.push(...(item.diagnostics ?? []));
      song.patterns.push(item);
    }
  }
  song.diagnostics = diagnostics;
  return song;
}

/**
 * @returns {{ air: object, diagnostics: object[] }}
 */
export function parseAudio(tokens, text, file) {
  const c = cursor(tokens, text, file, '.8ba');
  const diagnostics = [];
  const instruments = [];
  const samples = [];
  const songs = [];
  while (!c.done()) {
    const kw = c.eat(MediaTokenKind.Identifier);
    if (!kw) {
      diagnostics.push(c.report(c.syntax, 'expected a declaration', c.at()));
      break;
    }
    if (kw.text === 'instrument') {
      const inst = parseInstrument(c, kw);
      diagnostics.push(...inst.diagnostics);
      delete inst.diagnostics;
      instruments.push(inst);
      continue;
    }
    if (kw.text === 'sample') {
      const sample = parseSample(c, kw);
      diagnostics.push(...sample.diagnostics);
      delete sample.diagnostics;
      samples.push(sample);
      continue;
    }
    if (kw.text === 'song') {
      const song = parseSong(c, kw);
      diagnostics.push(...song.diagnostics);
      delete song.diagnostics;
      songs.push(song);
      continue;
    }
    if (kw.text === 'target') {
      diagnostics.push(c.report(c.unknown, `unknown target block '${kw.text}': target blocks are not in this slice`, kw));
      c.skipTo(['instrument', 'sample', 'song', 'target']);
      continue;
    }
    diagnostics.push(c.report(c.unknown, `'${kw.text}' is not an audio declaration in this slice (instrument, sample, song)`, kw));
    c.skipTo(['instrument', 'sample', 'song']);
  }
  return {
    air: { instruments, samples, songs, parts: [], voiceGroups: [] },
    diagnostics,
  };
}

export { NOTES, WAVEFORMS };
