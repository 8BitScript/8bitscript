// Regenerates fixtures/specifier.json: `resolveSpecifier`, `nativeSourcesBeside` and
// `resolveImports` of resolver/index.mjs over a temp package tree, from the JS. Rows are
// `{fn, args, result}` (or `throw`); paths in rows are written `<root>/...`, and the Rust test
// builds the same tree from `tree` (plus the `links` symlinks) and maps `<root>` to its own dir.
// `findPackageDir`, `nativeSourcesOf` and the other private helpers are reached through
// `resolveSpecifier` and `nativeSourcesBeside`.
// Run from the repo root: node crates/resolver/tests/gen/specifier.mjs
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../../../../packages/compiler/src/front/index.mjs';
import { CATALOG_SPECIFIER } from '../../../../packages/compiler/src/i18n/index.mjs';
import { nativeSourcesBeside, resolveImports, resolveSpecifier } from '../../../../packages/compiler/src/resolver/index.mjs';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'resolver-specifier-'));
const pkg = (manifest) => JSON.stringify(manifest);
const mod = (ns, members) => `pub mod ${ns} {\n${members.map(([k, v]) => `    const ${k}: string = ${JSON.stringify(v)};`).join('\n')}\n}\n`;
const catalog = mod('Game', [['NAME', '2048']]);

