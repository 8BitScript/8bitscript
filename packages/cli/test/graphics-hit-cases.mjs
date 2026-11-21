// The graphics::hit questions, shared by the wasm builds (graphics-hit.test.mjs) and the native
// emulator runs (packages/c64/test/graphics-hit.test.mjs). The expected bytes are worked out from the
// box rule (the pixels with alpha >= 16, over every frame) and the positions, not read from a build.
import { encodePNG } from '../src/png.mjs';

export function image(w, h, opaque) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) if (opaque(x, y)) rgba.set([255, 255, 255, 255], (y * w + x) * 4);
  }
  return encodePNG(w, h, rgba);
}

// Slots 0 to 4, in this order. `two` is a 32x16 source, two frames of 16x16.
// Boxes: solid 0,0,16,16; margin 3,3,13,13; blank none; two 0,0,16,16; notch 2,4,14,12.
export const PICTURES = [
  { name: 'solid', w: 16, h: 16, size: 16, opaque: () => true },
  { name: 'margin', w: 16, h: 16, size: 16, opaque: (x, y) => x >= 3 && x <= 12 && y >= 3 && y <= 12 },
  { name: 'blank', w: 8, h: 8, size: 8, opaque: () => false },
  { name: 'two', w: 32, h: 16, size: 16, opaque: (x, y) => (x < 16 ? x < 4 && y < 8 : x >= 28 && y >= 8) },
  { name: 'notch', w: 16, h: 16, size: 16, opaque: (x, y) => x >= 2 && x <= 13 && y >= 4 && y <= 11 },
];

export const ART = PICTURES.map(({ name, size }) => `sprite ${name} {\n  source "./${name}.png"\n  size ${size}x${size}\n  transparent auto\n}\n`).join('');

export const HEADER = [165, 90, 195, 60];
export const TRAILER = [60, 195, 90, 165];

// [k, what is placed before the call, the statement, the stored byte]
export const CASES = [
  [4, 'place(solid, 40, 40); place(margin, 50, 50);', 'yes(4, graphics::hit(solid, margin));', 1],
  [5, 'place(solid, 40, 40); place(margin, 53, 40);', 'yes(5, graphics::hit(solid, margin));', 2],
  [6, 'place(solid, 40, 40); place(margin, 52, 40);', 'yes(6, graphics::hit(solid, margin));', 1],
  [7, 'place(solid, 40, 40); place(two, 28, 40);', 'yes(7, graphics::hit(solid, two));', 1],
  [8, 'place(solid, 40, 40); place(two, 53, 40);', 'yes(8, graphics::hit(solid, two));', 1],
  [9, 'place(solid, 40, 40); place(two, 56, 40);', 'yes(9, graphics::hit(solid, two));', 2],
  [10, 'place(solid, 40, 40); place(margin, 50, 50); graphics::hide(margin);', 'yes(10, graphics::hit(solid, margin));', 2],
  [11, 'place(solid, 40, 40);', 'yes(11, graphics::hit(solid, solid));', 2],
  [12, 'place(solid, 40, 40);', 'yes(12, graphics::hit(solid, blank));', 2],
  [13, 'place(solid, 40, 40); place(blank, 40, 40);', 'yes(13, graphics::hit(solid, blank));', 2],
  [14, 'place(solid, 40, 40);', 'yes(14, graphics::hit(solid, 200));', 2],
  [15, 'place(solid, 40, 40); place(margin, 50, 50); graphics::hide(margin); place(margin, 50, 50);', 'yes(15, graphics::hit(solid, margin));', 1],
  [16, 'place(solid, 1000, 1000); place(margin, 1000, 1000);', 'yes(16, graphics::hit(solid, margin));', 1],
  [17, 'place(solid, 41, 41); place(margin, 54, 41);', 'yes(17, graphics::hit(solid, margin));', 2],
  [18, 'place(solid, 40, 40); place(margin, 50, 50); place(two, 45, 45);', 'answers[18] = graphics::hitAny(solid);', 1],
  [19, 'place(solid, 40, 40);', 'answers[19] = graphics::hitAny(solid);', 255],
  [20, 'place(solid, 40000, 10); place(margin, 40000, 10);', 'yes(20, graphics::hit(solid, margin));', 2],
  [21, 'place(solid, 40, 40); place(margin, 27, 40);', 'yes(21, graphics::hit(solid, margin));', 2],
  [22, 'place(solid, 40, 40); place(margin, 28, 40);', 'yes(22, graphics::hit(solid, margin));', 1],
  [23, 'place(solid, 40, 40); place(margin, 40, 27);', 'yes(23, graphics::hit(solid, margin));', 2],
  [24, 'place(solid, 40, 40); place(margin, 40, 28);', 'yes(24, graphics::hit(solid, margin));', 1],
  [25, 'place(solid, 40, 40); place(margin, 40, 53);', 'yes(25, graphics::hit(solid, margin));', 2],
  [26, 'place(solid, 40, 40); place(margin, 40, 52);', 'yes(26, graphics::hit(solid, margin));', 1],
  // a has an offset box: margin first, its box 3,3,13,13 at (40, 40) covers x 43..52 and y 43..52.
  [27, 'place(margin, 40, 40); place(solid, 27, 40);', 'yes(27, graphics::hit(margin, solid));', 2],
  [28, 'place(margin, 40, 40); place(solid, 28, 40);', 'yes(28, graphics::hit(margin, solid));', 1],
  [29, 'place(margin, 40, 40); place(solid, 40, 27);', 'yes(29, graphics::hit(margin, solid));', 2],
  [30, 'place(margin, 40, 40); place(solid, 40, 28);', 'yes(30, graphics::hit(margin, solid));', 1],
  [31, 'place(margin, 40, 40); place(solid, 53, 40);', 'yes(31, graphics::hit(margin, solid));', 2],
  [32, 'place(margin, 40, 40); place(solid, 52, 40);', 'yes(32, graphics::hit(margin, solid));', 1],
  [33, 'place(margin, 40, 40); place(solid, 40, 53);', 'yes(33, graphics::hit(margin, solid));', 2],
  [34, 'place(margin, 40, 40); place(solid, 40, 52);', 'yes(34, graphics::hit(margin, solid));', 1],
  // Both boxes offset, and different on x and y: notch 2,4,14,12.
  [35, 'place(margin, 40, 40); place(notch, 29, 40);', 'yes(35, graphics::hit(margin, notch));', 2],
  [36, 'place(margin, 40, 40); place(notch, 30, 40);', 'yes(36, graphics::hit(margin, notch));', 1],
  [37, 'place(margin, 40, 40); place(notch, 40, 31);', 'yes(37, graphics::hit(margin, notch));', 2],
  [38, 'place(margin, 40, 40); place(notch, 40, 32);', 'yes(38, graphics::hit(margin, notch));', 1],
  [39, 'place(margin, 40, 40); place(notch, 30, 40);', 'yes(39, graphics::hit(notch, margin));', 1],
  [40, 'place(margin, 40, 40); place(notch, 29, 40);', 'yes(40, graphics::hit(notch, margin));', 2],
  // hitAny returns from inside its loop: on the first pass (b = 0), on a later one past a placed
  // sprite that misses, and past a itself to the last placed slot.
  [41, 'place(solid, 40, 40); place(margin, 50, 50); place(two, 45, 45); place(notch, 48, 48);', 'answers[41] = graphics::hitAny(margin);', 0],
  [42, 'place(solid, 200, 100); place(two, 45, 45); place(notch, 48, 48);', 'answers[42] = graphics::hitAny(notch);', 3],
  [43, 'place(two, 45, 45); place(notch, 48, 48);', 'answers[43] = graphics::hitAny(two);', 4],
];

