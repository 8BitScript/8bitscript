// Hover, completion and go-to-definition for a program's own names —
// packages/compiler/src/intellisense/symbols.mjs, the binder-backed layer
// under getHoverInfo/getCompletions/getDefinition (8BX spec PR 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getHoverInfo, getCompletions, getDefinition } from '../index.mjs';
import { bindModule, bxPosition, scopeAt, visibleSymbols } from '../src/intellisense/symbols.mjs';

const at = (text, needle, into = 1) => text.lastIndexOf(needle) + into;

const withFiles = (files, fn) => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-intellisense-symbols-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const BAR = `// The bar's calls.
export namespace bar {
    // Opens a bar \`cells\` wide at \`row\`.
    function begin(row: utinyint, cells: utinyint): void { memory.write(0x8000, row); }
    function end(): void { memory.write(0x8001, 1); }
}
export let opened: utinyint = 0; // how many bars have been opened
let hidden: utinyint = 0;
`;

const MENU = `import { bar, opened } from "./bar.8bs";

// A bar with items in it.
export component MenuBar(row: utinyint, width: usmallint, title: string = "") {
    state depth: utinyint = 0;
    bar.begin(row, width);
    <slot />;
    bar.end();
}
export component MenuItem(label: string) {
    memory.write(0x8002, label.length);
}
component Hidden() { memory.write(0x8003, 1); }
`;

const MAIN = `import { MenuBar, MenuItem } from "./Menu.8bx";
import { opened } from "./bar.8bs";

// The program.
export function main(): void {
    let count: utinyint = opened;
    MenuBar(0, 40);
    count = count + 1;
}
`;

// ---- hover -------------------------------------------------------------------

test('hover on a component, in its declaration and in a tag, shows its signature and doc', () => {
  withFiles({ 'bar.8bs': BAR, 'Menu.8bx': MENU }, (dir) => {
    const path = join(dir, 'Menu.8bx');
    const text = `${MENU}export function draw(): void {\n    <MenuBar row={0} width={40}><MenuItem label="A" /></MenuBar>;\n}\n`;
    const declaration = getHoverInfo(text, at(text, 'component MenuBar', 12), { path });
    assert.match(declaration.markdown, /\*\*MenuBar\*\* — component/);
    assert.match(declaration.markdown, /export component MenuBar\(row: utinyint, width: usmallint, title: string = ""\)/);
    assert.match(declaration.markdown, /A bar with items in it\./);
    const tag = getHoverInfo(text, at(text, '<MenuBar row', 3), { path });
    assert.equal(tag.markdown, declaration.markdown);
    assert.equal(tag.start, text.lastIndexOf('<MenuBar row') + 1);
    assert.equal(tag.length, 'MenuBar'.length);
    const item = getHoverInfo(text, at(text, '<MenuItem label', 3), { path });
    assert.match(item.markdown, /component MenuItem\(label: string\)/);
    assert.doesNotMatch(item.markdown, /A bar with items/, 'the doc above MenuBar is not MenuItem\'s');
  });
});

test('hover on a prop, a state field and a local shows each as what it is', () => {
  withFiles({ 'bar.8bs': BAR, 'Menu.8bx': MENU }, (dir) => {
    const path = join(dir, 'Menu.8bx');
    const prop = getHoverInfo(MENU, at(MENU, 'begin(row', 7), { path });
    assert.match(prop.markdown, /\*\*row\*\* — parameter/);
    assert.match(prop.markdown, /row: utinyint/);
    const state = getHoverInfo(MENU, at(MENU, 'state depth', 8), { path });
    assert.match(state.markdown, /\*\*depth\*\* — state/);
    assert.match(state.markdown, /state depth: utinyint = 0/);
  });
});

