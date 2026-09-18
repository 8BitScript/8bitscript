import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lower } from './index.ts';
import type { IrStatement, IrExpr, LowerOptions, FunctionSite } from './index.ts';
import { LocalAllocator } from './allocator.ts';
import { assemble } from '../asm/assemble.ts';
import { assembleRelaxed } from '../asm/relax.ts';
import type { Directive } from '../asm/assemble.ts';

// Same shape as lower/index.test.ts's own private ctx(), plus the
// provenance fields that test file never needed (see its own
// "origin-tagged block" test, unaffected by this: fnName absent there
// keeps emit() from stamping anything, exactly like before this file
// existed).
function ctx(overrides: Partial<LowerOptions> = {}): LowerOptions {
  return {
    globals: new Map(), locals: new LocalAllocator(0x90, 0x100), params: [],
    functions: new Map<string, FunctionSite>(), arrays: new Map(),
    ...overrides,
  };
}

const u8 = (value: number): IrExpr => ({ kind: 'const', value, type: 'utinyint' });
const ref = (name: string, type = 'utinyint'): IrExpr => ({ kind: 'ref', name, type });
const bin = (operator: string, left: IrExpr, right: IrExpr, type = 'utinyint'): IrExpr => ({ kind: 'binop', operator, left, right, type });

test('source -> instruction mapping: every instruction score += 1 lowers to carries the assignment\'s own span and file', () => {
  // `score += 1;` at columns/offsets the checker would report — the front
  // end folds a compound assignment into a binop by the time this IR
  // exists (mos/AGENTS.md's calling-convention note), so this is exactly
  // the IR shape a real `score += 1;` produces.
  const assignScore: IrStatement = {
    kind: 'assign', target: 'score', value: bin('+', ref('score'), u8(1)), start: 1482, length: 10,
  };
  const result = lower([assignScore], ctx({
    globals: new Map([['score', { address: 0x18, type: 'utinyint' }]]),
    fnName: 'updateScore', fnFile: 'src/game.8bs',
  }));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  // result.parts is exactly this one statement's own slice of the
  // program — result.program also carries the function's trailing exit
  // label, which legitimately has no source statement of its own.
  assert.equal(result.parts.length, 1);
  assert.ok(result.parts[0].program.length > 0);
  for (const directive of result.parts[0].program) {
    assert.ok(directive.prov, `every directive should carry provenance, got ${JSON.stringify(directive)}`);
    assert.equal(directive.prov!.function, 'updateScore');
    assert.deepEqual(directive.prov!.source, { file: 'src/game.8bs', start: 1482, length: 10 });
    assert.equal(directive.prov!.origin, null);
  }
  const assembled = assemble(result.program, 0xc142);
  assert.equal(assembled.ok, true, assembled.ok ? '' : assembled.error);
  if (!assembled.ok) return;
  // score is at zero page $18, so `score += 1` is 6502's own INC $18
  // idiom (mos/AGENTS.md, "0.2.3: what fitting 2048 on a 4K PET forced")
  // rather than a separate load/add/store — one instruction, and the
  // listing line for it carries the same provenance the directive did.
  const inc = assembled.listing.find((l) => l.text.startsWith('INC'));
  assert.ok(inc, `expected an INC in the listing, got ${JSON.stringify(assembled.listing)}`);
  assert.deepEqual(inc!.prov?.source, { file: 'src/game.8bs', start: 1482, length: 10 });
});

test('function attribution: two statements in two different functions each name their own function', () => {
  const one = lower([{ kind: 'assign', target: 'x', value: u8(1), start: 10, length: 5 }], ctx({
    globals: new Map([['x', { address: 0x18, type: 'utinyint' }]]),
    fnName: 'first', fnFile: 'a.8bs',
  }));
  const two = lower([{ kind: 'assign', target: 'x', value: u8(2), start: 20, length: 5 }], ctx({
    globals: new Map([['x', { address: 0x18, type: 'utinyint' }]]),
    fnName: 'second', fnFile: 'a.8bs',
  }));
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  if (!one.ok || !two.ok) return;
  assert.ok(one.program.every((d) => d.prov?.function === 'first'));
  assert.ok(two.program.every((d) => d.prov?.function === 'second'));
});

