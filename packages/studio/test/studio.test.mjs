// Studio ships with the toolchain: version alignment, release-target builds,
// and a web smoke test for the bare bar and mark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { link } from '../../compiler/index.mjs';
import { loadCatalog, resolveHardware, stockFacts } from '../../cli/src/hardware.mjs';
import { instantiateProgram, FrameLimitReached } from '../../cli/src/wasm-host.mjs';
import { layoutFromHardware } from '../../cli/src/web-layout.mjs';
import { loadConfig } from '../../cli/src/config.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');
const ENTRY = join(SRC, 'main.8bs');
const BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');

const RELEASE_TARGETS = ['cx16', 'c64', 'vic20', 'pet', 'web'];

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const cli = JSON.parse(readFileSync(join(ROOT, '..', 'cli', 'package.json'), 'utf8'));

test('Studio declares itself an app, with a title and the shared entry', () => {
  assert.equal(pkg['8bitscript'].app.title, 'Studio');
  assert.equal(pkg['8bitscript'].app.entry, './src/main.8bs');
  assert.ok(existsSync(join(ROOT, '8bitscript.config.8bs')), 'an app is a project: it has the manifest the CLI reads');
});

test("Studio's version is the toolchain's version", () => {
  assert.equal(pkg.version, cli.version, '@8bitscript/studio and @8bitscript/cli share one version');
});

test('the CLI depends on Studio, so it ships with the toolchain', () => {
  assert.equal(cli.dependencies['@8bitscript/studio'], 'workspace:*');
});

test('Studio has one entry file: no main.<target>.8bs variants', () => {
  for (const target of RELEASE_TARGETS) {
    assert.ok(!existsSync(join(SRC, `main.${target}.8bs`)), target);
  }
});

test('the four pillars are present as source modules', () => {
  assert.ok(existsSync(join(SRC, 'Bar.8bx')));
  assert.ok(existsSync(join(SRC, 'mark.8bg')));
  assert.ok(existsSync(join(SRC, 'mark.png')));
  assert.ok(existsSync(join(SRC, 'chime.8ba')));
  assert.ok(existsSync(join(SRC, 'chime.wav')));
  const studio = readFileSync(join(SRC, 'studio.8bs'), 'utf8');
  assert.match(studio, /from "\.\/Bar\.8bx"/);
  assert.match(studio, /from "\.\/mark\.8bg"/);
  assert.match(studio, /from "\.\/chime\.8ba"/);
  assert.doesNotMatch(studio, /from "@8bitscript\/ui\/menu"/);
  assert.doesNotMatch(studio, /@8bitscript\/input/);
});

for (const target of RELEASE_TARGETS) {
  test(`Studio links clean for ${target}`, () => {
    const facts = target === 'vic20'
      ? resolveHardware(loadCatalog('vic20'), { hardware: { ram: '8k' } }).hardware.facts
      : target === 'pet'
        ? resolveHardware(loadCatalog('pet'), { hardware: { model: '4032', ram: '32' } }).hardware.facts
        : stockFacts(target);
    const { ir, diagnostics } = link(readFileSync(ENTRY, 'utf8'), ENTRY, { machine: target, facts });
    assert.deepEqual(diagnostics.filter((d) => d.severity !== 'warning'), []);
    assert.equal(ir.entry, 'main');
  });
}

test('release config matches shared-release-targets and names the X16 baseline', () => {
  const config = readFileSync(join(ROOT, '8bitscript.config.8bs'), 'utf8');
  assert.match(config, /shared-release-targets/);
  assert.match(config, /^  baseline: 'cx16',$/m);
  assert.match(config, /^  input: \{ primary: 'mouse', also: \['keyboard', 'stick', 'pad'\] \},$/m);
  assert.match(config, /targets: \{ \.\.\.releaseTargets \}/);
  assert.match(config, /^    'Commander X16': \{ target: 'cx16' \},$/m);
});

// An npm install puts Studio and the examples inside node_modules, where only
// what `files` lists arrives and Node will not strip types. Copy each package
// the way a pack would and load the configs from there: Studio's must be in
// the tarball, and its targets and every example's must still resolve.
test('Studio and the examples load their configs from an installed copy', async () => {
  assert.ok(pkg.files.includes('8bitscript.config.8bs'), 'Studio ships its config');
  const root = mkdtempSync(join(tmpdir(), '8bs-installed-'));
  try {
    const scope = join(root, 'node_modules', '@8bitscript');
    for (const name of ['studio', 'examples']) {
      const from = join(ROOT, '..', name);
      const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'));
      mkdirSync(join(scope, name), { recursive: true });
      cpSync(join(from, 'package.json'), join(scope, name, 'package.json'));
      for (const entry of manifest.files) cpSync(join(from, entry), join(scope, name, entry), { recursive: true });
    }
    const examples = JSON.parse(readFileSync(join(scope, 'examples', 'package.json'), 'utf8'))['8bitscript'].examples;
    const dirs = [join(scope, 'studio'), ...Object.values(examples).map((e) => join(scope, 'examples', e.dir))];
    for (const dir of dirs) {
      const config = await loadConfig(dir);
      assert.deepEqual(Object.keys(config?.targets ?? {}).sort(), [...RELEASE_TARGETS].sort(), dir);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** `8bs build --target <target>` in Studio's own directory. */
async function buildStudio(target) {
  const { stdout } = await run(process.execPath, [BIN, 'build', '--target', target], { cwd: ROOT });
  const built = stdout.match(/^built (.+)$/m);
  assert.ok(built, stdout);
  return built[1];
}

for (const target of RELEASE_TARGETS) {
  test(`Studio builds for ${target}, from its own config`, async () => {
    const outFile = await buildStudio(target);
    assert.ok(existsSync(outFile), outFile);
  });
}

test('the web shell shows a blank top bar and keeps running', async () => {
  const wasm = readFileSync(await buildStudio('web'));
  const layout = layoutFromHardware(resolveHardware(loadCatalog('web'), {}).hardware);
  const total = 30;
  let frame = 0;
  let mem;
  const program = await instantiateProgram(wasm, {
    waitFrame: () => {
      frame += 1;
      if (frame > total) throw new FrameLimitReached(total);
    },
  });
  mem = new Uint8Array(program.memory.buffer);
  let returned = true;
  try {
    program.entry();
  } catch (error) {
    if (!(error instanceof FrameLimitReached)) throw error;
    returned = false;
  }
  assert.equal(returned, false, 'the shell loops until stopped');

  let top = '';
  for (let c = 0; c < layout.cols; c += 1) {
    const code = mem[layout.charBase + c];
    top += code >= 32 && code < 127 ? String.fromCharCode(code) : '.';
  }
  assert.doesNotMatch(top, /FILE|STUDIO|CHARACTERS/);
  assert.ok(top[0] !== ' ', 'the mark.8bg glyph sits in the corner cell on web');
  assert.equal(mem[0], 6, 'border BLUE');
  assert.equal(mem[1], 0, 'background BLACK');
});
