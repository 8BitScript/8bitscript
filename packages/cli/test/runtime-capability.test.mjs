// `8bs targets --json` says, per machine, how it can be run: natively, as a
// wasm page, as the vendored real emulator in wasm, and booted bare. The
// editor builds its runtime buttons from that and keeps no table of its own,
// so the claim has to be true. The wasm claim is declared by each machine
// package (`emulator.wasm`) and held to a real build here: if the C64 gains
// a wasm port this fails until its package says so, and if a machine loses
// one the editor stops offering it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { RELEASE_MACHINES } from '@8bitscript/compiler';

import { describeTargets } from '../src/targets.mjs';

const exec = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/8bs.mjs', import.meta.url));
const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const byId = () => Object.fromEntries(describeTargets(null).map((t) => [t.id, t.runtime]));

test('every machine carries the four runtimes, each with an availability and a reason when not', () => {
  for (const [id, runtime] of Object.entries(byId())) {
    for (const kind of ['native', 'wasm', 'wasmEmulator', 'boot']) {
      assert.equal(typeof runtime[kind]?.available, 'boolean', `${id}.${kind}`);
      if (!runtime[kind].available) assert.equal(typeof runtime[kind].reason, 'string', `${id}.${kind} says why`);
    }
    assert.ok(runtime.native.installed === null || typeof runtime.native.installed === 'boolean', id);
  }
});

test('the release machines: native where there is an emulator, wasm where the package says so', () => {
  const runtime = byId();
  for (const id of ['pet', 'vic20', 'c64', 'cx16']) {
    assert.equal(runtime[id].native.available, true, id);
    assert.equal(runtime[id].boot.available, true, id);
    assert.equal(typeof runtime[id].native.emulator, 'string', id);
  }
  assert.equal(runtime.pet.native.emulator, 'xpet');
  assert.equal(runtime.c64.native.emulator, 'x64sc');
  assert.equal(runtime.cx16.native.emulator, 'x16emu');
  for (const id of ['pet', 'vic20', 'c64', 'cx16', 'web']) assert.equal(runtime[id].wasm.available, true, id);
});

test('the C64 runs in the browser as a model, and says in `limits` what the page does not model yet', () => {
  const { c64, web } = byId();
  assert.equal(c64.wasm.available, true);
  assert.equal(c64.wasm.reason, null);
  assert.ok(c64.wasm.limits.length > 0, 'a wasm C64 is text mode only today, and the editor shows why');
  assert.ok(c64.wasm.limits.some((line) => /sprites/.test(line)), 'sprites are not drawn');
  assert.ok(c64.wasm.limits.some((line) => /sound/.test(line)), 'there is no sound');
  assert.deepEqual(web.wasm.limits, [], 'the web target is the runtime itself: nothing is missing from it to show');
});

// docs/project/wasm-primary.md: a feature without a wasm path is a bug or a
// documented limit in the capability row. These are the gaps the audit and
// `8bs conform` found; a limit comes off this list when its test below does.
test('every machine whose wasm build has a known gap says so in `limits`, where the editor shows it', () => {
  const runtime = byId();
  const says = (id, pattern) => assert.ok(runtime[id].wasm.limits.some((line) => pattern.test(line)), `${id}: ${pattern}`);
  says('pet', /reverse video/);
  says('vic20', /reverse video/);
  for (const id of ['pet', 'vic20', 'cx16']) says(id, /graphics object|sprites/);
  says('vic20', /raster does not build/);
  says('cx16', /input does not build/); // the raster and the sprites are held in the X16's own test below
  for (const id of ['pet', 'vic20', 'c64', 'cx16']) says(id, /sound/);
});

test('the X16 runs in the browser on our own backend, and says what its flat model of VERA leaves out', () => {
  const { cx16 } = byId();
  assert.equal(cx16.wasm.available, true);
  assert.equal(cx16.wasm.reason, null);
  const limits = cx16.wasm.limits.join('\n');
  assert.match(limits, /sprites/, 'VERA sprites are not modelled: a picture is a glyph');
  assert.match(limits, /sound|8BS2211/, 'there is no audio driver');
  assert.match(limits, /raster/, 'the VERA raster list is machine code and does not build');
  assert.match(limits, /mouse/, 'the X16-only modules see nothing');
});

test('the real x16emu as WebAssembly is the X16\'s alone', () => {
  const runtime = byId();
  assert.equal(runtime.cx16.wasmEmulator.available, true);
  for (const id of ['pet', 'vic20', 'c64', 'web']) assert.equal(runtime[id].wasmEmulator.available, false, id);
});

test('the web has no native emulator and no bare machine to boot, and says so', () => {
  const { web } = byId();
  assert.equal(web.native.available, false);
  assert.equal(web.native.emulator, null);
  assert.equal(web.native.installed, null, 'nothing to look for');
  assert.match(web.native.reason, /runs in the browser/);
  assert.equal(web.boot.available, false);
  assert.equal(web.wasm.available, true);
});

test('a machine this release does not build is parked in every runtime, with that reason', () => {
  const runtime = byId();
  const parked = Object.keys(runtime).filter((id) => !RELEASE_MACHINES.includes(id));
  assert.ok(parked.length > 0);
  for (const id of parked) {
    for (const kind of ['native', 'wasm', 'wasmEmulator', 'boot']) {
      assert.equal(runtime[id][kind].available, false, `${id}.${kind}`);
    }
    assert.equal(runtime[id].native.reason, 'not built in this release', id);
    assert.equal(runtime[id].wasm.reason, 'not built in this release', id);
  }
});

test('8bs targets --json carries the runtime object on every machine', async () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-runtime-'));
  const { stdout } = await exec(process.execPath, [BIN, 'targets', '--json', '--checkout', CHECKOUT], { cwd: dir });
  const targets = JSON.parse(stdout).targets;
  assert.ok(targets.length > 5);
  for (const t of targets) assert.ok(t.runtime?.native && t.runtime.wasm && t.runtime.wasmEmulator && t.runtime.boot, t.id);
});

test('the declared wasm claim is the truth: each release machine builds through the wasm backend if and only if it says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-wasm-truth-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.8bs'), `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
export function main(): void {
    screen.blank();
    text.print(0, "HELLO");
    text.releaseCursor();
}
`);
  writeFileSync(join(dir, '8bitscript.config.8bs'), "export default { entry: 'src/main.8bs' };\n");
  const runtime = byId();
  for (const id of RELEASE_MACHINES) {
    let built = true;
    try {
      await exec(process.execPath, [BIN, 'build', '--target', id, '--web', '--checkout', CHECKOUT], { cwd: dir });
    } catch {
      built = false;
    }
    assert.equal(
      built, runtime[id].wasm.available,
      `${id}: the package says wasm.available is ${runtime[id].wasm.available}, but a build ${built ? 'succeeds' : 'fails'}`,
    );
  }
});
