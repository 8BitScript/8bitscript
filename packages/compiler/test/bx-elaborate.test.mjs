// 8BX elaboration: a component is a function in its own module, an
// element is a call to it, and the two meet across modules through the
// ordinary import machinery (bx/elaborate.mjs, binder bindImportedComponents).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Codes, analyze } from '../index.mjs';
import { optimizeReachable } from '../src/linker/optimize.mjs';
import { linkFiles as linkShared } from './support/link-files.mjs';

// The fixtures below keep their scaffolding (`let` counters, helpers) at
// the top of the .8bx file for brevity, which the ordinary-code lint (§2.6
// B) would flag; it is switched off here and tested on its own below.
const linkFiles = (files, entry, options = {}) => linkShared(files, entry, { bx: { strict: false }, ...options });

/** Every call by name anywhere in a lowered function body. */
function callsIn(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) callsIn(n, out); return out; }
  if (node && typeof node === 'object') {
    if (node.kind === 'call' && typeof node.name === 'string') out.push(node.name);
    for (const v of Object.values(node)) callsIn(v, out);
  }
  return out;
}

test('a component is a function of its own name, and an element is a call to it', () => {
  const main = `component Hello() { memory.write(0x8000, 1); }
export function main(): void { <Hello />; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const hello = ir.functions.find((f) => f.name === 'Hello');
  assert.ok(hello, 'the component is a function');
  assert.equal(hello.component, true, 'marked as the component it was');
  assert.equal(hello.exported, false, 'a component without export is not exported');
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Hello']);
});

test('props are the call\'s arguments, in parameter order, defaults filled, bare attributes true', () => {
  const main = `let hits: utinyint = 0;
component Box(x: utinyint, y: utinyint, wide: bool = false, tall: bool = false) {
    if (wide) { hits = hits + x; }
    if (tall) { hits = hits + y; }
}
export function main(): void { <Box tall y={4} x={2} />; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  const call = callsIn(entry.body);
  assert.deepEqual(call, ['Box']);
  const stmt = entry.body.find((s) => s.kind === 'call');
  assert.deepEqual(stmt.args.map((a) => a.value), [2, 4, 0, 1], 'x, y, wide (default false), tall (bare: true)');
});

test('an attribute expression runs once, however often the body reads the prop (§104)', () => {
  const main = `let n: utinyint = 0;
let sum: utinyint = 0;
function next(): utinyint { n = n + 1; return n; }
component Twice(value: utinyint) { sum = sum + value; sum = sum + value; }
export function main(): void { <Twice value={next()} />; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body).sort(), ['Twice', 'next'], 'next() is an argument, evaluated once');
});

test('a component with compile-time props is inlined; one fed a run-time value stays a call (§64, §65)', () => {
  const main = `let total: utinyint = 0;
let live: utinyint = 3;
component Add(amount: utinyint) { total = total + amount; }
export function main(): void {
    live = live + 1;
    <Add amount={5} />;
    <Add amount={live} />;
}
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const optimized = optimizeReachable(ir);
  const entry = optimized.functions.find((f) => f.name === ir.entry);
  const calls = entry.body.filter((s) => s.kind === 'call').map((s) => s.name);
  assert.deepEqual(calls, ['Add'], 'the run-time-argument element is the one call left');
  const inlined = entry.body.find((s) => s.kind === 'block' && s.origin === 'Add');
  assert.ok(inlined, 'the compile-time-argument element is its body, in place');
});

test('an exported component is imported and used from another module', () => {
  const files = {
    'Hello.8bx': `export component Hello(mark: utinyint) { memory.write(0x8000, mark); }
component Private() { memory.write(0x8001, 1); }
`,
    'main.8bx': `import { Hello } from "./Hello.8bx";
export function main(): void { <Hello mark={7} />; }
`,
  };
  const { ir, diagnostics } = linkFiles(files, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Hello']);
  assert.ok(ir.functions.some((f) => f.name === 'Hello' && f.component), 'Hello is linked in from its own module');
});

test('a component that is not exported is not a component to the importer', () => {
  const files = {
    'Hello.8bx': `component Hello() { memory.write(0x8000, 1); }
`,
    'main.8bx': `import { Hello } from "./Hello.8bx";
export function main(): void { <Hello />; }
`,
  };
  const { diagnostics } = linkFiles(files, 'main.8bx');
  const unknown = diagnostics.find((d) => d.code === Codes.BX_UNKNOWN_COMPONENT);
  assert.ok(unknown, 'reported as not a component');
  assert.match(unknown.message, /imported from '\.\/Hello\.8bx', which does not export a component by that name/);
});

test('a component from a package subpath links on every machine (the menu bar wrapper)', () => {
  // The only shipped .8bx component: a bar with its items in its slot.
  const main = `import { MenuBar, MenuItem } from "@8bitscript/ui/menubar-bx";
export function main(): void {
    <MenuBar row={0} width={40}>
        <MenuItem label="FILE" />
    </MenuBar>;
}
`;
  // From a scratch directory the package is not installed, so the
  // subpath is resolved through this checkout, as `8bs build --checkout` does.
  const checkout = join(import.meta.dirname, '..', '..', '..');
  for (const machine of ['pet', 'c64', 'nes', 'web']) {
    const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx', { machine, checkout });
    assert.deepEqual(diagnostics, [], machine);
    const entry = ir.functions.find((f) => f.name === ir.entry);
    assert.deepEqual(callsIn(entry.body), ['MenuBar__open', 'MenuItem', 'MenuBar__close'], machine);
  }
});

test('analyze() checks an imported component when it may read the import, and stays quiet when it may not', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bx-analyze-'));
  try {
    writeFileSync(join(dir, 'Hello.8bx'), 'export component Hello(mark: utinyint) { memory.write(0x8000, mark); }\n');
    const main = `import { Hello } from "./Hello.8bx";
export function main(): void { <Hello mark={1} nope={2} />; }
`;
    const file = join(dir, 'main.8bx');
    const resolved = analyze(main, file, { resolveImports: true }).map((d) => d.code);
    assert.deepEqual(resolved, [Codes.BX_UNKNOWN_PROP], 'the signature came from Hello.8bx');
    const unresolved = analyze(main, file, { resolveImports: false }).map((d) => d.code);
    assert.deepEqual(unresolved, [], 'an unread import is valid but unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an .8bs program calls a component positionally — `Hello(7);` is `<Hello mark={7} />` (§4.5)', () => {
  const files = {
    'Hello.8bx': `export component Hello(mark: utinyint, twice: bool = false) { memory.write(0x8000, mark); }
`,
    'main.8bs': `import { Hello } from "./Hello.8bx";
export function main(): void { Hello(7); Hello(8, true); }
`,
  };
  const { ir, diagnostics } = linkFiles(files, 'main.8bs');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Hello', 'Hello']);
  // The call form is checked as any call is: the wrong number of props is
  // the ordinary arity diagnostic, from the linker that knows both sides.
  const wrong = linkFiles({ ...files, 'main.8bs': 'import { Hello } from "./Hello.8bx";\nexport function main(): void { Hello(); }\n' }, 'main.8bs');
  assert.deepEqual(wrong.diagnostics.map((d) => d.code), ['8BS1035']);
  assert.match(wrong.diagnostics[0].message, /'Hello' takes 1 to 2 arguments, not 0/);
});

test('an element in .8bs is a syntax error: .8bs cannot contain 8BX (§4.2)', () => {
  const { diagnostics } = linkFiles({
    'Hello.8bx': 'export component Hello() { }\n',
    'main.8bs': 'import { Hello } from "./Hello.8bx";\nexport function main(): void { <Hello />; }\n',
  }, 'main.8bs');
  assert.ok(diagnostics.some((d) => d.code === '8BS1101' && /found '<'/.test(d.message)));
});

test('children go where <slot /> is: the component splits into two halves around them (§33, §105)', () => {
  const main = `let trace: utinyint = 0;
component Window(x: utinyint) {
    trace = trace + x;
    <slot />;
    trace = trace * 2;
}
component Item() { trace = trace + 100; }
export function main(): void {
    <Window x={1}><Item /><Item /></Window>;
    <Window x={2} />;
}
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const n of ['Window', 'Window__open', 'Window__close', 'Item']) assert.ok(names.includes(n), n);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Window__open', 'Item', 'Item', 'Window__close', 'Window'],
    'children between the halves, once each; a childless element is the whole component');
  // The whole component is the body with the slot elided; each half is its side of it.
  const whole = ir.functions.find((f) => f.name === 'Window');
  const open = ir.functions.find((f) => f.name === 'Window__open');
  const close = ir.functions.find((f) => f.name === 'Window__close');
  assert.equal(whole.body.length, 2);
  assert.equal(open.body.length, 1);
  assert.equal(close.body.length, 1);
  for (const f of [whole, open, close]) assert.equal(f.component, true);
});

test('an argument both halves read that could do something is evaluated once, into a local (§104)', () => {
  const main = `let n: utinyint = 0;
let sum: utinyint = 0;
function next(): utinyint { n = n + 1; return n; }
component Frame(v: utinyint) { sum = sum + v; <slot />; sum = sum + v; }
component Dot() { sum = sum + 1; }
export function main(): void { <Frame v={next()}><Dot /></Frame>; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body).filter((c) => c === 'next'), ['next'], 'next() runs once');
  const local = entry.body.find((s) => s.kind === 'let' || s.kind === 'local');
  assert.ok(local && /^__bx_1_v$/.test(local.name), `hoisted into a local, got ${JSON.stringify(local)}`);
});

test('a slotted component crosses modules: the halves are imported alongside it', () => {
  const files = {
    'Window.8bx': `export component Window(x: utinyint) { memory.write(0x8000, x); <slot />; memory.write(0x8001, x); }
`,
    'main.8bx': `import { Window } from "./Window.8bx";
component Dot() { memory.write(0x8002, 1); }
export function main(): void { <Window x={1}><Dot /></Window>; }
`,
  };
  const { ir, diagnostics } = linkFiles(files, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Window__open', 'Dot', 'Window__close']);
});

test('<slot /> out of place is 8BS2019, with the reason', () => {
  const codes = (src) => analyze(src, 't.8bx', { sourceKind: '.8bx' }).filter((d) => d.code === Codes.BX_INVALID_SLOT).map((d) => d.message);
  assert.match(codes('component A() { <slot />; <slot />; }\nexport function main(): void { }\n')[0], /more than once/);
  assert.match(codes('component A(f: bool) { if (f) { <slot />; } }\nexport function main(): void { }\n')[0], /top level of a component/);
  assert.match(codes('export function main(): void { <slot />; }\n')[0], /top level of a component/);
  assert.match(codes('component A() { let t: utinyint = 1; <slot />; t = 2; }\nexport function main(): void { }\n')[0], /declared before <slot \/> and used after it/);
  assert.match(codes('component A() { <slot name="x" />; }\nexport function main(): void { }\n')[0], /takes no attributes yet/);
  assert.deepEqual(codes('component A() { memory.write(0x8000, 1); <slot />; }\nexport function main(): void { }\n'), []);
});

test('element children on a component without a slot are still refused (§33)', () => {
  const src = 'component A() { }\ncomponent B() { }\nexport function main(): void { <A><B /></A>; }\n';
  const codes = analyze(src, 't.8bx', { sourceKind: '.8bx' }).map((d) => d.code);
  assert.ok(codes.includes(Codes.BX_CHILDREN_REJECTED));
});

test('.8bs is code, .8bx is composition: asm6502 is refused in .8bx, and ordinary code there is a warning (§2.6)', () => {
  const asm = `component Raster() { asm6502 { nop } }
export function main(): void { <Raster />; }
`;
  const a = analyze(asm, 't.8bx', { sourceKind: '.8bx' });
  const refused = a.find((d) => d.code === Codes.BX_ASM_IN_BX);
  assert.ok(refused, JSON.stringify(a));
  assert.equal(refused.severity, 'error');
  assert.match(refused.message, /put it in a \.8bs function and import it/);
  // The same block in .8bs is what it always was.
  assert.deepEqual(analyze('export function irq(): void { asm6502 { nop } }\n', 't.8bs').filter((d) => d.code === Codes.BX_ASM_IN_BX), []);

  const ordinary = `let count: utinyint = 0;
function helper(): void { count = count + 1; }
component Hello() { helper(); }
export function draw(): void { <Hello />; }
`;
  const b = analyze(ordinary, 't.8bx', { sourceKind: '.8bx' });
  const warnings = b.filter((d) => d.code === Codes.BX_ORDINARY_CODE);
  assert.deepEqual(warnings.map((d) => [d.severity, ordinary.slice(d.start, d.start + d.length)]), [['warning', 'count'], ['warning', 'helper']],
    'the let and the element-less function; draw() composes and is left alone');
  assert.match(warnings[1].message, /composes nothing/);
  // A project may switch the lint off; the hard rule stays.
  assert.deepEqual(analyze(ordinary, 't.8bx', { sourceKind: '.8bx', bx: { strict: false } }).filter((d) => d.code === Codes.BX_ORDINARY_CODE), []);
  assert.ok(analyze(asm, 't.8bx', { sourceKind: '.8bx', bx: { strict: false } }).some((d) => d.code === Codes.BX_ASM_IN_BX));
  // A warning reports and rides along: the program still links.
  const linked = linkShared({ 'main.8bx': ordinary.replace('export function draw', 'export function main') }, 'main.8bx');
  assert.ok(linked.ir, 'linked despite the warnings');
  assert.deepEqual(linked.diagnostics.map((d) => d.severity), ['warning', 'warning']);
});