const tree = {
  // The stop for the upward manifest walk.
  'package.json': '{}',
  // A project: relative, alias and package imports.
  'proj/src/main.8bs': 'x',
  'proj/src/a.8bs': 'x',
  'proj/src/a.pet.8bs': 'x',
  'proj/src/a.c64.8bs': 'x',
  'proj/src/b.8bs': 'x',
  'proj/src/b.de.8bs': 'x',
  'proj/src/b.pet.8bs': 'x',
  'proj/src/amb.nes.8bs': 'x',
  'proj/src/amb.de.8bs': 'x',
  'proj/src/amb.8bs': 'x',
  'proj/src/data.bin': 'x',
  'proj/src/geo.8bs': 'x',
  'proj/src/geo.8bx': 'x',
  'proj/case/mark/main.8bs': 'x',
  'proj/case/mark/Mark.8bx': 'x',
  'proj/case/mark/mark.8bg': 'x',
  'proj/case/twin/main.8bs': 'x',
  'proj/case/twin/Twin.c64.8bs': 'x',
  'proj/case/twin/twin.8bx': 'x',
  'proj/case/geo/main.8bs': 'x',
  'proj/case/geo/Geo.8bs': 'x',
  'proj/lib/two.8bs': 'x',
  'proj/lib/two.8bx': 'x',
  'proj/src/dir.8bs/keep': 'x',
  'proj/lib/util.8bs': 'x',
  'proj/lib/util.pet.8bs': 'x',
  'proj/lib/deep/inner.8bs': 'x',
  // Packages in the project's node_modules.
  'proj/node_modules/plain/package.json': pkg({ name: 'plain', '8bitscript': { entry: './src/index.8bs' } }),
  'proj/node_modules/plain/src/index.8bs': 'x',
  'proj/node_modules/plain/src/index.pet.8bs': 'x',
  'proj/node_modules/plain/src/index.pet.8032.8bs': 'x',
  'proj/node_modules/plain/src/index.de.8bs': 'x',
  'proj/node_modules/plain/src/index.nes.8bs': 'x',
  'proj/node_modules/native/package.json': pkg({ name: 'native', '8bitscript': { entry: './src/index.8bs', native: ['./asm/font.s', './asm/data.chr'] } }),
  'proj/node_modules/native/src/index.8bs': 'x',
  'proj/node_modules/native/src/inner.8bs': 'x',
  'proj/node_modules/native/asm/font.s': 'x',
  'proj/node_modules/native/asm/data.chr': 'x',
  'proj/node_modules/nativemissing/package.json': pkg({ name: 'nativemissing', '8bitscript': { entry: './src/index.8bs', native: ['./asm/gone.s'] } }),
  'proj/node_modules/nativemissing/src/index.8bs': 'x',
  'proj/node_modules/nativemissing/src/inner.8bs': 'x',
  'proj/node_modules/nativeform/package.json': pkg({ name: 'nativeform', '8bitscript': { entry: './src/index.8bs', native: 'font.s' } }),
  'proj/node_modules/nativeform/src/index.8bs': 'x',
  'proj/node_modules/nativeform/src/inner.8bs': 'x',
  'proj/node_modules/nativenum/package.json': pkg({ name: 'nativenum', '8bitscript': { entry: './src/index.8bs', native: ['a.s', 3] } }),
  'proj/node_modules/nativenum/src/index.8bs': 'x',
  'proj/node_modules/nativeempty/package.json': pkg({ name: 'nativeempty', '8bitscript': { entry: './src/index.8bs', native: [] } }),
  'proj/node_modules/nativeempty/src/index.8bs': 'x',
  'proj/node_modules/nativeempty/src/inner.8bs': 'x',
  'proj/node_modules/noname/package.json': pkg({ '8bitscript': { entry: './src/index.8bs', native: ['./x.s'] } }),
  'proj/node_modules/noname/src/index.8bs': 'x',
  'proj/node_modules/noname/src/inner.8bs': 'x',
  'proj/node_modules/sub/package.json': pkg({
    name: 'sub',
    '8bitscript': {
      entry: './src/index.8bs',
      native: ['./n.s'],
      exports: { './screen': './src/screen.8bs', './text': './src/text.8bs', './bad': 'nope.8bs', './num': 5, './missing': './src/none.8bs', './abs': '/etc/x.8bs' },
    },
  }),
  'proj/node_modules/sub/n.s': 'x',
  'proj/node_modules/sub/src/index.8bs': 'x',
  'proj/node_modules/sub/src/screen.8bs': 'x',
  'proj/node_modules/sub/src/screen.pet.8bs': 'x',
  'proj/node_modules/sub/src/text.8bs': 'x',
  'proj/node_modules/sub/src/text.de.8bs': 'x',
  'proj/node_modules/sub/src/text.pet.8bs': 'x',
  'proj/node_modules/sub/src/text.nes.8bs': 'x',
  'proj/node_modules/subnat/package.json': pkg({ name: 'subnat', '8bitscript': { entry: './i.8bs', native: ['./gone.s'], exports: { './a': './a.8bs' } } }),
  'proj/node_modules/subnat/i.8bs': 'x',
  'proj/node_modules/subnat/a.8bs': 'x',
  'proj/node_modules/noexports/package.json': pkg({ name: 'noexports', '8bitscript': { entry: './i.8bs' } }),
  'proj/node_modules/noexports/i.8bs': 'x',
  'proj/node_modules/exportsarray/package.json': pkg({ name: 'exportsarray', '8bitscript': { entry: './i.8bs', exports: ['./a'] } }),
  'proj/node_modules/exportsnull/package.json': pkg({ name: 'exportsnull', '8bitscript': { entry: './i.8bs', exports: null } }),
  'proj/node_modules/exportsstring/package.json': pkg({ name: 'exportsstring', '8bitscript': { entry: './i.8bs', exports: 'x' } }),
  'proj/node_modules/exportsempty/package.json': pkg({ name: 'exportsempty', '8bitscript': { entry: './i.8bs', exports: {} } }),
  'proj/node_modules/notbs/package.json': pkg({ name: 'notbs' }),
  'proj/node_modules/emptybs/package.json': pkg({ name: 'emptybs', '8bitscript': {} }),
  'proj/node_modules/entrynum/package.json': pkg({ name: 'entrynum', '8bitscript': { entry: 5 } }),
  'proj/node_modules/entryarray/package.json': pkg({ name: 'entryarray', '8bitscript': { entry: ['./a.8bs'] } }),
  'proj/node_modules/entrynull/package.json': pkg({ name: 'entrynull', '8bitscript': { entry: null } }),
  'proj/node_modules/entrymissing/package.json': pkg({ name: 'entrymissing', '8bitscript': { entry: './nope.8bs' } }),
  'proj/node_modules/broken/package.json': '{ not json',
  'proj/node_modules/jsonnull/package.json': 'null',
  'proj/node_modules/ambiguous/package.json': pkg({ name: 'ambiguous', '8bitscript': { entry: './amb.8bs' } }),
  'proj/node_modules/ambiguous/amb.8bs': 'x',
  'proj/node_modules/ambiguous/amb.nes.8bs': 'x',
  'proj/node_modules/ambiguous/amb.de.8bs': 'x',
  // Conditional entries, delegation and a cycle.
  'proj/node_modules/@8bitscript/screen/package.json': pkg({
    name: '@8bitscript/screen',
    '8bitscript': { entry: { pet: '@8bitscript/pet/screen', c64: '@8bitscript/c64/screen', nes: './src/nes.8bs' }, native: ['./s.s'] },
  }),
  'proj/node_modules/@8bitscript/screen/s.s': 'x',
  'proj/node_modules/@8bitscript/screen/src/nes.8bs': 'x',
  'proj/node_modules/@8bitscript/pet/package.json': pkg({ name: '@8bitscript/pet', '8bitscript': { entry: './i.8bs', native: ['./p.s'], exports: { './screen': './scr.8bs' } } }),
  'proj/node_modules/@8bitscript/pet/i.8bs': 'x',
  'proj/node_modules/@8bitscript/pet/scr.8bs': 'x',
  'proj/node_modules/@8bitscript/pet/p.s': 'x',
  'proj/node_modules/@8bitscript/c64/package.json': pkg({ name: '@8bitscript/c64', '8bitscript': { entry: './i.8bs', exports: { './screen': './scr.8bs' } } }),
  'proj/node_modules/@8bitscript/c64/i.8bs': 'x',
  'proj/node_modules/@8bitscript/c64/scr.8bs': 'x',
  'proj/node_modules/@8bitscript/half/package.json': pkg({
    name: '@8bitscript/half',
    '8bitscript': { entry: { pet: './pet.8bs', c64: './gone.8bs', vic20: 5, nes: 'bad name', a2: '@8bitscript/nothere', a3: '@8bitscript/notbs' } },
  }),
  'proj/node_modules/@8bitscript/half/pet.8bs': 'x',
  'proj/node_modules/@8bitscript/notbs/package.json': pkg({ name: '@8bitscript/notbs' }),
  'proj/node_modules/@8bitscript/sound/package.json': pkg({ name: '@8bitscript/sound', '8bitscript': { entry: { pet: './pet.8bs', c64: './c64.8bs' } } }),
  'proj/node_modules/@8bitscript/sound/pet.8bs': 'x',
  'proj/node_modules/@8bitscript/sound/c64.8bs': 'x',
  'proj/node_modules/@8bitscript/sound/c64.hires.8bs': 'x',
  'proj/node_modules/@8bitscript/empty/package.json': pkg({ name: '@8bitscript/empty', '8bitscript': { entry: {} } }),
  'proj/node_modules/@8bitscript/nativecond/package.json': pkg({ name: '@8bitscript/nativecond', '8bitscript': { entry: { pet: './p.8bs' }, native: ['./gone.s'] } }),
  'proj/node_modules/@8bitscript/nativecond/p.8bs': 'x',
  'proj/node_modules/cyca/package.json': pkg({ name: 'cyca', '8bitscript': { entry: { pet: 'cycb', c64: 'cycb' } } }),
  'proj/node_modules/cycb/package.json': pkg({ name: 'cycb', '8bitscript': { entry: { pet: 'cyca', c64: './x.8bs' } } }),
  'proj/node_modules/cycb/x.8bs': 'x',
  'proj/node_modules/selfcyc/package.json': pkg({ name: 'selfcyc', '8bitscript': { entry: { pet: 'selfcyc' } } }),
  'proj/node_modules/viasub/package.json': pkg({ name: 'viasub', '8bitscript': { entry: { pet: 'sub/screen', c64: 'sub/text', nes: 'sub/nope' } } }),
  'proj/node_modules/viarel/package.json': pkg({ name: 'viarel', '8bitscript': { entry: { pet: './x.8bs', c64: '../x.8bs' } } }),
  'proj/node_modules/viarel/x.8bs': 'x',
  // The pnpm layout: a real package in a store with its dependencies beside it, and a symlink
  // from the project. Only the store's own node_modules has the machine package.
  'store/text/package.json': pkg({ name: '@8bitscript/text', '8bitscript': { entry: { pet: '@8bitscript/pet2/text', c64: '@8bitscript/c642' } } }),
  'store/node_modules/@8bitscript/pet2/package.json': pkg({ name: '@8bitscript/pet2', '8bitscript': { entry: './i.8bs', exports: { './text': './t.8bs' } } }),
  'store/node_modules/@8bitscript/pet2/i.8bs': 'x',
  'store/node_modules/@8bitscript/pet2/t.8bs': 'x',
  'store/node_modules/@8bitscript/c642/package.json': pkg({ name: '@8bitscript/c642', '8bitscript': { entry: './i.8bs' } }),
  'store/node_modules/@8bitscript/c642/i.8bs': 'x',
  'store/lost/package.json': pkg({ name: 'lost', '8bitscript': { entry: { pet: 'nowhere' } } }),
  // A checkout whose packages win over node_modules.
  'chk/packages/screen/package.json': pkg({ name: '@8bitscript/screen', '8bitscript': { entry: './src/c.8bs' } }),
  'chk/packages/screen/src/c.8bs': 'x',
  'chk/packages/nopkg/x.8bs': 'x',
  // A manifest that does not parse beside a source file, and one that is not an object.
  'brokenpkg/package.json': '{ not json',
  'brokenpkg/src/m.8bs': 'x',
  'arrpkg/package.json': '[]',
  'arrpkg/src/m.8bs': 'x',
  'strpkg/package.json': pkg({ name: 5, '8bitscript': { native: ['./gone.s'] } }),
  'strpkg/src/m.8bs': 'x',
  // Catalog projects.
  'cat/src/i18n/en.8bs': catalog,
  'cat/src/i18n/de.8bs': mod('Game', [['NAME', 'café']]),
  'cat/src/game/main.8bs': 'x',
  'nocat/src/game/main.8bs': 'x',
  'badcat/src/i18n/en.8bs': 'pub mod Game {\n    const NAME: string = "unterminated;\n',
  'badcat/src/game/main.8bs': 'x',
};
const links = {
  'proj/node_modules/@8bitscript/text': 'store/text',
  'proj/node_modules/@8bitscript/lost': 'store/lost',
  'proj/node_modules/dangling': 'store/nothing',
};
for (const [file, text] of Object.entries(tree)) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}
for (const [link, target] of Object.entries(links)) {
  mkdirSync(dirname(join(root, link)), { recursive: true });
  symlinkSync(join(root, target), join(root, link));
}
mkdirSync(join(root, 'proj/src/emptydir'), { recursive: true });

