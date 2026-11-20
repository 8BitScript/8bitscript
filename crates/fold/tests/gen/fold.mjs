// Regenerates fixtures/fold.json: `foldCompileTime` (packages/compiler/src/fold/index.mjs) over
// parsed new-syntax text, one row per call in the front tap's record shape
// `{fn, args, result, after}` (the arguments as the tap encodes them before the call, `after` the
// tree as the call left it). A row also holds `sites` (the `defineSites` array after the call),
// `throw` when the call threw, and for `#package` rows `tree` (the files the call reads, written
// under a temporary directory that the row's strings name as `<tmp>`).
// Run from the repo root: node crates/fold/tests/gen/fold.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, tokenize } from '../../../../packages/compiler/src/front/index.mjs';
import { foldCompileTime, SYSTEMS } from '../../../../packages/compiler/src/fold/index.mjs';
import { FACTS } from '../../../../packages/compiler/src/fold/facts.mjs';
import { Encoder } from '../../../../scripts/oracle/front-tap/graph.mjs';

const rows = [];
const tmp = mkdtempSync(join(tmpdir(), 'fold-gen-'));

function parseText(text, file) {
  const tokens = tokenize(text, file);
  return parse(tokens, text, file).ast;
}

/** Stand-ins for the temporary directory in every string of a row. */
const mask = (value) => JSON.parse(JSON.stringify(value).split(JSON.stringify(tmp).slice(1, -1)).join('<tmp>'));

function call(name, text, file, options, extra = {}) {
  const ast = text === null ? null : parseText(text, file ?? '<unknown>');
  const sites = options?.defineSites;
  const args = [ast];
  if (file !== undefined || options !== undefined) args.push(file);
  if (options !== undefined) args.push(options);
  const encoded = args.map((arg) => new Encoder({ asts: [ast] }).encode(arg));
  const row = { name, fn: 'foldCompileTime', args: encoded };
  try {
    row.result = new Encoder({ asts: [ast] }).encode(foldCompileTime(...args));
    row.after = new Encoder({ asts: [ast] }).encode(ast);
  } catch (error) {
    row.throw = error.message;
  }
  if (sites) row.sites = JSON.parse(JSON.stringify(sites));
  rows.push(mask({ ...row, ...extra }));
}

const stmt = (expr) => `let a: u8 = ${expr};\n`;
const prog = (...exprs) => exprs.map(stmt).join('');

// Durations.
call('frames int', prog('#frames(1, seconds)', '#frames(3, seconds)', '#frames(0, seconds)'));
call('frames decimal', prog('#frames(0.5, seconds)', '#frames(1.5, seconds)', '#frames(0.25, seconds)', '#frames(0.0166, seconds)'));
for (const frameRate of [1, 5, 7, 15, 24, 25, 30, 50, 60, 75, 120, 144, 1000, 0, -60]) {
  call(`frames at ${frameRate}`, prog('#frames(0.5, seconds)', '#frames(0.1, seconds)', '#frames(2.5, seconds)', '#frames(0.333, seconds)', '#frames(1, seconds)'), undefined, { frameRate });
}
call('frames zero', prog('#frames(0.001, seconds)', '#frames(0.0, seconds)'));
call('frames singular inexact', prog('#frames(0.0166, seconds)', '#frames(0.0167, seconds)'));
call('frames huge', prog('#frames(100000000000000000000, seconds)', '#frames(123456789012345678901234567890, seconds)', '#frames(0.00000000000000000001, seconds)'));
call('frames many digits', prog('#frames(3.14159265358979323846, seconds)', '#frames(0.1000000000000000055511151231257827, seconds)'));
call('frames hex', prog('#frames(0x10, seconds)', '#frames(0b101, seconds)'));
call('frames fractional rate throws', prog('#frames(1, seconds)'), undefined, { frameRate: 1.5 });
call('frames bad rate unused', prog('#system()'), undefined, { frameRate: 1.5 });
call('frames bad shape', prog('#frames(x, seconds)', '#frames(1)', '#frames(1, seconds, 2)', '#frames(1, 2)', '#frames()', '#frames("a", seconds)', '#frames(1.5, #seconds)'));
call('frames unit', prog('#frames(1, minutes)', '#frames(1, Seconds)', '#frames(1.5, ms)'));
call('frames nested', 'fn f() {\n    g(#frames(1, seconds), [#frames(0.5, seconds)], x[#frames(2, seconds)]);\n    wait(#frames(#frames(1, seconds), seconds));\n}\n');
call('frames bx', 'component A() {\n    <Box w={#frames(1, seconds)} />;\n}\n');

// Unknown and bare names.
call('unknown call', prog('#nope(1)', '#nope()', '#Frames(1, seconds)', '#frames_(1)'));
call('bare names', 'fn f() {\n    #frames;\n    #system;\n    #fact;\n    #locale;\n    #package;\n    #define;\n    #nope;\n    let a = #frames + #nope;\n}\n');
call('unknown call arguments', 'fn f() {\n    #nope(1.5, #frames, #system());\n    #nope(#frames(1, seconds));\n}\n');
call('callee not an identifier', 'fn f() {\n    #frames.x(1);\n    a.b(#system());\n}\n');

