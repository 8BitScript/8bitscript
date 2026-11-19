// F-01: `findImports` over `use` token runs equals the import sources the
// parser makes, over every in-repo `.8bs` file converted by the migrate printer.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { convertSource } from '../src/migrate/print.mjs';
import { parse, tokenize } from '../../compiler/src/front/index.mjs';
import { findImports } from '../../compiler/src/resolver/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skip = new Set(['node_modules', '.git', 'target', 'dist', '.fleet-out']);

const sources = [];
const scan = (dir) => {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) scan(path);
    else if (name.endsWith('.8bs') && !name.startsWith('8bitscript.config')) sources.push(path);
  }
};
for (const top of ['packages', 'editors']) scan(join(root, top));

test('findImports equals the parsed import sources over the repo', () => {
  assert.ok(sources.length > 300);
  let imports = 0;
  for (const file of sources) {
    let text;
    try {
      ({ text } = convertSource(readFileSync(file, 'utf8'), { file }));
    } catch {
      continue; // not old syntax any more, or not convertible: C-02's concern
    }
    const { tokens } = tokenize(text, file);
    const { ast } = parse(tokens, text, file);
    const expected = ast.body.filter((n) => n.type === 'ImportDeclaration').map((n) => n.source.value);
    const found = findImports(tokens).map((i) => i.specifier);
    assert.deepEqual(found, expected, file);
    imports += expected.length;
  }
  assert.ok(imports > 100);
});