const abs = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'string' ? v.replaceAll('<root>', root) : v)));
const tokenized = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value, (_k, v) => (typeof v === 'string' ? v.replaceAll(root, '<root>') : v)));
const rows = [];
const run = (fn, args, call) => {
  const row = { fn, args };
  try {
    row.result = tokenized(call(...abs(args)));
  } catch (error) {
    row.throw = tokenized(String(error?.message ?? error));
  }
  rows.push(row);
};
const FROM = '<root>/proj/src/main.8bs';
const specifier = (spec, options = {}, from = FROM, seen) => {
  const args = seen === undefined ? [spec, from, options] : [spec, from, options, seen];
  run('resolveSpecifier', args, (s, f, o, sn) => resolveSpecifier(s, f, o, sn === undefined ? undefined : new Set(sn)));
};

// Relative imports: variants, path form, the extension rule, missing files and ambiguity.
for (const spec of ['./a.8bs', './b.8bs', './nope.8bs', './data.bin', './a', './dir.8bs', '../src/a.8bs', './amb.8bs', '.', '..', './emptydir', '/nothere.8bs', '<root>/proj/src/a.8bs', '<root>/proj/src/a']) {
  for (const options of [{}, { machine: 'pet' }, { machine: 'c64' }, { machine: 'nes', locale: 'de' }, { machine: 'pet', locale: 'de' }, { locale: 'de' }, { pathForm: true }, { pathForm: true, machine: 'pet' }]) {
    specifier(spec, options);
  }
}
// Two source kinds under one path-form name: 8BS2217.
for (const options of [{ pathForm: true }, { pathForm: true, machine: 'pet' }, {}]) {
  specifier('./geo', options);
  specifier('./geo.8bs', options);
  specifier('@lib/two', { ...options, importAliases: { '@lib': '<root>/proj/lib' } });
}
// Names that differ only in case: 8BS2217 on every file system.
specifier('./mark', { pathForm: true }, '<root>/proj/case/mark/main.8bs');
specifier('./twin', { pathForm: true, machine: 'c64' }, '<root>/proj/case/twin/main.8bs');
specifier('./geo', { pathForm: true }, '<root>/proj/case/geo/main.8bs');
specifier('./x.8bs', { machine: 'pet', tags: ['8032'] });
specifier('./a.8bs', { tags: ['8032'], profile: '8032', machine: 'pet' });
// A relative import inside a package carries the package's native sources.
const NAT = '<root>/proj/node_modules';
for (const name of ['native', 'nativemissing', 'nativeform', 'nativeempty', 'noname']) {
  specifier('./inner.8bs', {}, `${NAT}/${name}/src/main.8bs`);
  specifier('./index.8bs', {}, `${NAT}/${name}/src/main.8bs`);
  specifier('./nope.8bs', {}, `${NAT}/${name}/src/main.8bs`);
}
specifier('./m.8bs', {}, '<root>/brokenpkg/src/x.8bs');
specifier('./m.8bs', {}, '<root>/arrpkg/src/x.8bs');
specifier('./m.8bs', {}, '<root>/strpkg/src/x.8bs');

