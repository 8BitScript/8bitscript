// The 6502 backend's tests: the generated C as a deterministic string always,
// and a real compile to .prg when LLVM-MOS is installed (skipped, not failed,
// when it is not — CI without the SDK still runs the emitter tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tokenize, parse, lower } from '@8bitscript/compiler';
import { emitC, buildPrg } from '../src/index.mjs';

const irOf = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't').ir;
};

test('emits plain C for the milestone program', () => {
  const c = emitC(irOf('let x: u8 = 10;\nexport function main(): void { x = x + 1; }'));
  assert.match(c, /uint8_t x = 10;/);
  assert.match(c, /int main\(void\) \{/);
  assert.match(c, /x = \(x \+ 1\);/);
  assert.match(c, /return 0;/);
});

test('@address becomes a volatile pointer #define', () => {
  const c = emitC(irOf('@address(0x900F)\nlet vicColor: volatile<u8>;'));
  assert.match(c, /#define vicColor \(\*\(volatile uint8_t \*\)0x900F\)/);
});

test('calls emit with prototypes ahead of every definition', () => {
  // The linker puts the entry's functions first, so main may call a function
  // defined below it; without the prototype block the C would not compile.
  const c = emitC(irOf('export function main(): void { apply(); }\nexport function apply(): void { return; }'));
  assert.match(c, /void apply\(void\);/);
  assert.match(c, /apply\(\);/);
  assert.ok(c.indexOf('void apply(void);') < c.indexOf('int main(void)'));
});

test('asm6502 bodies pass through verbatim', () => {
  const c = emitC(irOf('export function f(): void { asm6502 { lda #$06\n sta $900f } }'));
  assert.match(c, /__asm__ volatile\(/);
  assert.match(c, /lda #\$06/);
});

test('IR with unresolved imports is refused, not dropped', async () => {
  const result = await buildPrg(
    irOf('import { limit } from "./lib.8bs";'),
    { machine: 'vic20', outFile: 'unused.prg' },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /unresolved imports/);
});

const HAS_SDK = process.env.LLVM_MOS_HOME
  && existsSync(join(process.env.LLVM_MOS_HOME, 'bin', 'mos-vic20-clang'));

test('the milestone program compiles to a real .prg', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-test-'));
  try {
    const outFile = join(scratch, 'm.prg');
    const result = await buildPrg(
      irOf('let x: u8 = 10;\nexport function main(): void { x = x + 1; }'),
      { machine: 'vic20', outFile },
    );
    assert.ok(result.ok, result.error);
    const prg = await readFile(outFile);
    // The first two bytes of a .prg are its load address: $1001, the BASIC
    // start of the unexpanded VIC-20 — the machine 8BitScript targets first.
    assert.equal(prg[0], 0x01);
    assert.equal(prg[1], 0x10);
    // The whole program has to fit the unexpanded machine's 3583 bytes.
    assert.ok(prg.length <= 3583, `prg is ${prg.length} bytes`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
