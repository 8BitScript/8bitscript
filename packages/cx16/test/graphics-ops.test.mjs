// The graphics contract's calls on the X16, read off x16emu screenshots:
// hide, place after hide, setFrame (and its clamp), animate pausing one object
// while another keeps going, color (a tint, and the picture's own colors
// back), and a position off the screen. packages/graphics/AGENTS.md says a
// twin's constants are proved by packages/compiler/test/graphics-contract.test.mjs
// and what it draws by a file like this one; the link-level half of this file
// is mirrored in packages/compiler/test/graphics-cx16-ops.test.mjs, which CI runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../../graphics-tools/src/index.mjs';
import { pixelAt } from '../../cli/src/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHECKOUT = join(ROOT, '..', '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const HAVE_EMULATOR = onPath('x16emu') && onPath('ffmpeg');
const SKIP = HAVE_EMULATOR ? false : 'x16emu and ffmpeg are not both on PATH';

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];
const MAGENTA = [255, 0, 255];
const CYAN = [0, 255, 255];
const ORANGE = [255, 136, 0];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

// An RGBA picture from a function of (x, y) returning [r, g, b] or null.
function picture(width, height, paint) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = paint(x, y);
      if (c) rgba.set([c[0], c[1], c[2], 255], (y * width + x) * 4);
    }
  }
  return rgba;
}

// Four objects, each 16 × 16, at fixed places along one row:
//   flip  (40, 40)  two frames, red|blue then green|yellow, every 4 updates
//   walk  (100, 40) four solid frames red, green, blue, yellow; never steps
//   pulse (160, 40) two frames, orange|magenta then cyan|white, every 4
//   gem   (220, 40) one frame, red|cyan
const FLIP_AT = [40, 40];
const WALK_AT = [100, 40];
const PULSE_AT = [160, 40];
const GEM_AT = [220, 40];

function writeArt(dir) {
  const halves = (a, b, c, d) => (x, y) => {
    const f = x < 16 ? 0 : 1;
    const left = (x % 16) < 8;
    return f === 0 ? (left ? a : b) : (left ? c : d);
  };
  writeFileSync(join(dir, 'flip.png'), encodePng(32, 16, picture(32, 16, halves(RED, BLUE, GREEN, YELLOW))));
  const solid = [RED, GREEN, BLUE, YELLOW];
  writeFileSync(join(dir, 'walk.png'), encodePng(64, 16, picture(64, 16, (x) => solid[Math.floor(x / 16)])));
  writeFileSync(join(dir, 'pulse.png'), encodePng(32, 16, picture(32, 16, halves(ORANGE, MAGENTA, CYAN, WHITE))));
  writeFileSync(join(dir, 'gem.png'), encodePng(16, 16, picture(16, 16, (x) => (x < 8 ? RED : CYAN))));
  writeFileSync(join(dir, 'art.8bg'), [
    'sprite flip {', '  source "./flip.png"', '  size 16x16', '  transparent auto',
    '  animation go {', '    frames 0, 1', '    every 4', '  }', '}',
    'sprite walk {', '  source "./walk.png"', '  size 16x16', '  transparent auto',
    '  animation go {', '    frames 0, 1, 2, 3', '    every 4', '  }', '}',
    'sprite pulse {', '  source "./pulse.png"', '  size 16x16', '  transparent auto',
    '  animation go {', '    frames 0, 1', '    every 4', '  }', '}',
    'sprite gem {', '  source "./gem.png"', '  size 16x16', '  transparent auto', '}',
    '',
  ].join('\n'));
}

// The probe: place the four, then run `ops` once, then update forever.
function writeProbe(dir, ops, { mouse = false } = {}) {
  writeArt(dir);
  writeFileSync(join(dir, 'probe.8bs'), [
    'import { graphics } from "@8bitscript/graphics";',
    'import { screen } from "@8bitscript/screen";',
    ...(mouse ? ['import { mouse } from "@8bitscript/cx16/mouse";'] : []),
    'import { flip, walk, pulse, gem } from "./art.8bg";',
    '',
    'export function main(): void {',
    '    screen.blank();',
    ...(mouse ? ['    mouse.begin();'] : []),
    `    graphics.place(flip, ${FLIP_AT.join(', ')});`,
    `    graphics.place(walk, ${WALK_AT.join(', ')});`,
    `    graphics.place(pulse, ${PULSE_AT.join(', ')});`,
    `    graphics.place(gem, ${GEM_AT.join(', ')});`,
    '    graphics.animate(walk, false);',
    ...ops.map((line) => `    ${line}`),
    '    while (true) {',
    '        waitFrame();',
    ...(mouse ? ['        mouse.poll();'] : []),
    '        graphics.update();',
    '    }',
    '}',
    '',
  ].join('\n'));
}

