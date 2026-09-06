// `#system()` — the compile-time builtin naming the machine a build is for.
// Covers the fold pass (packages/compiler/src/fold: SYSTEMS, the argument
// rule, the no-machine placeholder), the diagnostics, and the editor's
// hover and completion for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, link, tokenize, parse, foldCompileTime, NodeType, SYSTEMS, getHoverInfo, getCompletions,
} from '../index.mjs';

const codes = (src, options) => analyze(src, 't.8bs', options).map((d) => d.code);
const program = (expr) => `let x: utinyint = ${expr};\nexport function main(): void {}`;

test('SYSTEMS names the nine targets with distinct, stable numbers', () => {
  assert.deepEqual([...SYSTEMS.entries()], [
    ['web', 0], ['vic20', 1], ['c64', 2], ['pet', 3], ['c128', 4], ['atari8', 5], ['nes', 6], ['cx16', 7], ['mega65', 8],
  ]);
});

test('fold: #system() becomes the machine\'s number when a machine is known', () => {
  for (const [machine, value] of SYSTEMS) {
    const { tokens } = tokenize(program('#system()'), 't');
    const { ast } = parse(tokens, program('#system()'), 't');
    assert.deepEqual(foldCompileTime(ast, 't', { machine }), [], machine);
    const init = ast.body[0].initializer;
    assert.equal(init.type, NodeType.IntegerLiteral, machine);
    assert.equal(init.value, value, machine);
    assert.equal(init.raw, '#system()');
  }
});

test('fold: with no machine, #system() is a placeholder and no diagnostic — valid, target-dependent', () => {
  assert.deepEqual(codes(program('#system()')), []);
  const { tokens } = tokenize(program('#system()'), 't');
  const { ast } = parse(tokens, program('#system()'), 't');
  assert.deepEqual(foldCompileTime(ast, 't'), []);
  assert.equal(ast.body[0].initializer.value, 0);
});

test('link: #system() folds per target through the whole pipeline, into the IR', () => {
  for (const [machine, value] of SYSTEMS) {
    const src = 'let x: utinyint = 0;\nexport function main(): void {\n    x = #system();\n}\n';
    const { ir, diagnostics } = link(src, '/p/main.8bs', { machine });
    assert.deepEqual(diagnostics, [], machine);
    const assign = ir.functions[0].body.find((s) => s.kind === 'assign');
    assert.deepEqual(assign.value, { kind: 'const', value }, machine);
  }
});

test('link: a machine the compiler has no number for is 8BS3002', () => {
  const src = 'let x: utinyint = #system();\nexport function main(): void {}';
  const { diagnostics } = link(src, '/p/main.8bs', { machine: 'z80' });
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3002']);
});

test('#system(1) is 8BS1036: it takes no arguments', () => {
  assert.deepEqual(codes(program('#system(1)')), ['8BS1036']);
  assert.deepEqual(codes(program('#system(1)'), { machine: 'c64' }), ['8BS1036']);
});

test('a bare #system is 8BS1030, and says to call it', () => {
  const [d] = analyze(program('#system'), 't.8bs');
  assert.equal(d.code, '8BS1030');
  assert.match(d.message, /must be called: #system\(\)/);
});

test('an unknown #name lists #system() among the compile-time functions', () => {
  const [d] = analyze(program('#machine()'), 't.8bs');
  assert.equal(d.code, '8BS1030');
  assert.match(d.message, /#frames\(\.\.\.\), #system\(\)/);
});

test('#system() feeds the ordinary width rule: it fits a utinyint on every machine', () => {
  for (const machine of SYSTEMS.keys()) {
    assert.deepEqual(codes(program('#system()'), { machine }), [], machine);
  }
});

test('hover on #system explains the builtin and lists the machines', () => {
  const src = program('#system()');
  const hover = getHoverInfo(src, src.indexOf('#system') + 3);
  assert.ok(hover);
  assert.match(hover.markdown, /\*\*#system\(\)\*\*/);
  assert.match(hover.markdown, /`c64`/);
  assert.match(hover.markdown, /target-dependent/);
});

test('completion after # offers #frames and #system', () => {
  const src = 'let x: utinyint = #';
  const items = getCompletions(src, src.length);
  assert.deepEqual(items.map((i) => i.label), ['#frames', '#system']);
  assert.equal(items.find((i) => i.label === '#system').insertText, 'system()');
  const typed = 'let x: utinyint = #sys';
  const replacing = getCompletions(typed, typed.length);
  assert.equal(replacing.find((i) => i.label === '#system').insertText, '#system()');
});
