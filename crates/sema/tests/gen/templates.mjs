// Regenerates fixtures/templates.json from packages/compiler/src/templates (the JS oracle).
// Run from the repo root: node crates/sema/tests/gen/templates.mjs
//
// `scanDeclaredTypes` and `layoutTemplate` rows are tap records (scripts/oracle/front-tap): the
// real functions run through the front tap's wrappers and the rows are read back from its output.
// The other exports are plain rows `{fn, args, result}`; a node argument is plain JSON, a Map is
// `[[k, v], ...]`.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walk } from '../../../../packages/compiler/src/ast/index.mjs';
import { parse, tokenize } from '../../../../packages/compiler/src/front/index.mjs';
import {
  COMPARISON_OPERATORS,
  MAX_ARRAY_LENGTH,
  MAX_STRING_LENGTH,
  digitsFor,
  inferType,
  isTemplateCall,
  misplacedTemplate,
  parameterTypes,
  resolveArrayType,
  resolveScalarType,
  typeForCount,
  widerOf,
} from '../../../../packages/compiler/src/templates/index.mjs';
import { INTEGER_TYPE_NAMES } from '../../../../packages/compiler/src/types/index.mjs';

const dir = mkdtempSync(join(tmpdir(), 'templates-gen-'));
process.env.EIGHTBS_FRONT_TAP = dir;
delete process.env.EIGHTBS_FRONT_TAP_ROOTS;
const { layoutTemplate, scanDeclaredTypes } = await import('../../../../scripts/oracle/front-tap/shims/templates.mjs');

const log = join(dir, '0.jsonl');
function take(name) {
  const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (existsSync(log)) rmSync(log);
  return rows.map(({ seq, ...row }) => ({ name, ...row }));
}

const rows = [];
const add = (fn, args, result) => rows.push({ fn, args, result });
const plain = (node) => JSON.parse(JSON.stringify(node ?? null));
const pairs = (map) => [...map];

add('MAX_STRING_LENGTH', [], MAX_STRING_LENGTH);
add('MAX_ARRAY_LENGTH', [], MAX_ARRAY_LENGTH);
add('COMPARISON_OPERATORS', [], [...COMPARISON_OPERATORS]);

const typeNames = [...INTEGER_TYPE_NAMES, 'bool', 'string', 'void', '', 'u64', 'thing', 'constructor'];
const options = [undefined, {}, { allowVoid: true }, { allowString: true }, { allowVoid: true, allowString: true }];
for (const name of typeNames) {
  for (const option of options) {
    add('resolveScalarType', option === undefined ? [name] : [name, option], resolveScalarType(name, option));
  }
  add('digitsFor', [name], digitsFor(name));
  for (const other of [...typeNames, null]) add('widerOf', [name, other], widerOf(name, other));
}
for (const other of typeNames) add('widerOf', [null, other], widerOf(null, other));
add('widerOf', [null, null], widerOf(null, null));
for (const n of [0, 1, 254, 255, 256, 65535, 65536, 1e9]) add('typeForCount', [n], typeForCount(n));

function astOf(text, file) {
  const { tokens } = tokenize(text, file, { sourceKind: '.8bs' });
  return parse(tokens, text, file, { sourceKind: '.8bs' }).ast;
}