// Aliases.
const aliases = { '@lib': '<root>/proj/lib', '@lib/deep': '<root>/proj/lib/deep', '@x': '<root>/proj/src' };
for (const spec of ['@lib/util.8bs', '@lib/deep/inner.8bs', '@lib/nope.8bs', '@lib', '@lib/', '@lib/util', '@lib/util.txt', '@libx/util.8bs', '@x/a.8bs', '@x/amb.8bs', '@other/a.8bs']) {
  for (const options of [{}, { machine: 'pet' }, { pathForm: true }, { pathForm: true, machine: 'pet' }]) {
    specifier(spec, { ...options, importAliases: aliases });
  }
}
specifier('@lib/util.8bs', { importAliases: {} });
specifier('@lib/util.8bs', { importAliases: null });

// Packages: entry, variants, subpath, native sources, malformed manifests.
const names = [
  'plain', 'native', 'nativemissing', 'nativeform', 'nativenum', 'nativeempty', 'noname', 'sub', 'subnat', 'noexports', 'exportsarray',
  'exportsnull', 'exportsstring', 'exportsempty', 'notbs', 'emptybs', 'entrynum', 'entryarray', 'entrynull', 'entrymissing', 'broken',
  'jsonnull', 'ambiguous', 'nothere', 'dangling',
];
for (const name of names) {
  for (const options of [{}, { machine: 'pet' }, { machine: 'pet', tags: ['8032'] }, { locale: 'de' }, { machine: 'nes', locale: 'de' }]) specifier(name, options);
}
for (const spec of [
  'sub/screen', 'sub/text', 'sub/bad', 'sub/num', 'sub/missing', 'sub/abs', 'sub/other', 'sub/screen/deeper', 'sub/',
  'subnat/a', 'noexports/a', 'exportsarray/a', 'exportsnull/a', 'exportsstring/a', 'exportsempty/a', 'notbs/a', 'broken/a', 'nothere/a', 'plain/x',
  '@8bitscript/pet/screen', '@8bitscript/pet/nothere', '@8bitscript/pet', '@8bitscript/missing', '@8bitscript/missing/x', '@8bitscript/notbs/x',
]) {
  for (const options of [{}, { machine: 'pet' }, { machine: 'nes', locale: 'de' }, { machine: 'c64', tags: ['hires'] }]) specifier(spec, options);
}
// What is not a specifier at all.
for (const spec of ['', 'Bad Name', 'UPPER', '@scope', '@scope/', '@/x', 'a//b', 'a/b/c', '@a/b/c/d', 'a b', 'a.b', '_a', '-a', 'a_b-c.d', 'a/b.8bs', '@8bitscript/x y', ' ', 'é', 'a/é']) {
  specifier(spec, {});
  specifier(spec, { machine: 'pet' });
}