test('inlining: a statement inside an origin-tagged block keeps its own span, resolved against the origin function\'s own file, plus the origin name', () => {
  // Mirrors exactly what the real inliner (linker/optimize.mjs) produces:
  // `{ kind: 'block', origin: callee.name, body: clonedCalleeBody }`,
  // spliced into the caller's own body — the caller is `updatePlayer` in
  // game.8bs, `clampPosition`'s own body statement still carries physics.8bs
  // offsets, because structuredClone (optimize.mjs's clone()) never
  // touches start/length.
  const inlined: IrStatement = {
    kind: 'block',
    origin: 'clampPosition',
    body: [{ kind: 'assign', target: 'x', value: u8(0), start: 40, length: 12 }],
  };
  const result = lower([inlined], ctx({
    globals: new Map([['x', { address: 0x20, type: 'utinyint' }]]),
    fnName: 'updatePlayer',
    fnFile: 'src/game.8bs',
    originFiles: new Map([['clampPosition', 'src/physics.8bs']]),
  }));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0].origin, 'clampPosition');
  assert.ok(result.parts[0].program.length > 0);
  for (const directive of result.parts[0].program) {
    assert.equal(directive.prov!.function, 'updatePlayer', 'the enclosing function is where the bytes physically live');
    assert.equal(directive.prov!.origin, 'clampPosition', 'the logical function the block came from before inlining');
    assert.deepEqual(directive.prov!.source, { file: 'src/physics.8bs', start: 40, length: 12 }, 'the span resolves against the ORIGIN function\'s own file, not the caller\'s');
  }
});

test('inlining: once the inlined block ends, origin reverts for the caller\'s own following statements', () => {
  const result = lower([
    { kind: 'block', origin: 'helper', body: [{ kind: 'assign', target: 'x', value: u8(0), start: 1, length: 1 }] },
    { kind: 'assign', target: 'x', value: u8(2), start: 100, length: 1 },
  ], ctx({
    globals: new Map([['x', { address: 0x20, type: 'utinyint' }]]),
    fnName: 'caller', fnFile: 'game.8bs',
    originFiles: new Map([['helper', 'other.8bs']]),
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const afterInline = result.program.filter((d) => d.prov?.source?.start === 100);
  assert.ok(afterInline.length > 0);
  for (const d of afterInline) {
    assert.equal(d.prov!.origin, null);
    assert.deepEqual(d.prov!.source, { file: 'game.8bs', start: 100, length: 1 });
  }
});

test('branch relaxation: the replacement instructions inherit the original branch\'s own provenance, tagged as compiler-generated', () => {
  // A while(cond) { ...lots of instructions... } whose own body is bigger
  // than a relative branch's +-127 byte reach, forcing relax.ts to fire —
  // the same forcing technique relax.test.ts already uses (many .byte
  // padding directives between the branch and its target).
  const filler: Directive[] = [];
  for (let i = 0; i < 40; i += 1) filler.push({ kind: 'byte', values: [0, 0, 0, 0] });
  const branchProv = { source: { file: 'game.8bs', start: 5, length: 3 }, function: 'loop', origin: null, component: null, instance: null };
  const program: Directive[] = [
    { kind: 'instruction', mnemonic: 'BEQ', mode: 'relative', operand: { kind: 'label', name: 'target' }, prov: branchProv },
    ...filler,
    { kind: 'label', name: 'target' },
  ];
  const result = assembleRelaxed(program, 0x1000);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) return;
  const relaxedBranch = result.listing.find((l) => l.text.startsWith('BNE'));
  const jmp = result.listing.find((l) => l.text.startsWith('JMP'));
  assert.ok(relaxedBranch, 'the inverted branch should be in the listing');
  assert.ok(jmp, 'the long JMP should be in the listing');
  for (const line of [relaxedBranch!, jmp!]) {
    assert.deepEqual(line.prov?.source, branchProv.source, 'still attributed to the original BEQ\'s own source');
    assert.equal(line.prov?.function, 'loop');
    assert.deepEqual(line.prov?.generated, { reason: 'branch-relaxation' });
  }
});

test('determinism: lowering the same statements twice produces byte-identical programs, provenance included', () => {
  const body: IrStatement[] = [
    { kind: 'assign', target: 'x', value: bin('+', ref('x'), u8(1)), start: 7, length: 9 },
  ];
  const options = (): LowerOptions => ctx({
    globals: new Map([['x', { address: 0x18, type: 'utinyint' }]]),
    fnName: 'tick', fnFile: 'game.8bs',
  });
  const a = lower(body, options());
  const b = lower(body, options());
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  // Not a.program itself: freshLabel() (lower/index.ts) counts across the
  // whole process, so two lower() calls never mint the same internal
  // label name even for identical input — same as any other compiler
  // that gensyms. What has to be deterministic is the actually observable
  // output: the assembled bytes, addresses, mnemonics, and provenance.
  const assembledA = assemble(a.program, 0x1000);
  const assembledB = assemble(b.program, 0x1000);
  assert.equal(assembledA.ok, true);
  assert.equal(assembledB.ok, true);
  if (!assembledA.ok || !assembledB.ok) return;
  assert.deepEqual(assembledA.listing, assembledB.listing);
  assert.deepEqual(assembledA.bytes, assembledB.bytes);
});
