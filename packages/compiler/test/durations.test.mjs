// `seconds(...)` — the compile-time duration builtin — and the decimal
// literal syntax (`0.5`) that feeds it. Covers the lexer's decimal-literal
// recognition, the parser's DecimalLiteral node, the fold pass
// (packages/compiler/src/fold), and the diagnostics it and the checker's
// reserved-name rule produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, link, tokenize, parse, foldDurations, NodeType,
  DURATION_CLOCKS, DEFAULT_DURATION_CLOCK, getHoverInfo,
} from '../index.mjs';

const codes = (src, options) => analyze(src, 't.8bs', options).map((d) => d.code);
const clean = (src, options) => assert.deepEqual(codes(src, options), []);

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

test('parser: seconds(0.5) parses the argument as a DecimalLiteral', () => {
  const { tokens } = tokenize('seconds(0.5);', 't');
  const { ast } = parse(tokens, 'seconds(0.5);', 't');
  const call = ast.body[0].expression;
  assert.equal(call.type, NodeType.CallExpression);
  assert.equal(call.args[0].type, NodeType.DecimalLiteral);
  assert.equal(call.args[0].numerator, 5);
  assert.equal(call.args[0].denominator, 10);
});

test('parser: a decimal literal in a type argument position is a syntax error, not a crash', () => {
  const { tokens } = tokenize('let x: array<u8, 0.5>;', 't');
  const { diagnostics } = parse(tokens, 'let x: array<u8, 0.5>;', 't');
  assert.ok(diagnostics.length > 0);
});

// ---- fold: seconds(...) -----------------------------------------------------

test('fold: seconds(0.5) is exact at the default frameRate (60) and at 50', () => {
  clean('let x: utinyint = seconds(0.5);');
  clean('let x: utinyint = seconds(0.5);', { frameRate: 50 });

  const at60 = link('let x: utinyint = seconds(0.5);\nexport function main(): void {}', 't');
  assert.deepEqual(at60.diagnostics, []);
  assert.equal(at60.ir.globals[0].init, 30);

  const at50 = link('let x: utinyint = seconds(0.5);\nexport function main(): void {}', 't', { frameRate: 50 });
  assert.deepEqual(at50.diagnostics, []);
  assert.equal(at50.ir.globals[0].init, 25);
});

test('fold: seconds(1) is exact at any integer frameRate', () => {
  const at7 = link('let x: uint = seconds(1);\nexport function main(): void {}', 't', { frameRate: 7 });
  assert.deepEqual(at7.diagnostics, []);
  assert.equal(at7.ir.globals[0].init, 7);
});

// ---- fold: the clock argument --------------------------------------------------

test('fold: FRAMES is the only clock and the default one', () => {
  assert.deepEqual([...DURATION_CLOCKS.keys()], ['FRAMES']);
  assert.equal(DEFAULT_DURATION_CLOCK, 'FRAMES');
});

test('fold: seconds(0.5, FRAMES) is the same duration as seconds(0.5), at 60 and at 50', () => {
  const program = (call) => `let x: utinyint = ${call};\nexport function main(): void {}`;
  for (const frameRate of [60, 50]) {
    const bare = link(program('seconds(0.5)'), 't', { frameRate });
    const named = link(program('seconds(0.5, FRAMES)'), 't', { frameRate });
    assert.deepEqual(named.diagnostics, []);
    assert.equal(named.ir.globals[0].init, bare.ir.globals[0].init);
    assert.equal(named.ir.globals[0].init, frameRate / 2);
  }
});

test('fold: the clock argument goes through the same zero/inexact checks as the bare form', () => {
  assert.deepEqual(codes('let x: utinyint = seconds(0.001, FRAMES);'), ['8BS1023']);
  const d = analyze('let x: utinyint = seconds(0.5, FRAMES);', 't.8bs', { frameRate: 7 });
  assert.equal(d.length, 1);
  assert.equal(d[0].code, '8BS1024');
  assert.match(d[0].message, /seconds\(0\.5, FRAMES\) is not exact .* rounded to 4 frames/);
});

test('fold: an unknown clock is its own diagnostic, at the clock name, naming the clocks that exist', () => {
  const src = 'let x: utinyint = seconds(0.5, frames);';
  const d = analyze(src, 't.8bs');
  assert.equal(d.length, 1, 'no cascade — the decimal literal is consumed, not re-flagged');
  assert.equal(d[0].code, '8BS1025');
  assert.equal(d[0].start, src.indexOf('frames)'));
  assert.equal(d[0].length, 'frames'.length);
  assert.match(d[0].message, /'frames' is not a clock/);
  assert.match(d[0].message, /FRAMES \(the default\)/);
});