function runCli(args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: ROOT, env: { ...process.env, EIGHTBITSCRIPT_CHECKOUT: CHECKOUT }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

// The display is inset 16 px; a sprite's (0, 0) is the picture's top-left.
const INSET = 16;
const at = (png, x, y) => pixelAt(png, INSET + x, INSET + y);

async function shoot(dir, frames, name) {
  const shot = join(dir, name);
  const { code, stdout, stderr } = await runCli(['run', 'cx16', '--screenshot', shot, '--frames', String(frames), join(dir, 'probe.8bs')]);
  assert.equal(code, 0, `8bs run cx16 --screenshot failed:\n${stdout}${stderr}`);
  return readFileSync(shot);
}

// Run one scenario: build the probe with `ops`, take the screenshots at the
// given frame counts, hand them to `check`, and clean up.
async function scenario(ops, frames, check, options) {
  const dir = mkdtempSync(join(HERE, 'gfx-ops-'));
  try {
    writeProbe(dir, ops, options);
    const shots = [];
    for (const f of frames) shots.push(await shoot(dir, f, `s${f}.png`));
    await check(shots);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The two colors an object shows: the left half and the right half, at the
// middle row of its 16 × 16.
const halves = (png, [x, y]) => [at(png, x + 3, y + 8), at(png, x + 12, y + 8)];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('under x16emu, the baseline shows all four objects whole, and walk holds frame 0', { skip: SKIP }, async () => {
  await scenario([], [300, 304], async ([a, b]) => {
    assert.deepEqual(halves(a, WALK_AT), [RED, RED], 'walk, frame 0');
    assert.deepEqual(halves(b, WALK_AT), [RED, RED], 'walk, still frame 0 four frames later');
    assert.deepEqual(halves(a, GEM_AT), [RED, CYAN], 'gem');
    assert.deepEqual(at(a, WALK_AT[0] - 1, WALK_AT[1] + 8), BLACK, 'nothing beside walk');
  });
});

test('under x16emu, hide takes an object off the screen and leaves the others', { skip: SKIP }, async () => {
  await scenario(['graphics.hide(walk);'], [300], async ([png]) => {
    assert.deepEqual(halves(png, WALK_AT), [BLACK, BLACK], 'walk is gone');
    assert.deepEqual(halves(png, GEM_AT), [RED, CYAN], 'gem is still there');
    assert.ok(halves(png, FLIP_AT).every((c) => same(c, RED) || same(c, BLUE) || same(c, GREEN) || same(c, YELLOW)), 'flip is still there');
  });
});

test('under x16emu, place after hide draws the object at its new place, and only there', { skip: SKIP }, async () => {
  await scenario(['graphics.hide(walk);', 'graphics.place(walk, 100, 120);'], [300], async ([png]) => {
    assert.deepEqual(halves(png, WALK_AT), [BLACK, BLACK], 'not at the old place');
    assert.deepEqual(halves(png, [100, 120]), [RED, RED], 'at the new place');
  });
});

test('under x16emu, setFrame shows that frame, clamps past the last, and works while hidden', { skip: SKIP }, async () => {
  await scenario(['graphics.setFrame(walk, 2);'], [300], async ([png]) => {
    assert.deepEqual(halves(png, WALK_AT), [BLUE, BLUE], 'frame 2 is blue');
  });
  await scenario(['graphics.setFrame(walk, 9);'], [300], async ([png]) => {
    assert.deepEqual(halves(png, WALK_AT), [YELLOW, YELLOW], 'frame 9 clamps to the last, yellow');
  });
  await scenario(['graphics.hide(walk);', 'graphics.setFrame(walk, 1);', 'graphics.place(walk, 100, 40);'], [300], async ([png]) => {
    assert.deepEqual(halves(png, WALK_AT), [GREEN, GREEN], 'a frame chosen while hidden shows when placed');
  });
});

test('under x16emu, animate(false) holds one object on its frame while another keeps stepping', { skip: SKIP }, async () => {
  await scenario(['graphics.animate(pulse, false);'], [300, 304, 308, 312, 316], async (shots) => {
    const pulse = new Set(shots.map((png) => JSON.stringify(halves(png, PULSE_AT))));
    const flip = new Set(shots.map((png) => JSON.stringify(halves(png, FLIP_AT))));
    assert.equal(pulse.size, 1, `pulse held still: ${[...pulse]}`);
    assert.ok(flip.size >= 2, `flip kept stepping: ${[...flip]}`);
  });
  await scenario(['graphics.animate(pulse, false);', 'graphics.animate(pulse, true);'], [300, 304, 308, 312, 316], async (shots) => {
    const pulse = new Set(shots.map((png) => JSON.stringify(halves(png, PULSE_AT))));
    assert.ok(pulse.size >= 2, `animate(true) resumed it: ${[...pulse]}`);
  });
});

test('under x16emu, color tints every pixel one machine color, and a value from 16 up gives the picture its own back', { skip: SKIP }, async () => {
  await scenario(['graphics.color(gem, 1);'], [300], async ([png]) => {
    assert.deepEqual(halves(png, GEM_AT), [WHITE, WHITE], 'color 1 is white across the picture');
    assert.deepEqual(halves(png, WALK_AT), [RED, RED], 'another object keeps its colors');
  });
  await scenario(['graphics.color(gem, 2);'], [300], async ([png]) => {
    const [l, r] = halves(png, GEM_AT);
    assert.ok(same(l, r), 'one color across the picture');
    assert.ok(!same(l, RED) && !same(l, CYAN) && !same(l, WHITE), 'and it is the palette\'s color 2, not a picture color');
  });
  await scenario(['graphics.color(gem, 1);', 'graphics.color(gem, 255);'], [300], async ([png]) => {
    assert.deepEqual(halves(png, GEM_AT), [RED, CYAN], 'the picture\'s own colors are back');
  });
});

test('under x16emu, a position off the screen draws nothing, and does not wrap to the other side', { skip: SKIP }, async () => {
  await scenario(['graphics.place(walk, 1020, 40);', 'graphics.place(pulse, 700, 40);', 'graphics.place(gem, 220, 480);'], [300], async ([png]) => {
    assert.deepEqual(halves(png, [0, 40]), [BLACK, BLACK], 'nothing at the left edge for x = 1020');
    assert.deepEqual(at(png, 2, 48), BLACK, 'left edge, a few pixels in');
    assert.deepEqual(halves(png, PULSE_AT), [BLACK, BLACK], 'x = 700 is off, and the old place is empty');
    assert.deepEqual(halves(png, GEM_AT), [BLACK, BLACK], 'y = 480 is off');
  });
  await scenario(['graphics.place(walk, 1020, 40);', 'graphics.place(walk, 100, 40);'], [300], async ([png]) => {
    assert.deepEqual(halves(png, WALK_AT), [RED, RED], 'an object parked off the screen comes back with place()');
  });
});

test('under x16emu, an object at the right edge of the playfield is whole, and one past it is cut by the window', { skip: SKIP }, async () => {
  await scenario(['graphics.place(walk, 592, 40);'], [300], async ([png]) => {
    assert.deepEqual(at(png, 592, 48), RED, 'first column');
    assert.deepEqual(at(png, 607, 48), RED, 'last column, inside the playfield');
  });
  await scenario(['graphics.place(walk, 600, 40);'], [300], async ([png]) => {
    assert.deepEqual(at(png, 600, 48), RED, 'inside');
    assert.deepEqual(at(png, 607, 48), RED, 'inside, the last column');
    assert.notDeepEqual(at(png, 608, 48), RED, 'past the playfield, the window clips it');
  });
});

test('under x16emu, the KERNAL mouse cursor (sprite 0) and the four objects share VERA without disturbing each other', { skip: SKIP }, async () => {
  await scenario(['graphics.setFrame(walk, 2);', 'graphics.color(gem, 1);'], [300], async ([png]) => {
    assert.deepEqual(halves(png, WALK_AT), [BLUE, BLUE], 'walk, frame 2, with the mouse on');
    assert.deepEqual(halves(png, GEM_AT), [WHITE, WHITE], 'gem, tinted, with the mouse on');
    assert.deepEqual(halves(png, FLIP_AT).length, 2);
    // The firmware parks the arrow's hotspot at the centre of the active
    // area — screenshot (335, 254), playfield (319, 238) after the inset
    // (packages/cx16/AGENTS.md) — and draws it down and to the right.
    let lit = 0;
    for (let dy = 0; dy < 24; dy += 1) {
      for (let dx = 0; dx < 24; dx += 1) {
        if (!same(at(png, 316 + dx, 236 + dy), BLACK)) lit += 1;
      }
    }
    assert.ok(lit > 10, `the mouse cursor is drawn near the centre (${lit} lit pixels)`);
  }, { mouse: true });
});