const sources = {
  globals: `const COUNT: u8 = 4;
const BIG: u16 = 300;
const WORD: u16 = 1000;
const NEG: i8 = 5;
let a: u8;
let mut b: u16 = 5;
let c: i8;
let d: u32;
let e: u24;
let flag: bool;
let name: string = "hi";
const GREETING: string = "hello";
let mut port: volatile<u8>;
let mut wide: volatile<u16>;
let mut bad: volatile<thing>;
let untyped = 1;
let tbl: array<u8, 16>;
const rom: array<u8, COUNT> = [1, 2, 3, 4];
let big: array<u16, BIG>;
let bigger: array<u8, WORD>;
let flags: array<bool, 8>;
let strs: array<string, 3>;
let empty: array<u8, 0>;
let huge: array<u8, 70000>;
let unknown: array<u8, MISSING>;
let grid: array<array<u8, 4>, 4>;
let notype: array<u8>;
let counted: array<COUNT, 3>;
let sized: array<u8, NEG>;
let cell: ptr<u8>;
fn noop() {}
fn byte() -> u8 { return 1; }
fn word(x: u16, y: u8 = 2) -> u16 { return x; }
fn signed(x: i8) -> i8 { return x; }
fn text() -> string { return "s"; }
fn truth() -> bool { return true; }
fn odd() -> thing { }
fn many(a: u8, b: u8 = 1, c: u8 = 2, d: u8) {}
pub fn exported(msg: string, n: u8, w: u16, k: i8, big: u32, tbl: u8, flag: bool, weird: thing) {
    text::print(0, \`PLAIN\`);
    text::print(0, \`N \${n} W \${w} K \${k}\`);
    text::print(0, \`BIG \${big} FLAG \${flag} MSG \${msg}\`);
    text::print(0, \`G \${a} \${b} \${c} \${d} \${e} \${port} \${wide}\`);
    text::print(0, \`A \${a + n} \${a + b} \${n + w} \${a + c} \${-a} \${!flag} \${a == 1} \${a && n}\`);
    text::print(0, \`LIT \${7} \${255} \${256} \${65535} \${65536} \${true} \${false}\`);
    text::print(0, \`ARR \${tbl[1]} \${rom[0]} \${big[2]} \${flags[1]} \${tbl.length} \${big.length} \${rom.length}\`);
    text::print(0, \`STR \${name.length} \${msg.length} \${GREETING.length} \${a.length} \${tbl.other}\`);
    text::print(0, \`CALL \${byte()} \${word(1)} \${signed(1)} \${text()} \${truth()} \${odd()} \${#sizeof(a)} \${missing()}\`);
    text::print(0, \`WIDTH \${a:3} \${a:1} \${a:255} \${a:0} \${a:256} \${missing:4} \${flag:2}\`);
    text::print(0, \`UNKNOWN \${missing} \${other.thing} \${u.v + 1}\`);
    text::print(0, \`TEXT  é\${a}ü \${missing} \${a:0} ☃\${a}\`);
    text::print(0, \`\`);
    text::print(0, \`\${a}\${b}\${n}\`);
    text::print(0, \`\${(a + 1)} \${tbl[a]} \${tbl[a] + 1} \${-tbl[0]} \${!a} \${a + 300} \${300 + a}\`);
}
fn nested() {
    let local: u8 = 1;
    text::print(0, \`LOCAL \${local} \${a}\`);
}
`,
  strings: `fn show(msg: string, w: u16, k: u24) {
    text::print(0, \`A \${msg} \${msg.length} \${w} \${k}\`);
}
fn dup(a: u8, a: u16, s: string, t: thing, v: void) {}
`,
  empty: '',
  vars: `let t: array<u8, 4>;
fn f(t: u8) { text::print(0, \`\${t} \${t[0]} \${t.length}\`); }
fn g() { text::print(0, \`\${t[0]} \${t.length}\`); }
`,
};

const templates = [];
const calls = [];
const expressions = [];
for (const [key, text] of Object.entries(sources)) {
  const file = `${key}.8bs`;
  const ast = astOf(text, file);
  scanDeclaredTypes(ast);
  rows.push(...take(`scan ${key}`));
  const declared = scanDeclaredTypes(ast);
  take('');
  for (const fn of ast.body.filter((n) => n.type === 'FunctionDeclaration')) {
    add('parameterTypes', [plain(fn)], pairs(parameterTypes(fn)));
    const paramTypes = parameterTypes(fn);
    const scope = { ...declared, paramTypes };
    walk(fn, (node) => {
      if (node.type === 'TemplateLiteral') templates.push({ key, file, text, node, scope });
      if (node.type === 'CallExpression') calls.push(node);
      if (/Expression$|Literal$|Identifier$/.test(node.type)) expressions.push({ node, scope });
    });
  }
}
add('parameterTypes', [{ type: 'FunctionDeclaration', start: 0, length: 0, params: [], exported: false }], []);

