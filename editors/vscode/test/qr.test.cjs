// Byte-mode QR used for a web run's LAN URL. No vscode; the launcher
// draws what qrSvg returns.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { BYTE_CAPACITY, formatBits, qrModules, qrSvg, sizeOf, versionFor } = require('../src/qr.cjs');

test('versionFor picks the smallest ECC-M version that can hold the bytes', () => {
  assert.equal(versionFor(0), 1);
  assert.equal(versionFor(BYTE_CAPACITY[1]), 1);
  assert.equal(versionFor(BYTE_CAPACITY[1] + 1), 2);
  assert.equal(versionFor(28), 3, 'https://192.168.1.20:54321/ is 28 bytes');
  assert.equal(versionFor(BYTE_CAPACITY[6]), 6);
  assert.equal(versionFor(BYTE_CAPACITY[6] + 1), 0);
});

test('formatBits for ECC-M mask 0 is the masked-zero value from the spec', () => {
  assert.equal(formatBits(0), 0x5412);
});

test('qrModules sizes a short payload, a typical LAN URL, and a two-block version 4', () => {
  assert.equal(qrModules('hi').length, sizeOf(1));
  assert.equal(qrModules('https://10.0.0.4:9/').length, sizeOf(2));
  assert.equal(qrModules('https://192.168.1.20:54321/').length, sizeOf(3));
  const long = `https://192.168.1.20:54321/${'a'.repeat(20)}`;
  assert.ok(long.length > BYTE_CAPACITY[3]);
  assert.equal(qrModules(long).length, sizeOf(4));
});

test('qrModules is a square of dark/light with three finder patterns and no holes', () => {
  const url = 'https://192.168.1.20:54321/';
  const modules = qrModules(url);
  assert.equal(modules.length, sizeOf(3));
  assert.equal(modules[0].length, modules.length);
  for (const row of modules) {
    assert.equal(row.length, modules.length);
    for (const cell of row) assert.ok(cell === 0 || cell === 1, 'every module is 0 or 1');
  }
  const finder = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ];
  const at = (row0, col0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        assert.equal(modules[row0 + r][col0 + c], finder[r][c], `finder ${row0},${col0} ${r},${c}`);
      }
    }
  };
  const n = modules.length;
  at(0, 0);
  at(0, n - 7);
  at(n - 7, 0);
  assert.equal(modules[n - 8][8], 1, 'the dark module');
});

test('qrModules is stable, and a different URL is a different matrix', () => {
  const a = 'https://192.168.1.20:9/';
  const b = 'https://10.0.0.4:9/';
  assert.deepEqual(qrModules(a), qrModules(a));
  assert.notDeepEqual(qrModules(a), qrModules(b));
});

test('qrSvg is a white-on-black SVG the webview can inline', () => {
  const svg = qrSvg('https://192.168.1.20:54321/');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /fill="#fff"/);
  assert.match(svg, /fill="#000"/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.doesNotMatch(svg, /style=/);
  assert.equal(qrSvg('x'.repeat(BYTE_CAPACITY[6] + 1)), null);
});

function pbmOf(modules) {
  const quiet = 4;
  const scale = 8;
  const n = modules.length;
  const dim = (n + 2 * quiet) * scale;
  const rows = [];
  for (let y = 0; y < dim; y++) {
    const my = Math.floor(y / scale) - quiet;
    const line = [];
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const on = my >= 0 && mx >= 0 && my < n && mx < n && modules[my][mx];
      line.push(on ? '1' : '0');
    }
    rows.push(line.join(' '));
  }
  return `P1\n${dim} ${dim}\n${rows.join('\n')}\n`;
}

function scan(url) {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-qr-'));
  try {
    const file = path.join(dir, 'lan.pbm');
    fs.writeFileSync(file, pbmOf(qrModules(url)));
    const scanned = spawnSync('zbarimg', ['--raw', file], { encoding: 'utf8' });
    assert.equal(scanned.status, 0, scanned.stderr);
    assert.equal(scanned.stdout.trim(), url);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('zbarimg reads the LAN URL back when a scanner is installed', (t) => {
  const { spawnSync } = require('node:child_process');
  const probe = spawnSync('zbarimg', ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') {
    t.skip('zbarimg is not on PATH');
    return;
  }
  scan('https://192.168.1.20:54321/');
  scan(`https://192.168.1.20:54321/${'a'.repeat(20)}`);
});
