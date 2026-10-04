// A package manager that does not hoist (pnpm's default) installs a package
// as a symlink in the project's node_modules, and puts the package's own
// dependencies beside its REAL directory in a virtual store — not in the
// project's node_modules. Every `@8bitscript/*` entry that delegates to a
// machine package ("c64": "@8bitscript/c64/screen") therefore resolves only if
// the delegation starts from the package's real directory, the way Node's own
// resolver starts from a module's real path. Starting from the symlink's
// path (the project's node_modules/@8bitscript/screen) looks in the wrong
// place, finds no `@8bitscript/c64`, and `8bs check` and the editor — which
// validate every machine's branch because they have no machine — report a
// false 8BS2001 on every import of text, screen and input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSpecifier } from '../index.mjs';

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function scratch() {
  return realpathSync(mkdtempSync(join(tmpdir(), '8bs-pnpm-')));
}

/** A package `machine` with a `./screen` subpath, at `<dir>/machine`. */
function writeMachine(dir) {
  const machine = join(dir, 'machine');
  mkdirSync(join(machine, 'src'), { recursive: true });
  writeJson(join(machine, 'package.json'), {
    name: 'machine',
    '8bitscript': { exports: { './screen': './src/screen.8bs' } },
  });
  writeFileSync(join(machine, 'src', 'screen.8bs'), 'export namespace screen {}\n');
  return machine;
}

/** A package `layer` that delegates its entry to `machine/screen`, at `<dir>/layer`. */
function writeLayer(dir) {
  const layer = join(dir, 'layer');
  mkdirSync(layer, { recursive: true });
  writeJson(join(layer, 'package.json'), {
    name: 'layer',
    '8bitscript': { entry: { c64: 'machine/screen', pet: 'machine/screen' } },
  });
  return layer;
}

test("a package's machine branches resolve through its own dependencies when it is installed as a symlink", () => {
  const root = scratch();
  try {
    const store = join(root, 'node_modules', '.pnpm');
    const machine = writeMachine(join(store, 'machine@1', 'node_modules'));
    const layer = writeLayer(join(store, 'layer@1', 'node_modules'));
    // The layer's own dependency, beside its real directory.
    symlinkSync(machine, join(store, 'layer@1', 'node_modules', 'machine'));
    // The project depends on `layer` only: `machine` is NOT in its node_modules.
    symlinkSync(layer, join(root, 'node_modules', 'layer'));
    mkdirSync(join(root, 'src'), { recursive: true });
    const from = join(root, 'src', 'main.8bs');

    // With a machine: that machine's branch, found beside the real directory.
    const withMachine = resolveSpecifier('layer', from, { machine: 'c64' });
    assert.equal(withMachine.code, undefined, withMachine.message);
    assert.equal(realpathSync(withMachine.path), join(machine, 'src', 'screen.8bs'));

    // Without one (what `8bs check` and the editor do): every branch validated.
    const withoutMachine = resolveSpecifier('layer', from, {});
    assert.equal(withoutMachine.code, undefined, withoutMachine.message);
    assert.equal(withoutMachine.path, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a package that really is missing is still reported', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    const result = resolveSpecifier('not-installed', join(root, 'src', 'main.8bs'), {});
    assert.equal(result.code, '8BS2001');
    assert.match(result.message, /cannot find package 'not-installed'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a delegation to a package that is nowhere is reported, naming the machine branch', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    const layer = writeLayer(join(root, 'node_modules'));
    assert.ok(layer);
    mkdirSync(join(root, 'src'), { recursive: true });
    const result = resolveSpecifier('layer', join(root, 'src', 'main.8bs'), {});
    assert.equal(result.code, '8BS2001');
    assert.match(result.message, /cannot find package 'machine'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
