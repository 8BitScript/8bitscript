// Strings and templates: `"TICK"` as constant program data, `string`
// parameters with `.length` and `s[i]`, and the template layout —
// `text.print(0, \`TICK ${ticks % 10:1} OPTION ${option}\`)` laid out at
// compile time into print/printNumber calls. Covers the lexer's template
// token, the parser's template nodes, the checker's portable-character
// rule, lowering (the string table, the string expressions, the template
// expansion and its diagnostics), the linker's string-table merge, and
// hover for the `string` type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyze, link, tokenize, parse, lower, foldCompileTime, NodeType, getHoverInfo, getCompletions,
} from '../index.mjs';

const codes = (src, options) => analyze(src, 't.8bs', options).map((d) => d.code);
const clean = (src, options) => assert.deepEqual(codes(src, options), []);

const lowered = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't', src);
};

// A namespace with the two printers the template protocol targets, plus a
// program that uses it — self-contained, so nothing here depends on a
// machine package.
const TEXT = `
let printIndex: utinyint = 0;
export namespace text {
    function putChar(cell: usmallint, code: utinyint): void { memory.write(1024 + cell, code); }
    function print(cell: usmallint, s: string): void {
        printIndex = 0;
        while (printIndex < s.length) { text.putChar(cell + printIndex, s[printIndex]); printIndex = printIndex + 1; }
    }
    function printNumber(cell: usmallint, value: usmallint, width: utinyint): void {
        printIndex = width;
        while (printIndex > 0) { printIndex = printIndex - 1; text.putChar(cell + printIndex, 48 + value % 10); value = value / 10; }
    }
}
`;
const program = (body, globals = 'let ticks: utinyint = 0;\nlet option: utinyint = 0;\nlet score: usmallint = 0;') =>
  `import { text } from "./text.8bs";\n${globals}\nexport function main(): void {\n${body}\n}\n`;

// link() reads imports from disk: a scratch project with text.8bs beside main.
async function linked(body, globals) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-strings-'));
  try {
    await writeFile(join(dir, 'text.8bs'), TEXT);
    const main = join(dir, 'main.8bs');
    const src = program(body, globals);
    await writeFile(main, src);
    return link(src, main);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const callsOf = (ir, fnName = 'main') => {
  const fn = ir.functions.find((f) => f.name === fnName);
  const flat = (body) => body.flatMap((s) => (s.kind === 'block' ? flat(s.body) : [s]));
  return flat(fn.body).map((s) => `${s.name}(${s.args.map((a) => (
    a.kind === 'const' ? a.value
      : a.kind === 'string' ? JSON.stringify(ir.strings[a.index].text)
        : a.kind === 'ref' ? a.name
          : a.kind === 'binop' ? `${a.left.name ?? a.left.value} ${a.operator} ${a.right.name ?? a.right.value}`
            : a.kind
  )).join(', ')})`);
};

// ---- lexer: template token --------------------------------------------------

test('lexer: a backtick string is one template token with its text runs and fields marked', () => {
  const src = '`TICK ${ticks % 10:1} END`';
  const [token] = tokenize(src, 't').tokens;
  assert.equal(token.kind, 'template');
  assert.equal(token.length, src.length);
  assert.deepEqual(token.parts.map((p) => p.kind), ['text', 'field', 'text']);
  assert.equal(src.slice(token.parts[1].sourceStart, token.parts[1].sourceEnd), 'ticks % 10:1');
});

test('lexer: an unterminated template or field is a diagnostic on its own line', () => {
  assert.deepEqual(tokenize('`TICK ${ticks', 't').diagnostics.map((d) => d.code), ['8BS1002']);
  assert.deepEqual(tokenize('`TICK\n', 't').diagnostics.map((d) => d.code), ['8BS1002']);
});

test('lexer: braces inside a quoted field do not end the field early', () => {
  const src = '`${ "{" }`';
  const [token] = tokenize(src, 't').tokens;
  assert.equal(token.kind, 'template');
  assert.deepEqual(tokenize(src, 't').diagnostics, []);
  assert.equal(token.parts.filter((p) => p.kind === 'field').length, 1);
  assert.equal(src.slice(token.parts[0].sourceStart, token.parts[0].sourceEnd), ' "{" ');
});

test('lexer: string is a type name', () => {
  const [token] = tokenize('string', 't').tokens;
  assert.equal(token.kind, 'type');
});

// ---- parser: template nodes -------------------------------------------------

test('parser: a template parses into text and field nodes with the field expressions at their file offsets', () => {
  const src = 'text.print(0, `TICK ${ticks % 10:1} OPTION ${option}`);';
  const { tokens } = tokenize(src, 't');
  const { ast, diagnostics } = parse(tokens, src, 't');
  assert.deepEqual(diagnostics, []);
  const template = ast.body[0].expression.args[1];
  assert.equal(template.type, NodeType.TemplateLiteral);
  assert.deepEqual(template.parts.map((p) => p.type), [
    NodeType.TemplateText, NodeType.TemplateField, NodeType.TemplateText, NodeType.TemplateField,
  ]);
  assert.equal(template.parts[0].value, 'TICK ');
  const field = template.parts[1];
  assert.equal(field.expression.type, NodeType.BinaryExpression);
  assert.equal(src.slice(field.expression.start, field.expression.start + field.expression.length), 'ticks % 10');
  assert.equal(field.width.value, 1);
  assert.equal(template.parts[3].width, null);
});

test('parser: a bad field width or trailing junk inside a field is a syntax error at the right place', () => {
  const src = 'text.print(0, `${ticks:x}`);';
  const { tokens } = tokenize(src, 't');
  const { diagnostics } = parse(tokens, src, 't');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, '8BS1101');
  assert.equal(diagnostics[0].start, src.indexOf('x}'));
});