// hitAny for every slot from inside the caller's own loop, once and then in 60 more rounds: 305 calls, 183 of them returning from inside hitAny's own loop (slots 1, 3 and 4 on every pass). On the 6502 builds a return that left a byte on the stack would break the next RTS.
export const SWEEP = {
  place: 'graphics::place(solid, 200, 100); graphics::place(margin, 50, 50); graphics::place(blank, 40, 40); graphics::place(two, 45, 45); graphics::place(notch, 48, 48);',
  first: 44,
  again: 49,
  expected: [255, 3, 255, 1, 1],
};

export const LENGTH = 54 + TRAILER.length;

export function expected() {
  const bytes = new Array(LENGTH).fill(0);
  HEADER.forEach((v, i) => { bytes[i] = v; });
  for (const [k, , , value] of CASES) bytes[k] = value;
  SWEEP.expected.forEach((v, i) => { bytes[SWEEP.first + i] = v; bytes[SWEEP.again + i] = v; });
  TRAILER.forEach((v, i) => { bytes[54 + i] = v; });
  return bytes;
}

// The probe. `show` names extra top-level lines and a call to make once every answer is stored
// (the native runs draw the bytes on the screen; the wasm runs read RAM and pass nothing).
export function program({ uses = [], extra = [], start = [], show = null } = {}) {
  return [
    'use @8bitscript::graphics::graphics;',
    ...uses,
    `use self::art::{${PICTURES.map((p) => p.name).join(', ')}};`,
    '',
    `let mut answers: [u8; ${LENGTH}];`,
    '',
    'fn reset() {',
    ...PICTURES.map((p) => `    graphics::hide(${p.name});`),
    '}',
    '',
    'fn yes(k: utinyint, on: bool) {',
    '    if on {',
    '        answers[k] = 1;',
    '    } else {',
    '        answers[k] = 2;',
    '    }',
    '}',
    '',
    ...extra,
    '',
    'pub fn main() {',
    ...start.map((line) => `    ${line}`),
    ...HEADER.map((v, i) => `    answers[${i}] = ${v};`),
    ...CASES.flatMap(([, before, call]) => [`    ${before.replace(/(?<![:\w])place\(/g, 'graphics::place(')}`, `    ${call}`, '    reset();']),
    `    ${SWEEP.place}`,
    `    for s: utinyint in 0..${PICTURES.length} {`,
    `        answers[${SWEEP.first} + s] = graphics::hitAny(s);`,
    '    }',
    '    for round: utinyint in 0..60 {',
    `        for s: utinyint in 0..${PICTURES.length} {`,
    `            answers[${SWEEP.again} + s] = graphics::hitAny(s);`,
    '        }',
    '    }',
    '    reset();',
    ...TRAILER.map((v, i) => `    answers[${54 + i}] = ${v};`),
    ...(show ? [`    ${show}`] : []),
    '    loop {',
    '        waitFrame();',
    '        graphics::update();',
    '    }',
    '}',
  ].join('\n');
}
