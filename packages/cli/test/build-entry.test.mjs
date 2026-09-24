// `8bs build`'s choice of entry file: the config's (or the default, or the
// argument's) path, and that path's `.<target>.8bs` twin when one exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkEntryKind, resolveEntryPath } from '../src/build.mjs';

const withProject = (files, fn) => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-entry-'));
  try {
    mkdirSync(join(dir, 'src'));
    for (const name of files) writeFileSync(join(dir, 'src', name), '');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a main.<target>.8bs beside the entry is that target\'s entry', () => {
  withProject(['main.8bs', 'main.nes.8bs'], (dir) => {
    const config = { entry: join(dir, 'src', 'main.8bs') };
    assert.equal(resolveEntryPath(config, 'nes'), join(dir, 'src', 'main.nes.8bs'));
    assert.equal(resolveEntryPath(config, 'c64'), join(dir, 'src', 'main.8bs'));
    // No config at all: the default entry, same rule.
    assert.equal(resolveEntryPath(null, 'nes', join(dir, 'src', 'main.8bs')), join(dir, 'src', 'main.nes.8bs'));
  });
});

test('an explicit argument gets the same lookup, unless it already names a version', () => {
  withProject(['main.8bs', 'main.nes.8bs', 'other.8bs', 'other.nes.8bs'], (dir) => {
    const config = { entry: join(dir, 'src', 'main.8bs') };
    assert.equal(resolveEntryPath(config, 'nes', join(dir, 'src', 'other.8bs')), join(dir, 'src', 'other.nes.8bs'));
    // `8bs build --target c64 src/main.nes.8bs` means that file, as is.
    assert.equal(resolveEntryPath(config, 'c64', join(dir, 'src', 'main.nes.8bs')), join(dir, 'src', 'main.nes.8bs'));
  });
});

test('the older machine-keyed entry map still works', () => {
  withProject(['main.8bs', 'special.8bs'], (dir) => {
    const config = { entry: { default: join(dir, 'src', 'main.8bs'), nes: join(dir, 'src', 'special.8bs') } };
    assert.equal(resolveEntryPath(config, 'nes'), join(dir, 'src', 'special.8bs'));
    assert.equal(resolveEntryPath(config, 'c64'), join(dir, 'src', 'main.8bs'));
  });
});

test('an .8bx entry path takes its .8bx twin, never a .8bs one', () => {
  withProject(['App.8bx', 'App.nes.8bx'], (dir) => {
    assert.equal(resolveEntryPath(null, 'nes', join(dir, 'src', 'App.8bx')), join(dir, 'src', 'App.nes.8bx'));
    assert.equal(resolveEntryPath(null, 'c64', join(dir, 'src', 'App.8bx')), join(dir, 'src', 'App.8bx'));
  });
});

test('a program starts from .8bs: an .8bx entry is refused with the rule named', () => {
  assert.deepEqual(checkEntryKind('/p/src/main.8bs'), { ok: true });
  assert.deepEqual(checkEntryKind('/p/src/main.nes.8bs'), { ok: true });
  const bx = checkEntryKind('/p/src/App.8bx');
  assert.equal(bx.ok, false);
  assert.match(bx.error, /is a \.8bx file; a program starts from a \.8bs file/);
  assert.match(bx.error, /main\(\) in a \.8bs file that imports this file's components and calls them/);
  const other = checkEntryKind('/p/src/main.txt');
  assert.equal(other.ok, false);
  assert.match(other.error, /not an 8BitScript source file/);
  const gfx = checkEntryKind('/p/src/player.8bg');
  assert.equal(gfx.ok, false);
  assert.match(gfx.error, /is a media file; a program starts from a \.8bs file that imports it/);
  const aud = checkEntryKind('/p/src/theme.8ba');
  assert.equal(aud.ok, false);
  assert.match(aud.error, /is a media file/);
});
