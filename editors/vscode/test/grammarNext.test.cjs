// The staged TextMate grammar for the Rust-style .8bs syntax
// (syntaxes/8bs-next.tmLanguage.json), run through the real Oniguruma engine
// over a sample that uses every token class of the syntax spec's lexical
// grammar. The file is not contributed yet; the flip renames it over
// 8bs.tmLanguage.json, and this test then points at that name.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GRAMMAR_PATH = path.join(__dirname, '..', 'syntaxes', '8bs-next.tmLanguage.json');
const grammar = JSON.parse(fs.readFileSync(GRAMMAR_PATH, 'utf8'));

function rules(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) rules(item, out);
  } else if (node && typeof node === 'object') {
    if (node.match || node.begin || node.end || node.include) out.push(node);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') rules(value, out);
    }
  }
  return out;
}

const all = rules(grammar);

test('the staged grammar keeps the scope, and every #include resolves', () => {
  assert.equal(grammar.scopeName, 'source.8bs');
  const repository = new Set(Object.keys(grammar.repository));
  for (const rule of all) {
    if (typeof rule.include !== 'string' || rule.include === '$self') continue;
    assert.ok(rule.include.startsWith('#'), `unexpected include ${rule.include}`);
    assert.ok(repository.has(rule.include.slice(1)), `${rule.include} names nothing in the repository`);
  }
});

test('the staged grammar is not contributed before the flip', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(!manifest.contributes.grammars.some((g) => g.path.endsWith('8bs-next.tmLanguage.json')));
});

async function loadTokenizer() {
  const vsctm = require('vscode-textmate');
  const onig = require('vscode-oniguruma');
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer;
  const onigLib = onig.loadWASM(wasm).then(() => ({
    createOnigScanner: (patterns) => new onig.OnigScanner(patterns),
    createOnigString: (text) => new onig.OnigString(text),
  }));
  const registry = new vsctm.Registry({
    onigLib,
    loadGrammar: (scope) => (scope === grammar.scopeName
      ? vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR_PATH, 'utf8'), GRAMMAR_PATH)
      : null),
  });
  const compiled = await registry.loadGrammar(grammar.scopeName);
  /** Every token of `source` as [text, innermost scope without the `.8bs` suffix]. */
  return (source) => {
    const out = [];
    let state = vsctm.INITIAL;
    for (const line of source.split('\n')) {
      const { tokens, ruleStack } = compiled.tokenizeLine(line, state);
      for (const t of tokens) {
        const text = line.slice(t.startIndex, t.endIndex);
        if (text.trim() === '') continue;
        out.push([text, t.scopes.at(-1).replace(/\.8bs$/, '')]);
      }
      state = ruleStack;
    }
    return out;
  };
}

const SAMPLE = `use self::geo::{a, b};
use @lib::game::rules::x;
#[address($D020)]
let mut border: volatile<u8>;
const MAX: u8 = 0xFF;
mod Color { pub const RED: u8 = 0b0010; }
pub fn main(r#loop: u8) -> u8 {
  let x: u16 = 1_000;
  let mut y = $FF;
  for i: u8 in 0..=9 { y += i; }
  for j: u8 in 0..4 {}
  loop { break; }
  match x { 1 => y = 2, _ => {} }
  memory::read(r#loop);
  assert_eq!(x, 1);
  let t = \`HP \${hp:3}\`;
  let s = "hi";
  let d = #frames(0.5, seconds);
  #fact("k");
  asm6502 { lda #$01 ; set
    sta $D020,X }
  x as u8;
  return y;
}
#[test]
fn ok() {}
`;