// #system.
call('system no machine', prog('#system()'));
call('system args', prog('#system(1)', '#system(a, b)', '#system(1.5)'));
for (const machine of [...SYSTEMS.keys(), 'zzz', 'C64', '']) call(`system ${machine}`, prog('#system()', '#system(1)'), 'a.8bs', { machine });
call('system unknown machine', prog('#system()'), undefined, { machine: 'toaster' });

// #fact.
call('fact no machine', prog(...[...FACTS.keys()].map((key) => `#fact(${key})`)));
const sheet = {};
let n = 1;
for (const [key, fact] of FACTS) {
  if (fact.type === 'count') sheet[key] = n++ * 10;
  else if (fact.type === 'flag') sheet[key] = n++ % 2 === 0;
}
call('fact with sheet', prog(...[...FACTS.keys()].map((key) => `#fact(${key})`)), 'a.8bs', { machine: 'c64', facts: sheet });
call('fact sheet gaps', prog(...[...FACTS.keys()].map((key) => `#fact(${key})`)), 'a.8bs', { machine: 'c64', facts: {} });
call('fact no sheet', prog(...[...FACTS.keys()].map((key) => `#fact(${key})`)), 'a.8bs', { machine: 'nes' });
call('fact sheet no machine', prog('#fact(video.columns)'), 'a.8bs', { facts: { 'video.columns': 40 } });
call('fact odd values', prog('#fact(video.columns)', '#fact(memory.ram)'), 'a.8bs', { machine: 'c64', facts: { 'video.columns': 40.5, 'memory.ram': 1e21 } });
call('fact bad', prog('#fact()', '#fact(1)', '#fact(a, b)', '#fact(video.nope)', '#fact(nope)', '#fact(video.columns.x)', '#fact(#video.columns)', '#fact(video[0])', '#fact("video")', '#fact(a.b.c.d)'), 'a.8bs', { machine: 'c64', facts: sheet });
call('fact bad no machine', prog('#fact(nope)', '#fact()'));
call('fact list', prog('#fact(input.controls)'), 'a.8bs', { machine: 'c64', facts: sheet });
call('fact list no machine', prog('#fact(input.controls)'));
call('fact keys', prog('#fact(toString)', '#fact(constructor)', '#fact(__proto__)'), 'a.8bs', { machine: 'c64', facts: sheet });
call('fact own key only', prog('#fact(video.columns)'), 'a.8bs', { machine: 'c64', facts: Object.create({ 'video.columns': 9 }) });

// #locale.
call('locale none', prog('#locale("de")', '#locale("pt-br")'));
call('locale match', prog('#locale("de")', '#locale("fr")', '#locale("pt-br")'), 'a.8bs', { locale: 'de' });
call('locale region', prog('#locale("pt-br")', '#locale("pt")'), 'a.8bs', { locale: 'pt-br' });
call('locale invalid', prog('#locale("DE")', '#locale(1)', '#locale("c64")', '#locale()', '#locale("a")', '#locale("de", "fr")', '#locale(de)', '#locale("de-")', '#locale("toolongname")', '#locale("web")', '#locale("é")'), 'a.8bs', { locale: 'de' });
call('locale quote', prog('#locale("a\\"b")', '#locale("tab\\t")'));

// #define.
call('define defaults', prog('#define("SEED", 10)', '#define("FORCE_BONUS", false)', '#define("THEME", "classic")', '#define("ON", true)', '#define("ZERO", 0)'), 'a.8bs', {}, {});
call('define given', prog('#define("SEED", 10)', '#define("FORCE_BONUS", false)', '#define("THEME", "classic")'), 'a.8bs', { defines: { SEED: 42, FORCE_BONUS: true, THEME: 'dark' } });
call('define given odd numbers', prog('#define("SEED", 10)', '#define("OTHER", 1)'), 'a.8bs', { defines: { SEED: -5, OTHER: 2.5 } });
call('define mismatch', prog('#define("SEED", 10)', '#define("FORCE_BONUS", false)', '#define("THEME", "classic")'), 'a.8bs', { defines: { SEED: 'x', FORCE_BONUS: 3, THEME: true } });
call('define null given', prog('#define("SEED", 10)'), 'a.8bs', { defines: { SEED: null } });
call('define invalid', prog('#define("seed", 1)', '#define("1A", 1)', '#define(SEED, 1)', '#define("SEED")', '#define("SEED", 1, 2)', '#define("SEED", -1)', '#define("SEED", 1.5)', '#define("SEED", 9007199254740992)', '#define("SEED", x)', '#define()', '#define("", 1)', '#define("A B", 1)', '#define("A\\n", 1)', '#define(1, 2)'), 'a.8bs', {});
call('define safe int edge', prog('#define("A", 9007199254740991)', '#define("B", 0x10)'), 'a.8bs', {});
call('define sites', prog('#define("SEED", 10)', '#define("SEED", 10)', '#define("THEME", "x")', '#define("FLAG", true)'), 'a.8bs', { defineSites: [] });
call('define conflict', prog('#define("SEED", 10)', '#define("SEED", 11)', '#define("SEED", true)', '#define("SEED", "10")', '#define("S", "a")', '#define("S", "b")'), 'a.8bs', { defineSites: [] });
call('define conflict earlier file', prog('#define("SEED", 11)'), 'b.8bs', { defineSites: [{ name: 'SEED', kind: 'int', default: 10, file: 'a.8bs', start: 4 }] });
call('define sites invalid', prog('#define("seed", 1)', '#define("OK", 1)'), 'a.8bs', { defineSites: [] });
call('define string quote', prog('#define("T", "a\\"b\\\\c")', '#define("T", "x")'), 'a.8bs', { defineSites: [], defines: { T: 5 } });
call('define nested default', prog('#define("A", #define("B", 1))', '#define("C", #frames(1, seconds))'), 'a.8bs', {});

