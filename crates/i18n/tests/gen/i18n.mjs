// Regenerates fixtures/i18n.json: the i18n helpers over text and a temp tree, from the JS.
// Rows are `{fn, args, result, after?}`. Paths in rows are written `<root>/...`; the Rust test
// builds the same tree from `tree` and maps `<root>` to its own temp dir.
// Maps in results are written as plain objects (catalog identifiers are never integer-like).
// Run from the repo root: node crates/i18n/tests/gen/i18n.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCatalogCharset, catalogSchema, compareCatalogSchemas, discoverCatalogLocales,
  formatMessage, inferCatalogDir, isCatalogFile, isI18nPackageFile, placeholdersOf,
  prepareCatalog, resolveCatalogSpecifier, transliterate, TRANSLITERATIONS, CATALOG_SPECIFIER,
} from '../../../../packages/compiler/src/i18n/index.mjs';
import { parse, tokenize } from '../../../../packages/compiler/src/front/index.mjs';

const root = mkdtempSync(join(tmpdir(), 'i18n-fixture-'));
const mod = (ns, members) => `pub mod ${ns} {\n${members.map(([k, v]) => `    const ${k}: string = ${JSON.stringify(v)};`).join('\n')}\n}\n`;
const EN = mod('Game', [['NAME', '2048'], ['SCORE', 'SCORE']]) + mod('Prompt', [['START', 'PRESS {control}']]);
const DE = mod('Game', [['NAME', '2048'], ['SCORE', 'PUNKTE']]) + mod('Prompt', [['START', '{control} DR\u00dcCKEN']]);
const tree = {
  'ok/src/i18n/en.8bs': EN,
  'ok/src/i18n/de.8bs': DE,
  'ok/src/i18n/readme.txt': 'x',
  'ok/src/i18n/en-GB.8bs': mod('Game', [['NAME', '2048'], ['SCORE', 'SCORE']]),
  'ok/src/i18n/a.b.8bs': 'x',
  'ok/src/game/main.8bs': 'x',
  // German with a gap (filled from the fallback), an unmapped letter, and a stray const.
  'gap/src/i18n/en.8bs': EN,
  'gap/src/i18n/de.8bs': mod('Game', [['NAME', 'caf\u00e9']]),
  'gap/src/i18n/fr.8bs': 'pub mod Game {\n    const NAME: string = "x";\n    const EXTRA: string = "y";\n    const SCORE: string = "{a}";\n}\npub mod Other {\n    const Z: string = "z";\n}\npub mod Empty {\n}\nconst loose: string = "q";\n',
  'gap/src/game/main.8bs': 'x',
  // No default locale file.
  'nodefault/src/i18n/de.8bs': DE,
  // Syntax errors and non-string members.
  'bad/src/i18n/en.8bs': 'pub mod Game {\n    const NAME: number = 1;\n    fn f() {}\n    const OK: string = 3;\n}\nfn top() {}\n',
  'bad/src/i18n/de.8bs': 'pub mod Game {\n    const NAME: string = "unterminated;\n',
  'empty/src/i18n/readme.txt': 'x',
  // Probes: escapes and a newline in a value, a nested pub mod, an expression statement in a
  // mod, duplicate consts and namespaces.
  'esc/src/i18n/en.8bs': 'pub mod Game {\n    const A: string = "line\\nbreak \\"q\\" \\\\ \\t end";\n    const B: string = "a\nb";\n}\n',
  'nest/src/i18n/en.8bs': 'pub mod A {\n    pub mod B {\n        const C: string = "x";\n    }\n    const D: string = "y";\n}\n',
  'expr/src/i18n/en.8bs': 'pub mod A {\n    f();\n    const B: string = "x";\n}\n',
  'dup/src/i18n/en.8bs': 'pub mod A {\n    const B: string = "x";\n    const B: string = "y {p}";\n}\npub mod A {\n    const C: string = "z";\n}\n',
};
for (const [file, text] of Object.entries(tree)) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}
const abs = (value) => (typeof value === 'string' ? value.replaceAll('<root>', root) : value);
const tokenized = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'string' ? v.replaceAll(root, '<root>') : v)));
const absDeep = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'string' ? abs(v) : v)));
const mapToObject = (map) => Object.fromEntries([...map].map(([k, v]) => [k, v instanceof Map ? mapToObject(v) : v]));
const schemaOut = (schema) => ({ namespaces: mapToObject(schema.namespaces), extras: schema.extras, file: schema.file });
const parseText = (text, file) => {
  const { tokens } = tokenize(text, file, { sourceKind: '.8bs' });
  return parse(tokens, text, file, { sourceKind: '.8bs' }).ast;
};
const stringValues = (node, out = []) => {
  if (!node || typeof node.type !== 'string') return out;
  if (node.type === 'StringLiteral') { out.push(node.value); return out; }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => stringValues(item, out));
    else if (value && typeof value === 'object') stringValues(value, out);
  }
  return out;
};

