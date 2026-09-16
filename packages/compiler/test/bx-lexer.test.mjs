import assert from 'node:assert/strict';
import test from 'node:test';

import { TokenKind, tokenize } from '../index.mjs';

test('in .8bx, comparison and shift operators keep their .8bs meaning', () => {
  const src = 'let ok: bool = a < b;\nlet n: u8 = x << 2;\nlet t: array<u8, 4>;';
  const { tokens, diagnostics } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  assert.deepEqual(diagnostics, []);
  const lt = tokens.find((t) => t.text === '<' && tokens[tokens.indexOf(t) + 1]?.text !== '<');
  const shift = tokens.find((t) => t.text === '<<');
  assert.ok(lt);
  assert.ok(shift);
});

test('`component` is a keyword in .8bx and an ordinary name in .8bs (spec §129: .8bs unchanged)', () => {
  const bs = tokenize('let component: u8 = 1;', 't.8bs', { sourceKind: '.8bs' });
  assert.deepEqual(bs.diagnostics, []);
  assert.equal(bs.tokens.find((t) => t.text === 'component').kind, TokenKind.Identifier);
  const bx = tokenize('component Foo() { }', 't.8bx', { sourceKind: '.8bx' });
  assert.equal(bx.tokens.find((t) => t.text === 'component').kind, TokenKind.Keyword);
  // No source kind at all is .8bs.
  assert.equal(tokenize('let component: u8 = 1;', 't.8bs').tokens.find((t) => t.text === 'component').kind, TokenKind.Identifier);
});

// The §121 matrix: what the lexer's tag/children/expression modes make of
// each shape, and that ordinary 8BitScript lexes the same in `.8bx`.
const kinds = (src) => tokenize(src, 't.8bx', { sourceKind: '.8bx' }).tokens.map((t) => `${t.kind}:${t.text}`);

test('a tag opens where a value could not be, and only there (§14, §17)', () => {
  assert.deepEqual(kinds('<Foo />'), ['bxTagOpen:<', 'identifier:Foo', 'bxSelfClose:/>']);
  assert.deepEqual(kinds('return <Foo />;').slice(0, 2), ['keyword:return', 'bxTagOpen:<']);
  assert.deepEqual(kinds('if (x) <Foo />;')[4], 'bxTagOpen:<', 'a control header\'s `)` leaves no value');
  assert.deepEqual(kinds('f(x) < y')[4], 'operator:<', 'a call\'s `)` does');
  assert.deepEqual(kinds('a < b'), ['identifier:a', 'operator:<', 'identifier:b']);
  assert.deepEqual(kinds('a<b'), ['identifier:a', 'operator:<', 'identifier:b']);
  assert.deepEqual(kinds('x << 2')[1], 'operator:<<');
  assert.deepEqual(kinds('x <= 2')[1], 'operator:<=');
  assert.deepEqual(kinds('let t: array<u8, 4>;')[4], 'operator:<');
  assert.deepEqual(kinds('let p: ptr<u8>;')[4], 'operator:<');
  assert.deepEqual(kinds('<Foo value={a < b} />')[6], 'operator:<', 'inside {} a `<` is a comparison');
  assert.deepEqual(kinds('{c ? <A /> : <B />}')[3], 'bxTagOpen:<', 'after `?` an element');
  assert.deepEqual(kinds('{c ? <A /> : <B />}')[7], 'bxTagOpen:<', 'after `:` an element');
});

test('a tag holds names, `=`, strings and {expressions}; children hold raw text, `{` and nested tags (§15, §16)', () => {
  assert.deepEqual(kinds('<Foo a="s" b={1} c />'), [
    'bxTagOpen:<', 'identifier:Foo', 'identifier:a', 'operator:=', 'string:"s"',
    'identifier:b', 'operator:=', 'punctuation:{', 'number:1', 'punctuation:}', 'identifier:c', 'bxSelfClose:/>',
  ]);
  assert.deepEqual(kinds('<Studio.Window />').slice(1, 4), ['identifier:Studio', 'punctuation:.', 'identifier:Window']);
  assert.deepEqual(kinds('<T>a > b // not a comment; don\'t {n}</T>'), [
    'bxTagOpen:<', 'identifier:T', 'bxTagEnd:>',
    "bxText:a > b // not a comment; don't ", 'punctuation:{', 'identifier:n', 'punctuation:}',
    'bxClosingTagOpen:</', 'identifier:T', 'bxTagEnd:>',
  ]);
  assert.deepEqual(kinds('<A><B /></A>'), [
    'bxTagOpen:<', 'identifier:A', 'bxTagEnd:>', 'bxTagOpen:<', 'identifier:B', 'bxSelfClose:/>',
    'bxClosingTagOpen:</', 'identifier:A', 'bxTagEnd:>',
  ]);
  assert.deepEqual(kinds('<>\n<A/>\n</>'), [
    'bxTagOpen:<', 'bxTagEnd:>', 'bxText:\n', 'bxTagOpen:<', 'identifier:A', 'bxSelfClose:/>', 'bxText:\n',
    'bxClosingTagOpen:</', 'bxTagEnd:>',
  ]);
  // Braces nest inside an expression; the `}` that returns to the tag is the matching one.
  assert.deepEqual(kinds('<C v={a[f(x) + 1]} />').slice(-1), ['bxSelfClose:/>']);
  // A template with `${}` inside an attribute expression is one token, as anywhere.
  assert.deepEqual(kinds('<C v={`n ${n}`} />')[5], 'template:`n ${n}`');
  // A comment in braces is a comment token, and text after a tag is text.
  assert.deepEqual(kinds('<A>{/* c */}</A>')[4], 'comment:/* c */');
  // After the element the grammar is ordinary again.
  assert.deepEqual(kinds('<A />; let x: u8 = 1;').slice(3), ['operator:;', 'keyword:let', 'identifier:x', 'operator::', 'type:u8', 'operator:=', 'number:1', 'operator:;']);
});

test('half-typed markup ends with one diagnostic per open frame, at the `<` that opened it, and the lexer stops (§90)', () => {
  const diags = (src) => tokenize(src, 't.8bx', { sourceKind: '.8bx' }).diagnostics.map((d) => `${d.code}@${d.start}:${d.message}`);
  assert.deepEqual(diags('<Foo'), ['8BS1039@0:unterminated tag']);
  assert.deepEqual(diags('<Foo>'), ['8BS1039@0:unclosed element']);
  assert.deepEqual(diags('<Foo><Bar'), ['8BS1039@0:unclosed element', '8BS1039@5:unterminated tag']);
  assert.deepEqual(diags('<Foo a={'), ["8BS1005@7:unclosed '{'", '8BS1039@0:unterminated tag']);
  assert.deepEqual(diags('<Foo #x />'), ["8BS1039@5:unexpected '#' inside a tag"]);
  // asm6502 has no place in a tag or between tags; in an expression it is the ordinary block token.
  assert.equal(kinds('<A v={asm6502 { nop }} />')[5], 'keyword:asm6502');
});

test('an .8bs file never enters a mode: `<` is always an operator there', () => {
  const bs = tokenize('<Foo />', 't.8bs').tokens.map((t) => t.kind);
  assert.ok(!bs.includes(TokenKind.BxTagOpen));
});
