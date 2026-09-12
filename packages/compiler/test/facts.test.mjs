// `#fact(...)` — the compile-time builtin reading one fact about the
// machine a build is for, and the FACTS table behind it (packages/compiler/
// src/fold/facts.mjs). Covers the fold (a count to an IntegerLiteral, a
// flag to a BooleanLiteral, the no-machine placeholder, the no-facts
// diagnostic), the key rules, and the editor's hover and completion.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, link, tokenize, parse, foldCompileTime, NodeType, FACTS, PROGRAM_FACTS,
  CONTROLLER_KINDS, LOGICAL_CONTROLS, controllerKind,
  factConstName, factPlaceholder, factProblems, requiresProblems, unmetRequirements,
  getHoverInfo, getCompletions,
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

test('FACTS: every key is group.name, typed count, flag or list, settled at build or run, with a doc line', () => {
  for (const [key, fact] of FACTS) {
    assert.match(key, /^[a-z]+\.[a-zA-Z]+$/, key);
    assert.ok(['count', 'flag', 'list'].includes(fact.type), key);
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
  // A machine whose sheet says nothing about its controls carries none:
  // the same "nothing, said out loud" the 0 and the false are.
  assert.deepEqual(factPlaceholder('input.controls'), []);
  // The one list key, and it is the CLI's and the editor's, never a
  // program's — there is no literal for `#fact()` to fold it into.
  const lists = [...FACTS].filter(([, fact]) => fact.type === 'list').map(([key]) => key);
  assert.deepEqual(lists, ['input.controls']);
  assert.equal(FACTS.get('input.controls').program, false);
  assert.ok(!PROGRAM_FACTS.includes('input.controls'));
});

test('the controller shapes that have a name, and a kind derived from a list rather than declared beside it', () => {
  // The whole point of deriving: a machine package says what its
  // controller *carries* and the name falls out. Nothing in a catalog
  // spells `nes-pad`, so a name and the shape it names cannot disagree.
  assert.deepEqual(CONTROLLER_KINDS.map((entry) => entry.kind),
    ['atari-stick', 'nes-pad', 'snes-pad', 'xbox-style']);
  for (const { kind, controls } of CONTROLLER_KINDS) {
    for (const control of controls) assert.ok(LOGICAL_CONTROLS.includes(control), `${kind}: ${control}`);
    assert.deepEqual([...new Set(controls)], controls, `${kind} names each control once`);
    assert.equal(controllerKind(controls), kind, `${kind} round-trips`);
  }
  assert.equal(LOGICAL_CONTROLS.length, 18);
  // The shapes the nine machines actually declare, as their catalogs do:
  // an Atari-standard stick is four switches and one fire button
  // (packages/c64/src/joystick.8bs's Joystick.UP/DOWN/LEFT/RIGHT/FIRE, and
  // packages/atari8/AGENTS.md records the Atari's masks as bit-for-bit the
  // same); an NES pad is the eight bits its shift register clocks out
  // (packages/nes/src/pad.8bs).
  assert.equal(controllerKind(['up', 'down', 'left', 'right', 'a']), 'atari-stick');
  assert.equal(controllerKind(['a', 'b', 'select', 'start', 'up', 'down', 'left', 'right']), 'nes-pad',
    'the order a catalog lists them in is the hardware documentation\'s, not a different device');
  // Exact set equality, not a subset ladder: a two-button stick clears the
  // bar for `a` and `b` and is still not an NES pad.
  assert.equal(controllerKind(['up', 'down', 'left', 'right', 'a', 'b']), null);
  assert.equal(controllerKind([]), null);
  assert.equal(controllerKind(undefined), null);
});

test('factProblems checks a list of control names, and names the wrong one', () => {
  assert.deepEqual(factProblems({ 'input.controls': ['up', 'down', 'left', 'right', 'a'] }), []);
  assert.deepEqual(factProblems({ 'input.controls': [] }), [], 'a machine with no ports carries nothing');
  const notAList = factProblems({ 'input.controls': 5 });
  assert.equal(notAList.length, 1);
  assert.match(notAList[0], /is a list of control names: an array, not 5/);
  // A typo is a control that silently never projects, which is the whole
  // reason the compiler owns the names: it is caught here, by name.
  const typo = factProblems({ 'input.controls': ['up', 'fire'] });
  assert.equal(typo.length, 1);
  assert.match(typo[0], /holds "fire", which is not a control/);
});

test('#fact() refuses a list fact by name rather than folding an array into a literal', () => {
  // `replaceWithFact` would hand the IR an array where an integer goes.
  // The refusal is before the machine is looked at, because the answer is
  // the same on every machine: this is not a fact a program reads.
  const refused = folded(program('#fact(input.controls)'), {
    machine: 'c64',
    facts: { ...FACTS_C64, 'input.controls': ['up', 'down', 'left', 'right', 'a'] },
  });
  assert.equal(refused.diagnostics.length, 1);
  assert.match(refused.diagnostics[0].message, /is a list of control names, not a number or a flag/);
  // And it is refused with no machine in hand too — the editor's `8bs
  // check`, where every other fact is its placeholder.
  assert.equal(folded(program('#fact(input.controls)'), {}).diagnostics.length, 1);
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
  assert.deepEqual(tests[0], { kind: 'binop', operator: '==', left: { kind: 'const', type: 'utinyint', value: 40 }, right: { kind: 'const', value: 40, type: 'utinyint' }, type: 'bool' });
  assert.deepEqual(tests[1], { kind: 'unop', operator: '!', argument: { kind: 'const', type: 'utinyint', value: 1 }, type: 'bool' });
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

// `requires`: the floor a program sets on the machine it is built for. The
// table owns what may be required and what "enough" means; the CLI owns
// the message and the machine.
test('a requirement is a floor for a count and a yes for a flag, and nothing else', () => {
  assert.deepEqual(requiresProblems({ 'memory.ram': 8192, 'storage.save': true }), []);
  assert.deepEqual(requiresProblems({}), []);
  assert.deepEqual(requiresProblems(undefined), []);

  const one = (requires) => requiresProblems(requires)[0];
  // A run fact is the machine's answer, not the build's, so requiring it
  // would be a promise the build cannot keep.
  assert.match(one({ 'input.mouse': true }), /settled on the machine, not by the build/);
  assert.match(one({ 'memory.bankedKib': 512 }), /settled on the machine/);
  assert.match(one({ 'video.frameRate': 50 }), /not on a program's sheet/);
  assert.match(one({ 'nope.nope': 1 }), /is not a fact/);
  assert.match(one({ 'video.columns': -1 }), /a whole number above zero/);
  assert.match(one({ 'video.bitmap': false }), /require it with true, or leave it out/);
});

test('unmetRequirements answers against a build\'s sheet, and a missing fact is the placeholder', () => {
  const facts = { 'memory.ram': 3583, 'storage.save': false, 'video.columns': 22 };
  assert.deepEqual(unmetRequirements({ 'memory.ram': 8192 }, facts), [{ key: 'memory.ram', need: 8192, have: 3583 }]);
  assert.deepEqual(unmetRequirements({ 'memory.ram': 3583 }, facts), [], 'a floor is met exactly');
  assert.deepEqual(unmetRequirements({ 'video.columns': 40 }, facts), [{ key: 'video.columns', need: 40, have: 22 }]);
  assert.deepEqual(unmetRequirements({ 'storage.save': true }, facts), [{ key: 'storage.save', need: true, have: false }]);
  assert.deepEqual(unmetRequirements({ 'memory.ram': 8192, 'video.columns': 22 }, facts).map((u) => u.key), ['memory.ram']);
  // A sheet that never mentioned the key answers with the placeholder
  // rather than throwing: every catalog declares every program fact, but
  // this is asked of hand-made sheets too.
  assert.deepEqual(unmetRequirements({ 'video.sprites': 1 }, facts), [{ key: 'video.sprites', need: 1, have: 0 }]);
  assert.deepEqual(unmetRequirements({}, facts), []);
});

test('storage.kib is on the program\'s sheet, a build-time count', () => {
  const fact = FACTS.get('storage.kib');
  assert.equal(fact.type, 'count');
  assert.equal(fact.when, 'build');
  assert.equal(fact.program, true);
  assert.ok(PROGRAM_FACTS.includes('storage.kib'));
  assert.equal(factPlaceholder('storage.kib'), 0);
  assert.deepEqual(factConstName('storage.kib'), { namespace: 'Storage', name: 'KIB' });
});

