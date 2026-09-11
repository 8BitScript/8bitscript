// Last-run JSON → the Running machines tree. No vscode; the launcher
// page draws what this returns.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  formatElapsed, lastRunPath, machineTree, parseLastRun, readLastRun, sizeWithPct,
} = require('../src/runningMachines.cjs');

test('parseLastRun rejects junk and keeps a well-formed report', () => {
  assert.equal(parseLastRun('not json'), null);
  assert.equal(parseLastRun('[]'), null);
  const report = parseLastRun(JSON.stringify({
    target: 'pet',
    outFile: 'dist/main-pet.prg',
    memory: { variables: 8, program: 331 },
    size: [{ name: 'main', bytes: 40 }, { name: 'skip' }],
    hardware: { label: '8032', options: { model: '8032' }, facts: { 'video.columns': 80 } },
    emulator: 'xpet',
  }));
  assert.equal(report.target, 'pet');
  assert.equal(report.emulator, 'xpet');
  assert.deepEqual(report.size, [{ name: 'main', bytes: 40 }]);
  assert.equal(report.hardware.label, '8032');
});

test('readLastRun reads the file 8bs writes, and null when it is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '8bs-ext-last-'));
  try {
    assert.equal(readLastRun(dir, 'pet'), null);
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(lastRunPath(dir, 'pet'), JSON.stringify({
      target: 'pet', memory: { variables: 1, program: 10 }, size: [],
    }));
    const report = readLastRun(dir, 'pet');
    assert.equal(report.memory.program, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sizeWithPct is each entry as a share of the program total', () => {
  assert.deepEqual(
    sizeWithPct([{ name: 'a', bytes: 30 }, { name: 'b', bytes: 10 }], 40),
    [
      { name: 'a', bytes: 30, pct: '75.0' },
      { name: 'b', bytes: 10, pct: '25.0' },
    ],
  );
  assert.equal(sizeWithPct([{ name: 'a', bytes: 1 }], 0)[0].pct, '0.0');
});

test('formatElapsed is seconds, then minutes, then hours', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(4500), '4s');
  assert.equal(formatElapsed(90_000), '1m 30s');
  assert.equal(formatElapsed(3_600_000 + 5_000), '1h 0m');
});

test('machineTree is null for doctor/install, and a tree for run/boot', () => {
  assert.equal(machineTree({ command: 'doctor', startedAt: Date.now() }, null, null), null);
  const tree = machineTree(
    { command: 'run', target: 'pet', startedAt: Date.now() - 5000 },
    {
      emulator: 'xpet',
      outFile: 'dist/main-pet.prg',
      memory: { variables: 8, program: 100 },
      size: [{ name: 'main', bytes: 40 }],
      hardware: {
        label: '8032',
        options: { model: '8032' },
        facts: { 'video.columns': 80, 'audio.voices': 0 },
      },
    },
    { fps: 60, frames: 12 },
  );
  assert.equal(tree.emulator, 'xpet');
  assert.equal(tree.memory.line, '8 bytes RAM · 100 bytes program');
  assert.equal(tree.size[0].pct, '40.0');
  assert.equal(tree.fitted, '8032');
  assert.deepEqual(tree.options, [{ key: 'model', value: '8032' }]);
  assert.equal(tree.facts.find((f) => f.key === 'audio.voices').value, '0');
  assert.equal(tree.live.fps, 60);
  assert.match(tree.elapsed, /5s/);
});

test('livePollPlan lists web URLs to fetch and a stamp that moves with the report', () => {
  const { livePollPlan, rowKey } = require('../src/runningMachines.cjs');
  const rows = [
    { command: 'doctor', dir: '/a', target: undefined },
    { command: 'run', dir: '/p', target: 'web' },
    { command: 'run', dir: '/p', target: 'pet' },
  ];
  const reports = new Map([
    [rowKey('/p', 'web'), { url: 'http://127.0.0.1:9/', writtenAt: 't1', emulator: 'browser' }],
    [rowKey('/p', 'pet'), { writtenAt: 't2', emulator: 'xpet' }],
  ]);
  const plan = livePollPlan(rows, reports);
  assert.deepEqual(plan.fetches, [{ key: rowKey('/p', 'web'), url: 'http://127.0.0.1:9/' }]);
  assert.equal(plan.seen.has(rowKey('/p', 'pet')), true);
  assert.equal(plan.seen.has(rowKey('/a', undefined)), false, 'doctor is not a machine');
  const again = livePollPlan(rows, reports);
  assert.equal(plan.stamp, again.stamp);
  reports.set(rowKey('/p', 'pet'), { writtenAt: 't3', emulator: 'xpet' });
  assert.notEqual(livePollPlan(rows, reports).stamp, plan.stamp);
});

test('fetchStatus reads JSON from GET /status and is null when nothing is there', async () => {
  const http = require('node:http');
  const { fetchStatus } = require('../src/runningMachines.cjs');
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ fps: 60, frames: 3 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    assert.deepEqual(await fetchStatus(`http://127.0.0.1:${port}/`), { fps: 60, frames: 3 });
    assert.equal(await fetchStatus('http://127.0.0.1:1/'), null);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
