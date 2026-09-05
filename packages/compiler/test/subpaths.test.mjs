// Package subpaths: `@scope/name/thing` resolves through the package's
// "8bitscript".exports map to a file inside it. This is what lets a target
// package such as @8bitscript/c64 keep its `screen` and `text`
// implementations beside the registers they are built on, while the
// portable @8bitscript/screen and @8bitscript/text packages delegate to
// `@8bitscript/c64/screen` and `@8bitscript/c64/text` per machine. See
// docs/packages.md#package-subpaths for the contract these tests pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { analyze, link, resolveSpecifier } from '../index.mjs';

const withFiles = (files, fn) => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-subpath-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), typeof text === 'string' ? text : JSON.stringify(text));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// A package whose entry is its registers and whose `./screen` subpath is a
// namespace built on them — the shape every target package has.
const PACKAGE = {
  'node_modules/@t/p/package.json': {
    name: '@t/p',
    '8bitscript': { entry: './src/index.8bs', exports: { './screen': './src/screen.8bs', './text': './src/text.8bs' } },
  },
  'node_modules/@t/p/src/index.8bs': '@address(0xD020)\nexport let borderColor: volatile<u8>;\n',
  'node_modules/@t/p/src/screen.8bs': [
    'import { borderColor } from "./index.8bs";',
    'export namespace screen {',
    '    function setColors(border: u8, background: u8): void { borderColor = border & 15; }',
    '}',
  ].join('\n'),
  'node_modules/@t/p/src/text.8bs': 'export namespace text {\n    const CellCount: u16 = 1000;\n}\n',
};

const CONSUMER = [
  'import { screen } from "@t/p/screen";',
  'import { text } from "@t/p/text";',
  'let cells: u16 = 0;',
  'export function main(): void { screen.setColors(6, 0); cells = text.CellCount; }',
].join('\n');

test('a package subpath resolves through the "8bitscript".exports map', () => {
  withFiles(PACKAGE, (dir) => {
    const entry = join(dir, 'main.8bs');
    const screen = resolveSpecifier('@t/p/screen', entry, { machine: 'c64' });
    assert.ok(screen.path.endsWith(join('@t', 'p', 'src', 'screen.8bs')), screen.path);
    assert.deepEqual(screen.native, []);
    const text = resolveSpecifier('@t/p/text', entry);
    assert.ok(text.path.endsWith(join('src', 'text.8bs')));
    // The package's own entry still resolves exactly as before.
    assert.ok(resolveSpecifier('@t/p', entry).path.endsWith(join('src', 'index.8bs')));
  });
});

test('a program importing subpaths links, and the subpath module reaches the package entry by relative import', () => {
  withFiles(PACKAGE, (dir) => {
    const entry = join(dir, 'main.8bs');
    const { ir, diagnostics } = link(CONSUMER, entry, { machine: 'c64' });
    assert.deepEqual(diagnostics, []);
    assert.ok(ir.functions.some((f) => f.name === 'screen_setColors'));
    assert.equal(ir.globals.find((g) => g.name === 'borderColor').address, 0xd020);
    const main = ir.functions.find((f) => f.name === 'main');
    assert.equal(main.body[0].kind, 'call');
    assert.equal(main.body[0].name, 'screen_setColors');
    assert.deepEqual(main.body[1].value, { kind: 'const', value: 1000 }); // text.CellCount inlined
  });
});

test('an unscoped package takes a subpath too', () => {
  const files = {
    'node_modules/p/package.json': { name: 'p', '8bitscript': { entry: './index.8bs', exports: { './lib': './lib.8bs' } } },
    'node_modules/p/index.8bs': 'export let a: u8 = 1;',
    'node_modules/p/lib.8bs': 'export let b: u8 = 2;',
  };
  withFiles(files, (dir) => {
    const entry = join(dir, 'main.8bs');
    assert.ok(resolveSpecifier('p/lib', entry).path.endsWith(join('p', 'lib.8bs')));
    const { ir, diagnostics } = link('import { b } from "p/lib";\nlet x: u8 = 0;\nexport function main(): void { x = b; }', entry);
    assert.deepEqual(diagnostics, []);
    assert.ok(ir.globals.some((g) => g.name === 'b'));
  });
});

