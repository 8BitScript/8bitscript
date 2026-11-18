// The stage-dump writer (stage-dump.mjs) and its wiring into `8bs build`
// (`--dump-stages`, EIGHTBS_DUMP_STAGES): canonical text, the values it must
// refuse, path tokens, a read-only walk, and dump trees that do not depend on
// where the project lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build, compile } from '../src/build.mjs';
import {
  ENV_NAME, canonicalJson, createStageDump, dumpStagesArg, hexDump, openDump, stageFile, stageText, tokenStem, tokenizePath,
} from '../src/stage-dump.mjs';

function capture(fn) {
  const out = process.stdout.write;
  const err = process.stderr.write;
  const text = [];
  process.stdout.write = (chunk) => { text.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { text.push(String(chunk)); return true; };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  }).then((result) => ({ result, text: text.join('') }));
}

const PROGRAM = [
  'let score: utinyint = 0;',
  'export function main(): void {',
  '    score += 1;',
  '    memory.write(0x8000, score);',
  '}',
  '',
].join('\n');

const RECURSIVE = [
  'function again(): void { again(); }',
  'export function main(): void { again(); }',
  '',
].join('\n');

/** Every file under `root` as `relative path -> text`, sorted. */
function treeOf(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const next = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, next);
      else out[next] = readFileSync(path, 'utf8');
    }
  };
  walk(root, '');
  return out;
}

async function project(dir, source = PROGRAM) {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'main.8bs'), source);
}

async function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

test('canonicalJson sorts keys ordinally, drops undefined, and writes empty containers compactly', () => {
  const text = canonicalJson({ b: 1, a: [], z: {}, 10: 'x', 9: 'y', gone: undefined, '\u{FF5E}': 1, '\u{1F600}': 2 });
  assert.equal(
    text,
    '{\n  "10": "x",\n  "9": "y",\n  "a": [],\n  "b": 1,\n  "z": {},\n  "\u{1F600}": 2,\n  "\u{FF5E}": 1\n}\n',
  );
});

test('canonicalJson writes Maps as objects, Sets as arrays, typed arrays as numbers, and a hole as null', () => {
  const value = { m: new Map([['b', 2], ['a', 1]]), s: new Set([3, 1, 2]), u: new Uint8Array([1, 255]), h: [undefined, null, true, false, 1.5] };
  assert.deepEqual(JSON.parse(canonicalJson(value)), { m: { a: 1, b: 2 }, s: [3, 1, 2], u: [1, 255], h: [null, null, true, false, 1.5] });
  assert.match(canonicalJson(value), /"a": 1,\n {4}"b": 2/);
});

test('canonicalJson refuses what it cannot write exactly, naming where', () => {
  const loop = { items: [] };
  loop.items.push({ back: loop });
  assert.throws(() => canonicalJson({ ir: loop }), /stage dump: cycle at \/ir\/items\/0\/back/);
  assert.throws(() => canonicalJson({ n: -0 }), /-0 is not allowed at \/n/);
  assert.throws(() => canonicalJson([NaN]), /NaN is not a finite number at \/0/);
  assert.throws(() => canonicalJson({ n: Infinity }), /Infinity is not a finite number/);
  assert.throws(() => canonicalJson({ f() {} }), /a function cannot be written at \/f/);
  assert.throws(() => canonicalJson(1n), /a bigint cannot be written/);
  assert.throws(() => canonicalJson(new Map([[1, 2]])), /Map key of type number/);
  assert.throws(() => canonicalJson({ 'a/b': new Map([[1, 2]]) }), /at \/a~1b/);
});

test('a value shared twice (not a cycle) is written twice', () => {
  const shared = { k: 1 };
  assert.deepEqual(JSON.parse(canonicalJson([shared, shared])), [{ k: 1 }, { k: 1 }]);
});

