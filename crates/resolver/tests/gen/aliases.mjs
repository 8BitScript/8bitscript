// Regenerates fixtures/aliases.json: all four exports of resolver/import-aliases.mjs, from the JS.
// Run from the repo root: node crates/resolver/tests/gen/aliases.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aliasedSubpath, isPathForm, longestAliasPrefix, resolveImportAliases,
} from '../../../../packages/compiler/src/resolver/import-aliases.mjs';

const rows = [];
const add = (fn, args, result) => rows.push({ fn, args, result });

const dir = '/proj/app';
const importsCases = [
  undefined, null, {}, [], 'str', 5, true,
  { '@lib': 'src/lib' },
  { '@lib': './src/lib/', '@ui': 'ui//deep/./x', '@a': 'a' },
  { '@lib': 'src/lib', '@ui': 'src/ui', '@lib2': 'l2' },
  { lib: 'src' }, { '@': 'src' }, { '@a/b': 'src' }, { '@a b': 'src' }, { '@a\tb': 'src' }, { '@ ': 's' },
  { '@é\u{1f600}': 'src' }, { '@a"b': 'src' }, { '@a\\b': 'x' }, { '@a\u0001': 'x' }, { '': 'src' },
  { '@lib': '' }, { '@lib': '/abs' }, { '@lib': '../up' }, { '@lib': 'a..b' }, { '@lib': 5 }, { '@lib': null },
  { '@lib': ['x'] }, { '@lib': {} }, { '@ok': 'fine', bad: 'x' }, { bad: 'x', '@ok': '..' },
  { '@lib': 'src' , 7: 'x' }, { 7: 'x', '@lib': 'src' }, { '@z': 'z', '@a': 'a' },
];
for (const imports of importsCases) {
  for (const projectDir of [dir, '/', '/a/b/../c', '/with space']) {
    // serde_json's objects do not keep key order, so an object goes in as its entries.
    const isObject = typeof imports === 'object' && imports !== null && !Array.isArray(imports);
    const arg = imports === undefined ? { $undefined: true } : isObject ? { $entries: Object.entries(imports) } : imports;
    add('resolveImportAliases', [arg, projectDir], resolveImportAliases(imports, projectDir));
  }
}
for (const s of ['./geo', 'geo', 'a/b/c', 'a/b.json', 'a/_x1', 'a/1x', 'a/', '', 'a/b-c', 'a/é', 'x_', '_', 'a/b/c9', '@lib/util/math', 'a.8bs', './data.json', 'a//b']) {
  add('isPathForm', [s], isPathForm(s));
}
const aliases = { '@lib': '/p/lib', '@lib/game': '/p/game', '@ui': '/p/ui', '@é': '/p/e', '@\u{1f600}x': '/p/x' };
for (const s of ['@lib/a', '@lib/game/rules', '@lib', '@libx/a', '@ui/x.8bs', '@other/x', 'lib/a', '', '@lib/', '@é/a', '@\u{1f600}x/a']) {
  add('longestAliasPrefix', [s, aliases], longestAliasPrefix(s, aliases));
}
add('longestAliasPrefix', ['@lib/a', {}], longestAliasPrefix('@lib/a', {}));
for (const [s, p] of [['@lib/util/math.8bs', '@lib'], ['@lib/util/math', '@lib'], ['@lib/data.json', '@lib'], ['@lib/x.8bx', '@lib'], ['@lib/x.8bg', '@lib'],
  ['@lib/x.8ba', '@lib'], ['@lib/', '@lib'], ['@lib/9x', '@lib'], ['@\u{1f600}/a.8bs', '@\u{1f600}'], ['@\u{1f600}/a', '@\u{1f600}'], ['@lib', '@lib']]) {
  for (const pf of [undefined, false, true]) {
    add('aliasedSubpath', pf === undefined ? [s, p] : [s, p, pf], pf === undefined ? aliasedSubpath(s, p) : aliasedSubpath(s, p, pf));
  }
}
const out = fileURLToPath(new URL('../fixtures/aliases.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ rows }, null, 2)}\n`);
console.log(`${rows.length} rows -> ${out}`);