test('every token class of the new syntax gets its scope', async () => {
  const tokens = (await loadTokenizer())(SAMPLE);
  const scopeOf = (text, nth = 0) => tokens.filter((t) => t[0] === text)[nth]?.[1];

  assert.equal(scopeOf('use'), 'keyword.control.import');
  assert.equal(scopeOf('self'), 'variable.language');
  assert.equal(scopeOf('::'), 'punctuation.accessor');
  assert.equal(scopeOf('@lib'), 'entity.name.namespace.scope');
  assert.equal(scopeOf('#['), 'punctuation.definition.attribute.begin');
  assert.equal(scopeOf('address'), 'entity.name.function.attribute');
  assert.equal(scopeOf('$D020'), 'constant.numeric.hex');
  assert.equal(scopeOf('let'), 'storage.type');
  assert.equal(scopeOf('mut'), 'storage.modifier');
  assert.equal(scopeOf('border'), 'variable.other.readwrite');
  assert.equal(scopeOf('volatile'), 'support.type.constructor');
  assert.equal(scopeOf('u8'), 'support.type.primitive');
  assert.equal(scopeOf('const'), 'storage.type');
  assert.equal(scopeOf('MAX'), 'variable.other.constant');
  assert.equal(scopeOf('0xFF'), 'constant.numeric.hex');
  assert.equal(scopeOf('mod'), 'storage.type');
  assert.equal(scopeOf('Color'), 'entity.name.namespace');
  assert.equal(scopeOf('pub'), 'storage.modifier');
  assert.equal(scopeOf('0b0010'), 'constant.numeric.binary');
  assert.equal(scopeOf('fn'), 'storage.type.function');
  assert.equal(scopeOf('main'), 'entity.name.function');
  assert.equal(scopeOf('r#loop'), 'variable.other.raw');
  assert.equal(scopeOf('->'), 'keyword.operator.arrow');
  assert.equal(scopeOf('1_000'), 'constant.numeric.decimal');
  assert.equal(scopeOf('for'), 'keyword.control');
  assert.equal(scopeOf('in'), 'keyword.control');
  assert.equal(scopeOf('..='), 'keyword.operator.range');
  assert.equal(scopeOf('..'), 'keyword.operator.range');
  assert.equal(scopeOf('+='), 'keyword.operator');
  assert.equal(scopeOf('loop'), 'keyword.control');
  assert.equal(scopeOf('match'), 'keyword.control');
  assert.equal(scopeOf('=>'), 'keyword.operator.fat-arrow');
  assert.equal(scopeOf('memory'), 'entity.name.namespace');
  assert.equal(scopeOf('read'), 'entity.name.function.call');
  assert.equal(scopeOf('assert_eq'), 'support.function.macro');
  assert.equal(scopeOf('!'), 'support.function.macro.bang');
  assert.equal(scopeOf('HP '), 'string.template');
  assert.equal(scopeOf('hp'), 'meta.template.field', 'a template field holds source');
  assert.equal(scopeOf('hi'), 'string.quoted.double');
  assert.equal(scopeOf('#frames'), 'support.function.compile-time');
  assert.equal(scopeOf('0.5'), 'constant.numeric.decimal.fraction');
  assert.equal(scopeOf('seconds'), 'constant.language.unit');
  assert.equal(scopeOf('#fact'), 'support.function.compile-time');
  assert.equal(scopeOf('as'), 'keyword.other.as');
  assert.equal(scopeOf('return'), 'keyword.control');
  assert.equal(scopeOf('test'), 'entity.name.function.attribute');
});

test('asm6502 colours 6502 mnemonics, operands and its own comments, and ends at the brace', async () => {
  const tokens = (await loadTokenizer())(SAMPLE);
  const scopeOf = (text, nth = 0) => tokens.filter((t) => t[0] === text)[nth]?.[1];
  assert.equal(scopeOf('asm6502'), 'storage.modifier');
  assert.equal(scopeOf('lda'), 'keyword.mnemonic');
  assert.equal(scopeOf('#'), 'keyword.operator.immediate');
  assert.equal(scopeOf('$01'), 'constant.numeric.hex');
  assert.equal(scopeOf('; set'), 'comment.line.semicolon');
  assert.equal(scopeOf('sta'), 'keyword.mnemonic');
  assert.equal(scopeOf(',X'), 'variable.language.register');
  // After the closing brace the grammar is back in ordinary source.
  assert.equal(scopeOf('as'), 'keyword.other.as');
  assert.equal(scopeOf('return'), 'keyword.control');
});

test('old keywords and old spellings are not colored as language', async () => {
  const tokenize = await loadTokenizer();
  const tokens = tokenize('function namespace import export switch case\nlet x = a % 2;\nlet b = %1010;');
  // Unscoped text merges into one token, so the check is that nothing in the input got a keyword scope.
  assert.ok(!tokens.some((t) => t[0] !== 'let' && /^(keyword\.control|storage)/.test(t[1])), JSON.stringify(tokens));
  // `%` is only modulo: no binary-literal scope exists for %1010.
  assert.ok(!tokens.some((t) => t[1] === 'constant.numeric.binary'));
});

test('reserved words are flagged, and a range is not a fraction', async () => {
  const tokenize = await loadTokenizer();
  const tokens = tokenize('struct enum\nfor i: u8 in 0..5 {}');
  assert.equal(tokens.find((t) => t[0] === 'struct')[1], 'invalid.illegal.reserved');
  assert.equal(tokens.find((t) => t[0] === 'enum')[1], 'invalid.illegal.reserved');
  assert.ok(!tokens.some((t) => t[1] === 'constant.numeric.decimal.fraction'));
});
