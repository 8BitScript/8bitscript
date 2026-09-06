// `#fact(...)` — the compile-time builtin reading one fact about the
// machine a build is for, and the FACTS table behind it (packages/compiler/
// src/fold/facts.mjs). Covers the fold (a count to an IntegerLiteral, a
// flag to a BooleanLiteral, the no-machine placeholder, the no-facts
// diagnostic), the key rules, and the editor's hover and completion.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, link, tokenize, parse, foldCompileTime, NodeType, FACTS, PROGRAM_FACTS,
  factConstName, factPlaceholder, factProblems, getHoverInfo, getCompletions,
} from '../index.mjs';

const codes = (src, options) => analyze(src, 't.8bs', options).map((d) => d.code);
const program = (expr, type = 'utinyint') => `let x: ${type} = ${expr};\nexport function main(): void {}`;
const folded = (src, options) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  const diagnostics = foldCompileTime(ast, 't', options);
  return { diagnostics, init: ast.body[0].initializer };
};

const FACTS_C64 = { 'video.columns': 40, 'video.bitmap': true, 'memory.ram': 51199 };

test('FACTS: every key is group.name, typed count or flag, settled at build or run, with a doc line', () => {
  for (const [key, fact] of FACTS) {
    assert.match(key, /^[a-z]+\.[a-zA-Z]+$/, key);
    assert.ok(['count', 'flag'].includes(fact.type), key);
    assert.ok(['build', 'run'].includes(fact.when), key);
    assert.equal(typeof fact.program, 'boolean', key);
    assert.ok(fact.doc.length > 10, key);
  }
  assert.ok(PROGRAM_FACTS.includes('video.columns'));
  assert.ok(!PROGRAM_FACTS.includes('video.frameRate'), 'the refresh rate is the CLI\'s, not the program\'s: one binary runs NTSC and PAL');
  assert.deepEqual(factConstName('video.spritesPerLine'), { namespace: 'Video', name: 'SPRITES_PER_LINE' });
  assert.deepEqual(factConstName('memory.ram'), { namespace: 'Memory', name: 'RAM' });
  assert.equal(factPlaceholder('video.bitmap'), false);
  assert.equal(factPlaceholder('video.columns'), 0);
});

test('factProblems: unknown keys and wrongly typed values, in words', () => {
  assert.deepEqual(factProblems({ 'video.columns': 40, 'video.bitmap': true }), []);
  const problems = factProblems({ 'video.nope': 1, 'video.bitmap': 1, 'video.columns': -1 });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /'video.nope' is not a fact — the keys are video.columns/);
  assert.match(problems[1], /'video.bitmap' is a flag/);
  assert.match(problems[2], /'video.columns' is a count/);
});

test('fold: a count becomes an IntegerLiteral and a flag a BooleanLiteral, from the facts given', () => {
  const count = folded(program('#fact(video.columns)'), { machine: 'c64', facts: FACTS_C64 });
  assert.deepEqual(count.diagnostics, []);
  assert.equal(count.init.type, NodeType.IntegerLiteral);
  assert.equal(count.init.value, 40);
  assert.equal(count.init.raw, '#fact(video.columns)');

  const flag = folded(program('#fact(video.bitmap)', 'bool'), { machine: 'c64', facts: FACTS_C64 });
  assert.deepEqual(flag.diagnostics, []);
  assert.equal(flag.init.type, NodeType.BooleanLiteral);
  assert.equal(flag.init.value, true);
});

test('fold: a key the sheet leaves out is its placeholder — a fact is never missing', () => {
  const { diagnostics, init } = folded(program('#fact(video.sprites)'), { machine: 'c64', facts: FACTS_C64 });
  assert.deepEqual(diagnostics, []);
  assert.equal(init.value, 0);
  const flag = folded(program('#fact(audio.noise)', 'bool'), { machine: 'c64', facts: FACTS_C64 });
  assert.equal(flag.init.type, NodeType.BooleanLiteral);
  assert.equal(flag.init.value, false);
});

test('fold: with no machine, every fact is its placeholder and the program is valid', () => {
  assert.deepEqual(codes(program('#fact(video.columns)')), []);
  assert.deepEqual(codes(program('#fact(memory.banked)', 'bool')), []);
  const { init } = folded(program('#fact(memory.banked)', 'bool'), {});
  assert.equal(init.type, NodeType.BooleanLiteral);
  assert.equal(init.value, false);
});

