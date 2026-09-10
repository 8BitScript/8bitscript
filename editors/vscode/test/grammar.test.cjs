// The TextMate grammar, checked without an editor: every pattern's regular
// expression compiles, every `#include` names a repository entry, and the
// constructs the compiler specifies — types, the compile-time `#name`
// spelling, template strings and their `${...}` fields, the `seconds` unit
// inside `#frames(...)` — are present by scope name. VS Code runs these
// patterns through Oniguruma, not JavaScript's engine; the syntax the
// grammar uses is common to both, so a pattern that fails to compile here
// is a pattern that will fail there too, and `new RegExp` is the cheapest
// check that catches a typo before the extension is packaged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GRAMMAR = path.join(__dirname, '..', 'syntaxes', '8bs.tmLanguage.json');
const grammar = JSON.parse(fs.readFileSync(GRAMMAR, 'utf8'));

// Every rule object in the grammar, wherever it nests.
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
      // Oniguruma accepts `\\G` and back-references into `begin` captures
      // that JavaScript does not; the grammar uses neither.
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

const scopes = new Set(all.flatMap((rule) => [
  rule.name,
  ...Object.values(rule.captures ?? {}).map((c) => c.name),
  ...Object.values(rule.beginCaptures ?? {}).map((c) => c.name),
  ...Object.values(rule.endCaptures ?? {}).map((c) => c.name),
]).filter(Boolean));

test('the constructs the compiler specifies have scopes', () => {
  for (const scope of [
    'string.template.8bs',
    'meta.template.field.8bs',
    'support.function.compile-time.8bs',
    'support.function.builtin.8bs',
    'constant.language.unit.8bs',
    'constant.numeric.decimal.fraction.8bs',
    'support.type.primitive.8bs',
  ]) {
    assert.ok(scopes.has(scope), `no rule produces ${scope}`);
  }
});

test('the primitive type rule knows string; the compile-time rule matches #frames and any #name', () => {
  const primitive = all.find((r) => r.name === 'support.type.primitive.8bs');
  assert.match('string', new RegExp(primitive.match));
  assert.match('utinyint', new RegExp(primitive.match));
  const compileTime = all.filter((r) => (r.begin ?? r.match ?? '').includes('#'));
  assert.ok(compileTime.some((r) => new RegExp(r.begin ?? r.match).test('#frames(')), 'no rule opens on #frames(');
  assert.ok(compileTime.some((r) => new RegExp(r.begin ?? r.match).test('#later')), 'no rule colors an unknown #name');
});

test('the language configuration auto-closes and surrounds backticks, like the other quotes', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'language-configuration.json'), 'utf8'));
  assert.ok(config.autoClosingPairs.some((p) => p.open === '`' && p.close === '`'), 'no auto-closing backtick');
  assert.ok(config.surroundingPairs.some((p) => p[0] === '`' && p[1] === '`'), 'no surrounding backtick');
});

test('a #name or @name is one word, so completing one replaces the sigil too', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'language-configuration.json'), 'utf8'));
  const word = new RegExp(config.wordPattern);
  for (const [text, expected] of [['#frames', '#frames'], ['@address', '@address'], ['ticks', 'ticks'], ['_x9', '_x9']]) {
    assert.equal(text.match(word)[0], expected);
  }
});

// ---- snippets ---------------------------------------------------------------
//
// A snippet that expands to something the compiler rejects is worse than no
// snippet, so each one is checked for the two mistakes that are easy to make
// by hand: a duplicate prefix (only one of them would ever be offered) and a
// `$`/`${...}` placeholder that a template string's own `${...}` would be
// confused with.

const snippets = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'snippets', '8bs.json'), 'utf8'),
);
const snippetEntries = Object.entries(snippets).filter(([name]) => !name.startsWith('_'));

test('the extension contributes its snippets for the language', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const contributed = manifest.contributes.snippets ?? [];
  assert.ok(contributed.some((s) => s.language === '8bitscript' && s.path === './snippets/8bs.json'),
    'snippets/8bs.json is not contributed in package.json');
});

test('every snippet has a unique prefix, a description, and a body', () => {
  const prefixes = new Set();
  for (const [name, snippet] of snippetEntries) {
    assert.ok(snippet.prefix, `${name} has no prefix`);
    assert.ok(!prefixes.has(snippet.prefix), `two snippets share the prefix ${snippet.prefix}`);
    prefixes.add(snippet.prefix);
    assert.ok(snippet.description, `${name} has no description`);
    assert.ok(Array.isArray(snippet.body) && snippet.body.length > 0, `${name} has no body`);
  }
});

test('a template field in a snippet body is escaped, so it is text and not a placeholder', () => {
  const print = snippets['Print a template'];
  assert.match(print.body.join('\n'), /\\\$\{/, "the template's own ${...} must be escaped as \\${");
});

// Whether each snippet's expansion actually compiles is asserted in
// packages/compiler/test/snippets.test.mjs: the compiler is the source of
// truth for what the language accepts, and this package cannot import it.