test('the exported file follows the system-specific filename rule', () => {
  const files = {
    ...PACKAGE,
    'node_modules/@t/p/src/screen.nes.8bs': 'export namespace screen {\n    function setColors(border: u8, background: u8): void {}\n}\n',
  };
  withFiles(files, (dir) => {
    const entry = join(dir, 'main.8bs');
    assert.match(resolveSpecifier('@t/p/screen', entry, { machine: 'nes' }).path, /screen\.nes\.8bs$/);
    assert.match(resolveSpecifier('@t/p/screen', entry, { machine: 'c64' }).path, /src\/screen\.8bs$/);
    assert.match(resolveSpecifier('@t/p/screen', entry).path, /src\/screen\.8bs$/);
    // The NES version writes no register, so linking for nes carries none.
    const { ir, diagnostics } = link(CONSUMER, entry, { machine: 'nes' });
    assert.deepEqual(diagnostics, []);
    assert.ok(!ir.globals.some((g) => g.name === 'borderColor'));
  });
});

test('a subpath the package does not export is 8BS2011, naming what it does export', () => {
  withFiles(PACKAGE, (dir) => {
    const entry = join(dir, 'main.8bs');
    const resolved = resolveSpecifier('@t/p/sprites', entry);
    assert.equal(resolved.code, '8BS2011');
    assert.match(resolved.message, /'@t\/p' does not export '\.\/sprites' \(exports: \.\/screen, \.\/text\)/);
    // Through the linker, on the import's span.
    const program = 'import { sprites } from "@t/p/sprites";\nexport function main(): void {}';
    const { ir, diagnostics } = link(program, entry);
    assert.equal(ir, null);
    assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2011']);
    assert.equal(program.slice(diagnostics[0].start, diagnostics[0].start + diagnostics[0].length), 'import { sprites } from "@t/p/sprites";');
    // And through `8bs check` / the editor, which resolve without a machine.
    assert.deepEqual(analyze(program, entry, { resolveImports: true }).map((d) => d.code), ['8BS2011']);
  });
});

test('a package with no exports field offers no subpaths at all', () => {
  const files = {
    'node_modules/@t/q/package.json': { name: '@t/q', '8bitscript': { entry: './index.8bs' } },
    'node_modules/@t/q/index.8bs': 'export let a: u8 = 1;',
  };
  withFiles(files, (dir) => {
    const resolved = resolveSpecifier('@t/q/anything', join(dir, 'main.8bs'));
    assert.equal(resolved.code, '8BS2011');
    assert.match(resolved.message, /no "8bitscript"\.exports field/);
  });
});

test('a malformed exports map is 8BS2002, like any other malformed manifest', () => {
  const asArray = { ...PACKAGE, 'node_modules/@t/p/package.json': { name: '@t/p', '8bitscript': { entry: './src/index.8bs', exports: ['./src/screen.8bs'] } } };
  withFiles(asArray, (dir) => {
    assert.equal(resolveSpecifier('@t/p/screen', join(dir, 'main.8bs')).code, '8BS2002');
  });
  const notRelative = { ...PACKAGE, 'node_modules/@t/p/package.json': { name: '@t/p', '8bitscript': { entry: './src/index.8bs', exports: { './screen': '@t/other' } } } };
  withFiles(notRelative, (dir) => {
    const resolved = resolveSpecifier('@t/p/screen', join(dir, 'main.8bs'));
    assert.equal(resolved.code, '8BS2002');
    assert.match(resolved.message, /expected a relative path/);
  });
});

test('an exports key whose file does not exist is 8BS2003, like a missing entry', () => {
  const files = { ...PACKAGE };
  delete files['node_modules/@t/p/src/text.8bs'];
  withFiles(files, (dir) => {
    const resolved = resolveSpecifier('@t/p/text', join(dir, 'main.8bs'));
    assert.equal(resolved.code, '8BS2003');
    assert.match(resolved.message, /exports '\.\/text' as '\.\/src\/text\.8bs', which does not exist/);
  });
});

test('a subpath of a package that is not installed, or not 8BitScript, reports the package', () => {
  withFiles({ 'main.8bs': '' }, (dir) => {
    const resolved = resolveSpecifier('@t/missing/screen', join(dir, 'main.8bs'));
    assert.equal(resolved.code, '8BS2001');
    assert.match(resolved.message, /cannot find package '@t\/missing'/);
  });
  withFiles({ 'node_modules/plain/package.json': { name: 'plain', main: 'index.js' } }, (dir) => {
    const resolved = resolveSpecifier('plain/thing', join(dir, 'main.8bs'));
    assert.equal(resolved.code, '8BS2002');
  });
});