test('fold: a machine with no facts is 8BS1038 — the fold will not invent a sheet for a real build', () => {
  const diagnostics = analyze(program('#fact(video.columns)'), 't.8bs', { machine: 'c64' });
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS1038']);
  assert.match(diagnostics[0].message, /#fact\(video.columns\) needs this build's hardware facts, and the c64 build was given none/);
  // A program that reads no fact is untouched.
  assert.deepEqual(codes(program('#system()'), { machine: 'c64' }), []);
});

test('8BS1037: an unknown key, no key, two keys, or a non-key argument', () => {
  for (const call of ['#fact(video.nope)', '#fact()', '#fact(video.columns, video.rows)', '#fact(40)', '#fact("video.columns")']) {
    const diagnostics = analyze(program(call), 't.8bs', { machine: 'c64', facts: FACTS_C64 });
    assert.deepEqual(diagnostics.map((d) => d.code), ['8BS1037'], call);
  }
  const [unknown] = analyze(program('#fact(video.nope)'), 't.8bs');
  assert.match(unknown.message, /'video.nope' is not a fact — the keys are video.columns, video.rows/);
  const [shape] = analyze(program('#fact()'), 't.8bs');
  assert.match(shape.message, /takes one fact key, written as words/);
});

test('the key words are contextual: video and columns are ordinary names elsewhere', () => {
  const src = 'let video: utinyint = 1;\nlet columns: utinyint = #fact(video.columns);\nexport function main(): void { columns = video; }';
  assert.deepEqual(codes(src, { machine: 'c64', facts: FACTS_C64 }), []);
});

test('a bare #fact is 8BS1030 with the call shape', () => {
  const [d] = analyze(program('#fact'), 't.8bs');
  assert.equal(d.code, '8BS1030');
  assert.match(d.message, /#fact\(video.columns\) or #fact\(memory.ram\)/);
});

test('the folded value is range-checked against the const\'s type, like any literal', () => {
  const diagnostics = analyze(program('#fact(memory.ram)'), 't.8bs', { machine: 'c64', facts: FACTS_C64 });
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS1021'], '51199 in a utinyint');
});

test('link: a namespace const of a fact inlines and a branch on it is two constants', () => {
  const src = `namespace Video {
    const COLUMNS: utinyint = #fact(video.columns);
    const BITMAP: bool = #fact(video.bitmap);
}
let hit: utinyint = 0;
export function main(): void {
    if (Video.COLUMNS == 40) { hit = 1; }
    if (!Video.BITMAP) { hit = 2; }
    while (true) { waitFrame(); }
}
`;
  const { ir, diagnostics } = link(src, '/t/t.8bs', { machine: 'c64', facts: FACTS_C64 });
  assert.deepEqual(diagnostics, []);
  const tests = ir.functions.find((f) => f.name === 'main').body.filter((s) => s.kind === 'if').map((s) => s.test);
  assert.deepEqual(tests[0], { kind: 'binop', operator: '==', left: { kind: 'const', value: 40 }, right: { kind: 'const', value: 40 } });
  assert.deepEqual(tests[1], { kind: 'unop', operator: '!', argument: { kind: 'const', value: 1 } });
});

test('hover explains #fact(...) and a key inside it, and nowhere else', () => {
  const text = 'let x: utinyint = #fact(video.columns);';
  const call = getHoverInfo(text, text.indexOf('fact') + 1);
  assert.match(call.markdown, /\*\*#fact\(\.\.\.\)\*\*/);
  assert.match(call.markdown, /Video\.COLUMNS/);
  for (const word of ['video', 'columns']) {
    const info = getHoverInfo(text, text.indexOf(word) + 1);
    assert.match(info.markdown, /\*\*video\.columns\*\*/, word);
    assert.match(info.markdown, /Cells across the text grid/, word);
    assert.equal(info.start, text.indexOf('video.columns'), word);
    assert.equal(info.length, 'video.columns'.length, word);
  }
  const run = getHoverInfo('let x: bool = #fact(memory.banked);', 24);
  assert.match(run.markdown, /settled at run time/);
  assert.equal(getHoverInfo('let video: utinyint = 1;', 5), null, 'not a key outside the call');
  assert.equal(getHoverInfo('let x: utinyint = #fact(video.nope);', 26), null, 'not a key the compiler knows');
});

test('completion after # offers #fact, and inside #fact( offers the program\'s keys', () => {
  const after = getCompletions('let x: utinyint = #', 19);
  assert.ok(after.some((i) => i.label === '#fact' && i.insertText === 'fact'));
  const inside = getCompletions('let x: utinyint = #fact(', 24);
  assert.deepEqual(inside.map((i) => i.label), PROGRAM_FACTS);
  assert.ok(inside.every((i) => i.kind === 'constant'));
  const partial = getCompletions('let x: utinyint = #fact(video.col', 33);
  assert.deepEqual(partial.map((i) => i.label), PROGRAM_FACTS, 'a partly typed key still completes');
  assert.deepEqual(getCompletions('let x: utinyint = #frames(', 26), [], 'not inside another builtin');
});
