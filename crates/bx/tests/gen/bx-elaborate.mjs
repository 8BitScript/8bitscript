// Regenerates fixtures/bx-elaborate.json: `elaborateBx` (packages/compiler/src/bx/elaborate.mjs)
// over parsed `.8bx` text, one row per call in the front tap's record shape
// `{fn, args, result, after}`. The arguments are `[ast, symbols, file, foreign?]`: the symbols are
// the JS binder's (`bind`, then `bindImportedComponents`), written by the tap's own encoder
// (`Encoder`), so a row is what the tap would have recorded. `foreign` is the tree of the module
// an imported component comes from (a tap record has no such argument; the tree is what its
// `{"$node": n}` props point into). `result` and `after` are written after the call, which
// rewrites the tree in place; they carry `{"$node": n}` where the JS shares a node.
//
// The text is new syntax, parsed by `packages/compiler/src/front/index.mjs`.
// Run from the repo root: node crates/bx/tests/gen/bx-elaborate.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, tokenize } from '../../../../packages/compiler/src/front/index.mjs';
import { bind, bindImportedComponents } from '../../../../packages/compiler/src/binder/index.mjs';
import { elaborateBx } from '../../../../packages/compiler/src/bx/elaborate.mjs';
import { Encoder, noteBound } from '../../../../scripts/oracle/front-tap/graph.mjs';

const CARD = 'component Card(title: u8, count: u8 = 1) {}\ncomponent Plain() {}\n';
const FRAME = 'component Frame(title: u8) {\n    before();\n    <slot />;\n    after();\n}\n';
const LABEL = 'component Label(children: string) {}\ncomponent Soft(children: string = "") {}\n';
const BOX = 'pub component Box(label: u8, mark: u8 = 7) {\n    <slot />;\n}\npub component Tick(n: u8 = 2) {\n    state t: u8 = 0;\n}\ncomponent Hidden() {}\n';

