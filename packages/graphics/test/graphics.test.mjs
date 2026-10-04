import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

test('every twin exports graphics.bind, meta, place, and update', () => {
  for (const name of ['index.8bs', 'index.c64.8bs', 'index.nes.8bs', 'index.pet.8bs', 'index.vic20.8bs']) {
    const src = readFileSync(join(SRC, name), 'utf8');
    assert.match(src, /function bind\(/, name);
    assert.match(src, /function meta\(/, name);
    assert.match(src, /function place\(/, name);
    assert.match(src, /function update\(/, name);
  }
});

// ---- web (packages/web/media/index.cjs + src/index.web.8bs) ----------------

test('the web twin exports graphics.bind, meta, place, and update', () => {
  const src = readFileSync(join(SRC, 'index.web.8bs'), 'utf8');
  for (const fn of ['bind', 'meta', 'place', 'update']) {
    assert.match(src, new RegExp(`function ${fn}\\(`), fn);
  }
});

test('the web twin holds exactly as many animation steps as the web lowering keeps', async () => {
  const src = readFileSync(join(SRC, 'index.web.8bs'), 'utf8');
  const steps = Number(/const STEPS: utinyint = (\d+);/.exec(src)?.[1]);
  const { default: web } = await import('../../web/media/index.cjs');
  assert.equal(steps, web.MAX_STEPS);
  // codes is MAX pictures × STEPS steps, indexed (slot << 3) + step.
  const max = Number(/const MAX: utinyint = (\d+);/.exec(src)?.[1]);
  assert.equal(Number(/let codes: array<u8, (\d+)>;/.exec(src)?.[1]), max * steps);
  assert.equal(steps, 8, 'the (slot << 3) indexing assumes eight steps');
});