test('parser: a field expression is reachable by walk() — #frames(...) inside one folds', () => {
  const src = 'text.print(0, `${#frames(0.5, seconds)}`);';
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  assert.deepEqual(foldCompileTime(ast, 't', { frameRate: 60 }), []);
  assert.equal(ast.body[0].expression.args[1].parts[0].expression.value, 30);
});

// ---- checker: the portable character set ----------------------------------

test('checker: a string literal or template text outside the portable set is a diagnostic; lower case is in it; import paths are not checked at all', () => {
  clean('let x: utinyint = 1; function f(s: string): void { } export function main(): void { f("TICK 0-9 !,-.:?"); }');
  // Lower case is portable — the Commodore text character set holds both
  // cases at once (packages/pet/src/text.8bs); only a target with no
  // lower-case glyphs at all (the NES's font today) would ever lose this,
  // and the checker runs target-blind, so it no longer refuses it anywhere.
  clean('function f(s: string): void { } export function main(): void { f("tick"); }');
  const lower = analyze('function f(s: string): void { } export function main(): void { f("t~ck"); }', 't.8bs');
  assert.equal(lower[0].code, '8BS1026');
  assert.match(lower[0].message, /'~' is not in the portable character set/);
  assert.deepEqual(codes('export function main(): void { text.print(0, `héllo`); }'), ['8BS1026']);
  clean('import { text } from "./lower-case/path_with_underscores.8bs";\nexport function main(): void { }');
});

test('checker: a string longer than 255 characters is a diagnostic', () => {
  assert.deepEqual(codes(`function f(s: string): void { } export function main(): void { f("${'A'.repeat(256)}"); }`), ['8BS1027']);
  clean(`function f(s: string): void { } export function main(): void { f("${'A'.repeat(255)}"); }`);
});

// ---- lowering: strings ------------------------------------------------------

test('lowering: a string literal becomes a slot in the module string table, deduplicated', () => {
  const { ir, diagnostics } = lowered('function f(s: string): void { }\nexport function main(): void { f("TICK"); f("TICK"); f("OPTION"); }');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.strings.map((s) => s.text), ['TICK', 'OPTION']);
  assert.deepEqual(ir.strings[0].bytes, [84, 73, 67, 75]);
  assert.deepEqual(callsOf(ir), ['f("TICK")', 'f("TICK")', 'f("OPTION")']);
});

test('lowering: a string parameter has .length and s[i]; nothing else does', () => {
  const { ir, diagnostics } = lowered('let n: utinyint = 0;\nfunction f(s: string): void { n = s.length; n = s[n]; }\nexport function main(): void { }');
  assert.deepEqual(diagnostics, []);
  const [len, byte] = ir.functions[0].body.map((s) => s.value);
  assert.equal(len.kind, 'stringLength');
  assert.equal(byte.kind, 'stringByte');
  assert.equal(byte.index.name, 'n');

  const bad = lowered('let n: utinyint = 0;\nfunction f(s: string): void { n = s.size; }\nexport function main(): void { n = n[0]; }');
  assert.deepEqual(bad.diagnostics.map((d) => d.code), ['8BS3001', '8BS3001']);
  assert.match(bad.diagnostics[0].message, /a string has no 'size'; it has .length and s\[i\]/);
  assert.match(bad.diagnostics[1].message, /'n' is not an array: indexing needs an array<T, N>/);
});

test('lowering: a string global without a capacity is refused with an honest message', () => {
  const { diagnostics } = lowered('let label: string = "TICK";\nexport function main(): void { }');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
  assert.match(diagnostics[0].message, /a string variable needs a capacity: let name: string<N>/);
});

// ---- lowering: templates ----------------------------------------------------

test('template: laid out into print/printNumber calls at compile-time cells', async () => {
  const { ir, diagnostics } = await linked('text.print(0, `TICK ${ticks % 10:1} OPTION ${option}`);');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(callsOf(ir), [
    'text_print(0, "TICK ")',
    'text_printNumber(5, ticks % 10, 1)',
    'text_print(6, " OPTION ")',
    // No width given: `option` is a utinyint, so three digits.
    'text_printNumber(14, option, 3)',
  ]);
});

test('template: a non-constant cell is carried into every piece, each its own copy', async () => {
  const { ir, diagnostics } = await linked('text.print(option, `AB${score}`);');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(callsOf(ir), ['text_print(option, "AB")', 'text_printNumber(option + 2, score, 5)']);
});

