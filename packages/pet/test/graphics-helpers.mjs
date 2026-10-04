// Shared by the PET graphics tests (graphics.test.mjs, graphics-ops.test.mjs):
// fixtures written at run time, the xpet runner, and a whole-image PNG reader.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { encodePng } from '../../graphics-tools/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const CHECKOUT = join(ROOT, '..', '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');

// The four pictures of the animation, as 4×4 pseudo-pixel rows (bit 3 the left
// pixel): a left bar, a right bar, a top bar, a bottom bar. Each is drawn into
// the PNG as 16×16 so the lowering's downsample gets them back exactly.
export const WALK = [
  [12, 12, 12, 12],
  [3, 3, 3, 3],
  [15, 15, 0, 0],
  [0, 0, 15, 15],
];
export const RING = [6, 9, 9, 6];

export function sheet(frames) {
  const width = 16 * frames.length;
  const rgba = new Uint8Array(width * 16 * 4);
  frames.forEach((rows, f) => {
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        if ((rows[y >> 2] >> (3 - (x >> 2))) & 1) rgba[(y * width + f * 16 + x) * 4 + 3] = 255;
      }
    }
  });
  return encodePng(width, 16, rgba);
}

export function eightBg(name, animated) {
  return `sprite ${name} {\n  source "./${name}.png"\n  size 16x16\n  transparent auto\n${animated
    ? '  animation go {\n    frames 0, 1, 2, 3\n    every 4\n  }\n' : ''}}\n`;
}


export function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
export const SKIP = !onPath('xpet') && 'xpet is not on PATH';

export function runCli(args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

export async function shoot(scratch, program, hardware, frames, name) {
  const shot = join(scratch, `${name}.png`);
  const { code, stdout, stderr } = await runCli(['run', 'pet', '--hardware', hardware, '--checkout', CHECKOUT, '--frames', String(frames), '--screenshot', shot, program.file]);
  assert.equal(code, 0, `8bs run pet --hardware ${hardware} --frames ${frames} failed:\n${stdout}${stderr}`);
  return decodePng(readFileSync(shot));
}


// Where cell (0, 0) starts in each model's capture, and how tall a character
// row is: the 8032 draws a one-pixel gap under every row (measured against the
// text of a stock hello-world, and the sprites below land on whole rows of it).
export const GEOMETRY = {
  '2001': { x0: 32, y0: 8, pitch: 8 },
  '3032': { x0: 32, y0: 8, pitch: 8 },
  '4032': { x0: 32, y0: 36, pitch: 8 },
  '8032': { x0: 32, y0: 23, pitch: 9 },
};

/** The 4×4 rows (bit 3 the left) of the object whose top-left is at stage pixel (x, y), a whole cell. */
export function readShape(image, geometry, x, y) {
  const rows = [];
  for (let py = 0; py < 4; py += 1) {
    let row = 0;
    for (let px = 0; px < 4; px += 1) {
      const cellRow = (y >> 3) + (py >> 1);
      const sx = geometry.x0 + x + px * 4 + 2;
      const sy = geometry.y0 + cellRow * geometry.pitch + (py & 1) * 4 + 2;
      if (isLit(image, sx, sy)) row |= 1 << (3 - px);
    }
    rows.push(row);
  }
  return rows;
}


// ---- a whole-image PNG reader -------------------------------------------------

// packages/cli/src/png.mjs's pixelAt() re-inflates the file on every call;
// reading a shape is dozens of points, so the image is decoded once.
export function decodePng(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(signature)) throw new Error('not a PNG');
  let offset = 8; let width = 0; let height = 0; let depth = 0; let colorType = 0;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not 8`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const out = pixels.subarray(row * stride, (row + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      out[i] = v;
    }
    previous = out;
  }
  return { width, height, channels, pixels };
}

export function isLit(image, x, y) {
  const o = (y * image.width + x) * image.channels;
  return image.pixels[o] > 80 || image.pixels[o + 1] > 80 || image.pixels[o + 2] > 80;
}