test('the walk is read-only: a frozen value is written and comes out unchanged', () => {
  const value = Object.freeze({
    list: Object.freeze([Object.freeze({ b: 2, a: 1 }), 3]),
    bytes: Object.freeze([2, 1]),
    map: new Map([['z', 1], ['y', 2]]),
  });
  const before = JSON.stringify(value) + JSON.stringify([...value.map]);
  const text = canonicalJson(value);
  assert.equal(JSON.stringify(value) + JSON.stringify([...value.map]), before);
  assert.deepEqual([...value.map.keys()], ['z', 'y']);
  assert.ok(text.indexOf('"a": 1') < text.indexOf('"b": 2'));
});

test('tokenizePath replaces a whole-segment root, the toolchain first, and leaves other paths alone', () => {
  const roots = { toolchain: ['/r/tc'], project: ['/r/pj', '/real/pj'] };
  assert.equal(tokenizePath('/r/tc/packages/x', roots), '<toolchain>/packages/x');
  assert.equal(tokenizePath('/r/pj', roots), '<project>');
  assert.equal(tokenizePath('/real/pj/src/a.8bs', roots), '<project>/src/a.8bs');
  assert.equal(tokenizePath('/r/tcx/y', roots), '/r/tcx/y');
  assert.equal(tokenizePath('plain text', roots), 'plain text');
  assert.equal(tokenizePath('/anything', {}), '/anything');
  assert.equal(tokenStem('/r/tc/packages/c64/src/index.8bs', roots), 'toolchain/packages/c64/src/index.8bs');
  assert.equal(tokenStem('/r/pj/src/main.8bs', roots), 'project/src/main.8bs');
  assert.equal(tokenStem('/elsewhere/a.8bs', roots), 'external/elsewhere/a.8bs');
});

test('paths inside values are tokenized too', () => {
  const text = canonicalJson({ file: '/r/pj/src/main.8bs', note: 'in /r/pj/src' }, { project: '/r/pj' });
  assert.deepEqual(JSON.parse(text), { file: '<project>/src/main.8bs', note: 'in /r/pj/src' });
});

test('hexDump is lowercase, sixteen bytes a line, empty for no bytes', () => {
  assert.equal(hexDump(new Uint8Array(0)), '');
  assert.equal(hexDump(Uint8Array.from({ length: 17 }, (_, i) => i * 15)), '00 0f 1e 2d 3c 4b 5a 69 78 87 96 a5 b4 c3 d2 e1\nf0\n');
});

test('stageFile and stageText map each stage, and refuse an unknown stage or a module without its path', () => {
  const roots = { toolchain: '/r/tc' };
  assert.equal(stageFile('tokens', '/r/tc/a.8bs', roots), 'modules/toolchain/a.8bs.tokens.json');
  assert.equal(stageFile('ast', '/r/tc/a.8bs', roots), 'modules/toolchain/a.8bs.ast.json');
  assert.equal(stageFile('module-ir', '/r/tc/a.8bs', roots), 'modules/toolchain/a.8bs.ir.json');
  assert.equal(stageFile('linked-ir'), 'linked.json');
  assert.equal(stageFile('bytes'), 'bytes.hex');
  assert.equal(stageFile('error'), 'error.txt');
  assert.throws(() => stageFile('tokens'), /needs the module path/);
  assert.throws(() => stageFile('nope'), /unknown stage 'nope'/);
  assert.equal(stageText('bytes', [1, 2], roots), '01 02\n');
  assert.equal(stageText('error', 'boom\n', roots), 'boom\n');
  assert.equal(stageText('link', { a: 1 }, roots), '{\n  "a": 1\n}\n');
});

