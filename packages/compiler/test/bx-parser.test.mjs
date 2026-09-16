import assert from 'node:assert/strict';
import test from 'node:test';

import { NodeType, analyze, normalizeBxText, parse, tokenize } from '../index.mjs';

test('parses brace attribute values on elements', () => {
  const src = 'component Hud(score: usmallint, over: bool) { }\nexport function main(): void { <Hud score={score} over={over} />; }\n';
  const { tokens } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  const { diagnostics } = parse(tokens, src, 't.8bx', { sourceKind: '.8bx' });
  assert.equal(diagnostics.filter((d) => d.code === '8BS1039' || d.code === '8BS1101').length, 0);
});

test('parses a self-closing element in .8bx', () => {
  const src = 'component Foo() { }\n<Foo />;\n';
  const { tokens } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  const { ast, diagnostics } = parse(tokens, src, 't.8bx', { sourceKind: '.8bx' });
  assert.deepEqual(diagnostics, []);
  const el = ast.body.find((s) => s.type === NodeType.BxElement);
  assert.equal(el?.name, 'Foo');
  assert.equal(el?.selfClosing, true);
});

test('`export component` parses, and the declaration says so', () => {
  const src = 'export component Foo(x: utinyint = 1) { }\ncomponent Bar() { }\n';
  const { tokens } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  const { ast, diagnostics } = parse(tokens, src, 't.8bx', { sourceKind: '.8bx' });
  assert.deepEqual(diagnostics, []);
  const [foo, bar] = ast.body;
  assert.equal(foo.type, NodeType.ComponentDeclaration);
  assert.equal(foo.exported, true);
  assert.equal(foo.params[0].defaultValue?.value, 1);
  assert.equal(bar.exported, false);
});

test('`let component` still parses in .8bs', () => {
  const src = 'let component: u8 = 1;\nexport function main(): void { component = 2; }\n';
  const { tokens } = tokenize(src, 't.8bs');
  const { diagnostics } = parse(tokens, src, 't.8bs');
  assert.deepEqual(diagnostics, []);
});

test('a diagnostic inside an attribute expression carries the file offset, not the brace\'s', () => {
  // The reason the parser reads tokens rather than re-scanning text: the
  // `}` after `1 +` sits at a known offset of the file, and that is where
  // the syntax diagnostic points; an unknown prop points at its name.
  const src = 'component A(v: utinyint) { }\nexport function main(): void { <A v={1 +} nope={2} />; }\n';
  const diags = analyze(src, 't.8bx', { sourceKind: '.8bx' });
  const syntax = diags.find((d) => d.code === '8BS1101');
  assert.ok(syntax, JSON.stringify(diags));
  assert.equal(syntax.start, src.indexOf('} nope'));
  const prop = diags.find((d) => d.code === '8BS2013');
  assert.ok(prop);
  assert.equal(prop.start, src.indexOf('nope={2}'));
  assert.equal(prop.length, 'nope={2}'.length);
});

test('text children are normalized the JSX way, once, in the parser (§35)', () => {
  assert.equal(normalizeBxText('\n    Hello\n    World!\n'), 'Hello World!');
  assert.equal(normalizeBxText('  one line  '), 'one line');
  assert.equal(normalizeBxText('\n   \n'), '');
  const src = 'component T(children: string) { }\n<T>\n    Hello\n    World!\n</T>;\n';
  const { tokens } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  const { ast, diagnostics } = parse(tokens, src, 't.8bx', { sourceKind: '.8bx' });
  assert.deepEqual(diagnostics, []);
  const el = ast.body.find((s) => s.type === NodeType.BxElement);
  assert.deepEqual(el.children.map((c) => [c.type, c.value]), [[NodeType.BxText, 'Hello World!']]);
  // A run that is only whitespace is no child at all.
  const src2 = 'component T() { }\n<T>\n  <T />\n</T>;\n';
  const ast2 = parse(tokenize(src2, 't.8bx', { sourceKind: '.8bx' }).tokens, src2, 't.8bx', { sourceKind: '.8bx' }).ast;
  assert.deepEqual(ast2.body.find((s) => s.type === NodeType.BxElement).children.map((c) => c.type), [NodeType.BxElement]);
});

test('a comment child, a member name, a string attribute, and an element in a ?: all parse with their spans', () => {
  const src = 'component A(v: utinyint) { }\n<A v={1}>{/* note */}<Studio.Window /></A>;\n{c ? <A v={1} /> : <A v={2} />};\n';
  const { tokens } = tokenize(src, 't.8bx', { sourceKind: '.8bx' });
  const { ast, diagnostics } = parse(tokens, src, 't.8bx', { sourceKind: '.8bx' });
  assert.deepEqual(diagnostics.filter((d) => d.code === '8BS1039'), []);
  const el = ast.body.find((s) => s.type === NodeType.BxElement);
  assert.equal(el.start, src.indexOf('<A v'));
  assert.equal(el.start + el.length, src.indexOf('</A>') + 4);
  assert.deepEqual(el.children.map((c) => c.type), [NodeType.BxExpressionChild, NodeType.BxElement]);
  assert.equal(el.children[0].expression, null, 'a comment is an empty field');
  assert.equal(el.children[1].name, 'Studio.Window');
});

test('a mistyped closing tag and a stray token inside a tag are reported at the token, and parsing continues', () => {
  const src = 'component A() { }\ncomponent B() { }\nexport function main(): void { <A></B>; <A #x />; }\n';
  const diags = analyze(src, 't.8bx', { sourceKind: '.8bx' });
  const mismatch = diags.find((d) => /expected <\/A>, found <\/B>/.test(d.message));
  assert.ok(mismatch);
  assert.equal(mismatch.start, src.indexOf('B>;'));
  assert.ok(diags.some((d) => /unexpected '#' inside a tag/.test(d.message)));
  assert.ok(!diags.some((d) => d.code === '8BS3001'), 'main still lowers');
});