const rows = [];
const row = (fn, args, result, after) => rows.push(after === undefined ? { fn, args, result } : { fn, args, result, after });

// placeholdersOf
for (const text of ['PRESS {control}', '{a} OR {b}', '{a} and {a}', 'no slots', '', '{}', '{1a}', '{_x9}', '{{a}', '{a}}', '{ a }', '{a-b}', '{a}{b}{a}', '\u00dc{u}\u00dc', null, 42])
  row('placeholdersOf', [text], placeholdersOf(text));

// formatMessage: params are [name, value] pairs, in insertion order.
const formats = [
  ['PRESS {control}', [['control', 'RETURN']]],
  ['PRESS {control}', []],
  ['PRESS {control}', [['control', 'RETURN'], ['extra', 'x']]],
  ['{a} {a} {b}', [['a', '1'], ['b', '2']]],
  ['{a} {b}', [['b', '2']]],
  ['{a} {b}', []],
  ['no slots', []],
  ['no slots', [['z', 'x']]],
  ['x', [['b', '1'], ['7', '2'], ['a', '3'], ['1', '4']]],
  ['{a}', [['a', ''], ['3', 'x'], ['2', 'y']]],
  ['{a}', [['a', '$&']]],
  ['{{a}}', [['a', 'v']]],
];
// Names `Object.prototype` has: JS finds them on `params` unless `params` owns the name.
for (const name of Object.getOwnPropertyNames(Object.prototype)) {
  formats.push([`{${name}}`, []]);
  formats.push([`<{${name}}> {a}`, [['a', '1']]]);
  formats.push([`{${name}}`, [[name, 'own']]]);
  formats.push(['x', [[name, 'extra']]]);
}
for (const [template, pairs] of formats) row('formatMessage', [template, pairs], formatMessage(template, Object.fromEntries(pairs)));

// transliterate: every key, then mixes.
for (const key of Object.keys(TRANSLITERATIONS)) row('transliterate', [key], transliterate(key));
for (const text of ['', 'DR\u00dcCKEN', 'GROSS \u00df', 'caf\u00e9', '{a} \u00c4\u00d6\u00dc\u00e4\u00f6\u00fc\u00df', 'x\u00e9y\u00e8', '\ud83d\ude00', 'a\tb', '-.:?!, {}'])
  row('transliterate', [text], transliterate(text));

// catalogSchema and compareCatalogSchemas over text.
const schemaTexts = [
  EN, DE,
  tree['gap/src/i18n/fr.8bs'],
  tree['bad/src/i18n/en.8bs'],
  tree['bad/src/i18n/de.8bs'],
  'import { x } from "y";\npub mod A { const B: string = "{p} {q} {p}"; }\n',
  'mod Private { const B: string = "x"; }\n',
  'pub mod A { let b: string = "x"; pub const c: string = "y"; const d: string = f(); }\n',
  '',
  tree['esc/src/i18n/en.8bs'], tree['nest/src/i18n/en.8bs'], tree['expr/src/i18n/en.8bs'], tree['dup/src/i18n/en.8bs'],
];
for (const text of schemaTexts) row('catalogSchema', [text, 'cat.8bs'], schemaOut(catalogSchema(parseText(text, 'cat.8bs'), 'cat.8bs')));
const compareDiagnostics = (a, b, locale) => compareCatalogSchemas(
  catalogSchema(parseText(a, 'en.8bs'), 'en.8bs'), catalogSchema(parseText(b, `${locale}.8bs`), `${locale}.8bs`), locale);
for (const [a, b, locale] of [
  [EN, DE, 'de'],
  [EN, tree['gap/src/i18n/fr.8bs'], 'fr'],
  [EN, tree['bad/src/i18n/en.8bs'], 'xx'],
  [EN, 'pub mod Game {\n    const NAME: string = "2048 {x}";\n    const SCORE: string = "{a} {b}";\n}\n', 'es'],
  [EN, 'pub mod Prompt {\n    const START: string = "{z}";\n}\n', 'it'],
  [EN, '', 'nl'],
  // An empty extra namespace takes the diagnostic's file from the schema's own `file`.
  [EN, 'pub mod Nothing {\n}\n', 'pt'],
  ['pub mod A { const B: string = "{x} {y}"; }\n', 'pub mod A { const B: string = "{y} {x}"; }\n', 'sv'],
  ['pub mod A { const B: string = "{y} {x}"; }\n', 'pub mod A { const B: string = "{x} {y}"; }\n', 'sv'],
  [tree['dup/src/i18n/en.8bs'], tree['dup/src/i18n/en.8bs'], 'dd'],
  [tree['nest/src/i18n/en.8bs'], tree['expr/src/i18n/en.8bs'], 'ee'],
]) row('compareCatalogSchemas', [a, b, locale], compareDiagnostics(a, b, locale));