test('hover follows an import to its declaration in the other file, and says where it is from', () => {
  withFiles({ 'bar.8bs': BAR, 'Menu.8bx': MENU, 'main.8bs': MAIN }, (dir) => {
    const path = join(dir, 'main.8bs');
    // A component called from .8bs (spec §4.5) is the same component.
    const call = getHoverInfo(MAIN, at(MAIN, 'MenuBar(0', 3), { path });
    assert.match(call.markdown, /\*\*MenuBar\*\* — component/);
    assert.match(call.markdown, /A bar with items in it\./);
    assert.match(call.markdown, /Imported from `\.\/Menu\.8bx`\./);
    // A variable with its doc on its own line, after it.
    const variable = getHoverInfo(MAIN, at(MAIN, '= opened', 4), { path });
    assert.match(variable.markdown, /\*\*opened\*\* — variable/);
    assert.match(variable.markdown, /export let opened: utinyint = 0/);
    assert.match(variable.markdown, /how many bars have been opened/);
    // The import specifier itself.
    const specifier = getHoverInfo(MAIN, at(MAIN, 'import { opened', 12), { path });
    assert.match(specifier.markdown, /\*\*opened\*\* — variable/);
  });
});

test('hover on a namespace member reached through an import reads the member, with its own doc', () => {
  withFiles({ 'bar.8bs': BAR, 'Menu.8bx': MENU }, (dir) => {
    const path = join(dir, 'Menu.8bx');
    const member = getHoverInfo(MENU, at(MENU, 'bar.begin', 6), { path });
    // The token-level member hover answers first, in its own format.
    assert.match(member.markdown, /bar\.begin\(row: utinyint, cells: utinyint\): void/);
    assert.match(member.markdown, /Opens a bar `cells` wide at `row`\./);
  });
});

test('hover on an import that does not resolve, or names a non-export, says so and has no definition', () => {
  withFiles({ 'bar.8bs': BAR }, (dir) => {
    const path = join(dir, 'main.8bs');
    const missing = 'import { gone } from "./nowhere.8bs";\nlet x: utinyint = gone;\n';
    assert.match(getHoverInfo(missing, at(missing, '= gone', 3), { path }).markdown, /Imported from `\.\/nowhere\.8bs`\./);
    assert.equal(getDefinition(missing, at(missing, '= gone', 3), { path }), null);
    const unexported = 'import { hidden } from "./bar.8bs";\nlet x: utinyint = hidden;\n';
    assert.match(getHoverInfo(unexported, at(unexported, '= hidden', 3), { path }).markdown, /not exported there, or not found/);
    assert.equal(getDefinition(unexported, at(unexported, '= hidden', 3), { path }), null);
  });
});

test('hover on a namespace shows its header; a member not in it is nothing', () => {
  const text = `${BAR}let y: utinyint = bar.nope;\n`;
  assert.match(getHoverInfo(text, at(text, 'bar.nope', 1)).markdown, /\*\*bar\*\* — namespace/);
  assert.match(getHoverInfo(text, at(text, 'bar.nope', 1)).markdown, /export namespace bar/);
  assert.equal(getHoverInfo(text, at(text, 'bar.nope', 5)), null);
});

