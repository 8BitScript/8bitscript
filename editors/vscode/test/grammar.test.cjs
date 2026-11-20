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

// Oniguruma's `(?i:...)` group is not JavaScript: compile it as `(?:...)` with
// the `i` flag, which is equivalent for the patterns this grammar writes.
function jsRegExp(source) {
  return source.includes('(?i:') ? new RegExp(source.replaceAll('(?i:', '(?:'), 'i') : new RegExp(source);
}

test('every match/begin/end pattern is a regular expression that compiles', () => {
  for (const rule of all) {
    for (const key of ['match', 'begin', 'end']) {
      if (typeof rule[key] !== 'string') continue;
      // Oniguruma accepts `\\G` and back-references into `begin` captures
      // that JavaScript does not; the grammar uses neither.
      assert.doesNotThrow(() => jsRegExp(rule[key]), `${key}: ${rule[key]}`);
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
  for (const [text, expected] of [['#frames', '#frames'], ['@scope', '@scope'], ['ticks', 'ticks'], ['_x9', '_x9']]) {
    assert.equal(text.match(word)[0], expected);
  }
});

// ---- the new syntax, through the real tokenizer ----------------------------

async function loadNew() {
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
      ? vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR, 'utf8'), GRAMMAR)
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

const NEW_SAMPLE = `use self::geo::{a, b};
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
  const tokens = (await loadNew())(NEW_SAMPLE);
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
  const tokens = (await loadNew())(NEW_SAMPLE);
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
  const tokenize = await loadNew();
  const tokens = tokenize('function namespace import export switch case\nlet x = a % 2;\nlet b = %1010;');
  // Unscoped text merges into one token, so the check is that nothing in the input got a keyword scope.
  assert.ok(!tokens.some((t) => t[0] !== 'let' && /^(keyword\.control|storage)/.test(t[1])), JSON.stringify(tokens));
  // `%` is only modulo: no binary-literal scope exists for %1010.
  assert.ok(!tokens.some((t) => t[1] === 'constant.numeric.binary'));
});

test('reserved words are flagged, and a range is not a fraction', async () => {
  const tokenize = await loadNew();
  const tokens = tokenize('struct enum\nfor i: u8 in 0..5 {}');
  assert.equal(tokens.find((t) => t[0] === 'struct')[1], 'invalid.illegal.reserved');
  assert.equal(tokens.find((t) => t[0] === 'enum')[1], 'invalid.illegal.reserved');
  assert.ok(!tokens.some((t) => t[1] === 'constant.numeric.decimal.fraction'));
});

test('a string ends at the end of its line, so an unterminated one does not swallow the file', async () => {
  const tokenize = await loadNew();
  const tokens = tokenize('let s = "oops;\nlet n = 1;');
  assert.equal(tokens.find((t) => t[0] === '1')[1], 'constant.numeric.decimal');
});

test('a use list may span lines and ends at the semicolon', async () => {
  const tokenize = await loadNew();
  const tokens = tokenize('use self::geo::{\n  a,\n  b\n};\nlet n = 1;');
  assert.equal(tokens.find((t) => t[0] === 'b')[1], 'variable.other.readwrite');
  assert.equal(tokens.find((t) => t[0] === '1')[1], 'constant.numeric.decimal');
});

test('#[ is an attribute and #name is a compile-time call, never the other way round', async () => {
  const tokenize = await loadNew();
  const tokens = tokenize('#[cfg(test)]\n#[test]\nfn t() {}');
  assert.equal(tokens.find((t) => t[0] === 'cfg')[1], 'entity.name.function.attribute');
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

test('.8bx is registered as its own language, highlighted by the 8bs grammar', () => {
  // Two language ids, one server, two grammars — the second includes the
  // first, so an .8bx file colours exactly as .8bs does until the BX
  // grammar adds element syntax on top (spec §80, §81).
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const languages = manifest.contributes.languages;
  const bx = languages.find((l) => l.id === '8bitextensible');
  assert.ok(bx, '8bitextensible is not a contributed language');
  assert.deepEqual(bx.extensions, ['.8bx']);
  assert.equal(bx.configuration, languages.find((l) => l.id === '8bitscript').configuration);
  const grammar = manifest.contributes.grammars.find((g) => g.language === '8bitextensible');
  assert.ok(grammar, 'no grammar contributed for 8bitextensible');
  assert.equal(grammar.scopeName, 'source.8bx');
  const bxGrammar = JSON.parse(fs.readFileSync(path.join(__dirname, '..', grammar.path), 'utf8'));
  assert.equal(bxGrammar.scopeName, 'source.8bx');
  assert.ok(bxGrammar.patterns.some((p) => p.include === 'source.8bs'), 'the 8bx grammar does not include source.8bs');
  // 8BX's own scopes on top: the `component` declaration, tags with their
  // names and attributes, and `{ … }` expressions that are 8BitScript again.
  const scopes = new Set();
  for (const r of rules(bxGrammar)) {
    if (r.name) scopes.add(r.name);
    for (const c of Object.values(r.captures ?? {})) scopes.add(c.name);
    for (const c of Object.values(r.beginCaptures ?? {})) scopes.add(c.name);
  }
  for (const scope of ['storage.type.component.8bx', 'entity.name.type.component.8bx', 'storage.type.state.8bx', 'meta.tag.8bx',
    'entity.name.tag.component.8bx', 'entity.other.attribute-name.8bx', 'meta.embedded.expression.8bx']) {
    assert.ok(scopes.has(scope), `${scope} is not in the 8bx grammar`);
  }
  assert.ok(rules(bxGrammar).some((r) => r.include === 'source.8bs#strings'), 'string attributes reuse the 8bs string rule');
  // The tag rule must not fire on `a < b` or `array<u8, 4>`: it wants a
  // PascalCase name or `slot` right after the `<`; a fragment is `<>`.
  const tag = new RegExp(bxGrammar.repository.tag.begin);
  assert.ok(tag.test('<Foo />') && tag.test('<Studio.Window>') && tag.test('<slot />'));
  assert.ok(!tag.test('< b') && !tag.test('<u8, 4>') && !tag.test('<< 2') && !tag.test('<>'));
  assert.ok(new RegExp(bxGrammar.repository.fragment.begin).test('<>'));
  assert.ok(manifest.activationEvents.includes('workspaceContains:**/*.8bx'));
  // The client sends both ids to the one language server.
  const lsp = fs.readFileSync(path.join(__dirname, '..', 'src', 'lsp.cjs'), 'utf8');
  assert.match(lsp, /LANGUAGE_IDS = \['8bitscript', '8bitextensible', '8bitgraphics', '8bitaudio'\]/);
});

test('.8bg and .8ba are registered as their own languages', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const gfx = manifest.contributes.languages.find((l) => l.id === '8bitgraphics');
  const aud = manifest.contributes.languages.find((l) => l.id === '8bitaudio');
  assert.ok(gfx && aud);
  assert.deepEqual(gfx.extensions, ['.8bg']);
  assert.deepEqual(aud.extensions, ['.8ba']);
  const gfxG = manifest.contributes.grammars.find((g) => g.language === '8bitgraphics');
  const audG = manifest.contributes.grammars.find((g) => g.language === '8bitaudio');
  assert.equal(gfxG.scopeName, 'source.8bg');
  assert.equal(audG.scopeName, 'source.8ba');
  const gfxGrammar = JSON.parse(fs.readFileSync(path.join(__dirname, '..', gfxG.path), 'utf8'));
  const audGrammar = JSON.parse(fs.readFileSync(path.join(__dirname, '..', audG.path), 'utf8'));
  const gfxScopes = new Set();
  for (const r of rules(gfxGrammar)) {
    if (r.name) gfxScopes.add(r.name);
    for (const c of Object.values(r.captures ?? {})) gfxScopes.add(c.name);
    for (const c of Object.values(r.beginCaptures ?? {})) gfxScopes.add(c.name);
  }
  const audScopes = new Set();
  for (const r of rules(audGrammar)) {
    if (r.name) audScopes.add(r.name);
    for (const c of Object.values(r.captures ?? {})) audScopes.add(c.name);
    for (const c of Object.values(r.beginCaptures ?? {})) audScopes.add(c.name);
  }
  for (const scope of [
    'meta.declaration.sprite.8bg',
    'meta.declaration.animation.8bg',
    'entity.name.resource.8bg',
    'meta.field.size.8bg',
  ]) {
    assert.ok(gfxScopes.has(scope), `${scope} is not in the 8bg grammar`);
  }
  for (const scope of [
    'meta.declaration.instrument.8ba',
    'meta.declaration.song.8ba',
    'meta.declaration.pattern.8ba',
    'meta.declaration.row.8ba',
    'constant.other.note.8ba',
  ]) {
    assert.ok(audScopes.has(scope), `${scope} is not in the 8ba grammar`);
  }
  assert.ok(manifest.activationEvents.includes('workspaceContains:**/*.8bg'));
  assert.ok(manifest.activationEvents.includes('workspaceContains:**/*.8ba'));
});

test('each source language has light and dark file icons and an optional icon theme', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const byId = new Map(manifest.contributes.languages.map((l) => [l.id, l]));
  for (const [id, ext, light, dark] of [
    ['8bitscript', '.8bs', 'icons/src/8bs-light.svg', 'icons/src/8bs-dark.svg'],
    ['8bitextensible', '.8bx', 'icons/src/8bx-light.svg', 'icons/src/8bx-dark.svg'],
    ['8bitgraphics', '.8bg', 'icons/src/8bg-light.svg', 'icons/src/8bg-dark.svg'],
    ['8bitaudio', '.8ba', 'icons/src/8ba-light.svg', 'icons/src/8ba-dark.svg'],
  ]) {
    const lang = byId.get(id);
    assert.ok(lang?.icon?.light?.endsWith(light), `${id} has no light icon`);
    assert.ok(lang?.icon?.dark?.endsWith(dark), `${id} has no dark icon`);
    assert.ok(fs.existsSync(path.join(root, lang.icon.light)), lang.icon.light);
    assert.ok(fs.existsSync(path.join(root, lang.icon.dark)), lang.icon.dark);
    assert.deepEqual(lang.extensions, [ext]);
  }
  const theme = (manifest.contributes.iconThemes ?? []).find((t) => t.id === '8bitscript');
  assert.ok(theme, 'the 8BitScript icon theme is not contributed');
  assert.equal(theme.label, '8BitScript');
  const themePath = path.join(root, theme.path);
  assert.ok(fs.existsSync(themePath), theme.path);
  const defs = JSON.parse(fs.readFileSync(themePath, 'utf8'));
  // A file icon theme has no per-definition light variant: an `iconPathLight`
  // key is ignored, and a light UI theme is served by the `light` section
  // pointing the same extension at a different definition.
  for (const ext of ['8bs', '8bx', '8bg', '8ba']) {
    const dark = defs.fileExtensions[ext];
    const light = defs.light?.fileExtensions?.[ext];
    assert.ok(dark && defs.iconDefinitions[dark], `icon theme has no entry for .${ext}`);
    assert.ok(light && defs.iconDefinitions[light], `icon theme has no light entry for .${ext}`);
    assert.notEqual(light, dark, `.${ext} resolves to the same icon on both UI themes`);
    for (const key of [dark, light]) {
      const def = defs.iconDefinitions[key];
      assert.ok(def.iconPath, `${key} iconPath`);
      assert.ok(!def.iconPathLight, `${key} uses iconPathLight, which a file icon theme ignores`);
      assert.ok(fs.existsSync(path.join(root, 'themes', def.iconPath)), def.iconPath);
    }
  }
});

test('the icon theme covers the rest of a project, not only the four pillars', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const themePath = path.join(root, manifest.contributes.iconThemes.find((t) => t.id === '8bitscript').path);
  const defs = JSON.parse(fs.readFileSync(themePath, 'utf8'));
  // A file icon theme replaces every icon in the explorer, so a .png or a
  // folder with no entry here draws nothing at all.
  for (const key of ['file', 'folder', 'folderExpanded']) {
    assert.ok(defs.iconDefinitions[defs[key]], `the theme has no ${key} icon`);
  }
  for (const [extension, expected] of [
    ['png', '_image_dark'], ['wav', '_audio_dark'], ['ts', '_code_dark'],
    ['json', '_data'], ['md', '_doc'], ['prg', '_binary'],
  ]) {
    assert.equal(defs.fileExtensions[extension], expected, `.${extension}`);
  }
  // A supporting file wears its pillar's colour: .png the green of a .8bg
  // badge, .wav the amber of a .8ba one, in whichever theme is showing. The
  // badge is the last group drawn, so its fill is the last one in the file.
  const read = (id) => fs.readFileSync(path.join(root, 'themes', defs.iconDefinitions[id].iconPath), 'utf8');
  const badgeColour = (svg) => [...svg.matchAll(/<g fill="(#[0-9a-f]{6})">/g)].map((m) => m[1]).pop();
  for (const [supporting, pillar] of [['png', '8bg'], ['wav', '8ba'], ['ts', '8bx']]) {
    for (const section of [defs, defs.light]) {
      const accent = badgeColour(read(section.fileExtensions[pillar]));
      assert.ok(accent, `.${pillar} has no badge colour`);
      assert.ok(read(section.fileExtensions[supporting]).includes(accent), `.${supporting} does not carry the .${pillar} accent ${accent}`);
    }
  }
  assert.equal(defs.fileNames['8bitscript.config.8bs'], '_8bs_dark', 'a project config wears the language own 8');
  assert.equal(defs.light.fileNames['8bitscript.config.8bs'], '_8bs_light');
  // The old names still load, and still keep the icon rather than falling
  // back to a bare file icon for a project that has not renamed yet.
  assert.equal(defs.fileNames['8bitscript.config.ts'], '_8bs_dark');
  assert.equal(defs.fileNames['8bs.config.ts'], '_8bs_dark');
  for (const def of Object.values(defs.iconDefinitions)) {
    assert.ok(fs.existsSync(path.join(root, 'themes', def.iconPath)), def.iconPath);
  }
});

test('the generated icons and theme are what icons/src hashes to', () => {
  const root = path.join(__dirname, '..');
  const { plan, THEME } = require('../scripts/build-icons.cjs');
  const planned = plan(root);
  // The explorer caches an icon under its URL, so art only reaches the screen
  // when the filename changes with it. Committed output drifting from
  // icons/src is that failure, silently.
  assert.equal(fs.readFileSync(path.join(root, THEME), 'utf8'), planned.themeText, 'run `pnpm run icons`');
  const generated = fs.readdirSync(path.join(root, 'icons', 'file')).sort();
  assert.deepEqual(generated, planned.files.map((icon) => icon.file).sort(), 'run `pnpm run icons`');
  for (const icon of planned.files) {
    assert.deepEqual(fs.readFileSync(path.join(root, 'icons', 'file', icon.file)), icon.contents, icon.file);
  }
});

test('a redesigned icon is published under a new filename', () => {
  const root = path.join(__dirname, '..');
  const { plan } = require('../scripts/build-icons.cjs');
  const before = plan(root).files.map((icon) => icon.file);
  const source = path.join(root, 'icons', 'src', '8bx-dark.svg');
  const original = fs.readFileSync(source);
  try {
    fs.writeFileSync(source, `${original.toString()}<!-- redrawn -->\n`);
    const after = plan(root).files.map((icon) => icon.file);
    assert.equal(after.filter((file) => !before.includes(file)).length, 1);
  } finally {
    fs.writeFileSync(source, original);
  }
});

test('media snippets are contributed for 8bg and 8ba', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const contributed = manifest.contributes.snippets ?? [];
  assert.ok(contributed.some((s) => s.language === '8bitgraphics' && s.path === './snippets/8bg.json'));
  assert.ok(contributed.some((s) => s.language === '8bitaudio' && s.path === './snippets/8ba.json'));
});

// ---- the 8bx grammar, run: what an editor actually colours ------------------
//
// The patterns above compile; these run them, through the same Oniguruma
// VS Code uses, over the shapes the spec draws — an element with props
// and children, a fragment, `{cond ? <A /> : <B />}`, `<slot />`, text —
// and check the scopes each token lands in. A tag's closing `</Name>` is
// matched by a back-reference to its opening name, which `new RegExp`
// cannot check.

const SYNTAXES = path.join(__dirname, '..', 'syntaxes');

async function loadBx() {
  const vsctm = require('vscode-textmate');
  const onig = require('vscode-oniguruma');
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer;
  const onigLib = onig.loadWASM(wasm).then(() => ({
    createOnigScanner: (patterns) => new onig.OnigScanner(patterns),
    createOnigString: (text) => new onig.OnigString(text),
  }));
  const files = { 'source.8bs': '8bs.tmLanguage.json', 'source.8bx': '8bx.tmLanguage.json' };
  const registry = new vsctm.Registry({
    onigLib,
    loadGrammar: (scope) => {
      const file = files[scope];
      return file ? vsctm.parseRawGrammar(fs.readFileSync(path.join(SYNTAXES, file), 'utf8'), file) : null;
    },
  });
  const bxGrammar = await registry.loadGrammar('source.8bx');
  /** Every token of `source` as [text, innermost scope], with the `.8bs`/`.8bx` suffix dropped. */
  return (source) => {
    const out = [];
    let state = vsctm.INITIAL;
    for (const line of source.split('\n')) {
      const { tokens, ruleStack } = bxGrammar.tokenizeLine(line, state);
      for (const t of tokens) {
        const text = line.slice(t.startIndex, t.endIndex);
        if (text.trim() === '') continue;
        out.push([text, t.scopes.at(-1).replace(/\.8b[sx]$/, '')]);
      }
      state = ruleStack;
    }
    return out;
  };
}

const SAMPLE = `pub component Player(name: string) {
    state health: utinyint = 100;
    let a: [utinyint; 4];
    let mut p: ptr<utinyint>;
    if health < 50 && a[0] << 2 > 3 { damage(1); }
}
pub fn draw() {
    <MenuBar row={0} width={40} wide>
        <MenuItem label="FILE" />
        {open && <MenuItem label="EDIT" />}
        <Text>Hello World!</Text>
    </MenuBar>;
    <Box>
        {if c { <A /> } else { <B /> }}
    </Box>;
    return <>{if on { <A /> } else { <slot /> }}</>;
}
`;

test('the 8bx grammar colours components, tags, props, children and expressions the way the spec draws them', async () => {
  const tokenize = await loadBx();
  const tokens = tokenize(SAMPLE);
  const scopeOf = (text, nth = 0) => tokens.filter((t) => t[0] === text)[nth]?.[1];
  // The declaration and its state.
  assert.equal(scopeOf('component'), 'storage.type.component');
  assert.equal(scopeOf('Player'), 'entity.name.type.component');
  assert.equal(scopeOf('state'), 'storage.type.state');
  assert.equal(scopeOf('health'), 'variable.other.state');
  // A tag: its name, its props, `=`, a `{…}` value and a string value.
  assert.equal(scopeOf('MenuBar'), 'entity.name.tag.component');
  assert.equal(scopeOf('row'), 'entity.other.attribute-name');
  assert.equal(scopeOf('wide'), 'entity.other.attribute-name', 'a bare prop is a prop');
  assert.equal(scopeOf('=', 1), 'keyword.operator.assignment', 'the prop\'s =; the state\'s is the 8bs operator');
  assert.equal(scopeOf('40'), 'constant.numeric.decimal');
  assert.equal(scopeOf('FILE'), 'string.quoted.double');
  // Children: a nested self-closing tag, `{cond && <…/>}`, text left plain, the closing tag.
  assert.equal(scopeOf('/>'), 'punctuation.definition.tag.end');
  assert.equal(scopeOf('&&', 1), 'keyword.operator.ternary', 'inside {…} between tags');
  assert.equal(scopeOf('Hello World!'), 'meta.tag', 'text is plain, inside its tag');
  assert.equal(scopeOf('MenuBar', 1), 'entity.name.tag.component', 'the closing tag is the same tag');
  assert.equal(scopeOf('if', 1), 'keyword.control', 'an if expression inside {…} between tags');
  assert.equal(scopeOf('else'), 'keyword.control', 'its else');
  assert.ok(tokens.some(([text, scope]) => text === ':' && scope === 'punctuation.separator.type'), 'the parameter\'s colon still is one');
  assert.equal(scopeOf('slot'), 'entity.name.tag.component');
  // And nothing 8BitScript already had is disturbed: `<` is still the
  // operator in a comparison, a shift, and after ptr.
  assert.equal(scopeOf('<', 0), 'keyword.operator', 'ptr<…>');
  assert.equal(scopeOf('<', 1), 'keyword.operator', 'health < 50');
  assert.equal(scopeOf('<<'), 'keyword.operator');
  assert.equal(scopeOf('&&', 0), 'keyword.operator', 'outside a tag, the 8bs operator');
  assert.equal(scopeOf('damage'), 'entity.name.function.call');
  assert.equal(scopeOf('draw'), 'entity.name.function');
  assert.equal(scopeOf('pub'), 'storage.modifier', 'pub component, not export');
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

test('mnemonics match in any case, immediates take #<label and #>label, and the register may be upper case', async () => {
  const tokenize = await loadNew();
  const tokens = tokenize('asm6502 { LDA #<tbl ; x\n  Lda #>tbl\n  sta $D020,Y }');
  const mnemonics = tokens.filter((t) => t[1] === 'keyword.mnemonic').map((t) => t[0]);
  assert.deepEqual(mnemonics, ['LDA', 'Lda', 'sta']);
  assert.equal(tokens.filter((t) => t[0] === '#').length, 2);
  assert.ok(tokens.every((t) => t[0] !== '#' || t[1] === 'keyword.operator.immediate'));
  assert.equal(tokens.find((t) => t[0] === ',Y')[1], 'variable.language.register');
});

test('a use without its semicolon ends before the next statement', async () => {
  const tokenize = await loadNew();
  const tokens = tokenize('use self::geo::a\nfn f() {}\nuse x::y as z;');
  assert.equal(tokens.find((t) => t[0] === 'fn')[1], 'storage.type.function');
  assert.equal(tokens.find((t) => t[0] === 'f')[1], 'entity.name.function');
  assert.equal(tokens.find((t) => t[0] === 'as')[1], 'keyword.other.as', 'as is one scope in and out of use');
});

test('the C-style for and the fn after an attribute are colored', async () => {
  const tokenize = await loadNew();
  const tokens = tokenize('#[test]\nfn t() {\n  for (let mut i: u8 = 0; i < 9; i -= 1) {}\n}');
  assert.equal(tokens.find((t) => t[0] === 'fn')[1], 'storage.type.function');
  assert.equal(tokens.find((t) => t[0] === 't')[1], 'entity.name.function');
  assert.equal(tokens.find((t) => t[0] === 'for')[1], 'keyword.control');
  assert.equal(tokens.find((t) => t[0] === 'mut')[1], 'storage.modifier');
  assert.equal(tokens.find((t) => t[0] === 'i')[1], 'variable.other.readwrite');
  assert.equal(tokens.find((t) => t[0] === '-=')[1], 'keyword.operator');
});

test('single quotes are not an auto-closing or surrounding pair', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'language-configuration.json'), 'utf8'));
  assert.ok(!config.autoClosingPairs.some((p) => p.open === "'"));
  assert.ok(!config.surroundingPairs.some((p) => p[0] === "'"));
});
