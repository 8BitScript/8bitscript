// `frames(...)` — the compile-time duration builtin — and the decimal
// literal syntax (`0.5`) that feeds it. Covers the lexer's decimal-literal
// recognition, the parser's DecimalLiteral node, the fold pass
// (packages/compiler/src/fold), and the diagnostics it and the checker's
// reserved-name rule produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, link, tokenize, parse, foldDurations, NodeType,
  DURATION_CLOCKS, DURATION_UNITS, getHoverInfo,
} from '../index.mjs';

const codes = (src, options) => analyze(src, 't.8bs', options).map((d) => d.code);
const clean = (src, options) => assert.deepEqual(codes(src, options), []);
const program = (call) => `let x: utinyint = ${call};\nexport function main(): void {}`;

// ---- lexer: decimal literals -----------------------------------------------

test('lexer: 0.5 is a decimal literal token with an exact numerator/denominator', () => {
  const [token] = tokenize('0.5', 't').tokens;
  assert.equal(token.kind, 'number');
  assert.equal(token.isDecimal, true);
  assert.equal(token.numerator, 5);
  assert.equal(token.denominator, 10);
});

test('lexer: 123.45 reduces to numerator/denominator, not lowest terms required', () => {
  const [token] = tokenize('123.45', 't').tokens;
  assert.equal(token.numerator, 12345);
  assert.equal(token.denominator, 100);
});

test('lexer: a trailing dot with no digit after it is not a decimal literal', () => {
  const { tokens } = tokenize('1.', 't');
  assert.equal(tokens[0].kind, 'number');
  assert.equal(tokens[0].isDecimal, undefined);
  assert.equal(tokens[0].value, 1);
  assert.equal(tokens[1].kind, 'operator');
  assert.equal(tokens[1].text, '.');
});

test('lexer: hex/binary literals never become decimal, even followed by a dot', () => {
  for (const src of ['$FF.5', '0x1.5', '%101.5', '0b1.5']) {
    const [token] = tokenize(src, 't').tokens;
    assert.equal(token.isDecimal, undefined, `${src} should not lex as decimal`);
  }
});

// ---- parser: DecimalLiteral -------------------------------------------------

test('parser: frames(0.5, seconds) parses the first argument as a DecimalLiteral', () => {
  const { tokens } = tokenize('frames(0.5, seconds);', 't');
  const { ast } = parse(tokens, 'frames(0.5, seconds);', 't');
  const call = ast.body[0].expression;
  assert.equal(call.type, NodeType.CallExpression);
  assert.equal(call.args[0].type, NodeType.DecimalLiteral);
  assert.equal(call.args[0].numerator, 5);
  assert.equal(call.args[0].denominator, 10);
  assert.equal(call.args[1].type, NodeType.Identifier);
});

test('parser: a decimal literal in a type argument position is a syntax error, not a crash', () => {
  const { tokens } = tokenize('let x: array<u8, 0.5>;', 't');
  const { diagnostics } = parse(tokens, 'let x: array<u8, 0.5>;', 't');
  assert.ok(diagnostics.length > 0);
});

// ---- fold: frames(..., seconds) ---------------------------------------------

test('fold: frames is the only clock and seconds the only unit', () => {
  assert.deepEqual([...DURATION_CLOCKS.keys()], ['frames']);
  assert.deepEqual([...DURATION_UNITS.keys()], ['seconds']);
});

test('fold: frames(0.5, seconds) is exact at the default frameRate (60) and at 50', () => {
  clean('let x: utinyint = frames(0.5, seconds);');
  clean('let x: utinyint = frames(0.5, seconds);', { frameRate: 50 });

  const at60 = link(program('frames(0.5, seconds)'), 't');
  assert.deepEqual(at60.diagnostics, []);
  assert.equal(at60.ir.globals[0].init, 30);

  const at50 = link(program('frames(0.5, seconds)'), 't', { frameRate: 50 });
  assert.deepEqual(at50.diagnostics, []);
  assert.equal(at50.ir.globals[0].init, 25);
});

test('fold: frames(1, seconds) is exact at any integer frameRate', () => {
  const at7 = link('let x: uint = frames(1, seconds);\nexport function main(): void {}', 't', { frameRate: 7 });
  assert.deepEqual(at7.diagnostics, []);
  assert.equal(at7.ir.globals[0].init, 7);
});

test('fold: frames(...) that overflows the declared type gets the existing width diagnostic, folded first', () => {
  assert.deepEqual(codes('let x: utinyint = frames(100, seconds);'), ['8BS1021']);
});

test('fold: frames(...) rounding to zero frames is an error', () => {
  assert.deepEqual(codes('let x: utinyint = frames(0.001, seconds);'), ['8BS1023']);
});

test('fold: an inexact frames(...) is a warning naming the rounded value', () => {
  const d = analyze('let x: utinyint = frames(0.5, seconds);', 't.8bs', { frameRate: 7 });
  assert.equal(d.length, 1);
  assert.equal(d[0].code, '8BS1024');
  assert.equal(d[0].severity, 'warning');
  assert.match(d[0].message, /frames\(0\.5, seconds\) is not exact .* rounded to 4 frames/);
});

// ---- fold: the unit argument -------------------------------------------------

