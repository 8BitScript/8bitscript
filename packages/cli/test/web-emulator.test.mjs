// `8bs run cx16 --web`'s page and server: the argv is the native one with
// the .prg renamed, the page carries it to Emscripten's Module, the server
// answers exactly the page's five URLs from loopback, and the run wrapper
// wires ensure → serve → last-run → browser, refusing targets with no
// WebAssembly emulator before any of that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROGRAM_NAME, WEB_EMULATORS, renderEmulatorPage, runInWebEmulator, serveWebEmulator, webEmulatorArgs,
} from '../src/web-emulator.mjs';

function capture(fn) {
  const stdout = [];
  const stderr = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  }).then((result) => ({ result, stdout: stdout.join(''), stderr: stderr.join('') }));
}

test('only the X16 has a WebAssembly emulator, and its argv is the native one with the .prg renamed', () => {
  assert.deepEqual(Object.keys(WEB_EMULATORS), ['cx16']);
  assert.equal(WEB_EMULATORS.cx16.tag, 'r49');
  const native = ['-capture', '-ram', '512', '-joy1', '-prg', '/p/dist/main-cx16.prg', '-run'];
  assert.deepEqual(webEmulatorArgs(native, '/p/dist/main-cx16.prg'), ['-capture', '-ram', '512', '-joy1', '-prg', PROGRAM_NAME, '-run']);
});