const emptyScope = { paramTypes: new Map(), globalTypes: new Map(), functionTypes: new Map(), arrayTypes: new Map() };
for (const { key, file, text, node, scope } of templates) {
  const name = `${key}@${node.start}`;
  layoutTemplate(node, scope, file, text);
  rows.push(...take(`layout ${name} with source`));
  layoutTemplate(node, scope, file);
  rows.push(...take(`layout ${name} without source`));
  layoutTemplate(node, scope, file, '');
  rows.push(...take(`layout ${name} empty source`));
  layoutTemplate(node, emptyScope, file, text);
  rows.push(...take(`layout ${name} empty scope`));
  const noArrays = { paramTypes: scope.paramTypes, globalTypes: scope.globalTypes, functionTypes: scope.functionTypes };
  layoutTemplate(node, noArrays, file, text);
  rows.push(...take(`layout ${name} no arrayTypes`));
  for (const namespace of [undefined, 'text', '']) {
    add('misplacedTemplate', namespace === undefined ? [plain(node), file] : [plain(node), file, namespace],
      misplacedTemplate(node, file, namespace));
  }
}
// The scan of a missing tree.
scanDeclaredTypes(undefined);
rows.push(...take('scan undefined'));
scanDeclaredTypes(null);
rows.push(...take('scan null'));

const encodeScope = (scope) => ({
  paramTypes: pairs(scope.paramTypes),
  globalTypes: pairs(scope.globalTypes),
  functionTypes: pairs(scope.functionTypes),
  ...(scope.arrayTypes ? { arrayTypes: pairs(scope.arrayTypes) } : {}),
});
for (const { node, scope } of expressions) {
  add('inferType', [plain(node), encodeScope(scope)], inferType(node, scope) ?? null);
}
const sample = expressions.find(({ node }) => node.type === 'Identifier')?.scope;
for (const { node } of expressions.slice(0, 40)) {
  const bare = { ...sample, arrayTypes: undefined };
  add('inferType', [plain(node), encodeScope(bare)], inferType(node, bare) ?? null);
}

for (const node of calls) add('isTemplateCall', [plain(node)], isTemplateCall(node));
for (const { node } of expressions.slice(0, 30)) add('isTemplateCall', [plain(node)], isTemplateCall(node));
add('isTemplateCall', [null], isTemplateCall(null));
add('isTemplateCall', [undefined], isTemplateCall(undefined));

// resolveArrayType: every array annotation above, with and without the consts, plus extra consts.
const annotations = [];
for (const text of Object.values(sources)) {
  for (const node of astOf(text, 'a.8bs').body) {
    if (node.type === 'VariableDeclaration' && node.typeAnnotation) annotations.push(node.typeAnnotation);
  }
}
const constSets = [
  undefined, [], [['COUNT', 4]], [['COUNT', 4], ['BIG', 300], ['WORD', 1000], ['NEG', 5], ['MISSING', 0]],
  [['COUNT', 0], ['BIG', 70000], ['WORD', 1.5], ['NEG', -3]],
];
for (const annotation of annotations) {
  for (const consts of constSets) {
    const args = consts === undefined ? [plain(annotation)] : [plain(annotation), consts];
    add('resolveArrayType', args, resolveArrayType(annotation, consts && new Map(consts)));
  }
}
add('resolveArrayType', [null], resolveArrayType(undefined));
add('resolveArrayType', [null, []], resolveArrayType(null, new Map()));

writeFileSync(fileURLToPath(new URL('../fixtures/templates.json', import.meta.url)), `${JSON.stringify(rows)}\n`);
rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${rows.length} rows`);
