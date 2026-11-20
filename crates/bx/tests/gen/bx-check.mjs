// Regenerates fixtures/bx-check.json: `checkBx` (packages/compiler/src/bx/check.mjs) over parsed
// `.8bx` and `.8bs` text, one row per call in the front tap's record shape `{fn, args, result}`.
// Arguments and result go through the tap's own encoder (`encodeGraph`), so a row is what the
// tap would have recorded: the AST in full, the binder's symbols with `$sym` ids.
//
// The text is new syntax, parsed by `packages/compiler/src/front/index.mjs`. Every `.8bx`
// snippet runs under all four option sets (source kind `.8bs`/`.8bx`, strict true/false); the
// source kind option is what the check reads, not how the text was parsed. A few rows come
// from text parsed as `.8bs` too. Imported components are bound across two modules.
// Run from the repo root: node crates/bx/tests/gen/bx-check.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, tokenize } from '../../../../packages/compiler/src/front/index.mjs';
import { bind, bindImportedComponents } from '../../../../packages/compiler/src/binder/index.mjs';
import { checkBx } from '../../../../packages/compiler/src/bx/check.mjs';
import { Encoder, noteBound } from '../../../../scripts/oracle/front-tap/graph.mjs';

const CARD = 'component Card(title: u8, count: u8 = 1) {}\ncomponent Plain() {}\n';
const FRAME = 'component Frame(title: u8) {\n    <slot />;\n}\n';
const LABEL = 'component Label(children: string) {}\ncomponent Soft(children: string = "") {}\n';
const WRAP = 'component Wrap(children: string) {\n    <slot />;\n}\n';