test('the page hands Emscripten that argv, preloads the program, and keeps keys on the canvas', () => {
  const page = renderEmulatorPage({ args: ['-ram', '512', '-prg', PROGRAM_NAME, '-run', '</script><b>'], title: 'main-cx16.prg — Commander X16' });
  assert.match(page, /<title>main-cx16\.prg — Commander X16<\/title>/);
  assert.match(page, /<canvas id="canvas" tabindex="1"/);
  assert.match(page, /<div id="status">Loading x16emu r49…<\/div>/);
  assert.match(page, /arguments: \["-ram","512","-prg","program\.prg","-run","\\u003c\/script>\\u003cb>"\]/, 'the argv, with < escaped so it cannot end the script');
  assert.match(page, /ENV\.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT = '#canvas'/);
  assert.match(page, /FS\.createPreloadedFile\('\/', "program\.prg", "program\.prg", true, true\)/);
  assert.match(page, /onRuntimeInitialized: function \(\) \{ loading\.hidden = true; canvas\.focus\(\); \}/);
  assert.match(page, /<script async src="x16emu\.js"><\/script>/);
  assert.doesNotMatch(page, /var status\b/, 'window.status is a string; the overlay needs another name');
  assert.match(page, /click the screen to give it the mouse · Esc gives it back/);
  // A framing page (the editor's Studio tab) is told about pointer lock,
  // which it cannot observe across origins itself.
  assert.match(page, /source: '8bs-x16emu', type: 'pointerlock', locked: locked, error: error \|\| null/);
  assert.match(page, /document\.addEventListener\('pointerlockchange'/);
  assert.match(page, /document\.addEventListener\('pointerlockerror'/);
});

test('the server answers the page, the program and the three emulator files, and nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-x16emu-wasm-'));
  try {
    await writeFile(join(dir, 'x16emu.js'), 'var Module;');
    await writeFile(join(dir, 'x16emu.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
    // x16emu.data deliberately absent: a file the release dir lost is a 404, not a crash.
    const serving = await serveWebEmulator({ dir, programBytes: Buffer.from([1, 8, 9]), args: ['-prg', PROGRAM_NAME, '-run'], title: 'T' });
    assert.ok(!serving.error, serving.error);
    assert.match(serving.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.match(serving.banner, /serving http:\/\/127\.0\.0\.1/);
    try {
      const get = async (path) => {
        const res = await fetch(new URL(path, serving.url));
        return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), body: Buffer.from(await res.arrayBuffer()) };
      };
      const page = await get('/');
      assert.equal(page.status, 200);
      assert.equal(page.type, 'text/html; charset=utf-8');
      assert.equal(page.cache, 'no-store');
      assert.match(page.body.toString(), /<title>T<\/title>/);
      assert.equal((await get('/index.html')).status, 200);
      const prg = await get(`/${PROGRAM_NAME}`);
      assert.equal(prg.status, 200);
      assert.equal(prg.cache, 'no-store', 'a rebuilt program must not come from the browser cache');
      assert.deepEqual([...prg.body], [1, 8, 9]);
      const wasm = await get('/x16emu.wasm');
      assert.equal(wasm.type, 'application/wasm', 'so the browser can compile it streaming');
      assert.deepEqual([...wasm.body], [0, 0x61, 0x73, 0x6d]);
      assert.equal((await get('/x16emu.js')).type, 'text/javascript; charset=utf-8');
      assert.equal((await get('/x16emu.data')).status, 404);
      assert.equal((await get('/webassembly/main.js')).status, 404, 'upstream loader is not served');
      assert.equal((await get('/../etc/passwd')).status, 404);
      assert.equal((await get('/favicon.ico')).status, 204);
    } finally {
      await serving.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a port already in use is reported, not thrown', async () => {
  const first = await serveWebEmulator({ dir: '/nowhere', programBytes: Buffer.alloc(0), args: [] });
  try {
    const port = Number(new URL(first.url).port);
    const second = await serveWebEmulator({ dir: '/nowhere', programBytes: Buffer.alloc(0), args: [], port });
    assert.match(second.error, /already in use/);
  } finally {
    await first.close();
  }
});

/** The run wrapper with every side effect faked. */
function fakes({ ensureOk = true, serveError = null } = {}) {
  const calls = { ensure: [], serve: [], opened: [], lastRun: [], closed: 0 };
  return {
    calls,
    io: {
      ensure: async (opts) => { calls.ensure.push(opts); return ensureOk ? { ok: true, dir: '/cache/r49', downloaded: false } : { ok: false, error: 'no network' }; },
      serve: async (opts) => {
        calls.serve.push(opts);
        if (serveError) return { error: serveError };
        return { url: 'http://127.0.0.1:4321/', banner: 'serving http://127.0.0.1:4321/\n', close: async () => { calls.closed += 1; } };
      },
      openUrl: (url) => calls.opened.push(url),
      writeLastRun: async (target, patch) => calls.lastRun.push({ target, patch }),
      wait: async (close) => { await close(); return 0; },
    },
  };
}

test('runInWebEmulator refuses a target with no WebAssembly emulator before touching anything', async () => {
  const { calls, io } = fakes();
  const { result, stderr } = await capture(() => runInWebEmulator({ target: 'pet', outFile: '/p/dist/main-pet.prg', emulatorArgs: [], ...io }));
  assert.equal(result, 2);
  assert.match(stderr, /only the Commander X16 has one \(cx16\); 'pet' does not yet/);
  assert.equal(calls.ensure.length, 0);
});

test('runInWebEmulator: ensure → serve → last-run → browser → wait, with the argv renamed', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-run-'));
  try {
    const outFile = join(dir, 'main-cx16.prg');
    await writeFile(outFile, Buffer.from([1, 8]));
    const { calls, io } = fakes();
    const { result, stdout, stderr } = await capture(() => runInWebEmulator({
      target: 'cx16', outFile, emulatorArgs: ['-capture', '-prg', outFile, '-run'], port: 4321, ...io,
    }));
    assert.equal(result, 0);
    assert.equal(stderr, '');
    assert.equal(calls.ensure[0].release.tag, 'r49');
    assert.equal(calls.serve[0].dir, '/cache/r49');
    assert.deepEqual([...calls.serve[0].programBytes], [1, 8]);
    assert.deepEqual(calls.serve[0].args, ['-capture', '-prg', PROGRAM_NAME, '-run']);
    assert.equal(calls.serve[0].port, 4321);
    assert.equal(calls.serve[0].title, 'main-cx16.prg — Commander X16');
    assert.deepEqual(calls.lastRun, [{ target: 'cx16', patch: { emulator: 'x16emu r49 (WebAssembly)', url: 'http://127.0.0.1:4321/', lanUrls: [] } }]);
    assert.deepEqual(calls.opened, ['http://127.0.0.1:4321/']);
    assert.equal(calls.closed, 1);
    assert.match(stdout, /serving http:\/\/127\.0\.0\.1:4321\//);
    assert.match(stdout, /click the screen to give it the mouse; Esc gives it back/);

    // --no-open: everything but the browser.
    const quiet = fakes();
    await capture(() => runInWebEmulator({ target: 'cx16', outFile, emulatorArgs: ['-prg', outFile, '-run'], open: false, ...quiet.io }));
    assert.deepEqual(quiet.calls.opened, []);
    assert.equal(quiet.calls.lastRun.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runInWebEmulator reports a failed download or a taken port as exit 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-run-'));
  try {
    const outFile = join(dir, 'main-cx16.prg');
    await writeFile(outFile, Buffer.alloc(1));
    const noNet = fakes({ ensureOk: false });
    const first = await capture(() => runInWebEmulator({ target: 'cx16', outFile, emulatorArgs: [], ...noNet.io }));
    assert.equal(first.result, 1);
    assert.match(first.stderr, /8bs run: no network/);
    assert.equal(noNet.calls.serve.length, 0);

    const taken = fakes({ serveError: 'port 4321 is already in use. Stop the other 8bs run, or pass --port <n>.' });
    const second = await capture(() => runInWebEmulator({ target: 'cx16', outFile, emulatorArgs: [], ...taken.io }));
    assert.equal(second.result, 1);
    assert.match(second.stderr, /port 4321 is already in use/);
    assert.equal(taken.calls.lastRun.length, 0);
    assert.equal(taken.calls.opened.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
