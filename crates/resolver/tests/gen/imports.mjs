// Regenerates fixtures/imports.json: `findImports` and `pathFormSpecifiers` over token arrays
// from front/index.mjs, plus hand-built old-lexer token runs, from the JS.
// Run from the repo root: node crates/resolver/tests/gen/imports.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../../../../packages/compiler/src/front/index.mjs';
import { findImports, pathFormSpecifiers, withPathForm } from '../../../../packages/compiler/src/resolver/index.mjs';

const sources = [
  '',
  'let x = 1;',
  'use "./a.8bs"::thing;',
  "use './b.8bs'::{x, y};",
  'use "unterminated::x;\n',
  'use "x"',
  'use "x" ::name',
  'use geo::point;',
  'use geo::{a, b};',
  'use geo::shapes::circle::Circle;',
  'use geo;',
  'use @lib::util::math::sqrt;',
  'use @lib::util::{a};',
  'use @lib;',
  'use @lib::x;',
  'use self::a::b;',
  'use self::{a};',
  'use self;',
  'use self::self::a;',
  'use super::a;',
  'use super::super::a::b;',
  'use super::super::{x};',
  'use super::a::super::b;',
  'use super::self::b;',
  'use super;',
  'use super::{a};',
  'use crate::a::b;',
  'use crate::geo::{a};',
  'use crate;',
  'use crate::;',
  'use r#type::value;',
  'use r#mod::{a};',
  'use a::;',
  'use 5::a;',
  'use ::a;',
  'use ',
  'use',
  '// c\nuse /* x */ geo::point; // tail\nuse "m.8bs"::z;',
  'use a::b;\nuse c::d;\nuse "e.8bs"::f;\nlet x = 1;',
  'use geo::point as p;',
  'use a::b::{c, d};\nuse a::b::c;',
  'import "./a.8bs";',
  'import { x } from "./a.8bs";',
  'import x from "./a.8bs"',
  'import { x } "./a.8bs";',
  'import { x }\nfrom "./a.8bs";',
  'import "unterminated\n',
  'import ;',
  'import let x = "a.8bs";',
  'import const y;',
  'import function f() {} "a.8bs"',
  'import return "a.8bs"',
  'import export "a.8bs"',
  'import import "a.8bs"',
  'import { a, b } from "x"; import "y"; use z::w;',
  'import "a" "b"',
  'import "é\u{1f600}.8bs";',
  'use "é\u{1f600}.8bs"::x; use café::x;',
  "import 'single.8bs';",
  'import `tick`;',
];

const rows = [];
const run = (kind, text, tokens) => {
  rows.push({ fn: 'findImports', args: [tokens], result: findImports(tokens), text, kind });
  rows.push({ fn: 'pathFormSpecifiers', args: [tokens], result: [...pathFormSpecifiers(tokens)], text, kind });
};
for (const text of sources) {
  for (const sourceKind of ['.8bs', '.8bx']) {
    const { tokens } = tokenize(text, 'x.8bs', { sourceKind });
    run(sourceKind, text, tokens);
  }
}
const KINDS = new Set();
for (const row of rows) for (const tok of row.args[0]) KINDS.add(tok.kind);

// Old-lexer style runs: `import` and `use` as hand-built tokens with every kind in the scan.
const tok = (kind, text, start) => ({ kind, text, start, length: text.length });
run('hand', 'old', [tok('keyword', 'import', 0), tok('identifier', 'x', 7), tok('identifier', 'from', 9), tok('string', '"a"', 14)]);
run('hand', 'old-comment', [tok('comment', '// c', 0), tok('keyword', 'import', 5), tok('string', '"a"', 12)]);
run('hand', 'use-ident', [tok('identifier', 'use', 0), tok('identifier', 'a', 4), tok('punctuation', '::', 5), tok('identifier', 'b', 7)]);
run('hand', 'scope', [tok('keyword', 'use', 0), tok('scope', '@lib', 4), tok('punctuation', '::', 8), tok('identifier', 'a', 10), tok('punctuation', '::', 11), tok('identifier', 'b', 13)]);
run('hand', 'empty-string', [tok('keyword', 'import', 0), tok('string', '', 7)]);
run('hand', 'one-quote', [tok('keyword', 'import', 0), tok('string', '"', 7)]);
run('hand', 'string-value', [tok('keyword', 'import', 0), { ...tok('string', '"a"', 7), value: 'a' }, { ...tok('identifier', 'x', 12), value: './x.png' }]);
run('hand', 'mismatched', [tok('keyword', 'import', 0), tok('string', '"a\'', 7)]);

// withPathForm over each option shape.
const optionRows = [{}, { machine: 'pet' }, { pathForm: true }, { locale: 'de', tags: ['8032'] }];
const options = [];
for (const o of optionRows) {
  for (const pf of [true, false, undefined]) options.push({ options: o, pathForm: pf ?? null, result: withPathForm(o, pf) });
}

const out = fileURLToPath(new URL('../fixtures/imports.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ rows, options }, null, 2)}\n`);
console.log(`${rows.length} rows, ${options.length} option rows, token kinds ${[...KINDS].join(',')} -> ${out}`);
