// Byte-mode QR (ISO/IEC 18004), ECC-M, versions 1–6.
//
// The launcher draws one of these for a web run's LAN URL so a phone can
// open it without typing an ephemeral port. Kept free of `vscode` so
// node --test can check the matrix. No library: a URL like
// `https://192.168.1.20:54321/` is 28 bytes, well inside version 3.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Total codewords, ECC per block, and block count for versions 1–6 at ECC-M. */
const TOTAL = [0, 26, 44, 70, 100, 134, 172];
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4];
const BYTE_CAPACITY = [0, 14, 26, 42, 62, 84, 106];

function versionFor(byteLength) {
  for (let v = 1; v <= 6; v++) {
    if (byteLength <= BYTE_CAPACITY[v]) return v;
  }
  return 0;
}

function sizeOf(version) {
  return 21 + 4 * (version - 1);
}

function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    if (factor === 0) continue;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function dataCodewords(bytes, version) {
  const dataWords = TOTAL[version] - ECC_PER_BLOCK[version] * BLOCKS[version];
  const bits = [];
  const push = (value, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const capacity = dataWords * 8;
  const rest = Math.min(4, capacity - bits.length);
  for (let i = 0; i < rest; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let pad = 0;
  while (bits.length < capacity) push(pads[pad++ % 2], 8);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bits[i + j];
    words.push(w);
  }
  return words;
}

function interleaved(data, version) {
  const blockCount = BLOCKS[version];
  const eccLen = ECC_PER_BLOCK[version];
  const dataLen = data.length / blockCount;
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  const eccs = [];
  for (let i = 0; i < blockCount; i++) {
    const block = data.slice(i * dataLen, (i + 1) * dataLen);
    blocks.push(block);
    eccs.push([...rsRemainder(block, divisor)]);
  }
  const out = [];
  for (let i = 0; i < dataLen; i++) {
    for (const block of blocks) out.push(block[i]);
  }
  for (let i = 0; i < eccLen; i++) {
    for (const ecc of eccs) out.push(ecc[i]);
  }
  return out;
}

function bitsOf(codewords) {
  const bits = [];
  for (const w of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((w >>> i) & 1);
  }
  return bits;
}

function blank(size) {
  return Array.from({ length: size }, () => Array(size).fill(null));
}

function finder(modules, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= modules.length || cc >= modules.length) continue;
      const on = r === -1 || r === 7 || c === -1 || c === 7
        ? 0
        : r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      modules[rr][cc] = on ? 1 : 0;
    }
  }
}

function alignment(modules, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const on = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
      modules[row + r][col + c] = on ? 1 : 0;
    }
  }
}

function alignmentCenters(version) {
  if (version === 1) return [];
  return [6, 4 * version + 10];
}

function placeFunction(modules, version) {
  const size = modules.length;
  finder(modules, 0, 0);
  finder(modules, 0, size - 7);
  finder(modules, size - 7, 0);
  const centers = alignmentCenters(version);
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      alignment(modules, r, c);
    }
  }
  for (let i = 8; i < size - 8; i++) {
    if (modules[6][i] === null) modules[6][i] = i % 2 === 0 ? 1 : 0;
    if (modules[i][6] === null) modules[i][6] = i % 2 === 0 ? 1 : 0;
  }
  modules[size - 8][8] = 1;
  placeFormat(modules, 0);
}

function formatBits(mask) {
  const data = mask & 7;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function placeFormat(modules, bits) {
  const size = modules.length;
  for (let i = 0; i <= 5; i++) modules[i][8] = (bits >> i) & 1;
  modules[7][8] = (bits >> 6) & 1;
  modules[8][8] = (bits >> 7) & 1;
  modules[8][7] = (bits >> 8) & 1;
  for (let i = 9; i <= 14; i++) modules[8][14 - i] = (bits >> i) & 1;
  for (let i = 0; i <= 7; i++) modules[8][size - 1 - i] = (bits >> i) & 1;
  for (let i = 8; i <= 14; i++) modules[size - 15 + i][8] = (bits >> i) & 1;
}

function maskAt(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
}

function placeData(modules, bits, mask) {
  const size = modules.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const row = upward ? size - 1 - vert : vert;
        if (modules[row][col] !== null) continue;
        let bit = i < bits.length ? bits[i++] : 0;
        if (maskAt(mask, row, col)) bit ^= 1;
        modules[row][col] = bit;
      }
    }
  }
}

function penalty(modules) {
  const size = modules.length;
  let score = 0;
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c <= size; c++) {
      if (c < size && modules[r][c] === modules[r][c - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r <= size; r++) {
      if (r < size && modules[r][c] === modules[r - 1][c]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }
  const finder = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const finderRev = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const has = (line, at, pattern) => {
    for (let i = 0; i < pattern.length; i++) {
      if (line[at + i] !== pattern[i]) return false;
    }
    return true;
  };
  for (let r = 0; r < size; r++) {
    const row = modules[r];
    for (let c = 0; c <= size - 11; c++) {
      if (has(row, c, finder) || has(row, c, finderRev)) score += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    const col = modules.map((row) => row[c]);
    for (let r = 0; r <= size - 11; r++) {
      if (has(col, r, finder) || has(col, r, finderRev)) score += 40;
    }
  }
  let dark = 0;
  for (const row of modules) {
    for (const cell of row) if (cell) dark++;
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

function clone(modules) {
  return modules.map((row) => row.slice());
}

/**
 * Module matrix for `text` (UTF-8). Each cell is 1 (dark) or 0.
 * Returns null when the payload is longer than version 6 can hold.
 *
 * @param {string} text
 * @returns {number[][] | null}
 */
function qrModules(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  const version = versionFor(bytes.length);
  if (!version) return null;
  const modules = blank(sizeOf(version));
  placeFunction(modules, version);
  const bits = bitsOf(interleaved(dataCodewords(bytes, version), version));
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const trial = clone(modules);
    placeData(trial, bits, mask);
    placeFormat(trial, formatBits(mask));
    trial[sizeOf(version) - 8][8] = 1;
    const score = penalty(trial);
    if (score < bestScore) {
      best = trial;
      bestScore = score;
    }
  }
  return best;
}

/**
 * SVG for `text`, white quiet zone of 4 modules, black modules.
 * `null` when the payload does not fit.
 *
 * @param {string} text
 * @param {{ size?: number }} [options]
 * @returns {string | null}
 */
function qrSvg(text, { size = 148 } = {}) {
  const modules = qrModules(text);
  if (!modules) return null;
  const n = modules.length;
  const quiet = 4;
  const dim = n + quiet * 2;
  const path = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules[y][x]) path.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true"><rect width="${dim}" height="${dim}" fill="#fff"/><path fill="#000" d="${path.join('')}"/></svg>`;
}

module.exports = {
  BYTE_CAPACITY,
  formatBits,
  qrModules,
  qrSvg,
  sizeOf,
  versionFor,
};
