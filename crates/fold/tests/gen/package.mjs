// Regenerates fixtures/package.json: `nearestPackage` over a temp tree, from
// the JS. Paths in the fixture are relative to the tree root; the Rust test
// builds the same tree from `tree` and strips its own root the same way.
// Run from the repo root: node crates/fold/tests/gen/package.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nearestPackage, PACKAGE_FIELDS } from '../../../../packages/compiler/src/fold/package.mjs';

const root = mkdtempSync(join(tmpdir(), 'fold-package-'));
const tree = {
  'a/package.json': '{"name":"outer","version":"1.2.3","extra":{"k":[1,2.5,null,true]}}',
  'a/b/c/deep.txt': 'x',
  'a/b/package.json': '{"name":"@scope/inner","version":"0.0.1"}',
  'a/b/c/d/e.txt': 'x',
  'a/empty/f/g.txt': 'x',
  'z/y/x.txt': 'x',
  // Inputs serde_json refuses and JSON.parse takes: deep nesting, a number
  // past f64, a lone surrogate escape.
  'deep/package.json': `{"name":"deep","version":"1","x":${'['.repeat(3000)}1${']'.repeat(3000)}}`,
  'deep/sub/f.txt': 'x',
  'big/package.json': '{"name":"big","version":"1","n":1e400,"m":-1e400,"k":123456789012345678901234567890}',
  'big/sub/f.txt': 'x',
  'surrogate/package.json': '{"name":"a\\ud800b","version":"1","pair":"\\ud83d\\ude00","7":1,"b":2,"3":3}',
  'surrogate/sub/f.txt': 'x',
};
for (const [file, text] of Object.entries(tree)) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}
const rows = [{ fn: 'PACKAGE_FIELDS', args: [], result: PACKAGE_FIELDS }];
const dirs = ['a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/empty', 'a/empty/f', 'a/b/c/../..', 'a/./b/', 'a/missing/dir', 'deep/sub', 'big/sub', 'surrogate/sub'];
for (const dir of dirs) {
  const found = nearestPackage(join(root, dir));
  const result = found && { ...found, path: relative(root, found.path) };
  rows.push({ fn: 'nearestPackage', args: [dir], result });
}
// Outside any package: only meaningful where nothing above the temp dir has one.
const above = nearestPackage(root);
if (above !== null) throw new Error(`a package.json exists above ${root}: ${above.path}`);
rows.push({ fn: 'nearestPackage', args: ['z/y'], result: null });
rmSync(root, { recursive: true });

const out = fileURLToPath(new URL('../fixtures/package.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ tree, rows }, null, 2)}\n`);
console.log(`${rows.length} rows -> ${out}`);
