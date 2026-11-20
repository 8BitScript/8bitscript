import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { analyze, link, resolveImportAliases, resolveSpecifier } from '../index.mjs';

test('resolveImportAliases validates keys and paths', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-alias-'));
  assert.deepEqual(resolveImportAliases(undefined, dir), { ok: true, importAliases: {} });
  assert.equal(resolveImportAliases({ '@lib': 'src/lib' }, dir).ok, true);
  assert.match(resolveImportAliases({ '@lib': 'src/lib' }, dir).importAliases['@lib'], /src\/lib$/);
  assert.equal(resolveImportAliases({ lib: 'src/lib' }, dir).ok, false);
  assert.equal(resolveImportAliases({ '@lib': '../escape' }, dir).ok, false);
});

test('a project import alias resolves like a relative path from its directory', () => {
  const root = mkdtempSync(join(tmpdir(), '8bs-alias-'));
  const libDir = join(root, 'src', 'lib');
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(libDir, 'rules.8bs'), 'pub const SCORE: utinyint = 0;\n');
  const consumer = join(root, 'src', 'ui', 'view.8bs');
  mkdirSync(dirname(consumer), { recursive: true });
  writeFileSync(consumer, 'use "@lib/rules.8bs"::SCORE;\npub fn draw() -> utinyint {\n    return SCORE;\n}\n');

  const aliases = resolveImportAliases({ '@lib': 'src/lib' }, root).importAliases;
  const resolved = resolveSpecifier('@lib/rules.8bs', consumer, { importAliases: aliases });
  assert.ok(resolved.path?.endsWith(join('src', 'lib', 'rules.8bs')));

  const main = join(root, 'src', 'main.8bs');
  writeFileSync(main, 'use self::ui::view::draw;\npub fn main() {\n    draw();\n}\n');
  assert.deepEqual(
    analyze(readFileSync(consumer, 'utf8'), consumer, { resolveImports: true, importAliases: aliases }).map((d) => d.code),
    [],
  );
  const { ir } = link(readFileSync(main, 'utf8'), main, { importAliases: aliases });
  assert.ok(ir);

  rmSync(root, { recursive: true, force: true });
});