test('a package\'s native sources ride along with its subpaths', () => {
  const files = {
    ...PACKAGE,
    'node_modules/@t/p/package.json': {
      name: '@t/p',
      '8bitscript': { entry: './src/index.8bs', exports: { './screen': './src/screen.8bs' }, native: ['./native/font.s'] },
    },
    'node_modules/@t/p/native/font.s': '; font\n',
  };
  withFiles(files, (dir) => {
    const entry = join(dir, 'main.8bs');
    const resolved = resolveSpecifier('@t/p/screen', entry, { machine: 'nes' });
    assert.equal(resolved.native.length, 1);
    assert.ok(resolved.native[0].endsWith(join('native', 'font.s')));
    const { ir, diagnostics } = link(
      'import { screen } from "@t/p/screen";\nexport function main(): void { screen.setColors(1, 2); }',
      entry, { machine: 'nes' },
    );
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.nativeSources.length, 1);
  });
});

// ---- the delegation form: a portable package keyed by machine -------------
//
// @8bitscript/screen is exactly this: no source of its own, an entry object
// whose every branch is another package's subpath.

const PORTABLE = {
  ...PACKAGE,
  'node_modules/@t/p/src/screen.nes.8bs': 'export namespace screen {\n    function setColors(border: u8, background: u8): void {}\n}\n',
  'node_modules/@t/screen/package.json': {
    name: '@t/screen',
    '8bitscript': { entry: { c64: '@t/p/screen', nes: '@t/p/screen' } },
  },
  // The delegating package's own dependency serves the delegation.
  'node_modules/@t/screen/node_modules/@t/p/package.json': PACKAGE['node_modules/@t/p/package.json'],
  'node_modules/@t/screen/node_modules/@t/p/src/index.8bs': PACKAGE['node_modules/@t/p/src/index.8bs'],
  'node_modules/@t/screen/node_modules/@t/p/src/screen.8bs': PACKAGE['node_modules/@t/p/src/screen.8bs'],
  'node_modules/@t/screen/node_modules/@t/p/src/screen.nes.8bs': 'export namespace screen {\n    function setColors(border: u8, background: u8): void {}\n}\n',
};

test('a conditional entry may delegate to another package\'s subpath', () => {
  withFiles(PORTABLE, (dir) => {
    const entry = join(dir, 'main.8bs');
    const program = 'import { screen } from "@t/screen";\nexport function main(): void { screen.setColors(6, 0); }';
    const c64 = link(program, entry, { machine: 'c64' });
    assert.deepEqual(c64.diagnostics, []);
    assert.equal(c64.ir.globals.find((g) => g.name === 'borderColor').address, 0xd020);
    const nes = link(program, entry, { machine: 'nes' });
    assert.deepEqual(nes.diagnostics, []);
    assert.ok(!nes.ir.globals.some((g) => g.name === 'borderColor'));
    // No branch for the web: 8BS3002, as for any conditional entry.
    assert.deepEqual(link(program, entry, { machine: 'web' }).diagnostics.map((d) => d.code), ['8BS3002']);
    // Without a machine, every branch is validated and found sound.
    assert.deepEqual(analyze(program, entry, { resolveImports: true }), []);
    assert.equal(resolveSpecifier('@t/screen', entry).path, null);
  });
});

test('a delegation to a subpath the target does not export fails for that branch', () => {
  const broken = {
    ...PORTABLE,
    'node_modules/@t/screen/package.json': { name: '@t/screen', '8bitscript': { entry: { c64: '@t/p/screen', nes: '@t/p/sprites' } } },
  };
  withFiles(broken, (dir) => {
    const entry = join(dir, 'main.8bs');
    const resolved = resolveSpecifier('@t/screen', entry, { machine: 'nes' });
    assert.equal(resolved.code, '8BS2011');
    // With no machine in hand, the broken branch is still found.
    const checked = resolveSpecifier('@t/screen', entry);
    assert.equal(checked.code, '8BS2011');
    assert.match(checked.message, /for the nes target/);
    // The sound branch still builds.
    assert.ok(resolveSpecifier('@t/screen', entry, { machine: 'c64' }).path.endsWith('screen.8bs'));
  });
});
