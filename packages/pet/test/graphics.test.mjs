// @8bitscript/graphics on the PET: a .8bg picture becomes a 4×4 quadrant-
// block object, an animation is one shape a frame, and the sprite layer's
// seven shapes are shared by every picture in the program.
//
// This file is the real thing under xpet: a program built from generated
// pictures, screenshotted headless, and read by pixel. The lowering and the
// link — slots, bind order, the budget's warnings — are tested in
// packages/compiler/test/media-lower.test.mjs, where CI runs them. The
// fixtures are written to a scratch directory at run time so no PNG lives
// in the tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { encodePng } from '../../graphics-tools/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHECKOUT = join(ROOT, '..', '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');

// ---- fixtures ---------------------------------------------------------------

// The four pictures of the animation, as 4×4 pseudo-pixel rows (bit 3 the left
// pixel): a left bar, a right bar, a top bar, a bottom bar. Each is drawn into
// the PNG as 16×16 so the lowering's downsample gets them back exactly.
const WALK = [
  [12, 12, 12, 12],
  [3, 3, 3, 3],
  [15, 15, 0, 0],
  [0, 0, 15, 15],
];
const RING = [6, 9, 9, 6];

function sheet(frames) {
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

function eightBg(name, animated) {
  return `sprite ${name} {\n  source "./${name}.png"\n  size 16x16\n  transparent auto\n${animated
    ? '  animation go {\n    frames 0, 1, 2, 3\n    every 4\n  }\n' : ''}}\n`;
}

/** Write the pictures and a program into `dir`; `layout` is [name, frames, x, y] for each. */
function writeProgram(dir, layout) {
  const imports = [];
  const places = [];
  for (const [name, frames, x, y] of layout) {
    writeFileSync(join(dir, `${name}.png`), sheet(frames));
    writeFileSync(join(dir, `${name}.8bg`), eightBg(name, frames.length > 1));
    imports.push(`import { ${name} } from "./${name}.8bg";`);
    places.push(`    graphics.place(${name}, sprites.ORIGIN_X + ${x}, sprites.ORIGIN_Y + ${y});`);
  }
  const text = `import { screen } from "@8bitscript/screen";
import { graphics } from "@8bitscript/graphics";
import { sprites } from "@8bitscript/sprites";
${imports.join('\n')}

export function main(): void {
    screen.blank();
${places.join('\n')}
    while (true) {
        waitFrame();
        graphics.update();
    }
}
`;
  const file = join(dir, 'main.8bs');
  writeFileSync(file, text);
  return { file, text };
}

// ---- under xpet ---------------------------------------------------------------

// The animated pictures sit in the lower half of the screen on purpose. The
// sprite layer redraws a picture that changed right after the frame edge, about
// 2,600 cycles each, while the beam is still near the top of the picture: a
// capture that lands in that window shows a half-old, half-new object (seen
// here at y 16 — packages/sprites/src/index.pet.8bs, header, "tear"). By row 17
// the beam has not yet arrived when the redraw is done.

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const SKIP = !onPath('xpet') && 'xpet is not on PATH';

function runCli(args, { timeoutMs = 180_000 } = {}) {
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

async function shoot(scratch, program, hardware, frames, name) {
  const shot = join(scratch, `${name}.png`);
  const { code, stdout, stderr } = await runCli(['run', 'pet', '--hardware', hardware, '--checkout', CHECKOUT, '--frames', String(frames), '--screenshot', shot, program.file]);
  assert.equal(code, 0, `8bs run pet --hardware ${hardware} --frames ${frames} failed:\n${stdout}${stderr}`);
  return decodePng(readFileSync(shot));
}

// Where cell (0, 0) starts in each model's capture, and how tall a character
// row is: the 8032 draws a one-pixel gap under every row (measured against the
// text of a stock hello-world, and the sprites below land on whole rows of it).
const GEOMETRY = {
  '2001': { x0: 32, y0: 8, pitch: 8 },
  '3032': { x0: 32, y0: 8, pitch: 8 },
  '4032': { x0: 32, y0: 36, pitch: 8 },
  '8032': { x0: 32, y0: 23, pitch: 9 },
};

/** The 4×4 rows (bit 3 the left) of the object whose top-left is at stage pixel (x, y), a whole cell. */
function readShape(image, geometry, x, y) {
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

/** Frame counts at which a program is photographed: nine looks, five frames apart. */
const LOOKS = Array.from({ length: 9 }, (_, k) => 300 + 5 * k);

/**
 * What a run of looks at one animated picture has to show. A look is a
 * capture taken mid-frame, so one that lands on the frame where the picture
 * changes can hold part of the old picture and part of the new (the lines the
 * beam had drawn, and the lines it had not): that look matches none of the
 * pictures and is allowed, a couple of times. Every other look is one of the
 * pictures, each next one is the picture after or the one after that, and
 * every picture the sprite was given comes up.
 */
function assertStepsThrough(seq, count, label) {
  assert.ok(seq.filter((i) => i === -1).length <= 2, `${label}: at most two torn looks: ${seq}`);
  assert.ok(seq.every((i) => i < count), `${label}: never beyond the ${count} pictures it was given: ${seq}`);
  for (let i = 1; i < seq.length; i += 1) {
    if (seq[i] === -1 || seq[i - 1] === -1) continue;
    const step = (seq[i] - seq[i - 1] + count) % count;
    assert.ok(step === 1 || step === 2, `${label}: look ${i} is ${step} pictures on from the last: ${seq}`);
  }
  assert.equal(new Set(seq.filter((i) => i !== -1)).size, count, `${label}: all ${count} pictures come up: ${seq}`);
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const frameIndex = (rows, frames = WALK) => frames.findIndex((f) => same(f, rows));

test('under xpet, a static picture and a four-frame walk are drawn where they are placed, and the walk steps through its frames in order', { skip: SKIP }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-gfx-walk-'));
  try {
    const program = writeProgram(scratch, [['ring', [RING], 16, 16], ['walk', WALK, 120, 136]]);
    // Five frames apart is a step and a quarter of `every 4`: each look is the
    // next picture or the one after, mostly the next, so nine looks go round
    // the four. (Six apart is a step and a half — which, over a cycle of three
    // or four, can alternate between two pictures and never show the rest.)
    const times = LOOKS;
    const images = await Promise.all(times.map((t) => shoot(scratch, program, 'model=3032,ram=8', t, `walk-${t}`)));
    const geometry = GEOMETRY['3032'];
    const seen = images.map((image) => {
      assert.deepEqual(readShape(image, geometry, 16, 16), RING, 'the static ring, every look');
      return frameIndex(readShape(image, geometry, 120, 136));
    });
    assertStepsThrough(seen, 4, 'walk');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under xpet, pictures past the seven shapes lose frames, then vanish, exactly as the build said', { skip: SKIP }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-gfx-budget-'));
  try {
    const program = writeProgram(scratch, [['alpha', WALK, 16, 136], ['beta', WALK, 120, 136], ['gamma', [RING], 224, 136]]);
    const times = LOOKS;
    const images = await Promise.all(times.map((t) => shoot(scratch, program, 'model=3032,ram=8', t, `budget-${t}`)));
    const geometry = GEOMETRY['3032'];
    const alphaSeq = [];
    const betaSeq = [];
    for (const image of images) {
      alphaSeq.push(frameIndex(readShape(image, geometry, 16, 136)));
      betaSeq.push(frameIndex(readShape(image, geometry, 120, 136)));
      assert.deepEqual(readShape(image, geometry, 224, 136), [0, 0, 0, 0], 'gamma found no shape left and is not drawn');
    }
    assertStepsThrough(alphaSeq, 4, 'alpha, given all four');
    assertStepsThrough(betaSeq, 3, 'beta, given the three that were left');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under xpet, the same program draws the same pictures on the 2001, the CRTC 4032 and the 80-column 8032', { skip: SKIP }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-gfx-models-'));
  try {
    // The ring near the top-left and a walk in the bottom-right corner of a
    // 40-column screen: its last whole cells are columns 38-39 (x 304) and
    // rows 23-24 (y 184). The 80-column 8032 has room beyond that column.
    const program = writeProgram(scratch, [['ring', [RING], 16, 16], ['edge', WALK, 304, 184]]);
    const cases = [
      ['2001', 'model=2001,ram=8'],
      ['4032', 'model=4032,ram=32'],
      ['8032', 'model=8032,ram=32,speaker=attached'],
    ];
    const images = await Promise.all(cases.map(([model, hardware]) => shoot(scratch, program, hardware, 300, `model-${model}`)));
    cases.forEach(([model], i) => {
      const geometry = GEOMETRY[model];
      assert.deepEqual(readShape(images[i], geometry, 16, 16), RING, `${model}: ring`);
      assert.notEqual(frameIndex(readShape(images[i], geometry, 304, 184)), -1, `${model}: the picture in the bottom-right whole cells`);
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---- a whole-image PNG reader -------------------------------------------------

// packages/cli/src/png.mjs's pixelAt() re-inflates the file on every call;
// reading a shape is dozens of points, so the image is decoded once.
function decodePng(buf) {
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

function isLit(image, x, y) {
  const o = (y * image.width + x) * image.channels;
  return image.pixels[o] > 80 || image.pixels[o + 1] > 80 || image.pixels[o + 2] > 80;
}