// applyCatalogCharset over parsed text; result is the diagnostics and the string values after.
const charsetText = [
  'import { x } from "caf\u00e9";\npub mod A {\n    const B: string = "DR\u00dcCKEN";\n    const C: string = "caf\u00e9 \u00df";\n    const D: string = "{p} ok";\n}\n',
  'pub mod A { const B: string = "\u00e9\u00e8"; const C: string = "\ud83d\ude00"; }\n',
  'pub mod A { const B: string = "fine"; }\n',
];
for (const text of charsetText) {
  for (const charset of [undefined, 'transliterate', 'strict', 'other']) {
    const ast = parseText(text, 'c.8bs');
    const diagnostics = applyCatalogCharset(ast, 'c.8bs', charset);
    row('applyCatalogCharset', charset === undefined ? [text, 'c.8bs'] : [text, 'c.8bs', charset], { diagnostics, values: stringValues(ast) });
  }
}

// Files and paths.
const D = '/proj/src/i18n';
for (const [file, i18n] of [
  [`${D}/en.8bs`, undefined], [`${D}/en-GB.8bs`, undefined], [`${D}/en.bx`, undefined], [`${D}/a.b.8bs`, undefined],
  [`${D}/readme.txt`, undefined], ['/proj/src/game/en.8bs', undefined], ['/proj/src/game/en.8bs', { catalogDir: '/proj/src/game' }],
  [`${D}/en.8bs`, { catalogDir: '/proj/src/game' }], [`${D}/en.8bs`, { catalogDir: '/proj/src/../src/i18n/' }],
  [`${D}/en.8bs`, { catalogDir: '' }], [`${D}/en.8bs`, {}], ['', undefined], ['/i18n/en.8bs', undefined], [`${D}/./en.8bs`, undefined],
  ['src/i18n/en.8bs', { catalogDir: 'src/i18n/.' }], [`${D}/EN.8bs`, undefined], [`${D}/1.8bs`, undefined], [`${D}/x_y.8bs`, undefined],
]) row('isCatalogFile', i18n === undefined ? [file] : [file, i18n], isCatalogFile(file, i18n));
for (const file of [
  '/p/i18n/src/index.8bs', '/p/i18n/src/index.de.8bs', 'C:\\p\\i18n\\src\\index.en-GB.8bs', '/p/i18n/src/index.8bs.8bs',
  'i18n/src/index.8bs', '/i18n/src/index.8bs', '/p/i18n/src/index..8bs', '/p/i18n/src/index.a.b.8bs', '/p/i18n/src/index.8bx',
  '/p/i18n/src/other.8bs', '/p/i18n/src/index.d_e.8bs', '/p/i18n/src/index.-.8bs', '/p/i18n/src/index.x.8bs/', '', '/i18n/src/index/i18n/src/index.x.8bs', '/p/i18n/src/index.i18n/src/index.8bs',
]) row('isI18nPackageFile', [file], isI18nPackageFile(file));

for (const dir of ['<root>/ok/src/i18n', '<root>/empty/src/i18n', '<root>/missing/dir', '<root>/ok/src/game/main.8bs', '<root>/ok/src/i18n/en.8bs'])
  row('discoverCatalogLocales', [dir], tokenized(discoverCatalogLocales(abs(dir))));
for (const file of ['<root>/ok/src/game/main.8bs', '<root>/ok/src/i18n/en.8bs', '<root>/gap/src/game/main.8bs', '<root>/empty/src/x.8bs', '']) {
  row('inferCatalogDir', [file], tokenized(inferCatalogDir(abs(file))));
}
const above = inferCatalogDir(join(root, 'orphan', 'x.8bs'));
if (above !== null) throw new Error(`a src/i18n exists above ${root}: ${above}`);
row('inferCatalogDir', ['<root>/orphan/x.8bs'], null);

