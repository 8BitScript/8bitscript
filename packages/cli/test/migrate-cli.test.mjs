// `8bs migrate`: the modes, the proof, the embedded-program scanner, and the
// rule that no converted file assigns an immutable `let` (E20, 8BS1031). The
// new checker (F-01) is not built yet, so `immutableLetStores` below applies
// the same block-scope rule over the new front end's tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseNew, tokenize as tokenizeNew } from '@8bitscript/compiler/front';
import { migrate, migrateText, sourceFiles } from '../src/migrate/index.mjs';
import { convertEmbedded, convertFences } from '../src/migrate/embedded.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Run `8bs migrate` in `cwd`, returning the exit code and the printed lines. */
async function run(cwd, ...args) {
  const lines = [];
  const code = await migrate(args, { cwd, out: (line) => lines.push(line) });
  return { code, lines, summary: lines.at(-1) };
}

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-migrate-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const OLD = 'export let n: u8 = 0;\nexport function main(): void {\n    n++;\n}\n';
const NEW = 'pub let mut n: u8 = 0;\npub fn main() {\n    n += 1;\n}\n';

// ---- migrateText -------------------------------------------------------------

test('migrateText converts old syntax and proves it', () => {
  assert.deepEqual(migrateText(OLD), { status: 'converted', text: NEW });
});

test('migrateText reports already-new text, including text the old parser would recover from', () => {
  assert.equal(migrateText(NEW).status, 'already-new');
  // The old parser reads this as three expression statements and a block, with no diagnostic.
  assert.equal(migrateText('pub mod Video {\n    const ROWS: u8 = 24;\n}\n').status, 'already-new');
});

test('migrateText reports text that is neither syntax, with its line', () => {
  const result = migrateText('let x = ;\n');
  assert.equal(result.status, 'failed');
  assert.match(result.message, /does not parse as old syntax: expected an expression.*\(line 1\)/);
});

test('migrateText converts a source that both parsers accept, marking what is assigned', () => {
  const result = migrateText('let x: u8 = 1;\nfunction f(): void { x = 2; }\n');
  assert.equal(result.status, 'converted');
  assert.equal(result.text, 'let mut x: u8 = 1;\nfn f() {\n    x = 2;\n}\n');
});

// ---- the modes -----------------------------------------------------------------

