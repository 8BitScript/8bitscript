// The 8bitscript-asm TextMate grammar (syntaxes/asm-8bs.tmLanguage.json):
// checked without an editor, the same way grammar.test.cjs checks 8bs.
// tmLanguage.json — every pattern compiles, every #include resolves — and
// then run through the real Oniguruma engine VS Code uses, over a sample
// in exactly the shape assemblyView.cjs's own renderView() produces
// (ported from the compiler's ListingLine.text — packages/compiler/src/
// mos/asm/assemble.ts's operandText()), so a coloring regression here is
// caught the same way a language-grammar one is.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { installVscodeMock } = require('./support/vscodeMock.cjs');

installVscodeMock();

const SYNTAXES = path.join(__dirname, '..', 'syntaxes');
const GRAMMAR_PATH = path.join(SYNTAXES, 'asm-8bs.tmLanguage.json');
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

test('every match/begin/end pattern is a regular expression that compiles', () => {
  for (const rule of all) {
    for (const key of ['match', 'begin', 'end']) {
      if (typeof rule[key] !== 'string') continue;
      assert.doesNotThrow(() => new RegExp(rule[key]), `${key}: ${rule[key]}`);
    }
  }
});

test('every #include names a repository entry (or $self)', () => {
  const repository = new Set(Object.keys(grammar.repository));
  for (const rule of all) {
    if (typeof rule.include !== 'string') continue;
    if (rule.include === '$self') continue;
    assert.ok(rule.include.startsWith('#'), `unexpected include ${rule.include}`);
    assert.ok(repository.has(rule.include.slice(1)), `#include ${rule.include} names nothing in the repository`);
  }
});

test('the extension contributes the grammar and language for the id assemblyView.cjs actually sets', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const language = manifest.contributes.languages.find((l) => l.id === '8bitscript-asm');
  assert.ok(language, '8bitscript-asm is not a contributed language');
  const contributedGrammar = manifest.contributes.grammars.find((g) => g.language === '8bitscript-asm');
  assert.ok(contributedGrammar, 'no grammar contributed for 8bitscript-asm');
  assert.equal(contributedGrammar.scopeName, grammar.scopeName);
  const { ASM_LANGUAGE } = require('../src/assemblyView.cjs');
  assert.equal(ASM_LANGUAGE, '8bitscript-asm');
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
  /** Every token of `source` as [text, innermost scope], with the grammar's own `.asm-8bs` suffix dropped. */
  return (source) => {
    const out = [];
    let state = vsctm.INITIAL;
    for (const line of source.split('\n')) {
      const { tokens, ruleStack } = compiled.tokenizeLine(line, state);
      for (const t of tokens) {
        const text = line.slice(t.startIndex, t.endIndex);
        if (text.trim() === '') continue;
        out.push([text, t.scopes.at(-1).replace(/\.asm-8bs$/, '')]);
      }
      state = ruleStack;
    }
    return out;
  };
}

// The exact shape renderView() produces, including the highlighted-line
// marker, a compiler-generated reason comment, and a `.byte` directive.
const SAMPLE = `; generated assembly for main.8bs
; /project/src/main.8bs

; function: main (inlined from updateScore)

  $C142   A5 18       LDA $18
> $C144   69 01       ADC #$01  ; branch-relaxation
  $C146   85 18       STA $18,X
  $C148   00          .byte $00
  $C149   60          RTS

; (compiler-generated — no direct source)

  $C14A   0A          ASL A
`;

test('the grammar colours addresses, bytes, mnemonics, operands, markers and comments the way renderView() renders them', async () => {
  const tokenize = await loadTokenizer();
  const tokens = tokenize(SAMPLE);
  const scopeOf = (text, nth = 0) => tokens.filter((t) => t[0] === text)[nth]?.[1];

  assert.equal(scopeOf('; generated assembly for main.8bs'), 'comment.line.semicolon');
  assert.equal(scopeOf('>'), 'keyword.control.marker', 'the highlighted-line marker is its own scope');
  assert.equal(scopeOf('$C142'), 'constant.numeric.hex', 'the address column is a hex constant');
  assert.equal(scopeOf('A5'), 'constant.numeric.hex.byte', 'a raw byte-dump pair');
  assert.equal(scopeOf('18', 0), 'constant.numeric.hex.byte', 'the second byte of the same pair');
  assert.equal(scopeOf('LDA'), 'keyword.mnemonic');
  assert.equal(scopeOf('$18', 0), 'constant.numeric.hex', 'the operand, not just the byte dump');
  assert.equal(scopeOf('#'), 'keyword.operator.immediate');
  assert.equal(scopeOf('$01'), 'constant.numeric.hex', 'an immediate operand is still a hex constant');
  assert.equal(scopeOf('; branch-relaxation'), 'comment.line.semicolon', 'a compiler-generated reason is a trailing comment');
  assert.equal(scopeOf(',X'), 'variable.language.register', 'an indexed operand names its register');
  assert.equal(scopeOf('.byte'), 'keyword.other.directive');
  assert.equal(scopeOf('main', 0), 'entity.name.function', 'the function header names the function');
  assert.equal(scopeOf('updateScore'), 'entity.name.function.origin', 'and the function it was inlined from');
  assert.equal(scopeOf('; (compiler-generated — no direct source)'), 'comment.line.semicolon');
  assert.equal(scopeOf('ASL'), 'keyword.mnemonic');
  assert.equal(scopeOf('A', 0), 'variable.language.accumulator', 'accumulator addressing mode');
});