// Conditional entries: one machine's branch, all branches without one, delegation, the pnpm
// symlink, a cycle, and a `seen` that already holds the package.
const COND = ['@8bitscript/screen', '@8bitscript/half', '@8bitscript/sound', '@8bitscript/empty', '@8bitscript/nativecond', '@8bitscript/text', '@8bitscript/lost', 'cyca', 'cycb', 'selfcyc', 'viasub', 'viarel'];
for (const spec of COND) {
  for (const options of [{}, { machine: 'pet' }, { machine: 'c64' }, { machine: 'nes' }, { machine: 'vic20' }, { machine: 'a2' }, { machine: 'a3' }, { machine: 'c64', tags: ['hires'] }, { machine: 'pet', locale: 'de' }]) {
    specifier(spec, options);
  }
}
specifier('@8bitscript/screen', { machine: 'pet' }, FROM, ['<root>/proj/node_modules/@8bitscript/screen']);
specifier('@8bitscript/screen', {}, FROM, ['<root>/proj/node_modules/@8bitscript/screen']);
specifier('@8bitscript/screen', { machine: 'c64' }, FROM, ['<root>/proj/node_modules/@8bitscript/screen']);
specifier('cyca', { machine: 'pet' }, FROM, ['<root>/proj/node_modules/cycb']);
specifier('cyca', { machine: 'pet' }, FROM, []);
specifier('@8bitscript/text', { machine: 'pet' }, FROM, ['<root>/store/text']);
specifier('@8bitscript/text', { machine: 'pet' }, FROM, ['<root>/proj/node_modules/@8bitscript/text']);
// The symlinked package imported from inside the symlink's own tree.
specifier('@8bitscript/pet2/text', { machine: 'pet' }, '<root>/store/text/package.json');

