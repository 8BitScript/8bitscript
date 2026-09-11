// Last-run reports and live status for the launcher's Running machines tree.
//
// Deliberately free of the `vscode` API so node --test can cover the
// shape: parse the JSON `8bs run --size` writes, format elapsed time, and
// turn one running task plus that report into the tree the panel draws.
const fs = require('fs');
const http = require('http');
const path = require('path');

const LAST_RUN_PREFIX = '.8bs-last-';

/** Absolute path of the last-run file `8bs` writes for this project/target. */
function lastRunPath(dir, target) {
  return path.join(dir, 'dist', `${LAST_RUN_PREFIX}${target}.json`);
}

function rowKey(dir, target) {
  return `${dir}\0${target ?? ''}`;
}

/**
 * @param {string} text
 * @returns {object|null}
 */
function parseLastRun(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || typeof data.target !== 'string') return null;
  const memory = data.memory && typeof data.memory === 'object' ? data.memory : null;
  const size = Array.isArray(data.size)
    ? data.size.filter((e) => e && typeof e.name === 'string' && typeof e.bytes === 'number')
    : [];
  const hardware = data.hardware && typeof data.hardware === 'object' ? data.hardware : null;
  return {
    target: data.target,
    outFile: typeof data.outFile === 'string' ? data.outFile : null,
    frameRate: typeof data.frameRate === 'number' ? data.frameRate : null,
    memory,
    size,
    hardware,
    emulator: typeof data.emulator === 'string' ? data.emulator : null,
    url: typeof data.url === 'string' ? data.url : null,
    writtenAt: typeof data.writtenAt === 'string' ? data.writtenAt : null,
  };
}

function readLastRun(dir, target) {
  if (!dir || !target) return null;
  try {
    return parseLastRun(fs.readFileSync(lastRunPath(dir, target), 'utf8'));
  } catch {
    return null;
  }
}

function sizeWithPct(entries, total) {
  const bytes = typeof total === 'number' && total > 0 ? total : 0;
  return entries.map((entry) => ({
    name: entry.name,
    bytes: entry.bytes,
    pct: bytes > 0 ? ((entry.bytes / bytes) * 100).toFixed(1) : '0.0',
  }));
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * The expandable tree one running `8bs run`/`boot` shows. `null` when the
 * task is not a machine (doctor, install) — those stay a single row.
 *
 * @param {{ command: string, target?: string, startedAt: number }} row
 * @param {object|null} report
 * @param {object|null} live
 */
function machineTree(row, report, live) {
  if (row.command !== 'run' && row.command !== 'boot') return null;
  const memory = report?.memory ?? null;
  const program = memory?.program ?? 0;
  const size = sizeWithPct(report?.size ?? [], program);
  const facts = report?.hardware?.facts && typeof report.hardware.facts === 'object'
    ? Object.entries(report.hardware.facts).map(([key, value]) => ({
      key,
      value: value === true ? 'yes' : value === false ? 'no' : String(value),
    }))
    : [];
  const options = report?.hardware?.options && typeof report.hardware.options === 'object'
    ? Object.entries(report.hardware.options).map(([key, value]) => ({ key, value: String(value) }))
    : [];
  return {
    emulator: report?.emulator ?? (row.target === 'web' ? 'browser' : null),
    outFile: report?.outFile ?? null,
    fitted: report?.hardware?.label ?? null,
    profile: report?.hardware?.profile ?? null,
    memory: memory
      ? {
        variables: memory.variables ?? 0,
        program: program,
        line: memory.program != null
          ? `${memory.variables ?? 0} bytes RAM · ${memory.program} bytes program`
          : null,
      }
      : null,
    size,
    options,
    facts,
    url: report?.url ?? null,
    live: live
      ? {
        fps: typeof live.fps === 'number' ? live.fps : null,
        frames: typeof live.frames === 'number' ? live.frames : null,
        done: live.done === true,
        error: typeof live.error === 'string' ? live.error : null,
        frameRate: typeof live.frameRate === 'number' ? live.frameRate : report?.frameRate ?? null,
      }
      : null,
    elapsed: formatElapsed(Date.now() - row.startedAt),
  };
}

/**
 * GET `${url}status`. Resolves null on any failure so a closed tab does
 * not take the panel down.
 *
 * @param {string} url
 * @returns {Promise<object|null>}
 */
function fetchStatus(url) {
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolvePromise(value);
    };
    let parsed;
    try {
      parsed = new URL('status', url.endsWith('/') ? url : `${url}/`);
    } catch {
      finish(null);
      return;
    }
    const req = http.get(parsed, { timeout: 800 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          finish(null);
        }
      });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });
  });
}

/**
 * One tick of the live poller, without I/O: which last-run files to
 * watch, which web URLs to GET /status, and a stamp that changes when the
 * compile report itself changes (so the panel redraws when size/emulator
 * appear, not only when FPS does).
 *
 * @param {{ dir: string, target?: string, command: string }[]} rows
 * @param {Map<string, object|null>} reports keyed by rowKey
 */
function livePollPlan(rows, reports) {
  const fetches = [];
  const seen = new Set();
  const stamps = [];
  for (const row of rows) {
    if (row.command !== 'run' && row.command !== 'boot') continue;
    const key = rowKey(row.dir, row.target);
    seen.add(key);
    const report = reports.get(key) ?? null;
    stamps.push(report?.writtenAt ?? '', report?.emulator ?? '', report?.url ?? '');
    if (report?.url) fetches.push({ key, url: report.url });
  }
  return { seen, stamp: stamps.join('\0'), fetches };
}

module.exports = {
  LAST_RUN_PREFIX,
  fetchStatus,
  formatElapsed,
  lastRunPath,
  livePollPlan,
  machineTree,
  parseLastRun,
  readLastRun,
  rowKey,
  sizeWithPct,
};
