// The published npm package must be runnable JavaScript. In the workspace,
// `./mos` and `./wasm` resolve to TypeScript that Node type-strips on load —
// but Node refuses to strip types for anything under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a consumer installing
// from npm needs real .js there. prepack (tsconfig.publish.json) emits the
// stripped backends next to their sources and publishConfig.exports points
// the published manifest at them. This test packs the real tarball the way
// a release does and imports the backends out of it — exactly what broke
// for every 0.2.x consumer before this existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
};

test('the packed tarball ships importable JavaScript backends', async () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-pack-'));
  try {
    // Pack for real: this runs prepack, so the emit + manifest rewrite are
    // exercised as a release would, not simulated.
    run('pnpm', ['pack', '--pack-destination', dir], PACKAGE_DIR);
    const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz'));
    assert.ok(tarball, `no tarball in ${dir}`);
    run('tar', ['-xzf', tarball], dir);
    const packed = join(dir, 'package');

    // Every export of the published manifest must point at a file that is in
    // the tarball, and none of them may be TypeScript.
    const manifest = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
    for (const [key, target] of Object.entries(manifest.exports)) {
      assert.ok(!target.endsWith('.ts'), `published export '${key}' still points at TypeScript: ${target}`);
      assert.ok(existsSync(join(packed, target)), `published export '${key}' points at a missing file: ${target}`);
    }
    assert.equal(manifest.exports['./mos'], './src/mos/index.js');
    assert.equal(manifest.exports['./wasm'], './src/wasm/index.js');

    // The stripped backends must actually load from inside the package —
    // this fails if any relative `.ts` specifier survived the rewrite.
    const mos = await import(pathToFileURL(join(packed, 'src/mos/index.js')));
    assert.equal(typeof mos.build, 'function');
    assert.ok(mos.CPU.pet, 'mos CPU table lost in stripping');
    const wasm = await import(pathToFileURL(join(packed, 'src/wasm/index.js')));
    assert.equal(typeof wasm.build, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