// A checkout's packages win over node_modules for `@8bitscript/<name>`.
const CHK = '<root>/chk';
for (const options of [{ checkout: CHK }, { checkout: CHK, machine: 'pet' }, { checkout: `${CHK}/` }, { checkout: '' }, { checkout: '<root>/nochk' }, { checkout: null }]) {
  specifier('@8bitscript/screen', options);
  specifier('@8bitscript/pet', options);
  specifier('@8bitscript/nopkg', options);
  specifier('@8bitscript/screen/x', options);
  specifier('@scope/screen', options);
  specifier('screen', options);
}
specifier('@8bitscript/nopkg', { checkout: CHK });

// Package lookup walks up from the importing file.
specifier('plain', {}, '<root>/proj/src/deep/er/x.8bs');
specifier('plain', {}, '<root>/proj/x.8bs');
specifier('plain', {}, '<root>/x.8bs');
specifier('plain', {}, '<root>/store/x.8bs');
specifier('plain', {}, '/x.8bs');

// The message catalog specifier.
for (const [from, options] of [
  ['<root>/cat/src/game/main.8bs', {}], ['<root>/cat/src/game/main.8bs', { locale: 'de' }], ['<root>/cat/src/game/main.8bs', { locale: 'fr' }],
  ['<root>/nocat/src/game/main.8bs', {}], ['<root>/badcat/src/game/main.8bs', {}], ['<root>/cat/src/game/main.8bs', { machine: 'pet' }],
]) {
  specifier(CATALOG_SPECIFIER, options, from);
}