test('fold: the unit is required — frames(30) is the shape diagnostic, not thirty frames', () => {
  const [d] = analyze('let x: utinyint = frames(30);', 't.8bs');
  assert.equal(d.code, '8BS1022');
  assert.match(d.message, /the unit it is measured in/);
  assert.match(d.message, /frames\(0\.5, seconds\)/);
});

test('fold: an unknown unit is its own diagnostic, at the unit word, naming the units that exist', () => {
  const src = 'let x: utinyint = frames(0.5, minutes);';
  const d = analyze(src, 't.8bs');
  assert.equal(d.length, 1, 'no cascade — the decimal literal is consumed, not re-flagged');
  assert.equal(d[0].code, '8BS1025');
  assert.equal(d[0].start, src.indexOf('minutes)'));
  assert.equal(d[0].length, 'minutes'.length);
  assert.match(d[0].message, /'minutes' is not a unit/);
  assert.match(d[0].message, /the units are seconds/);
});

test('fold: the unit word is matched by spelling — SECONDS is not seconds', () => {
  assert.deepEqual(codes('let x: utinyint = frames(0.5, SECONDS);'), ['8BS1025']);
});

test('fold: a unit in the wrong position, a non-identifier unit, or a third argument is the shape diagnostic', () => {
  assert.deepEqual(codes('let x: utinyint = frames(seconds);'), ['8BS1022']);
  assert.deepEqual(codes('let x: utinyint = frames(seconds, 0.5);'), ['8BS1022']);
  assert.deepEqual(codes('let x: utinyint = frames(0.5, 60);'), ['8BS1022']);
  assert.deepEqual(codes('let x: utinyint = frames(0.5, seconds, 1);'), ['8BS1022']);
});

test('fold: frames() with the wrong argument shape is one clear diagnostic, not a cascade', () => {
  assert.deepEqual(codes('let x: utinyint = frames();'), ['8BS1022']);
  assert.deepEqual(codes('let x: utinyint = frames(1, 2);'), ['8BS1022']);
  assert.deepEqual(codes('let y: utinyint = 1;\nlet x: utinyint = frames(y, seconds);'), ['8BS1022']);
});

test('fold: foldDurations consumes the unit word so the linker never tries to resolve it', () => {
  const { diagnostics } = link(program('frames(0.5, seconds)'), 't');
  assert.deepEqual(diagnostics, []);
});

test('fold: a bare decimal literal outside frames(...) is misplaced', () => {
  const [d] = analyze('let x: u8 = 0.5;', 't.8bs');
  assert.equal(d.code, '8BS1009');
  assert.match(d.message, /frames\(\.\.\.\)/);
});

test('fold: foldDurations mutates the call node into a plain IntegerLiteral in place', () => {
  const src = 'frames(0.5, seconds);';
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  const before = ast.body[0].expression;
  assert.equal(before.type, NodeType.CallExpression);
  foldDurations(ast, 't', 60);
  const after = ast.body[0].expression;
  assert.equal(after, before, 'same node object, mutated in place');
  assert.equal(after.type, NodeType.IntegerLiteral);
  assert.equal(after.value, 30);
  assert.equal(after.callee, undefined);
  assert.equal(after.args, undefined);
});

// ---- hover ------------------------------------------------------------------

test('hover explains frames(...)', () => {
  const text = 'let x: utinyint = frames(0.5, seconds);';
  const info = getHoverInfo(text, text.indexOf('frames') + 1);
  assert.ok(info);
  assert.match(info.markdown, /\*\*frames\(n, unit\)\*\*/);
  assert.match(info.markdown, /frameRate/);
});

test('hover explains seconds only in the unit slot of frames(...)', () => {
  const text = 'let x: utinyint = frames(0.5, seconds);';
  const info = getHoverInfo(text, text.indexOf('seconds') + 1);
  assert.ok(info);
  assert.match(info.markdown, /\*\*seconds\*\*/);
  assert.match(info.markdown, /unit for `frames\(\.\.\.\)`/);

  const plain = 'let seconds: utinyint = 3;';
  assert.equal(getHoverInfo(plain, plain.indexOf('seconds') + 1), null, 'a declared seconds is not the unit');
});

// ---- checker: 'frames' is reserved; 'seconds' is not ------------------------

test('reserved name: declaring or importing "frames" is a diagnostic, not silent shadowing', () => {
  const [d] = analyze('let frames: u8 = 60;', 't.8bs');
  assert.equal(d.code, '8BS2009');
  assert.match(d.message, /duration clock, frames\(\.\.\., seconds\)/);
  assert.deepEqual(codes('function frames(n: uint): uint { return n; }'), ['8BS2009']);
  assert.deepEqual(codes('import { frames } from "./x.8bs";'), ['8BS2009']);
  assert.deepEqual(codes('function f(frames: u8): void { }'), ['8BS2009']);
});

test('not reserved: the unit word "seconds" is an ordinary name everywhere but the unit slot', () => {
  clean('let seconds: u8 = 1;');
  clean('function seconds(n: uint): uint { return n; }');
  clean('function f(seconds: u8): void { }');
  // Declaring it and using the unit in the same program are independent.
  clean('let seconds: u8 = 3;\nlet x: utinyint = frames(0.5, seconds);');
});
