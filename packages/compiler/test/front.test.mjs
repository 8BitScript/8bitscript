import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  KEYWORDS, TYPE_NAMES, TokenKind, callFront, check, isOperandToken, normalizeBxText, parse, tokenize,
} from '../src/front/index.mjs';

const pairs = new URL('../../../crates/front-wasm/tests/pairs/', import.meta.url);
const stems = readdirSync(pairs).filter((f) => /\.old\.8b[sx]$/.test(f)).map((f) => f.replace(/\.old\.8b[sx]$/, '')).sort();
const extOf = (stem) => (existsSync(new URL(`${stem}.8bx`, pairs)) ? '.8bx' : '.8bs');
const read = (name) => readFileSync(new URL(name, pairs), 'utf8');

const byCodeUnit = (a, b) => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};
const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort(byCodeUnit).map((k) => [k, sortKeys(v[k])]));
  }
  return v;
};
const canon = (v) => `${JSON.stringify(sortKeys(v), null, 2)}\n`;

test('the pair fixtures are present', () => {
  assert.ok(stems.length >= 3, stems.join(','));
});

test('the wasm AST equals the native AST on every pair', () => {
  for (const stem of stems) {
    const ext = extOf(stem);
    const options = { sourceKind: ext };
    const text = read(`${stem}${ext}`);
    const { tokens, diagnostics: lexed } = tokenize(text, `${stem}${ext}`, options);
    const { ast, diagnostics } = parse(tokens, text, `${stem}${ext}`, options);
    assert.deepEqual([...lexed, ...diagnostics], [], stem);
    assert.equal(canon(ast), read(`${stem}.ast.json`), stem);
  }
});

test('the pair check says equal on every pair, and names a difference when not', () => {
  for (const stem of stems) {
    const oldAst = JSON.parse(read(`${stem}.old.ast.json`));
    const ext = extOf(stem);
    const reply = check({ file: `${stem}${ext}`, sourceKind: ext, oldAst, newText: read(`${stem}${ext}`) });
    assert.deepEqual(reply, { equal: true, differences: [] }, stem);
  }
  const oldAst = JSON.parse(read('02-declarations.old.ast.json'));
  const reply = check({ file: 't.8bs', oldAst, newText: read('02-declarations.8bs').replace('fn add', 'fn sum') });
  assert.equal(reply.equal, false);
  assert.deepEqual(reply.differences, [{ path: 'body[1].name.name', old: 'add', new: 'sum' }]);
});

test('tokenize and parse of one file agree and hand out separate trees', () => {
  const text = 'let x: u8 = 1;\n';
  const first = parse([], text, 'a.8bs');
  const lexed = tokenize(text, 'a.8bs');
  assert.equal(first.ast.type, 'Program');
  assert.equal(lexed.tokens[0].text, 'let');
  assert.deepEqual(lexed.diagnostics, []);
  first.ast.body.length = 0;
  const second = parse([], text, 'a.8bs');
  assert.equal(second.ast.body.length, 1);
  assert.notEqual(second.ast, first.ast);
});

test('diagnostics come back in the old shapes', () => {
  const lexed = tokenize('x++;', 'a.8bs');
  assert.equal(lexed.diagnostics.length, 1);
  assert.deepEqual(Object.keys(lexed.diagnostics[0]).sort(), ['code', 'file', 'length', 'message', 'severity', 'start']);
  const parsed = parse(lexed.tokens, 'x++;', 'a.8bs');
  assert.ok(Array.isArray(parsed.diagnostics));
  const bad = parse([], 'let = 3;', 'a.8bs');
  assert.ok(bad.diagnostics.length > 0);
  assert.equal(bad.diagnostics[0].code, '8BS1101');
});

test('spans count UTF-16 units', () => {
  const text = '// \u{1F600}\nlet n = 1;';
  const { tokens } = tokenize(text, 'u.8bs');
  const let_ = tokens.find((t) => t.text === 'let');
  assert.equal(let_.start, text.indexOf('let'));
});

test('the source kind reaches the module', () => {
  const lexed = tokenize('component A() { <Box />; }', 'a.8bx', { sourceKind: '.8bx' });
  assert.ok(lexed.tokens.some((t) => t.kind === TokenKind.BxTagOpen));
});

test('malformed requests throw, they never trap', () => {
  assert.throws(() => callFront('front_parse', { text: 3 }), /front end: bad request/);
  assert.throws(() => callFront('front_parse', { text: '', sourceKind: '.8bg' }), /unsupported sourceKind/);
  assert.throws(() => callFront('front_check', { newText: '' }), /oldAst/);
});

test('deep nesting is a diagnostic or an error, not a trap', () => {
  const deep = `${'if a { '.repeat(300)}${'} '.repeat(300)}`;
  const parsed = parse([], deep, 'deep.8bs');
  assert.ok(parsed.diagnostics.length > 0);
  const chain = `let x = ${'a + '.repeat(3000)}a;`;
  assert.equal(parse([], chain, 'chain.8bs').ast.type, 'Program');
  const parens = `let x = ${'('.repeat(300)}1${')'.repeat(300)};`;
  assert.equal(parse([], parens, 'parens.8bs').ast.type, 'Program');
  assert.throws(
    () => check({ file: 'd.8bs', oldAst: { type: 'Program', body: [] }, newText: `${'if a { '.repeat(120)}${'} '.repeat(120)}` }),
    /too deep/,
  );
});

test('the lexer constants keep their shapes', () => {
  assert.ok(KEYWORDS.has('fn') && KEYWORDS.has('struct') && !KEYWORDS.has('function'));
  assert.ok(TYPE_NAMES.has('u8') && TYPE_NAMES.has('volatile'));
  // The sets are the module's own: every member lexes as that kind, and a
  // word outside both lexes as an identifier.
  for (const word of KEYWORDS) {
    if (word === 'asm6502') continue; // opens an opaque body, not a lone token
    assert.equal(tokenize(word, 'k.8bs').tokens[0].kind, TokenKind.Keyword, word);
  }
  for (const word of TYPE_NAMES) {
    assert.equal(tokenize(word, 't.8bs').tokens[0].kind, TokenKind.Type, word);
  }
  assert.equal(tokenize('function', 'k.8bs').tokens[0].kind, TokenKind.Identifier);
  assert.equal(TokenKind.Macro, 'macro');
  assert.equal(TokenKind.Scope, 'scope');
  assert.equal(isOperandToken({ kind: 'identifier', text: 'a' }), true);
  assert.equal(isOperandToken({ kind: 'keyword', text: 'true' }), true);
  assert.equal(isOperandToken({ kind: 'keyword', text: 'if' }), false);
  assert.equal(isOperandToken({ kind: 'punctuation', text: ')' }), true);
  assert.equal(isOperandToken({ kind: 'operator', text: '+' }), false);
  assert.equal(isOperandToken(undefined), false);
  assert.equal(normalizeBxText('  a  \n\n   b \n'), 'a b');
});

test('a trap drops the instance and the next call runs on a fresh one', () => {
  const text = 'let x = 1;\n';
  assert.equal(parse([], text, 'a.8bs').ast.type, 'Program');
  assert.throws(() => callFront('front_nothing', {}), TypeError);
  assert.equal(parse([], text, 'b.8bs').ast.type, 'Program');
});