test('template: a plain string is fine as the print argument too; a template with only text is one print', async () => {
  const both = await linked('text.print(0, "TICK");\ntext.print(10, `OPTION`);');
  assert.deepEqual(both.diagnostics, []);
  assert.deepEqual(callsOf(both.ir), ['text_print(0, "TICK")', 'text_print(10, "OPTION")']);
});

test('template: identical text across modules is one string constant in the linked program', async () => {
  const { ir } = await linked('text.print(0, "A");\ntext.print(0, "A");\ntext.print(0, `A`);');
  assert.deepEqual(ir.strings.map((s) => s.text), ['A']);
});

test('template: a field whose type lowering cannot see needs an explicit width', async () => {
  const { diagnostics } = await linked('text.print(0, `${text.width()}`);');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS1029']);
  assert.match(diagnostics[0].message, /say it: \$\{text\.width\(\):3\}/);
});

test('template: a signed or 32-bit field, or a width of 0, is a diagnostic naming the limit', async () => {
  const signed = await linked('text.print(0, `${delta}`);', 'let delta: tinyint = 0;');
  assert.deepEqual(signed.diagnostics.map((d) => d.code), ['8BS1029']);
  assert.match(signed.diagnostics[0].message, /a tinyint cannot be a number field/);
  const wide = await linked('text.print(0, `${big}`);', 'let big: uint = 0;');
  assert.deepEqual(wide.diagnostics.map((d) => d.code), ['8BS1029']);
  const zero = await linked('text.print(0, `${option:0}`);');
  assert.deepEqual(zero.diagnostics.map((d) => d.code), ['8BS1029']);
  assert.match(zero.diagnostics[0].message, /width must be 1..255/);
});

test('template: anywhere but a namespace print(cell, ...) is a diagnostic', async () => {
  for (const body of [
    'text.putChar(0, `A`);',
    'text.print(`A`);',
    'text.print(0, 1, `A`);',
    'main2(`A`);',
    'ticks = `A`;',
  ]) {
    const { diagnostics } = await linked(body);
    assert.deepEqual(diagnostics.map((d) => d.code), ['8BS1028'], body);
  }
});

test('template: the field expression itself is lowered — a #frames(...) field folds first', async () => {
  const { ir, diagnostics } = await linked('text.print(0, `${#frames(1, seconds):2}`);');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(callsOf(ir), ['text_printNumber(0, 60, 2)']);
});

// ---- hover / completion -----------------------------------------------------

test('hover explains the string type', () => {
  const text = 'function f(s: string): void { }';
  const info = getHoverInfo(text, text.indexOf('string') + 1);
  assert.ok(info);
  assert.match(info.markdown, /\*\*string\*\*/);
  assert.match(info.markdown, /portable character set/);
});

test('completion offers string in a type position', () => {
  const text = 'function f(s: ';
  assert.ok(getCompletions(text, text.length).some((item) => item.label === 'string'));
});

// ---- the editor path: check() runs the same layout ------------------------

test('checker: template shape and field-width problems reach analyze() (so the editor), once each through link()', async () => {
  // analyze() never lowers, so these must come from the checker.
  assert.deepEqual(codes('export function main(): void { text.putChar(0, `A`); }'), ['8BS1028']);
  assert.deepEqual(codes('let x: utinyint = 0;\nexport function main(): void { x = `A`; }'), ['8BS1028']);
  assert.deepEqual(codes('let t: utinyint = `A`;\nexport function main(): void { }'), ['8BS1028']);
  assert.deepEqual(codes('export function main(): void { text.print(0, `${text.width()}`); }'), ['8BS1029']);
  assert.deepEqual(codes('let d: tinyint = 0;\nexport function main(): void { text.print(0, `${d}`); }'), ['8BS1029']);
  assert.deepEqual(codes('function f(v: usmallint): void { text.print(0, `${v}`); }\nexport function main(): void { }'), []);
  // A namespace member function is checked in its own parameter scope too.
  assert.deepEqual(codes('namespace hud { function show(v: tinyint): void { text.print(0, `${v}`); } }\nexport function main(): void { }'), ['8BS1029']);
  // And link() reports one problem once, not once from check() and once from lower().
  const { diagnostics } = await linked('text.print(0, `${text.width()}`);');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS1029']);
});

test('hover inside a ${...} field answers for the token there: #frames and its unit', () => {
  const text = 'text.print(0, `A ${#frames(0.5, seconds):2} B`);';
  assert.match(getHoverInfo(text, text.indexOf('#frames') + 2).markdown, /\*\*#frames\(n, unit\)\*\*/);
  assert.match(getHoverInfo(text, text.indexOf('seconds') + 2).markdown, /\*\*seconds\*\*/);
  assert.equal(getHoverInfo(text, text.indexOf('A ') + 1), null, 'template text is not a construct');
  assert.equal(getHoverInfo(text, text.indexOf(':2') + 1), null, 'the width is not a construct');
});