test('createStageDump keeps text, not the value: a later change does not reach the files', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-dump-'));
  try {
    const writer = createStageDump({});
    const value = { n: 1 };
    writer.dump('link', value);
    writer.dump('link', value);
    writer.dump('bytes', new Uint8Array([7]));
    value.n = 2;
    assert.equal(writer.flush(dir, { target: 'pet', machine: 'pet', program: 'p' }), 3);
    assert.equal(readFileSync(join(dir, 'link.json'), 'utf8'), '{\n  "n": 1\n}\n');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), {
      target: 'pet', machine: 'pet', program: 'p', locale: null, stages: ['link', 'bytes'],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dumpStagesArg reads the flag, lets it win over the environment, and refuses a missing directory', () => {
  assert.deepEqual(dumpStagesArg(['--target', 'pet'], {}), { ok: true, dir: undefined, consumed: [] });
  assert.deepEqual(dumpStagesArg([], { [ENV_NAME]: '/env' }), { ok: true, dir: '/env', consumed: [] });
  assert.deepEqual(dumpStagesArg(['a', '--dump-stages', '/flag'], { [ENV_NAME]: '/env' }), { ok: true, dir: '/flag', consumed: [1, 2] });
  assert.equal(dumpStagesArg(['--dump-stages'], {}).ok, false);
  assert.equal(dumpStagesArg(['--dump-stages', '--size'], {}).ok, false);
});