/** `[name, text, extra]`: `extra` is `{ files, lookup }` for imports, `{ stack }` for a stack. */
const bx = [
  // Unknown and known components.
  ['unknown', 'component A() {\n    <Missing />;\n}\n'],
  ['unknown-nested-unchecked', `${CARD}component A() {\n    <Missing><Card title={1} /></Missing>;\n}\n`],
  ['not-a-component', 'fn Helper() {}\ncomponent A() {\n    <Helper />;\n}\n'],
  ['top-level-element', `${CARD}<Card title={1} />;\n<Missing />;\n`],
  ['ok', `${CARD}component A() {\n    <Card title={1} />;\n    <Card title={2} count={3} />;\n}\n`],
  ['fragment', `${CARD}component A() {\n    <><Card title={1} /><Missing /><><Card /></></>;\n}\n`],
  ['missing-prop', `${CARD}component A() {\n    <Card />;\n}\n`],
  ['unknown-prop', `${CARD}component A() {\n    <Card title={1} extra={2} other="x" />;\n}\n`],
  ['duplicate-prop', `${CARD}component A() {\n    <Card title={1} title={2} count={1} count={2} />;\n}\n`],
  ['spread', `${CARD}component A() {\n    <Card {rest} title={1} />;\n}\n`],
  ['self-recursion-without-stack', 'component Rec() {\n    <Rec />;\n}\n'],
  // Children.
  ['text-children-rejected', `${CARD}component A() {\n    <Card title={1}>hello</Card>;\n}\n`],
  ['text-children-accepted', `${LABEL}component A() {\n    <Label>hello</Label>;\n    <Soft>x</Soft>;\n}\n`],
  ['children-prop-missing', `${LABEL}component A() {\n    <Label />;\n    <Soft />;\n}\n`],
  ['element-children-rejected', `${CARD}component A() {\n    <Card title={1}><Card title={2} /></Card>;\n}\n`],
  ['expression-children-rejected', `${CARD}component A(ok: bool) {\n    <Card title={1}>{ok && <Card title={2} />}</Card>;\n}\n`],
  ['element-children-accepted', `${CARD}${FRAME}component A() {\n    <Frame title={1}><Card title={2} /></Frame>;\n    <Frame title={1} />;\n}\n`],
  ['children-prop-with-elements', `${CARD}${WRAP}component A() {\n    <Wrap><Card title={1} /></Wrap>;\n    <Wrap />;\n}\n`],
  ['text-children-on-slot-component', `${FRAME}component A() {\n    <Frame title={1}>text</Frame>;\n}\n`],
  // checkSlots.
  ['slot-twice', 'component F() {\n    <slot />;\n    <slot />;\n    <slot />;\n}\n'],
  ['slot-attributes', 'component F() {\n    <slot a={1} />;\n}\n'],
  ['slot-children', 'component F() {\n    <slot>text</slot>;\n}\n'],
  ['slot-blank-children', 'component F() {\n    <slot> </slot>;\n}\n'],
  ['slot-local-crosses', 'component F() {\n    let a: u8 = 1;\n    let b: u8 = 2;\n    <slot />;\n    use1(a, a);\n    use1(b);\n}\n'],
  ['slot-local-not-read', 'component F() {\n    let a: u8 = 1;\n    state s: u8 = 0;\n    <slot />;\n    let c: u8 = 3;\n    use1(c, s);\n}\n'],
  ['slot-nested', 'component F() {\n    if true {\n        <slot />;\n    }\n}\n'],
  ['slot-outside', 'fn plain() {\n    <slot />;\n}\n<slot />;\n'],
  ['slot-in-expression', 'component F(ok: bool) {\n    ok && <slot />;\n}\n'],
  // checkState.
  ['state-needs-type', 'component C() {\n    state x = 1;\n    state y: u8 = 2;\n}\n'],
  ['state-same-as-prop', 'component C(a: u8) {\n    state a: u8 = 0;\n}\n'],
  ['state-twice', 'component C() {\n    state a: u8 = 0;\n    state a: u8 = 1;\n}\n'],
  ['state-nested', 'component C() {\n    if true {\n        state z: u8 = 0;\n    }\n}\n'],
  ['state-outside', 'state q: u8 = 0;\nfn f() {\n    state r: u8 = 0;\n}\n'],
  ['state-shadowed', 'component C() {\n    state n: u8 = 0;\n    let n: u8 = 1;\n    if true {\n        let n: u8 = 2;\n    }\n}\n'],
  ['state-ok', 'component C(p: u8) {\n    state n: u8 = 0;\n    state m: bool;\n    n += p;\n}\n'],
  // checkMethods.
  ['method-takes-prop-name', 'component C(a: u8) {\n    fn a() {}\n}\n'],
  ['method-takes-state-name', 'component C() {\n    state a: u8 = 0;\n    fn a() {}\n}\n'],
  ['method-twice', 'component C() {\n    fn m() {}\n    fn m() {}\n}\n'],
  ['method-reads-prop', 'component C(a: u8, b: u8) {\n    fn m() {\n        a;\n        b + a;\n        x.a;\n    }\n}\n'],
  ['method-shadows-prop', 'component C(a: u8, b: u8) {\n    fn m(a: u8) {\n        a;\n        b;\n    }\n    fn n() {\n        let b: u8 = 1;\n        b;\n        a;\n    }\n}\n'],
  ['method-nameless', 'component C(a: u8) {\n    fn () {}\n}\n'],
  // checkFileRole.
  ['role-asm', 'fn raw() {\n    asm6502 { nop }\n}\ncomponent C() {\n    asm6502 { rts }\n}\n'],
  ['role-ordinary-function', 'fn plain() {}\nfn view() {\n    <Plain />;\n}\ncomponent Plain() {}\n'],
  ['role-top-level-let', 'let counter: u8 = 0;\nlet mut other: u8 = 1;\nconst LIMIT: u8 = 3;\n'],
  ['role-nameless', 'fn () {}\nlet = 1;\ncomponent C() {}\n'],
  ['role-components-and-methods-exempt', 'component C() {\n    fn m() {}\n    let inner: u8 = 0;\n}\nmod m {\n    fn f() {}\n}\n'],
  // checkComposition.
  ['value-let', `${CARD}component A() {\n    let x = <Card title={1} />;\n}\n`],
  ['value-call-argument', `${CARD}component A() {\n    f(<Card title={1} />);\n}\n`],
  ['value-binary', `${CARD}component A() {\n    let x = a + <Card title={1} />;\n}\n`],
  ['value-attribute', `${CARD}component A() {\n    <Card title={<Card title={1} />} />;\n}\n`],
  ['value-assignment-and-friends', `${CARD}component A() {\n    x = <Card title={1} />;\n    y = [<Card title={1} />, 2];\n    m.n(<Card title={1} />);\n    z = !<Card title={1} />;\n    w = arr[<Card title={1} />];\n    k.j = <Card title={1} />;\n}\n`],
  ['value-in-control-flow', `${CARD}component A(ok: bool) {\n    if ok {\n        <Card title={1} />;\n    } else {\n        <Card title={2} />;\n    }\n    while ok {\n        <Card title={3} />;\n    }\n    for i in 0..3 {\n        <Card title={4} />;\n    }\n    if <Card title={5} /> {\n    }\n}\n`],
  ['value-in-namespace', `${CARD}mod m {\n    fn f() {\n        <Card title={1} />;\n    }\n    let v = <Card title={2} />;\n}\n`],
  ['value-decorated', `${CARD}@irq\nfn f() {\n    <Card title={1} />;\n}\n`],
  ['conditional-arms', `${CARD}component A(ok: bool) {\n    ok ? <Card title={1} /> : <Card title={2} />;\n    ok ? <Card title={1} /> : 1;\n    ok && <Card title={3} />;\n    ok && ok && <Card title={4} />;\n    ok || <Card title={5} />;\n}\n`],
  ['conditional-let', `${CARD}component A(ok: bool) {\n    let x = ok ? <Card title={1} /> : <Card title={2} />;\n    let y = ok && <Card title={3} />;\n}\n`],
  ['expression-children', `${CARD}component A(ok: bool, score: u8) {\n    <>{ok && <Card title={1} />}{ok ? <Card title={2} /> : <Card title={3} />}{score}{f()}{}{ok ? <Card title={4} /> : 1}</>;\n}\n`],
  ['expression-child-nested-element', `${CARD}component A(ok: bool) {\n    <>{ok ? <Card title={<Card title={1} />} /> : <Plain />}</>;\n}\n`],
  ['return-element', `${CARD}component A(ok: bool) {\n    return <Card title={1} />;\n}\nfn g(ok: bool) {\n    return (<Card title={2} />);\n}\nfn h(ok: bool) {\n    return ok && <Card title={3} />;\n}\nfn i() {\n    return 1;\n}\nfn j() {\n    return;\n}\n`],
  ['return-value-element', `${CARD}fn k() {\n    f(return_value);\n    return 1 + <Card title={1} />;\n}\n`],
  // Order-sensitive probes: two failing arms or siblings, so the order of the walk shows.
  ['order-let-conditional', 'component A(ok: bool) {\n    let x = ok ? <M1 /> : <M2 />;\n}\n'],
  ['order-call-conditional', 'component A(ok: bool) {\n    f(ok ? <M1 /> : <M2 />);\n}\n'],
  ['order-return-conditional', 'component A(ok: bool) {\n    return ok ? <M1 /> : <M2 />;\n}\n'],
  ['order-statement-conditional', 'component A(ok: bool) {\n    ok ? <M1 /> : <M2 />;\n    ok && <M3 />;\n    ok ? <M4 /> : ok ? <M5 /> : <M6 />;\n}\n'],
  ['order-attribute-conditional', `${CARD}component A(ok: bool) {\n    <Card title={ok ? <M1 /> : <M2 />} count={ok && <M3 />} />;\n}\n`],
  ['order-child-conditional', `${CARD}component A(ok: bool) {\n    <Card title={1}>{ok ? <M1 /> : <M2 />}{ok && <M3 />}</Card>;\n}\n`],
  ['order-fragment-conditional', 'component A(ok: bool) {\n    <>{ok ? <M1 /> : <M2 />}{ok ? <M3 /> : 1}<M4 /></>;\n}\n'],
  ['order-if-arms', 'component A(ok: bool) {\n    if ok {\n        <M1 />;\n    } else {\n        <M2 />;\n    }\n    while ok {\n        <M3 />;\n    }\n}\n'],
  ['order-binary-both-sides', 'component A(ok: bool) {\n    let x = <M1 /> + <M2 />;\n    let y = <M3 /> && <M4 />;\n    x = y ? <M5 /> : <M6 />;\n}\n'],
  ['order-index-member-call', 'component A(ok: bool) {\n    f(<M1 />)[<M2 />];\n    a.b(<M3 />, <M4 />);\n    r = { a: <M5 />, b: <M6 /> };\n    arr = [<M7 />, <M8 />];\n}\n'],
  ['order-slot-arms', 'component A(ok: bool) {\n    if ok {\n        <slot />;\n    } else {\n        <slot />;\n    }\n}\n'],
  ['order-slot-conditional', 'component A(ok: bool) {\n    ok ? <slot /> : <slot />;\n    <slot />;\n    <slot />;\n}\n'],
  ['order-asm-arms', 'component A(ok: bool) {\n    if ok {\n        asm6502 { nop }\n    } else {\n        asm6502 { rts }\n    }\n}\n'],
  ['order-state-arms', 'component A(ok: bool) {\n    if ok {\n        state a: u8 = 0;\n    } else {\n        state b: u8 = 0;\n    }\n    ok ? 1 : 2;\n}\n'],
  ['order-state-untyped-arms', 'component A(ok: bool) {\n    state a = 0;\n    state b = 1;\n    if ok {\n        state c = 2;\n    } else {\n        state d = 3;\n    }\n}\n'],
  ['order-method-arms', 'component A(a: u8, b: u8) {\n    fn m() {\n        if a {\n            a;\n        } else {\n            b;\n        }\n        a + b;\n        f(b, a);\n    }\n    fn n() {\n        b;\n        a;\n    }\n}\n'],
  ['order-ordinary-code', 'fn one() {}\nfn two() {}\nlet a: u8 = 0;\nlet b: u8 = 1;\nfn three() {}\n'],
  ['order-decorators', `${CARD}@irq\n@irq\nfn f() {\n    <M1 />;\n}\n@irq\ncomponent B() {\n    <M2 />;\n}\n`],
  // Plain code that carries no element at all.
  ['no-elements', 'use self::util::{helper};\nfn main() {\n    let x: u8 = helper(1);\n}\n'],
];