test('fold: a clock in the wrong position, a non-identifier clock, or a third argument is the shape diagnostic', () => {
  assert.deepEqual(codes('let x: utinyint = seconds(FRAMES);'), ['8BS1022']);
  assert.deepEqual(codes('let x: utinyint = seconds(FRAMES, 0.5);'), ['8BS1022']);
  assert.deepEqual(codes('let x: utinyint = seconds(0.5, 60);'), ['8BS1022']);
  assert.deepEqual(codes('let x: utinyint = seconds(0.5, FRAMES, 1);'), ['8BS1022']);
});

test('fold: the shape diagnostic shows the two-argument form too', () => {
  const [d] = analyze('let x: utinyint = seconds();', 't.8bs');
  assert.equal(d.code, '8BS1022');
  assert.match(d.message, /seconds\(0\.5, FRAMES\)/);
});

test('fold: foldDurations consumes the clock identifier so the linker never tries to resolve it', () => {
  const src = 'let x: utinyint = seconds(0.5, FRAMES);\nexport function main(): void {}';
  const { diagnostics } = link(src, 't');
  assert.deepEqual(diagnostics, []);
});

test('hover explains FRAMES', () => {
  const text = 'let x: utinyint = seconds(0.5, FRAMES);';
  const info = getHoverInfo(text, text.indexOf('FRAMES') + 1);
  assert.ok(info);
  assert.match(info.markdown, /\*\*FRAMES\*\*/);
  assert.match(info.markdown, /default/);
});

test('fold: seconds(...) that overflows the declared type gets the existing width diagnostic, folded first', () => {
  assert.deepEqual(codes('let x: utinyint = seconds(100);'), ['8BS1021']);
});

test('fold: seconds(...) rounding to zero frames is an error', () => {
  assert.deepEqual(codes('let x: utinyint = seconds(0.001);'), ['8BS1023']);
});

test('fold: an inexact seconds(...) is a warning naming the rounded value', () => {
  const d = analyze('let x: utinyint = seconds(0.5);', 't.8bs', { frameRate: 7 });
  assert.equal(d.length, 1);
  assert.equal(d[0].code, '8BS1024');
  assert.equal(d[0].severity, 'warning');
  assert.match(d[0].message, /rounded to 4 frames/);
});

test('fold: seconds() with the wrong argument shape is one clear diagnostic, not a cascade', () => {
  assert.deepEqual(codes('let x: utinyint = seconds();'), ['8BS1022']);
  assert.deepEqual(codes('let x: utinyint = seconds(1, 2);'), ['8BS1022']);
  assert.deepEqual(codes('let y: utinyint = 1;\nlet x: utinyint = seconds(y);'), ['8BS1022']);
});

test('fold: a bare decimal literal outside seconds(...) is misplaced', () => {
  assert.deepEqual(codes('let x: u8 = 0.5;'), ['8BS1009']);
});

test('fold: foldDurations mutates the call node into a plain IntegerLiteral in place', () => {
  const src = 'seconds(0.5);';
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

// ---- checker: 'seconds' is a reserved name ----------------------------------

test('reserved name: declaring or importing "seconds" is a diagnostic, not silent shadowing', () => {
  assert.deepEqual(codes('function seconds(n: uint): uint { return n; }'), ['8BS2009']);
  assert.deepEqual(codes('let seconds: u8 = 1;'), ['8BS2009']);
  assert.deepEqual(codes('import { seconds } from "./x.8bs";'), ['8BS2009']);
  assert.deepEqual(codes('function f(seconds: u8): void { }'), ['8BS2009']);
});

test('reserved name: a duration clock ("FRAMES") is reserved the same way', () => {
  const [d] = analyze('let FRAMES: u8 = 60;', 't.8bs');
  assert.equal(d.code, '8BS2009');
  assert.match(d.message, /duration clock, seconds\(\.\.\., FRAMES\)/);
  assert.deepEqual(codes('function FRAMES(): void { }'), ['8BS2009']);
  assert.deepEqual(codes('import { FRAMES } from "./x.8bs";'), ['8BS2009']);
  assert.deepEqual(codes('function f(FRAMES: u8): void { }'), ['8BS2009']);
});