test('--check writes nothing, reports the count and exits 0 when every file proves', async () => {
  const dir = project({ 'a.8bs': OLD, 'sub/b.8bx': 'export function f(): void { <A />; }\n' });
  try {
    const { code, summary } = await run(dir, '--check');
    assert.equal(code, 0);
    assert.match(summary, /^2 would convert, 0 already new syntax, 0 differences, 0 failures$/);
    assert.equal(readFileSync(join(dir, 'a.8bs'), 'utf8'), OLD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without --check the files are converted in place, and a second run says already new syntax', async () => {
  const dir = project({ 'a.8bs': OLD });
  try {
    assert.equal((await run(dir)).code, 0);
    assert.equal(readFileSync(join(dir, 'a.8bs'), 'utf8'), NEW);
    const again = await run(dir, '--check');
    assert.equal(again.code, 0);
    assert.ok(again.lines.includes('already new syntax a.8bs'));
    assert.match(again.summary, /^0 would convert, 1 already new syntax/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that cannot be converted is a failure: exit 1, and the file is left alone', async () => {
  const dir = project({ 'ok.8bs': OLD, 'bad.8bs': 'let x = ;\n' });
  try {
    const { code, lines } = await run(dir);
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.startsWith('FAILED bad.8bs: ')));
    assert.equal(readFileSync(join(dir, 'bad.8bs'), 'utf8'), 'let x = ;\n');
    assert.equal(readFileSync(join(dir, 'ok.8bs'), 'utf8'), NEW);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configs, old-syntax pair fixtures, crates and the converter itself are skipped; node_modules too', async () => {
  const dir = project({
    'crates/x/tests/p.8bs': 'let x = ;\n',
    'tests/pairs/1.old.8bs': OLD,
    'node_modules/m/a.8bs': OLD,
    'packages/cli/src/migrate/fixture.8bs': OLD,
    'src/real.8bs': OLD,
  });
  try {
    const { lines } = await run(dir, '--check');
    assert.deepEqual(lines, ['would convert src/real.8bs', '1 would convert, 0 already new syntax, 0 differences, 0 failures']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--alias lets a package import with an extension take the path form', async () => {
  const src = 'import { a } from "@lib/rules.8bs";\n';
  const dir = project({ 'a.8bs': src });
  try {
    await run(dir, '--alias', '@lib');
    assert.equal(readFileSync(join(dir, 'a.8bs'), 'utf8'), 'use @lib::rules::a;\n');
    assert.equal((await run(dir, '--alias')).code, 2);
    assert.equal((await run(dir, '--nope')).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--embedded and --fences convert their own files, --all does all three', async () => {
  const files = {
    'a.8bs': OLD,
    't.test.mjs': `const p = \`${OLD}\`;\n`,
    'd.md': `text\n\n\`\`\`8bs\n${OLD}\`\`\`\n`,
  };
  const dir = project(files);
  try {
    const embedded = await run(dir, '--embedded');
    assert.deepEqual(embedded.lines, ['converted 1 embedded programs in t.test.mjs', '1 converted, 0 already new syntax, 0 differences, 0 failures']);
    assert.equal(readFileSync(join(dir, 'a.8bs'), 'utf8'), OLD);
    assert.equal(readFileSync(join(dir, 't.test.mjs'), 'utf8'), `const p = \`${NEW}\`;\n`);
    assert.equal(readFileSync(join(dir, 'd.md'), 'utf8'), files['d.md']);
    await run(dir, '--all');
    assert.equal(readFileSync(join(dir, 'a.8bs'), 'utf8'), NEW);
    assert.equal(readFileSync(join(dir, 'd.md'), 'utf8'), `text\n\n\`\`\`8bs\n${NEW}\`\`\`\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- embedded programs ---------------------------------------------------------

/** The convert callback, as the CLI wires it. */
const convert = (body, sourceKind) => migrateText(body, { file: 'embedded', sourceKind });

test('embedded: a template keeps its leading newline, indentation and closing indent', () => {
  const src = 'const p = `\n      export function main(): void {\n          n++;\n      }\n    `;\n';
  const out = convertEmbedded(src, convert);
  assert.equal(out.text, 'const p = `\n      pub fn main() {\n          n += 1;\n      }\n    `;\n');
  assert.deepEqual([out.converted, out.failures], [1, []]);
});

test('embedded: ${expr} is kept verbatim and a lost one is a failure', () => {
  const src = 'const p = `function f(): u8 { return ${value}; }\nexport const K: u8 = ${a + 1};`;\n';
  const out = convertEmbedded(src, convert);
  assert.equal(out.text, 'const p = `fn f() -> u8 {\n    return ${value};\n}\npub const K: u8 = ${a + 1};`;\n');
});

test('embedded: a ${} lost by the conversion is a failure and the literal is left alone', () => {
  const src = 'const p = `function f(): void { ${x}; }`;\n';
  const out = convertEmbedded(src, () => ({ status: 'converted', text: 'fn f() {}\n' }));
  assert.equal(out.text, src);
  assert.match(out.failures[0].message, /did not survive/);
});

test('embedded: backslashes and backticks in the program survive the round trip', () => {
  const src = 'const p = `export function main(): void { print("a\\\\nb"); }`;\n';
  const out = convertEmbedded(src, convert);
  assert.equal(out.text, 'const p = `pub fn main() {\n    print("a\\\\nb");\n}`;\n');
});

test('embedded: a line array closed by join becomes one element per printed line', () => {
  const src = [
    'const files = {',
    "  'main.8bs': [",
    "    'import { a } from \"./b.8bs\";',",
    "    'export function main(): void {',",
    "    '    a();',",
    "    '}',",
    "  ].join('\\n'),",
    '};',
    '',
  ].join('\n');
  const out = convertEmbedded(src, convert);
  assert.equal(out.text, [
    'const files = {',
    "  'main.8bs': [",
    "    'use self::b::a;',",
    "    'pub fn main() {',",
    "    '    a();',",
    "    '}',",
    "  ].join('\\n'),",
    '};',
    '',
  ].join('\n'));
  assert.equal(out.converted, 1);
});

test('embedded: an array element with ${} comes back as a template', () => {
  const src = "const x = [\n  'export function main(): void {',\n  `    ${call}();`,\n  '}',\n].join('\\n');\n";
  const out = convertEmbedded(src, convert);
  assert.equal(out.text, "const x = [\n  'pub fn main() {',\n  `    ${call}();`,\n  '}',\n].join('\\n');\n");
});

test('embedded: what is not a program, or is not old syntax, is left out of the lists', () => {
  const src = [
    'const a = `just some text`;',
    "const b = `const x = ${y};`; // JS-ish: arrow below",
    "const c = `${f} => const z = 1;`;",
    `const d = \`${NEW}\`;`,
    "const e = ['a', 'b'].join('\\n');",
    '',
  ].join('\n');
  const out = convertEmbedded(src, convert);
  assert.equal(out.converted, 0);
  assert.equal(out.text, src);
});

test('embedded: a literal that fails is listed with its line and left untouched', () => {
  const src = 'const ok = 1;\nconst p = `export function main(): void { n++ + 1; }\nlet q = ;`;\n';
  const out = convertEmbedded(src, convert);
  assert.equal(out.text, src);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].line, 2);
  assert.match(out.failures[0].message, /does not parse as old syntax/);
});

test('embedded: an array holding other expressions or comments is listed, not touched', () => {
  const mixed = "const x = [\n  'export function main(): void {',\n  body,\n  '}',\n].join('\\n');\n";
  const a = convertEmbedded(mixed, convert);
  assert.equal(a.text, mixed);
  assert.match(a.failures[0].message, /not string literals/);
  const commented = "const x = [\n  'export function main(): void {',\n  // why\n  '}',\n].join('\\n');\n";
  const b = convertEmbedded(commented, convert);
  assert.equal(b.text, commented);
  assert.match(b.failures[0].message, /not string literals/);
});

test('embedded: strings, comments and regular expressions do not fool the scanner', () => {
  const src = [
    "const s = '`'; // a ` in a comment",
    'const r = /`+/g;',
    'const t = `a ${`export function f(): void {}`} b`;',
    `const p = \`${OLD}\`;`,
    '',
  ].join('\n');
  const out = convertEmbedded(src, convert);
  assert.ok(out.text.includes(`const p = \`${NEW}\`;`));
  assert.equal(out.failures.length, 0);
});

test('embedded: converted text is left alone on a second run', () => {
  const once = convertEmbedded(`const p = \`${OLD}\`;\n`, convert);
  const twice = convertEmbedded(once.text, convert);
  assert.equal(twice.text, once.text);
  assert.deepEqual([twice.converted, twice.failures], [0, []]);
});

test('embedded: an .8bx program is tried as .8bx', () => {
  const out = convertEmbedded('const p = `export function f(): void { <A />; }`;\n', convert);
  assert.equal(out.text, 'const p = `pub fn f() {\n    <A />;\n}`;\n');
});

// ---- fences --------------------------------------------------------------------

test('fences: ```8bs blocks are converted, others and failures are left alone', () => {
  const md = ['# T', '', '```8bs', 'function f(): void {}', '```', '', '```js', 'function g() {}', '```', '', '```8bs', 'let x = ;', '```', ''].join('\n');
  const out = convertFences(md, convert);
  assert.equal(out.text, ['# T', '', '```8bs', 'fn f() {', '}', '```', '', '```js', 'function g() {}', '```', '', '```8bs', 'let x = ;', '```', ''].join('\n'));
  assert.equal(out.converted, 1);
  assert.deepEqual(out.failures.map((f) => f.line), [11]);
});

test('fences: a ```8bs block holding a component is converted as .8bx', () => {
  const out = convertFences('```8bs\nexport component Box() { <A />; }\n```\n', convert);
  assert.equal(out.converted, 1);
  assert.equal(out.text, '```8bs\npub component Box() {\n    <A />;\n}\n```\n');
});

test('fences: an indented fence keeps its indent', () => {
  const out = convertFences('  ```8bs\n  function f(): void {}\n\n  ```\n', convert);
  assert.equal(out.text, '  ```8bs\n  fn f() {\n  }\n  ```\n');
});

// ---- the whole repo --------------------------------------------------------------

test('8bs migrate --check over the whole repo: every source proves, nothing fails', async () => {
  const { code, summary } = await run(REPO, '--check');
  const found = /^(\d+) would convert, (\d+) already new syntax, 0 differences, 0 failures$/.exec(summary);
  assert.ok(found, summary);
  assert.equal(code, 0);
  assert.ok(Number(found[1]) + Number(found[2]) > 400, 'the whole corpus');
});

test('--embedded and --fences over the repo: no proof ever differs (failures are the hand set)', async () => {
  const { lines } = await run(REPO, '--check', '--embedded', '--fences');
  assert.deepEqual(lines.filter((l) => l.startsWith('DIFFERENCE')), []);
});

// ---- E20: no immutable `let` is assigned, over the converted corpus --------------

/**
 * Stores to an immutable `let` in a new-syntax program, with names resolved by
 * block scope (the rule F-01's checker applies): a binding is found in the
 * innermost block that declares it, `Name.member` goes through a module, and a
 * range `for` variable's own update is not a store.
 *
 * @param {object} ast  the new front end's tree
 * @returns {string[]}  one `name@offset` per store
 */
function immutableLetStores(ast) {
  const found = [];
  const declare = (scope, nodes) => {
    for (const n of nodes) {
      if (n?.type === 'VariableDeclaration' && n.kind === 'let') scope.vars.set(n.name.name, n);
      else if (n?.type === 'NamespaceDeclaration') scope.vars.set(n.name.name, { module: n });
    }
  };
  const lookup = (scope, name) => {
    for (let s = scope; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
    return undefined;
  };
  const baseOf = (target) => {
    let n = target;
    while (n?.type === 'IndexExpression') n = n.object;
    return n;
  };
  const stored = (scope, target) => {
    const n = baseOf(target);
    let decl;
    if (n?.type === 'Identifier') decl = lookup(scope, n.name);
    else if (n?.type === 'MemberExpression' && n.object?.type === 'Identifier') {
      const mod = lookup(scope, n.object.name)?.module;
      decl = mod?.members.find((m) => m.type === 'VariableDeclaration' && m.name.name === n.property.name);
    }
    if (decl?.type === 'VariableDeclaration' && decl.kind === 'let' && decl.immutable === true) {
      found.push(`${decl.name.name}@${n.start}`);
    }
  };
  const visit = (node, scope, skip) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, scope, skip);
      return;
    }
    if (!node || typeof node !== 'object') return;
    let inner = scope;
    if (node.type === 'BlockStatement' || node.type === 'Program') {
      inner = { vars: new Map(), parent: scope };
      declare(inner, node.body);
    } else if (node.type === 'NamespaceDeclaration') {
      inner = { vars: new Map(), parent: scope };
      declare(inner, node.members);
    } else if (node.type === 'FunctionDeclaration' || node.type === 'ComponentDeclaration') {
      inner = { vars: new Map(), parent: scope };
      for (const p of node.params ?? []) inner.vars.set(p.name.name, { param: true });
    } else if (node.type === 'ForStatement') {
      inner = { vars: new Map(), parent: scope };
      declare(inner, [node.init]);
    }
    if (node.type === 'AssignmentExpression') stored(scope, node.left);
    if (node.type === 'UpdateExpression' && node !== skip) stored(scope, node.argument);
    const ownUpdate = node.type === 'ForStatement' && node.init?.immutable === true
      && node.update?.type === 'UpdateExpression' && node.update.argument?.name === node.init.name.name
      ? node.update : skip;
    for (const value of Object.values(node)) visit(value, inner, ownUpdate);
  };
  visit(ast, undefined, undefined);
  return found;
}

const newAst = (text, sourceKind = '.8bs') => {
  const lexed = tokenizeNew(text, 'x', { sourceKind });
  const parsed = parseNew(lexed.tokens, text, 'x', { sourceKind });
  assert.deepEqual([...lexed.diagnostics, ...parsed.diagnostics], [], text);
  return parsed.ast;
};

test('E20 scan: finds stores to an immutable let, by block scope, and skips a range for variable', () => {
  const stores = (text) => immutableLetStores(newAst(text));
  assert.equal(stores('fn f() { let x: u8 = 1; x = 2; }').length, 1);
  assert.equal(stores('fn f() { let x: u8 = 1; x += 2; x -= 1; }').length, 2);
  assert.equal(stores('fn f() { let a: [u8; 2]; a[0] = 1; }').length, 1);
  assert.equal(stores('fn f() { let mut x: u8 = 1; x = 2; }').length, 0);
  assert.equal(stores('let g: u8 = 0;\nfn f() { g = 1; }').length, 1);
  assert.equal(stores('fn f() { let x: u8 = 0; { let mut x: u8 = 0; x = 1; } }').length, 0);
  assert.equal(stores('fn f() { let mut x: u8 = 0; { let x: u8 = 0; x = 1; } }').length, 1);
  assert.equal(stores('fn f(p: u8) { p = 1; }').length, 0);
  assert.equal(stores('pub mod M { let a: u8 = 0; pub let mut z: u8 = 0; }\nfn f() { M.a = 1; M.z = 1; }').length, 1);
  assert.equal(stores('fn f() { for i in 0..3 { let y: u8 = i; } }').length, 0);
  assert.equal(stores('fn f() { for i in 0..3 { i = 5; } }').length, 1);
});

test('E20 over the converted corpus: no immutable let is ever assigned', () => {
  const files = sourceFiles(REPO);
  assert.ok(files.length > 400, `expected the whole corpus, found ${files.length}`);
  const violations = [];
  for (const file of files) {
    const sourceKind = extname(file);
    const result = migrateText(readFileSync(file, 'utf8'), { file, sourceKind });
    if (result.status !== 'converted') continue;
    for (const store of immutableLetStores(newAst(result.text, sourceKind))) violations.push(`${file} ${store}`);
  }
  assert.deepEqual(violations, []);
});

// ---- F-01b: the old front end lives only here, and the config name ---------------

test('the legacy lexer and parser still read the old syntax for migrate', async () => {
  const { tokenize } = await import('../src/migrate/legacy/lexer.mjs');
  const { parse } = await import('../src/migrate/legacy/parser.mjs');
  const src = 'import { a } from "./geo.8bs";\nexport namespace m { function f(): void {} }\n';
  const { tokens } = tokenize(src, 't.8bs');
  const { ast, diagnostics } = parse(tokens, src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ast.body.map((n) => n.type), ['ImportDeclaration', 'NamespaceDeclaration']);
});

test('CONFIG_FILENAMES names 8bitscript.config.ts and 8bs.config.ts only', async () => {
  const { CONFIG_FILENAMES } = await import('../src/config.mjs');
  assert.deepEqual(CONFIG_FILENAMES, ['8bitscript.config.ts', '8bs.config.ts']);
});

test('migrate renames the old 8bitscript.config.8bs and reports it; --check writes nothing', async () => {
  const dir = project({ '8bitscript.config.8bs': "export default { entry: 'src/main.8bs' };\n" });
  try {
    const dry = await run(dir, '--check');
    assert.ok(dry.lines.some((l) => /would rename 8bitscript\.config\.8bs to 8bitscript\.config\.ts/.test(l)), dry.lines.join('\n'));
    assert.equal(existsSync(join(dir, '8bitscript.config.8bs')), true);
    const real = await run(dir);
    assert.equal(real.code, 0, real.lines.join('\n'));
    assert.equal(existsSync(join(dir, '8bitscript.config.8bs')), false);
    assert.equal(readFileSync(join(dir, '8bitscript.config.ts'), 'utf8'), "export default { entry: 'src/main.8bs' };\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate refuses to overwrite an existing 8bitscript.config.ts', async () => {
  const dir = project({ '8bitscript.config.8bs': 'export default {};\n', '8bitscript.config.ts': 'export default { a: 1 };\n' });
  try {
    const result = await run(dir);
    assert.equal(result.code, 1);
    assert.ok(result.lines.some((l) => /^FAILED .*already exists/.test(l)), result.lines.join('\n'));
    assert.equal(existsSync(join(dir, '8bitscript.config.8bs')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory whose only config is the old .8bs name is an error, not an empty project', async () => {
  const { loadConfig, staleConfigError } = await import('../src/config.mjs');
  const dir = project({ '8bitscript.config.8bs': 'export default {};\n' });
  try {
    await assert.rejects(loadConfig(dir, '8bs build'), (error) => error.name === 'StaleConfigError'
      && /8bitscript\.config\.8bs is no longer read; rename it to 8bitscript\.config\.ts/.test(error.message));
    writeFileSync(join(dir, '8bitscript.config.ts'), 'export default { frameRate: 50 };\n');
    assert.equal(staleConfigError(dir), null);
    assert.deepEqual(await loadConfig(dir), { frameRate: 50 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('8bs build prints the stale-config line and exits 1', () => {
  const dir = project({ '8bitscript.config.8bs': 'export default {};\n' });
  try {
    const bin = join(REPO, 'packages', 'cli', 'bin', '8bs.mjs');
    const result = spawnSync(process.execPath, [bin, 'targets'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no longer read; rename it to 8bitscript\.config\.ts/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