test('a long declaration is cut in the hover', () => {
  const text = `const TABLE: array<utinyint, 40> = [${Array.from({ length: 40 }, (_, i) => i).join(', ')}];\nlet x: utinyint = TABLE[0];\n`;
  const info = getHoverInfo(text, at(text, 'TABLE[0]', 2));
  assert.match(info.markdown, /…\n```/);
  assert.ok(info.markdown.length < text.length);
});

// ---- completion ---------------------------------------------------------------

test('after < the components visible from here complete, then slot; a < in .8bs still means a type argument', () => {
  withFiles({ 'bar.8bs': BAR, 'Menu.8bx': MENU }, (dir) => {
    const path = join(dir, 'Menu.8bx');
    const text = `${MENU}export function draw(): void {\n    <`;
    const items = getCompletions(text, text.length, { path });
    assert.deepEqual(items.map((i) => i.label), ['MenuBar', 'MenuItem', 'Hidden', 'slot']);
    assert.equal(items[0].kind, 'component');
    assert.match(items[0].documentation, /A bar with items in it\./);
    // Mid-name: the same list, the editor filters by what is typed.
    const typing = `${text}Menu`;
    assert.deepEqual(getCompletions(typing, typing.length, { path }).map((i) => i.label), ['MenuBar', 'MenuItem', 'Hidden', 'slot']);
    // An imported component is offered from the file that imports it.
    const main = `${MAIN.replace('.8bs', '.8bx')}`;
    const other = `${main}export function draw(): void { <`;
    assert.deepEqual(getCompletions(other, other.length, { path: join(dir, 'main.8bx') }).map((i) => i.label), ['MenuBar', 'MenuItem', 'slot']);
  });
  const bs = 'let a: array<';
  assert.ok(getCompletions(bs, bs.length).some((i) => i.label === 'utinyint'));
});

test('inside a tag after its name, the component\'s props complete — as snippets, minus the ones given', () => {
  withFiles({ 'bar.8bs': BAR, 'Menu.8bx': MENU }, (dir) => {
    const path = join(dir, 'Menu.8bx');
    const text = `${MENU}export function draw(): void {\n    <MenuBar row={0} `;
    const items = getCompletions(text, text.length, { path });
    assert.deepEqual(items.map((i) => i.label), ['width', 'title']);
    assert.deepEqual(items.map((i) => i.insertText), ['width={$1}', 'title="$1"']);
    assert.ok(items.every((i) => i.snippet));
    assert.equal(items[0].detail, 'width: usmallint');
    assert.equal(items[1].detail, 'title?: string');
    assert.equal(items[1].sortRank, 1, 'optional props sort after required ones');
    // Inside a `{ … }` value, ordinary completion: the program's names.
    const inValue = `${text}width={`;
    assert.ok(getCompletions(inValue, inValue.length, { path }).some((i) => i.label === 'opened'));
    // A tag naming nothing known offers nothing.
    const unknown = `${MENU}export function draw(): void {\n    <Nope `;
    assert.deepEqual(getCompletions(unknown, unknown.length, { path }), []);
  });
});

test('after </ the innermost open element completes, closing it', () => {
  withFiles({ 'bar.8bs': BAR, 'Menu.8bx': MENU }, (dir) => {
    const path = join(dir, 'Menu.8bx');
    const text = `${MENU}export function draw(): void {\n    <MenuBar row={0} width={40}>\n        <MenuItem label="A" />\n        <>{opened && <MenuItem label="B" />}</>\n    </`;
    const items = getCompletions(text, text.length, { path });
    assert.deepEqual(items.map((i) => [i.label, i.insertText]), [['</MenuBar>', 'MenuBar>']]);
    // Nothing open: nothing to close.
    const closed = `${text}MenuBar>;\n    </`;
    assert.deepEqual(getCompletions(closed, closed.length, { path }), []);
  });
});

test('anywhere an expression goes, the names visible from there — innermost scope first, shadowing once', () => {
  const text = 'const LIMIT: utinyint = 4;\nfunction f(n: utinyint): void {\n    let LIMIT: utinyint = n;\n    if (n > 0) {\n        let inner: utinyint = 1;\n        inner = \n    }\n}\n';
  const items = getCompletions(text, at(text, 'inner = ', 8));
  assert.deepEqual(items.map((i) => i.label), ['inner', 'LIMIT', 'n', 'f']);
  assert.deepEqual(items.map((i) => i.kind), ['variable', 'variable', 'variable', 'function']);
  assert.equal(items[1].detail, 'variable', 'the local LIMIT shadows the const');
  // Not inside a comment or a string.
  const comment = 'let x: utinyint = 1; // x is ';
  assert.deepEqual(getCompletions(comment, comment.length), []);
  const string = 'let s: string = "x';
  assert.deepEqual(getCompletions(string, string.length), []);
});

// ---- definition ----------------------------------------------------------------

test('definition of a tag, a call from .8bs, an import, a local and a member lands on each declaration', () => {
  withFiles({ 'bar.8bs': BAR, 'Menu.8bx': MENU, 'main.8bs': MAIN }, (dir) => {
    const menu = join(dir, 'Menu.8bx');
    const main = join(dir, 'main.8bs');
    const bar = join(dir, 'bar.8bs');
    const draw = `${MENU}export function draw(): void { <MenuItem label="A" />; }\n`;
    assert.deepEqual(getDefinition(draw, at(draw, '<MenuItem label', 3), { path: menu }),
      { path: menu, start: MENU.indexOf('MenuItem'), length: 'MenuItem'.length });
    assert.deepEqual(getDefinition(MAIN, at(MAIN, 'MenuBar(0', 3), { path: main }),
      { path: menu, start: MENU.indexOf('MenuBar'), length: 'MenuBar'.length });
    assert.deepEqual(getDefinition(MAIN, at(MAIN, 'count + 1', 2), { path: main }),
      { path: main, start: MAIN.indexOf('count'), length: 'count'.length });
    assert.deepEqual(getDefinition(MENU, at(MENU, 'bar.end', 5), { path: menu }),
      { path: bar, start: BAR.indexOf('end('), length: 'end'.length });
    assert.equal(getDefinition(MAIN, at(MAIN, 'void {', 2), { path: main }), null, 'not a name');
    assert.equal(getDefinition(MAIN, at(MAIN, 'count + 1', 2)), null, 'no path, no file to point at');
  });
});

// ---- the pieces ------------------------------------------------------------------

test('bxPosition reads a tag, its name, a { } inside it, and the elements still open', () => {
  const src = 'component A() {\n    <Box row={1}>\n        <Item />\n        {c && <B></B>}\n        <C\n';
  const { tokens } = bindModule(src, 'x.8bx');
  const atText = (needle, into = needle.length) => bxPosition(tokens, src.indexOf(needle) + into);
  assert.equal(atText('<Box').tag.name.text, 'Box');
  assert.equal(atText('<Box').tag.nameDone, false, 'the cursor is still on the name');
  assert.equal(atText('<Box ').tag.nameDone, true);
  assert.equal(atText('row={').inExpression, true);
  assert.equal(atText('row={1}').inExpression, false);
  assert.deepEqual(atText('<Item />').open, ['Box']);
  assert.deepEqual(atText('<B>').open, ['Box', 'B']);
  assert.deepEqual(atText('</B>').open, ['Box']);
  assert.equal(atText('<C\n').tag.name.text, 'C');
  assert.equal(atText('<C\n').tag.nameDone, true);
  const fragment = 'component A() { <><X /></>; <';
  const frag = bindModule(fragment, 'x.8bx').tokens;
  assert.deepEqual(bxPosition(frag, fragment.indexOf('<X') + 2).open, ['']);
  assert.deepEqual(bxPosition(frag, fragment.length).open, [], 'the fragment\'s </> popped its own entry');
});

test('scopeAt finds the innermost scope, and the module\'s outside any', () => {
  const src = 'let g: utinyint = 0;\nfunction f(p: utinyint): void {\n    let l: utinyint = 0;\n    { let b: utinyint = 0; }\n}\n';
  const module = bindModule(src, 'x.8bs');
  const names = (offset) => visibleSymbols(scopeAt(module, offset)).map((s) => s.name);
  assert.deepEqual(names(0), ['g', 'f']);
  assert.deepEqual(names(src.indexOf('let l')), ['l', 'p', 'g', 'f']);
  assert.deepEqual(names(src.indexOf('let b')), ['b', 'l', 'p', 'g', 'f']);
});

test('bindModule reads an import\'s module once per specifier and survives one it cannot read', () => {
  withFiles({ 'bar.8bs': BAR }, (dir) => {
    const text = 'import { bar } from "./bar.8bs";\nimport { opened } from "./bar.8bs";\nimport { x } from "./missing.8bs";\n';
    const module = bindModule(text, join(dir, 'main.8bs'));
    assert.deepEqual([...module.modules.keys()], ['./bar.8bs']);
    assert.equal(module.bound.symbols.get('x').resolved, undefined);
  });
});