test('openDump puts a release output in its own directory, falling back to program and target', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-dump-'));
  try {
    const named = openDump({ dir, perOutput: true }, {});
    named.dump('link', {});
    named.note({ program: 'game', output: '/x/dist/game-pet.prg' });
    named.finish('pet');
    const unnamed = openDump({ dir, perOutput: true }, {});
    unnamed.dump('error', 'x\n');
    unnamed.finish('c64');
    assert.ok(existsSync(join(dir, 'game-pet.prg', 'link.json')));
    assert.ok(existsSync(join(dir, 'program-c64', 'error.txt')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the same project from two paths gives identical dump trees', async () => {
  const base = await mkdtemp(join(tmpdir(), '8bs-dump-'));
  try {
    const trees = [];
    for (const name of ['one', join('deeper', 'two')]) {
      const dir = join(base, name);
      await project(dir);
      const out = join(base, `out-${trees.length}`);
      const { result, text } = await inDir(dir, () => capture(() => compile('pet', undefined, { dumpStages: out })));
      assert.equal(result.ok, true, text);
      trees.push(treeOf(out));
    }
    assert.deepEqual(trees[0], trees[1]);
    const files = Object.keys(trees[0]);
    for (const wanted of ['bytes.hex', 'link.json', 'backend-input.json', 'linked.json', 'diagnostics.json', 'manifest.json', 'modules/project/src/main.8bs.tokens.json', 'modules/project/src/main.8bs.ast.json', 'modules/project/src/main.8bs.ir.json']) {
      assert.ok(files.includes(wanted), `${wanted} in ${files.join(', ')}`);
    }
    const manifest = JSON.parse(trees[0]['manifest.json']);
    assert.equal(manifest.target, 'pet');
    assert.deepEqual(manifest.stages.slice(0, 2), ['tokens', 'ast']);
    assert.ok(!JSON.stringify(trees[0]).includes(base), 'no checkout or temp path leaks into a dump');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a build with dumps on writes the same bytes as one with dumps off, on both backends', async () => {
  const base = await mkdtemp(join(tmpdir(), '8bs-dump-'));
  try {
    const dir = await mkdtemp(join(base, 'p-'));
    await project(dir);
    for (const target of ['pet', 'c64', 'web']) {
      const off = await inDir(dir, async () => {
        const run = await capture(() => compile(target, undefined, {}));
        assert.equal(run.result.ok, true, run.text);
        return readFile(run.result.outFile);
      });
      const out = join(base, `on-${target}`);
      const on = await inDir(dir, async () => {
        const run = await capture(() => compile(target, undefined, { dumpStages: out }));
        assert.equal(run.result.ok, true, run.text);
        return readFile(run.result.outFile);
      });
      assert.deepEqual(on, off, target);
      assert.equal(treeOf(out)['bytes.hex'].replaceAll(/\s/g, ''), Buffer.from(on).toString('hex'), `${target} bytes.hex`);
    }
    assert.ok(existsSync(join(base, 'on-web', 'wasm-input.json')));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('--dump-stages and the environment variable select the directory, and the flag wins', async () => {
  const base = await mkdtemp(join(tmpdir(), '8bs-dump-'));
  const saved = process.env[ENV_NAME];
  try {
    const dir = join(base, 'p');
    await project(dir);
    process.env[ENV_NAME] = join(base, 'env');
    const viaEnv = await inDir(dir, () => capture(() => build(['--target', 'pet'])));
    assert.equal(viaEnv.result, 0, viaEnv.text);
    assert.ok(existsSync(join(base, 'env', 'manifest.json')));
    const viaFlag = await inDir(dir, () => capture(() => build(['--target', 'pet', '--dump-stages', join(base, 'flag')])));
    assert.equal(viaFlag.result, 0, viaFlag.text);
    assert.ok(existsSync(join(base, 'flag', 'manifest.json')));
    assert.equal(statSync(join(base, 'env', 'manifest.json')).isFile(), true);
    delete process.env[ENV_NAME];
    const missing = await capture(() => build(['--target', 'pet', '--dump-stages']));
    assert.equal(missing.result, 2);
    assert.match(missing.text, /--dump-stages expects a directory/);
  } finally {
    if (saved === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = saved;
    await rm(base, { recursive: true, force: true });
  }
});

test('a failed build still dumps its diagnostics and the error text', async () => {
  const base = await mkdtemp(join(tmpdir(), '8bs-dump-'));
  try {
    const dir = join(base, 'p');
    await project(dir, RECURSIVE);
    const out = join(base, 'out');
    const { result } = await inDir(dir, () => capture(() => compile('pet', undefined, { dumpStages: out })));
    assert.equal(result.ok, false);
    const tree = treeOf(out);
    assert.match(tree['error.txt'], /recursion isn't lowered yet/);
    assert.ok(tree['error.txt'].endsWith('\n'));
    assert.ok('diagnostics.json' in tree);
    assert.ok(!('bytes.hex' in tree));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a dump that cannot be written does not hide the error the build threw', async () => {
  const base = await mkdtemp(join(tmpdir(), '8bs-dump-'));
  try {
    const dir = join(base, 'p');
    await project(dir);
    const blocker = join(base, 'blocker');
    await writeFile(blocker, 'a file, so nothing can be created under it');
    const own = await inDir(dir, () => capture(() => compile('pet', undefined, { hardware: null }).catch((err) => err)));
    assert.ok(own.result instanceof Error, 'the options must make the build throw');
    const dumped = await inDir(dir, () => capture(() => compile('pet', undefined, { hardware: null, dumpStages: join(blocker, 'out') }).catch((err) => err)));
    assert.equal(dumped.result.message, own.result.message);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('--release gives each output its own directory under the dump directory', async () => {
  const base = await mkdtemp(join(tmpdir(), '8bs-dump-'));
  try {
    const dir = join(base, 'p');
    await project(dir);
    await writeFile(join(dir, '8bitscript.config.8bs'), 'export default { entry: "src/main.8bs", targets: { pet: { hardware: { model: "4032", ram: "32" }, release: ["2001", {}] }, web: {} } };\n');
    const out = join(base, 'out');
    const { result, text } = await inDir(dir, () => capture(() => build(['--release', '--dump-stages', out])));
    assert.equal(result, 0, text);
    assert.deepEqual(readdirSync(out).sort(), ['main-pet-4032-32.prg', 'main-pet.prg', 'main.wasm']);
    for (const name of readdirSync(out)) assert.ok(existsSync(join(out, name, 'manifest.json')), name);
    assert.equal(JSON.parse(readFileSync(join(out, 'main.wasm', 'manifest.json'), 'utf8')).target, 'web');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