/** Text parsed as `.8bs`: the file-role checks over plain code. */
const bs = [
  ['bs-plain-code', 'fn main() {\n    let x: u8 = 1;\n}\nlet top: u8 = 0;\nconst K: u8 = 1;\n'],
  ['bs-asm', 'fn raw() {\n    asm6502 { nop }\n}\n'],
  ['bs-component-as-plain-names', 'fn component() {}\nlet state: u8 = 0;\n'],
];

/** Cross-module imports: `main` imports `Box` and `Hidden` from `box`. */
const BOX = 'pub component Box(label: u8) {\n    <slot />;\n}\ncomponent Hidden() {}\npub fn helper() {}\npub let value: u8 = 1;\n';
const imports = [
  ['import-resolved', 'use self::box::{Box};\ncomponent A() {\n    <Box label={1}><Box label={2} /></Box>;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['import-resolved-misuse', 'use self::box::{Box};\ncomponent A() {\n    <Box />;\n    <Box label={1} extra={2} />;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['import-unresolved-silent', 'use self::box::{Box, Hidden};\ncomponent A() {\n    <Box label={1} />;\n    <Hidden />;\n}\n', { files: { box: BOX }, lookup: [] }],
  ['import-not-a-component', 'use self::box::{helper, value, Hidden, Missing};\ncomponent A() {\n    <helper />;\n    <value />;\n    <Hidden />;\n    <Missing />;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['import-renamed', 'use self::box::{Box as Crate};\ncomponent A() {\n    <Crate label={1} />;\n    <Box label={1} />;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
  ['import-module-missing', 'use self::gone::{Box};\ncomponent A() {\n    <Box />;\n}\n', { files: { box: BOX }, lookup: ['box'] }],
];

const OPTIONS = [
  { sourceKind: '.8bs', strict: true },
  { sourceKind: '.8bs', strict: false },
  { sourceKind: '.8bx', strict: true },
  { sourceKind: '.8bx', strict: false },
];

const rows = [];
const notes = [];

function parseText(text, file, sourceKind) {
  const tokens = tokenize(text, file, { sourceKind });
  const { ast, diagnostics } = parse(tokens, text, file, { sourceKind });
  return { ast, diagnostics };
}

function row(name, ast, file, bound, args) {
  const call = [ast, file, bound.symbols, ...args];
  const encoder = new Encoder({ asts: [ast] });
  const encoded = call.map((arg) => encoder.encode(arg));
  const result = checkBx(...call);
  rows.push({ name, fn: 'checkBx', args: encoded, result: new Encoder({ asts: [ast] }).encode(result) });
  return result;
}

function boundOf(text, file, sourceKind) {
  const { ast, diagnostics } = parseText(text, file, sourceKind);
  if (diagnostics.length) notes.push(`${file}: ${diagnostics.map((d) => d.code).join(',')}`);
  const bound = bind(ast, file);
  noteBound(bound, ast);
  return { ast, bound };
}

function sweep(name, text, sourceKind, extra = {}) {
  const file = `${name}.${sourceKind === '.8bx' ? '8bx' : '8bs'}`;
  const { ast, bound } = boundOf(text, file, sourceKind);
  if (extra.files) {
    const others = Object.fromEntries(Object.entries(extra.files).map(([key, source]) => [key, boundOf(source, `${key}.8bx`, '.8bx')]));
    bindImportedComponents(bound, (source) => {
      const key = extra.lookup.find((k) => source.includes(k));
      return key ? others[key].bound : null;
    });
  }
  let diagnostics = 0;
  for (const options of OPTIONS) {
    diagnostics += row(`${name} ${options.sourceKind} strict=${options.strict}`, ast, file, bound, [options]).length;
  }
  return { ast, bound, file, diagnostics };
}

const seen = {};
for (const [name, text, extra] of bx) seen[name] = sweep(name, text, '.8bx', extra);
for (const [name, text, extra] of imports) seen[name] = sweep(name, text, '.8bx', extra);
for (const [name, text] of bs) seen[name] = sweep(name, text, '.8bs');

// The same sources with the options left out (the defaults: `.8bs`, strict), and with `{}`.
for (const name of ['ok', 'missing-prop', 'role-asm', 'role-top-level-let']) {
  const { ast, bound, file } = seen[name];
  row(`${name} no options`, ast, file, bound, []);
  row(`${name} empty options`, ast, file, bound, [{}]);
}
// A stack: an element naming a component already on it is a recursion.
{
  const { ast, bound, file } = seen['ok'];
  const options = { sourceKind: '.8bx', strict: true };
  row('ok stack Card', ast, file, bound, [options, ['Card']]);
  row('ok stack Plain', ast, file, bound, [options, ['Plain']]);
  row('ok stack empty', ast, file, bound, [options, []]);
  row('ok stack Frame, Card', ast, file, bound, [options, ['Frame', 'Card']]);
  const rec = seen['self-recursion-without-stack'];
  row('self-recursion stack Rec', rec.ast, rec.file, rec.bound, [options, ['Rec']]);
  const frag = seen['fragment'];
  row('fragment stack Card', frag.ast, frag.file, frag.bound, [options, ['Card']]);
}
// Props only a hand-built binder result has: `optional` without a default value.
{
  const file = 'optional-without-default.8bx';
  const { ast, bound } = boundOf(`${CARD}${LABEL}component A() {\n    <Card />;\n    <Label />;\n    <Soft />;\n}\n`, file, '.8bx');
  const card = bound.symbols.get('Card');
  card.props[0].optional = true;
  const label = bound.symbols.get('Label');
  label.props[0].optional = true;
  for (const options of OPTIONS) {
    row(`optional-without-default ${options.sourceKind} strict=${options.strict}`, ast, file, bound, [options]);
  }
  const text = 'component B() {\n    <Plain><Plain /></Plain>;\n}\n';
  const b = boundOf(`${CARD}${text}`, 'allows-children.8bx', '.8bx');
  b.bound.symbols.get('Plain').allowsChildren = true;
  row('allows-children', b.ast, 'allows-children.8bx', b.bound, [{ sourceKind: '.8bx', strict: true }]);
}

const empty = rows.filter((r) => r.result.length === 0).length;
const out = fileURLToPath(new URL('../fixtures/bx-check.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(rows)}\n`);
if (notes.length) console.log(`parse diagnostics:\n  ${notes.join('\n  ')}`);
const codes = new Map();
for (const r of rows) for (const d of r.result) codes.set(d.code, (codes.get(d.code) ?? 0) + 1);
console.log(`${rows.length} rows (${empty} with no diagnostics) -> ${out}`);
console.log([...codes].sort().map(([c, n]) => `${c}:${n}`).join(' '));
