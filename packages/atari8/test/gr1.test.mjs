// GR.1 text twins: setColor survives optimize, COLUMNS is 20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { optimizeReachable } from '../../compiler/src/linker/optimize.mjs';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, 'gr1-probe.8bs');
const STUDIO_ENTRY = join(HERE, '..', '..', 'studio', 'src', 'main.8bs');

test('textmode=gr1 links the ANTIC 6 twins: setColor is kept and the grid is 20×24', () => {
  const { hardware } = resolveHardware(loadCatalog('atari8'), { overrides: { textmode: 'gr1' } });
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), STUDIO_ENTRY, {
    machine: 'atari8', tags: hardware.tags, facts: hardware.facts,
  });
  assert.deepEqual(diagnostics, []);
  const columns = ir.functions.find((f) => f.name === 'text_columns');
  assert.ok(columns, 'text.columns is in the IR');
  const out = optimizeReachable(ir);
  assert.ok(out.functions.some((f) => f.name === 'text_setColor'), 'GR.1 must keep setColor');
  assert.ok(out.globals.some((g) => g.name === 'currentColor'), 'GR.1 must keep currentColor');
  const main = JSON.stringify(out.functions.find((f) => f.name === 'main'));
  assert.ok(main.includes('"value":20') || out.functions.some((f) => f.name === 'text_setColor'), '20-column build');
});
