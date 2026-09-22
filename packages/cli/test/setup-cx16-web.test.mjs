// The pinned WebAssembly x16emu behind `8bs run cx16 --web`, with the
// network and the disk faked: nothing is fetched when every file is
// already there, a download that fails or does not match the pin writes
// nothing, and a good archive is unpacked file by file into the cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  X16EMU_WASM_RELEASE, ensureX16emuWasm, inspectX16emuWasm, sha256Hex,
} from '../src/setup/cx16-web.mjs';
import { x16emuWasmDir } from '../src/setup/paths.mjs';

/** A stored (method 0) zip of `entries` — the layout the reader in
 * setup/zip.mjs understands; CRCs are left at 0 since it never checks them. */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

const FULL = [
  { name: 'webassembly/main.js', content: 'upstream loader, not served' },
  { name: 'x16emu.html', content: '<html>' },
  { name: 'x16emu.js', content: 'var Module;' },
  { name: 'x16emu.wasm', content: '\0asm' },
  { name: 'x16emu.data', content: 'rom' },
];

/** A world with `have` already on disk, a fetch that answers `zip`, and a
 * record of every write. */
function world({ have = [], zip = null, status = 200, fetchThrows = null } = {}) {
  const written = new Map();
  const dirs = [];
  const lines = [];
  let fetched = 0;
  const io = {
    dir: '/cache/x16emu-wasm/r49',
    exists: async (p) => have.includes(p) || written.has(p),
    fetchImpl: async () => {
      fetched += 1;
      if (fetchThrows) throw fetchThrows;
      return { ok: status === 200, status, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
    },
    mkdirFn: async (p) => { dirs.push(p); },
    writeFileFn: async (p, bytes) => { written.set(p, Buffer.from(bytes)); },
    report: (line) => lines.push(line),
  };
  return { io, written, dirs, lines, fetched: () => fetched };
}

const pinned = (zip) => ({ ...X16EMU_WASM_RELEASE, sha256: sha256Hex(zip) });

test('the pin names one release by tag, URL and SHA-256, and the three files the page loads', () => {
  assert.equal(X16EMU_WASM_RELEASE.tag, 'r49');
  assert.match(X16EMU_WASM_RELEASE.url, /^https:\/\/github\.com\/X16Community\/x16-emulator\/releases\/download\/r49\/x16emu_wasm-r49\.zip$/);
  assert.match(X16EMU_WASM_RELEASE.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([...X16EMU_WASM_RELEASE.files], ['x16emu.js', 'x16emu.wasm', 'x16emu.data']);
  assert.match(x16emuWasmDir('r49'), /8bitscript\/setup\/x16emu-wasm\/r49$/);
});

test('inspect lists what is missing from the release directory', async () => {
  const { io } = world({ have: ['/cache/x16emu-wasm/r49/x16emu.js'] });
  const state = await inspectX16emuWasm({ dir: io.dir, exists: io.exists });
  assert.equal(state.present, false);
  assert.deepEqual(state.missing, ['x16emu.wasm', 'x16emu.data']);
  assert.equal(state.dir, io.dir);
});

test('ensure leaves a complete directory alone without a request', async () => {
  const w = world({ have: X16EMU_WASM_RELEASE.files.map((f) => `/cache/x16emu-wasm/r49/${f}`) });
  const result = await ensureX16emuWasm(w.io);
  assert.deepEqual(result, { ok: true, dir: w.io.dir, downloaded: false });
  assert.equal(w.fetched(), 0);
  assert.equal(w.written.size, 0);
});

test('ensure downloads, checks the pin, and unpacks only the files the page loads', async () => {
  const zip = storedZip(FULL);
  const w = world({ zip });
  const result = await ensureX16emuWasm({ ...w.io, release: pinned(zip) });
  assert.deepEqual(result, { ok: true, dir: w.io.dir, downloaded: true });
  assert.equal(w.fetched(), 1);
  assert.deepEqual([...w.written.keys()].sort(), [
    '/cache/x16emu-wasm/r49/x16emu.data', '/cache/x16emu-wasm/r49/x16emu.js', '/cache/x16emu-wasm/r49/x16emu.wasm',
  ]);
  assert.equal(w.written.get('/cache/x16emu-wasm/r49/x16emu.js').toString(), 'var Module;');
  assert.ok(w.dirs.every((d) => d === w.io.dir), 'every file lands in the release directory');
  assert.match(w.lines[0], /downloading x16emu r49 \(WebAssembly\) from https:\/\//);
  assert.match(w.lines[1], /unpacked x16emu r49 into \/cache\/x16emu-wasm\/r49/);
});

test('ensure re-downloads a half-unpacked directory rather than trusting it', async () => {
  const zip = storedZip(FULL);
  const w = world({ zip, have: ['/cache/x16emu-wasm/r49/x16emu.js'] });
  const result = await ensureX16emuWasm({ ...w.io, release: pinned(zip) });
  assert.equal(result.ok, true);
  assert.equal(result.downloaded, true);
  assert.equal(w.written.size, 3);
});

test('ensure writes nothing when the archive does not match the pinned SHA-256', async () => {
  const zip = storedZip(FULL);
  const w = world({ zip });
  const result = await ensureX16emuWasm(w.io); // the real pin, not this zip's digest
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match the pinned SHA-256 \(got [0-9a-f]{64}\); nothing was written/);
  assert.equal(w.written.size, 0);
});

test('ensure reports a download that fails, by HTTP status or by not connecting', async () => {
  const gone = world({ zip: storedZip(FULL), status: 404 });
  const notFound = await ensureX16emuWasm(gone.io);
  assert.equal(notFound.ok, false);
  assert.match(notFound.error, /failed \(HTTP 404\)/);
  assert.match(notFound.error, /packages\/cli\/src\/setup\/cx16-web\.mjs/);

  const offline = world({ fetchThrows: new Error('getaddrinfo ENOTFOUND github.com') });
  const failed = await ensureX16emuWasm(offline.io);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /could not download .*ENOTFOUND/);
  assert.equal(offline.written.size, 0);
});

test('ensure names the files a re-laid-out archive no longer has, and refuses a non-zip', async () => {
  const partial = storedZip(FULL.filter((e) => e.name !== 'x16emu.data'));
  const w = world({ zip: partial });
  const result = await ensureX16emuWasm({ ...w.io, release: pinned(partial) });
  assert.equal(result.ok, false);
  assert.match(result.error, /has no x16emu\.data/);
  assert.equal(w.written.size, 0);

  const junk = Buffer.from('definitely not a zip archive, just text');
  const j = world({ zip: junk });
  const notZip = await ensureX16emuWasm({ ...j.io, release: pinned(junk) });
  assert.equal(notZip.ok, false);
  assert.match(notZip.error, /not a zip/);
});
