// Regenerates crates/syntax/tests/fixtures/*, the Node-made expectations the
// syntax tests read. Run from the repo root:
//   node crates/syntax/tests/make-fixtures.mjs
// For each case it writes, in the canonical dump form (sorted keys, two-space
// indent, trailing newline), `<name>.ast.json` and (sources up to 700 units)
// `<name>.tokens.json`, plus
// `<name>.walk.json` (the JS `walk` order as "Type@start+length" strings with
// the parent's type), and lists the cases in `cases.json`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../../../packages/compiler/src/lexer/index.mjs';
import { parse } from '../../../packages/compiler/src/parser/index.mjs';
import { walk } from '../../../packages/compiler/src/ast/index.mjs';
import { sourceKindOf } from '../../../packages/compiler/src/source/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const out = join(here, 'fixtures');

// 12 corpus files.
const corpus = [
  'packages/compiler/test/fixtures/partial-subset.8bs',
  'packages/plus4/src/index.8bs',
  'packages/i18n/src/index.8bs',
  'packages/i18n/src/index.nl.8bs',
  'packages/i18n/src/catalog.8bs',
  'packages/sprites/test/shapes.c64.8bs',
  'packages/vic20/src/cursor.8bs',
  'packages/cx16/src/pointer.cx16.web.8bs',
  'packages/c64/test/addr-tmp.8bs',
  'packages/odyssey2/src/geometry.8bs',
  'packages/examples/hello-8bx/src/Hello.8bx',
  'packages/examples/media-walk/src/Walk.8bx',
];

// Snippets for what the corpus files above do not reach: UTF-16 spans after an
// astral character, decimals, templates, `import ... as`, state, error recovery.
const synthetic = {
  'utf16-astral.8bs': '// \u{1F600} café — spans count UTF-16 units\nlet s: string<8> = "héllo \u{1F600}";\nlet n: utinyint = 7;\n',
  'frames-decimal.8bs': 'export function main(): void {\n  let t: utinyint = #frames(0.5, seconds);\n  let big: smallint = 0xFFFFFFFF;\n  let b: utinyint = %1010_1010;\n}\n',
  'template-record.8bs': 'function f(): void {\n  text.print(0, `TICK ${ticks % 10:1} OPT ${opt}`);\n  i18n.format(M.X, { control: Input.OK, n: 2 });\n}\n',
  'imports-as.8bs': 'import { a, b as c } from "./geo.8bs";\nimport "x";\n@address($D020) let border: volatile<u8>;\n@unroll(4) for (let i: u8 = 0; i < 8; i++) { a[i] = -i; }\n',
  'control-flow.8bs': 'function g(x: u8 = 3): u8 {\n  if (x > 1) return 1; else if (x) { x += 2; } else x--;\n  while (true) { break; continue; }\n  for (;;) {}\n  return x ? --x : ~x;\n}\nasm6502 { lda #1 }\nlet arr: array<u8, 4> = [1, 2, 3, 4,];\nconst K: u8 = 0x10;\n',
  'recovery.8bs': 'function (a: ) { let = 3; }\nnamespace N { let ; function f(): void {} 5 }\nlet s = "open\nif (\n',
  'state-component.8bx': 'component Box(label: string = "x", n: u8) {\n  state shown: u8 = 1;\n  <slot />\n  <>{shown ? <Mark /> : <Mark on {...p} k={1} t="s" />}</>\n  text here\n}\nexport component Top() { <Box label="a">hi {n}</Box> }\n',
};

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
};
const canon = (v) => `${JSON.stringify(sortKeys(v), null, 2)}\n`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const cases = [];
const add = (file, text, keepSource) => {
  const name = file.replace(/[^A-Za-z0-9.]+/g, '_');
  const sourceKind = sourceKindOf(file) ?? '.8bs';
  const { tokens } = tokenize(text, file, { sourceKind });
  const { ast } = parse(tokens, text, file, { sourceKind });
  const order = [];
  walk(ast, (n, parent) => order.push(`${n.type}@${n.start}+${n.length}<${parent ? parent.type : ''}`));
  writeFileSync(join(out, `${name}.ast.json`), canon(ast));
  // Token dumps only for short sources, to keep the fixtures under 200 KB.
  if (text.length <= 700) writeFileSync(join(out, `${name}.tokens.json`), canon(tokens));
  writeFileSync(join(out, `${name}.walk.json`), canon(order));
  cases.push({ name, file, utf16Length: text.length, ...(keepSource ? { source: text } : {}) });
};

for (const file of corpus) {
  const text = readFileSync(join(root, file), 'utf8');
  add(file, text, /[^\x00-\x7f]/.test(text));
}
for (const [file, text] of Object.entries(synthetic)) add(file, text, true);

writeFileSync(join(out, 'cases.json'), canon(cases));
console.log(`${cases.length} cases`);