/** `[name, text, extra]`: `extra` is `{ files, lookup }` for imports. */
const TICK = 'component T() {\n    state t: u8 = 0;\n}\n';
const cases = [
  // Elements and attributes.
  ['plain-element', `${CARD}component A() {\n    <Card title={1} />;\n}\n`],
  ['default-prop', `${CARD}component A() {\n    <Card title={1} count={3} />;\n    <Card title={2} />;\n}\n`],
  ['bare-attribute', 'component Flag(visible: bool) {}\ncomponent A() {\n    <Flag visible />;\n}\n'],
  ['string-attribute', 'component Name(text: string) {}\ncomponent A() {\n    <Name text="hi" />;\n}\n'],
  ['missing-required', `${CARD}component A() {\n    <Card />;\n}\n`],
  ['skip-middle', 'component M(a: u8 = 1, b: u8 = 2, c: u8) {}\ncomponent A() {\n    <M c={3} />;\n    <M b={5} />;\n}\n'],
  ['unknown-element', 'component A() {\n    <Missing />;\n    <Missing><Missing /></Missing>;\n}\n'],
  ['not-a-component', 'fn Helper() {}\ncomponent A() {\n    <Helper />;\n}\n'],
  ['spread-attribute', `${CARD}component A() {\n    <Card {rest} title={1} />;\n}\n`],
  ['top-level-element', `${CARD}<Card title={1} />;\n`],
  ['nameless-component', 'component () {}\ncomponent A() {}\n'],
  // Text.
  ['text-children', `${LABEL}component A() {\n    <Label>hello world</Label>;\n    <Soft>x</Soft>;\n    <Soft />;\n}\n`],
  ['text-children-dropped', `${CARD}component A() {\n    <Card title={1}>hello</Card>;\n}\n`],
  // Fragments and nesting.
  ['fragment', `${CARD}component A() {\n    <><Card title={1} /><><Card title={2} /></></>;\n}\n`],
  ['nested-components', `${CARD}component B() {\n    <Card title={1} />;\n}\ncomponent A() {\n    <B />;\n    <Plain />;\n}\n`],
  ['empty-expression-child', `${CARD}component A() {\n    <>{/* nothing */}<Card title={1} /></>;\n}\n`],
  // Control flow around elements.
  ['conditional', `${CARD}component A(ok: bool) {\n    <>{ok ? <Card title={1} /> : <Plain />}</>;\n}\n`],
  ['and-expression', `${CARD}component A(ok: bool) {\n    <>{ok && <Card title={1} />}</>;\n}\n`],
  ['nested-condition', `${CARD}component A(a: bool, b: bool) {\n    <>{a ? (b && <Card title={1} />) : <></>}</>;\n}\n`],
  ['not-a-composition', `${CARD}component A(ok: bool) {\n    <>{ok}</>;\n    <>{ok ? <Plain /> : 1}</>;\n}\n`],
  ['return-composition', `${CARD}component A() {\n    return (<Card title={1} />);\n}\n`],
  ['return-value', 'component A() {\n    return 1;\n}\n'],
  ['if-while-for', `${CARD}component A(n: u8) {\n    if n > 1 {\n        <Card title={1} />;\n    } else {\n        <Plain />;\n    }\n    while n > 0 {\n        <Plain />;\n    }\n    for (let mut i: u8 = 0; i < 3; i += 1) {\n        <Card title={i} />;\n    }\n    { <Plain />; }\n}\n`],
  ['plain-function-body', `${CARD}fn run() {\n    <Card title={1} />;\n    let x: u8 = 1;\n}\n`],
  ['plain-program', 'let a: u8 = 1;\nfn f() {\n    a += 1;\n}\nif a > 0 {\n    f();\n}\n'],
  ['decorated-loop', 'component A() {\n    @unroll\n    for (let mut i: u8 = 0; i < 2; i += 1) {\n        f(i);\n    }\n}\n'],
  // Slots.
  ['slot-element', `${CARD}${FRAME}component A() {\n    <Frame title={1}><Card title={2} /><Plain /></Frame>;\n    <Frame title={3} />;\n}\n`],
  ['slot-hoisted-argument', `${FRAME}component A() {\n    <Frame title={next()}><Plain /></Frame>;\n    <Frame title={x = 1}><Plain /></Frame>;\n    <Frame title={\`a\${b}\`}><Plain /></Frame>;\n}\ncomponent Plain() {}\n`],
  ['slot-untyped-not-hoisted', 'component U(v) {\n    <slot />;\n}\ncomponent A() {\n    <U v={next()}><U v={1}><U v={2} /></U></U>;\n}\n'],
  ['slot-only-before', 'component S() {\n    start();\n    <slot />;\n}\ncomponent A() {\n    <S><S /></S>;\n}\n'],
  ['slot-only-after', 'component S() {\n    <slot />;\n    stop();\n}\ncomponent A() {\n    <S><S /></S>;\n}\n'],
  ['slot-second-ignored', 'component S() {\n    a();\n    <slot />;\n    b();\n    <slot />;\n    c();\n}\n'],
  ['slot-nested-in-if', 'component S(ok: bool) {\n    if ok {\n        <slot />;\n    }\n}\n'],
  ['slot-with-elements-inside', `${CARD}component S() {\n    <Card title={1} />;\n    <slot />;\n    <Plain />;\n}\ncomponent A() {\n    <S><Plain /></S>;\n}\n`],
  ['slot-children-fragment-and-field', `${CARD}${FRAME}component A(ok: bool) {\n    <Frame title={1}><>{ok && <Plain />}</></Frame>;\n}\n`],
  // State and methods.
  ['state', 'component C() {\n    state n: u8 = 0;\n    state m: bool;\n    n += 1;\n    use(m, n);\n}\ncomponent A() {\n    <C />;\n    <C />;\n}\n'],
  ['state-member-property', 'component C() {\n    state frame: u8 = 0;\n    use(frame, a.frame, frame.frame);\n}\n'],
  ['state-nameless', 'component C() {\n    state : u8 = 0;\n    state ok: u8 = 1;\n}\n'],
  ['methods', 'component C() {\n    state hp: u8 = 9;\n    fn damage(amount: u8) {\n        hp -= amount;\n        heal(1);\n    }\n    fn heal(by: u8) {\n        hp += by;\n    }\n    damage(5);\n}\ncomponent A() {\n    <C />;\n}\n'],
  ['method-without-state', 'component C() {\n    fn f() {\n        g();\n    }\n    f();\n}\n'],
  ['method-with-elements', `${CARD}component C() {\n    fn show() {\n        <Card title={1} />;\n    }\n    <Plain />;\n}\n`],
  ['method-nameless', 'component C() {\n    fn () {}\n    fn ok() {}\n}\n'],
  ['stateful-slot', 'component W() {\n    state k: u8 = 0;\n    open();\n    <slot />;\n    close();\n}\ncomponent A() {\n    <W><W /></W>;\n    <W />;\n}\n'],
  ['exported-component', 'pub component E(a: u8) {\n    <slot />;\n}\n'],
  // Imports.
  ['import-element', 'use self::box::{Box, Tick};\ncomponent A() {\n    <Box label={1} />;\n    <Tick />;\n    <Tick n={4} />;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['import-slot', 'use self::box::{Box};\ncomponent A() {\n    <Box label={1}><Box label={2} mark={3} /></Box>;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['import-slot-hoisted', 'use self::box::{Box};\ncomponent A() {\n    <Box label={next()}><Box label={1} /></Box>;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['import-renamed-slot', 'use self::box::{Box as Crate};\ncomponent A() {\n    <Crate label={1}><Crate label={2} /></Crate>;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['import-two-specifiers', 'use self::box::{Tick, Box};\nuse self::box::{Hidden};\ncomponent A() {\n    <Box label={1}><Tick /></Box>;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['import-unresolved', 'use self::box::{Box, Hidden};\ncomponent A() {\n    <Box label={1}><Hidden /></Box>;\n}\n', { files: { box: BOX }, lookup: [] }],
  ['p-toplevel-instance-order', `${TICK}<T />;\nfn f() {\n    <T />;\n}\n`],
  ['p-toplevel-block-instance-order', `${TICK}{ <T />; }\ncomponent B() {\n    <T />;\n}\n`],
  ['p-toplevel-hoist-order', `${FRAME}component Plain() {}\n<Frame title={next()}><Plain /></Frame>;\nfn f() {\n    <Frame title={next()}><Plain /></Frame>;\n}\n`],
  ['p-toplevel-import-order', 'use self::box::{Box, Tick};\n<Box label={1}><Tick /></Box>;\nfn f() {\n    <Tick />;\n}\ncomponent A() {\n    <Box label={2}><Box label={3} /></Box>;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['p-decorated-method', 'component C() {\n    state h: u8 = 0;\n    @inline\n    fn f() {\n        h += 1;\n    }\n    f();\n}\n'],
  ['p-discarded-conditional-instance', `${TICK}component A(ok: bool) {\n    <>{ok ? <T /> : 1}</>;\n    <T />;\n}\n`],
  ['p-slot-nested-stateful', `${TICK}component W() {\n    state k: u8 = 0;\n    <T />;\n    <slot />;\n    <T />;\n}\ncomponent A() {\n    <W><W><T /></W></W>;\n}\n`],
  ['p-two-imports-same-source', 'use self::box::{Tick};\nuse self::box::{Box};\ncomponent A() {\n    <Box label={1}><Tick /></Box>;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['p-unicode-name', 'component Ünï(a: u8) {\n    <slot />;\n}\ncomponent A() {\n    <Ünï a={f()}><Ünï a={1} /></Ünï>;\n}\n'],
];

const rows = [];
const notes = [];

function boundOf(text, file) {
  const tokens = tokenize(text, file, { sourceKind: '.8bx' });
  const { ast, diagnostics } = parse(tokens, text, file, { sourceKind: '.8bx' });
  if (diagnostics.length) notes.push(`${file}: ${diagnostics.map((d) => d.code).join(',')}`);
  const bound = bind(ast, file);
  noteBound(bound, ast);
  return { ast, bound };
}

for (const [name, text, extra] of cases) {
  const file = `${name}.8bx`;
  const { ast, bound } = boundOf(text, file);
  let foreign = null;
  if (extra?.files) {
    const others = Object.fromEntries(Object.entries(extra.files).map(([key, source]) => [key, boundOf(source, `${key}.8bx`)]));
    bindImportedComponents(bound, (source) => {
      const key = extra.lookup.find((k) => source.includes(k));
      return key ? others[key].bound : null;
    });
    foreign = others.box.ast;
  }
  const call = [ast, bound.symbols, file];
  const encoder = new Encoder({ asts: foreign ? [ast, foreign] : [ast] });
  const encoded = [...call, ...(foreign ? [foreign] : [])].map((arg) => encoder.encode(arg));
  const result = elaborateBx(...call);
  rows.push({
    name,
    fn: 'elaborateBx',
    args: encoded,
    result: new Encoder({ asts: [ast] }).encode(result),
    after: new Encoder({ asts: [ast] }).encode(ast),
  });
}

const out = fileURLToPath(new URL('../fixtures/bx-elaborate.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(rows)}\n`);
if (notes.length) console.log(`parse diagnostics:\n  ${notes.join('\n  ')}`);
const shared = rows.filter((r) => JSON.stringify(r.after).includes('"$node"')).length;
console.log(`${rows.length} rows (${shared} with shared nodes) -> ${out}`);