// prepareCatalog and resolveCatalogSpecifier.
const options = (project, extras = {}) => ({
  catalogDir: `<root>/${project}/src/i18n`, defaultLocale: 'en', fallbackLocale: 'en', locales: ['en', 'de'], charset: 'transliterate', ...extras,
});
const prepares = [
  { i18n: options('ok') },
  { i18n: options('ok'), locale: 'de' },
  { i18n: options('ok'), locale: 'fr' },
  { i18n: options('ok', { locales: [] }), locale: 'en-GB' },
  { i18n: options('ok', { locales: undefined, fallbackLocale: 'de' }), locale: 'zz' },
  { i18n: options('ok', { charset: 'strict' }), locale: 'de' },
  { i18n: options('gap', { locales: ['en', 'de', 'fr'] }), locale: 'de' },
  { i18n: options('gap', { locales: ['en', 'de', 'fr'], charset: 'strict' }), locale: 'fr' },
  { i18n: options('gap', { locales: ['en', 'de', 'fr', 'es'] }), locale: 'es' },
  { i18n: options('nodefault') },
  { i18n: options('nodefault'), fromFile: '<root>/nodefault/src/main.8bs' },
  { i18n: options('nodefault', { defaultLocale: 'de', locales: ['de'] }), locale: 'de' },
  { i18n: options('nodefault', { defaultLocale: 'fr', locales: ['de'] }) },
  { i18n: options('bad') },
  { i18n: options('empty') },
  { i18n: options('missing') },
  { i18n: options('ok', { defaultLocale: undefined, fallbackLocale: undefined }) },
  { i18n: options('ok', { defaultLocale: '' }) },
  { i18n: options('ok', { locales: ['en', 'en', 'de'] }), locale: 'de' },
  { i18n: options('ok', { catalogDir: '<root>/ok/src/i18n/' }) },
  { i18n: options('esc', { locales: ['en'] }) },
  { i18n: options('esc', { locales: ['en'], charset: 'strict' }) },
  { i18n: options('nest', { locales: ['en'] }) },
  { i18n: options('expr', { locales: ['en'] }) },
  { i18n: options('dup', { locales: ['en'] }) },
  { i18n: { catalogDir: '' } },
  { fromFile: '<root>/x.8bs' },
  {},
];
for (const opts of prepares) row('prepareCatalog', [opts], tokenized(prepareCatalog(absDeep(opts))));

const resolves = [
  ['<root>/ok/src/game/main.8bs', {}],
  ['<root>/ok/src/game/main.8bs', { locale: 'de' }],
  ['<root>/ok/src/game/main.8bs', { locale: 'fr' }],
  ['<root>/gap/src/game/main.8bs', {}],
  ['<root>/ok/src/game/main.8bs', { i18n: options('ok') }],
  ['<root>/ok/src/game/main.8bs', { i18n: options('ok', { charset: 'strict' }), locale: 'de' }],
  ['<root>/ok/src/game/main.8bs', { i18n: options('gap', { locales: ['en', 'de', 'fr'] }) }],
  ['<root>/ok/src/game/main.8bs', { i18n: options('nodefault') }],
  ['<root>/ok/src/game/main.8bs', { i18n: options('bad') }],
  ['<root>/ok/src/game/main.8bs', { i18n: options('missing') }],
  ['<root>/ok/src/game/main.8bs', { i18n: { catalogDir: '' } }],
  ['<root>/orphan/x.8bs', {}],
  ['', {}],
  ['<root>/ok/src/game/main.8bs', { i18n: { ...options('ok'), prepared: { ok: true, path: 'cached.8bs', text: 'T', diagnostics: [] }, preparedLocale: 'en' } }],
  ['<root>/ok/src/game/main.8bs', { i18n: { ...options('ok'), prepared: { ok: true, path: 'cached.8bs', text: 'T', diagnostics: [] }, preparedLocale: 'de' } }],
  ['<root>/ok/src/game/main.8bs', { locale: 'de', i18n: { ...options('ok'), prepared: { ok: true, path: 'cached.8bs', text: 'T', diagnostics: [] }, preparedLocale: 'de' } }],
  ['<root>/ok/src/game/main.8bs', { i18n: { ...options('ok'), prepared: { ok: false, path: 'p.8bs', diagnostics: [] }, preparedLocale: 'en' } }],
  ['<root>/ok/src/game/main.8bs', { i18n: { ...options('ok'), prepared: { ok: true, path: '', diagnostics: [{ code: 'C1', message: 'm', file: 'f', start: 1, length: 2, severity: 'error' }] }, preparedLocale: 'en' } }],
  ['<root>/ok/src/game/main.8bs', { i18n: { ...options('ok'), prepared: { ok: false, diagnostics: [] }, preparedLocale: 'en' } }],
];
for (const [fromFile, opts] of resolves) {
  const live = absDeep(opts);
  const result = resolveCatalogSpecifier(CATALOG_SPECIFIER, abs(fromFile), live);
  row('resolveCatalogSpecifier', [CATALOG_SPECIFIER, fromFile, opts], tokenized(result), tokenized(live));
}
row('resolveCatalogSpecifier', ['other/thing', '<root>/ok/src/game/main.8bs', {}], null, {});
row('resolveCatalogSpecifier', ['', '', {}], null, {});

rmSync(root, { recursive: true });
const out = fileURLToPath(new URL('../fixtures/i18n.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ tree, rows }, null, 2)}\n`);
console.log(`${rows.length} rows -> ${out}`);
