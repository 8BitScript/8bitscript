// Which module lowers a picture for a --web build of a real machine.
//
// The wasm rail models a flat screen, not VERA: a Commander X16 build through
// it has no hardware sprites to hand a picture to, so it lowers pictures the
// way the web target does (eight row bytes a step, drawn as a glyph) instead of
// the VERA sprite format the native build wants. The cx16 package names that in
// "8bitscript".wasmMedia, and the build's internal `web` tag (build.mjs adds it
// for `--web`) says a build is such a one. A native build, and a machine that
// names no such module, keep their own lowering.
//
// packages/cli/test/web-cx16.test.mjs draws the result pixel for pixel; this
// half asks only which lowering ran, and needs no page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '@8bitscript/graphics-tools';
import { link } from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The `kind` byte each lowering gives a picture: the web's glyph is 0, the X16's VERA sprite 5.
const KIND_WEB_GLYPH = 0;
const KIND_CX16_VERA = 5;

const SPRITE = 'sprite dot {\n  source "./dot.png"\n  size 8x8\n  transparent auto\n}\n';
const PROGRAM = `import { dot } from "./dot.8bg";
import { graphics } from "@8bitscript/graphics";

export function main(): void {
    graphics.place(dot, 0, 0);
}
`;

function solid() {
  const rgba = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i += 1) rgba.set([255, 255, 255, 255], i * 4);
  return encodePng(8, 8, rgba);
}

/** The `kind` the program's picture was lowered to: the fourth argument of the generated meta() call. */
function kindOf(machine, tags) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-media-wasm-'));
  try {
    writeFileSync(join(dir, 'dot.png'), solid());
    writeFileSync(join(dir, 'dot.8bg'), SPRITE);
    const { ir, diagnostics } = link(PROGRAM, join(dir, 'main.8bs'), { machine, tags, facts: stockFacts(machine), checkout: CHECKOUT });
    assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [], `${machine} ${tags.join(',') || 'native'} links`);
    const bind = ir.functions.find((f) => f.name.endsWith('__8bs_media_bind_dot'));
    assert.ok(bind, 'the picture has a generated binder');
    const meta = bind.body.find((s) => s.kind === 'call' && /graphics_meta$/.test(s.name));
    assert.ok(meta, 'and it calls graphics.meta');
    return { kind: meta.args[3].value, messages: diagnostics.map((d) => d.message) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a native X16 build lowers a picture to a VERA sprite', () => {
  assert.equal(kindOf('cx16', []).kind, KIND_CX16_VERA);
});

test('a --web build of the X16 lowers it the way the web target does: a glyph, not a VERA sprite', () => {
  const web = kindOf('cx16', ['web']);
  assert.equal(web.kind, KIND_WEB_GLYPH);
  assert.ok(!web.messages.some((m) => /VERA/.test(m)), 'and nothing says it became a VERA sprite');
});

test('a machine that names no wasm lowering keeps its own on a --web build', () => {
  // The C64's pictures are sprite data (a kind of its own), never the web's glyph.
  const native = kindOf('c64', []).kind;
  assert.equal(kindOf('c64', ['web']).kind, native);
  assert.notEqual(native, KIND_WEB_GLYPH);
});
