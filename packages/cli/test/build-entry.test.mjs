// `8bs build`'s choice of entry file: the config's (or the default, or the
// argument's) path, and that path's `.<target>.8bs` twin when one exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveEntryPath } from '../src/build.mjs';

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