// nativeSourcesBeside: nearest manifest wins; none, broken, wrong shape, missing files.
for (const file of [
  'proj/node_modules/native/src/index.8bs', 'proj/node_modules/native/src/deep/x.8bs', 'proj/node_modules/native/package.json', 'proj/node_modules/native/x.8bs',
  'proj/node_modules/nativemissing/src/inner.8bs', 'proj/node_modules/nativeform/src/inner.8bs', 'proj/node_modules/nativenum/src/index.8bs',
  'proj/node_modules/nativeempty/src/inner.8bs', 'proj/node_modules/noname/src/inner.8bs', 'proj/node_modules/sub/src/screen.8bs',
  'proj/node_modules/@8bitscript/pet/i.8bs', 'proj/node_modules/@8bitscript/screen/s.s', 'proj/node_modules/jsonnull/x.8bs',
  'brokenpkg/src/m.8bs', 'arrpkg/src/m.8bs', 'strpkg/src/m.8bs', 'proj/src/a.8bs', 'proj/lib/util.8bs', 'x.8bs', 'nothing/at/all.8bs', 'proj/node_modules/plain/src/index.8bs',
]) {
  run('nativeSourcesBeside', [`<root>/${file}`], nativeSourcesBeside);
}
run('nativeSourcesBeside', ['/x.8bs'], nativeSourcesBeside);
run('nativeSourcesBeside', ['x.8bs'], nativeSourcesBeside);
run('nativeSourcesBeside', [''], nativeSourcesBeside);

// resolveImports: every import of a file, reported as diagnostics.
const imports = (text, file, options = {}) => {
  const { tokens } = tokenize(text, 'x.8bs', { sourceKind: '.8bs' });
  run('resolveImports', [tokens, file, options], resolveImports);
};
const SRC = [
  'use "./a.8bs"::a;\nuse "./nope.8bs"::b;\nuse "./a"::c;\nuse "./amb.8bs"::d;\n',
  'use plain::x;\nuse nothere::y;\nuse notbs::z;\nuse sub::screen;\nuse sub::missing;\n',
  'use "plain"::x;\nuse "sub/screen"::s;\nuse "sub/nope"::s;\nuse "nativemissing"::n;\n',
  'use @lib::util::a;\nuse @lib::nope::b;\nuse @other::q;\n',
  'use "./nope.8bs"::a;\nuse "./nope.8bs"::a;\nuse "./nope.8bs"::b;\n',
  `use "${CATALOG_SPECIFIER}"::Game;\nuse "./a.8bs"::a;\n`,
  'let x = 1;\n',
  '',
];
for (const text of SRC) {
  for (const options of [{}, { machine: 'pet' }, { importAliases: aliases }, { importAliases: aliases, machine: 'pet' }, { checkout: CHK }]) {
    imports(text, FROM, options);
  }
}
imports(SRC[0], '<root>/proj/node_modules/nativemissing/src/main.8bs');
imports(`use "${CATALOG_SPECIFIER}"::Game;\n`, '<root>/cat/src/game/main.8bs');
imports(`use "${CATALOG_SPECIFIER}"::Game;\n`, '<root>/badcat/src/game/main.8bs');
imports(`use "${CATALOG_SPECIFIER}"::Game;\nuse "./nope.8bs"::a;\n`, '<root>/nocat/src/game/main.8bs');
imports('use "./geo"::g;\nuse @lib::two;\n', FROM, { importAliases: aliases });
imports(SRC[0], 'relative/main.8bs');
imports(SRC[0], '');

rmSync(root, { recursive: true });

const out = fileURLToPath(new URL('../fixtures/specifier.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `{\n"tree": ${JSON.stringify(tree)},\n"links": ${JSON.stringify(links)},\n"dirs": ["proj/src/emptydir"],\n"rows": [\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n}\n`);
console.log(`${rows.length} rows -> ${out}`);