// #package.
let packages = 0;
function packageCase(name, tree, file, text = prog('#package("version")', '#package("name")')) {
  const dir = `p${++packages}`;
  const root = join(tmp, dir);
  mkdirSync(root);
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const abs = file === undefined ? undefined : join(root, file);
  call(name, text, abs, {}, { tree: Object.fromEntries(Object.entries(tree).map(([p, c]) => [`${dir}/${p}`, c])) });
}
packageCase('package ok', { 'package.json': '{"name":"demo","version":"1.2.3"}', 'src/a.8bs': '' }, 'src/a.8bs');
packageCase('package nested', { 'package.json': '{"name":"outer","version":"1"}', 'inner/package.json': '{"name":"inner","version":"2"}', 'inner/src/x/a.8bs': '' }, 'inner/src/x/a.8bs');
packageCase('package missing field', { 'package.json': '{"name":"demo"}', 'a.8bs': '' }, 'a.8bs');
packageCase('package non string', { 'package.json': '{"name":1,"version":["a"]}', 'a.8bs': '' }, 'a.8bs');
packageCase('package not object', { 'package.json': '[1,2]', 'a.8bs': '' }, 'a.8bs');
packageCase('package null json', { 'package.json': 'null', 'a.8bs': '' }, 'a.8bs');
packageCase('package string json', { 'package.json': '"abc"', 'a.8bs': '' }, 'a.8bs');
packageCase('package broken', { 'package.json': '{"name":', 'a.8bs': '' }, 'a.8bs', prog('#package("name")'));
packageCase('package empty string', { 'package.json': '{"name":"","version":"0"}', 'a.8bs': '' }, 'a.8bs');
packageCase('package unicode', { 'package.json': '{"name":"d\\u00e9mo\\n\\"q\\"","version":"1"}', 'a.8bs': '' }, 'a.8bs');
packageCase('package bad field', { 'package.json': '{"name":"demo","version":"1"}', 'a.8bs': '' }, 'a.8bs', prog('#package("main")', '#package()', '#package(version)', '#package("name", "x")', '#package(1)', '#package("Name")'));
packageCase('package no file', { 'package.json': '{"name":"demo","version":"1"}' }, undefined);
call('package unknown file', prog('#package("name")'), '<unknown>', {});
call('package empty file', prog('#package("name")'), '', {});
packageCase('package none above', { 'a.8bs': '' }, 'a.8bs', prog('#package("name")'));
packageCase('package root file', { 'package.json': '{"name":"demo","version":"1"}' }, 'a.8bs');

// Decimal literals outside a clock call, and a tree that is not a program.
call('decimal misplaced', 'fn f() {\n    let a: u8 = 1.5;\n    g(2.25, 0.5);\n    let b = [1.5, 2.5];\n}\n');
call('decimal inside call args', prog('#nope(1.5)', '#system(1.5)', '#fact(1.5)', '#locale(1.5)', '#define("A", 1.5)', '#package(1.5)'));
call('no calls', 'fn f() {\n    let a: u8 = 1;\n    g(a, "s", true);\n}\n');
call('empty program', '');
call('null tree', null);
call('options absent file', prog('#frames(1, seconds)'), undefined, undefined);
call('options only file', prog('#frames(1, seconds)'), 'a.8bs', undefined);
call('options empty', prog('#frames(1, seconds)'), 'a.8bs', {});
call('options frame rate only', prog('#frames(1, seconds)'), 'a.8bs', { frameRate: 30 });
call('mixed', 'fn f() {\n    let a: u8 = #frames(0.5, seconds) + #system() + #fact(video.columns);\n    if #locale("de") && #define("ON", true) {\n        g(#nope(1), 1.5);\n    }\n}\n', 'a.8bs', { frameRate: 50, machine: 'c64', facts: sheet, locale: 'de', defines: { ON: false }, defineSites: [] });

rmSync(tmp, { recursive: true, force: true });
const out = fileURLToPath(new URL('../fixtures/fold.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(rows)}\n`);
console.log(`${rows.length} rows -> ${out}`);
