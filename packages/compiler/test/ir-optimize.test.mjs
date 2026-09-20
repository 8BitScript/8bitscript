// Constant-if folding, compile-time calls, and literal-print stores —
// packages/compiler/src/linker/optimize.mjs, the pass each backend runs
// after link() via optimizeReachable (prune, fold, prune).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { optimizeIr, optimizeReachable } from '../src/linker/optimize.mjs';

const constNum = (value, type = 'utinyint') => ({ kind: 'const', value, type });
const ref = (name, type = 'utinyint') => ({ kind: 'ref', name, type });
const bin = (operator, left, right, type = 'bool') => ({ kind: 'binop', operator, left, right, type });
const assign = (target, value) => ({ kind: 'assign', target, value });
const call = (name, args = []) => ({ kind: 'call', name, args, type: 'void' });
const ret = (value = null) => ({ kind: 'return', value });
function ifNode(test, then, elseBranch = null) {
  return { kind: 'if', test, then, else: elseBranch }; // NOSONAR: typescript:S7739 — 'then' is the IR field name
}

test('if (true) unwraps to its then-branch; if (false) drops', () => {
  const ir = {
    entry: 'main',
    functions: [{
      name: 'main',
      body: [
        ifNode(constNum(1, 'bool'), [assign('hit', constNum(1))]),
        ifNode(constNum(0, 'bool'), [assign('hit', constNum(2))]),
      ],
    }],
    globals: [],
  };
  const out = optimizeIr(ir);
  assert.deepEqual(out.functions[0].body, [assign('hit', constNum(1))]);
});

test('a const == const comparison folds, so a #fact branch costs the unused side nothing', () => {
  const ir = {
    entry: 'main',
    functions: [{
      name: 'main',
      body: [
        ifNode(bin('==', constNum(40), constNum(40)), [assign('hit', constNum(1))]),
        ifNode(bin('==', constNum(80), constNum(40)), [assign('hit', constNum(2))]),
      ],
    }],
    globals: [],
  };
  const out = optimizeIr(ir);
  assert.deepEqual(out.functions[0].body, [assign('hit', constNum(1))]);
});

test('statements after a definite return are dropped — the dead half of a folded if (true) { ... return; }', () => {
  const ir = {
    entry: 'asciiToScreenCode',
    functions: [{
      name: 'asciiToScreenCode',
      params: [{ name: 'code', type: 'utinyint' }],
      returnType: 'utinyint',
      body: [
        ifNode(constNum(1, 'bool'), [ret(constNum(1))]),
        ret(constNum(2)),
      ],
    }],
    globals: [],
  };
  const out = optimizeIr(ir);
  assert.deepEqual(out.functions[0].body, [ret(constNum(1))]);
});

test('a global that is never assigned becomes its initializer, so if (flag) with flag = false is gone', () => {
  const ir = {
    entry: 'main',
    functions: [{
      name: 'main',
      body: [
        ifNode(ref('currentReverse', 'bool'), [assign('hit', constNum(1))]),
        assign('ok', constNum(2)),
      ],
    }],
    globals: [{ name: 'currentReverse', type: 'bool', address: null, init: 0 }],
  };
  const out = optimizeIr(ir);
  assert.deepEqual(out.functions[0].body, [assign('ok', constNum(2))]);
});

test('a local of the same name as an immutable global is not replaced — shadowing still wins', () => {
  const ir = {
    entry: 'main',
    functions: [{
      name: 'main',
      body: [
        { kind: 'local', name: 'x', type: 'utinyint', init: constNum(7) },
        { kind: 'return', value: ref('x') },
      ],
    }],
    globals: [{ name: 'x', type: 'utinyint', address: null, init: 100 }],
  };
  const out = optimizeIr(ir);
  assert.equal(out.functions[0].body[1].value.kind, 'ref');
  assert.equal(out.functions[0].body[1].value.name, 'x');
});

test('unsigned constant arithmetic wraps at the type width — 250 + 10 as utinyint is 4', () => {
  const ir = {
    entry: 'main',
    functions: [{
      name: 'main',
      body: [ret({ kind: 'binop', operator: '+', left: constNum(250), right: constNum(10), type: 'utinyint' })],
    }],
    globals: [],
  };
  const out = optimizeIr(ir);
  assert.deepEqual(out.functions[0].body[0].value, constNum(4));
});

test('signed constant arithmetic is left alone — wraparound and the signed refusal still belong to the backend', () => {
  const ir = {
    entry: 'main',
    functions: [{
      name: 'main',
      body: [ret({ kind: 'binop', operator: '+', left: { kind: 'const', value: 5, type: 'tinyint' }, right: { kind: 'const', value: 3, type: 'tinyint' }, type: 'tinyint' })],
    }],
    globals: [],
  };
  const out = optimizeIr(ir);
  assert.equal(out.functions[0].body[0].value.kind, 'binop');
  assert.equal(out.functions[0].body[0].value.operator, '+');
});

test('optimizeIr does not mutate the input IR', () => {
  const body = [ifNode(constNum(1, 'bool'), [assign('hit', constNum(1))])];
  const ir = { entry: 'main', functions: [{ name: 'main', body }], globals: [] };
  optimizeIr(ir);
  assert.equal(ir.functions[0].body.length, 1);
  assert.equal(ir.functions[0].body[0].kind, 'if');
});

test('a write in an unreachable function does not keep a global mutable — prune, fold, prune', () => {
  const ir = {
    entry: 'main',
    functions: [
      {
        name: 'main',
        body: [
          ifNode(ref('currentReverse', 'bool'), [assign('hit', constNum(1))]),
          assign('ok', constNum(2)),
        ],
      },
      { name: 'setReverse', body: [assign('currentReverse', constNum(1, 'bool'))] },
    ],
    globals: [{ name: 'currentReverse', type: 'bool', address: null, init: 0 }],
  };
  const out = optimizeReachable(ir);
  assert.deepEqual(out.functions.map((f) => f.name), ['main']);
  assert.deepEqual(out.functions[0].body, [assign('ok', constNum(2))]);
  assert.deepEqual(out.globals, []);
});

test('asciiToScreenCode of a constant is the mapped byte — no runtime conversion', () => {
  const ir = {
    entry: 'main',
    functions: [
      { name: 'main', returnType: 'utinyint', body: [ret({ kind: 'call', name: 'asciiToScreenCode', args: [constNum(101)], type: 'utinyint' })] },
      {
        name: 'asciiToScreenCode',
        params: [{ name: 'code', type: 'utinyint' }],
        returnType: 'utinyint',
        body: [
          ifNode(
            bin('&&', bin('>=', ref('code'), constNum(97)), bin('<', ref('code'), constNum(123))),
            [ret({ kind: 'binop', operator: '-', left: ref('code'), right: constNum(96), type: 'utinyint' })],
          ),
          ret(ref('code')),
        ],
      },
    ],
    globals: [],
  };
  const out = optimizeIr(ir);
  assert.deepEqual(out.functions[0].body, [ret(constNum(5))]);
});

test('a call to an empty void function is dropped, so a no-op capability costs nothing', () => {
  const ir = {
    entry: 'main',
    functions: [
      { name: 'main', body: [call('setColor', [constNum(1)])] },
      { name: 'setColor', params: [{ name: 'color', type: 'utinyint' }], returnType: 'void', body: [] },
    ],
    globals: [],
  };
  const out = optimizeReachable(ir);
  assert.deepEqual(out.functions.map((f) => f.name), ['main']);
  assert.deepEqual(out.functions[0].body, []);
});

test('dropping an empty setColor also drops the color table it indexed', () => {
  const ir = {
    entry: 'main',
    functions: [
      {
        name: 'main',
        body: [call('setColor', [{
          kind: 'index',
          array: ref('TILE_COLOR'),
          index: constNum(0),
          type: 'utinyint',
        }])],
      },
      { name: 'setColor', params: [{ name: 'color', type: 'utinyint' }], returnType: 'void', body: [] },
    ],
    globals: [{ name: 'TILE_COLOR', type: 'utinyint', array: 12, constant: true, init: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }],
  };
  const out = optimizeReachable(ir);
  assert.deepEqual(out.functions.map((f) => f.name), ['main']);
  assert.deepEqual(out.globals, []);
});

test('an empty void call with a side-effecting argument stays, so the argument still runs', () => {
  const ir = {
    entry: 'main',
    functions: [
      {
        name: 'main',
        body: [call('setColor', [{
          kind: 'memoryRead',
          address: constNum(0, 'usmallint'),
          type: 'utinyint',
        }])],
      },
      { name: 'setColor', params: [{ name: 'color', type: 'utinyint' }], returnType: 'void', body: [] },
    ],
    globals: [],
  };
  const out = optimizeIr(ir);
  assert.equal(out.functions[0].body[0].kind, 'call');
  assert.equal(out.functions[0].body[0].name, 'setColor');
});

test('print of a string literal at a constant cell becomes stores of converted bytes', () => {
  const hi = { kind: 'string', index: 0, type: 'string' };
  const ir = {
    entry: 'main',
    strings: [{ text: 'Hi', bytes: [72, 105] }],
    functions: [
      { name: 'main', body: [call('print', [{ kind: 'const', value: 0, type: 'usmallint' }, hi])] },
      {
        name: 'print',
        params: [{ name: 'cell', type: 'usmallint' }, { name: 's', type: 'string' }],
        returnType: 'void',
        body: [{
          kind: 'for',
          init: { kind: 'local', name: 'i', type: 'utinyint', init: constNum(0) },
          test: bin('<', ref('i'), { kind: 'stringLength', string: ref('s', 'string'), type: 'utinyint' }),
          update: assign('i', { kind: 'binop', operator: '+', left: ref('i'), right: constNum(1), type: 'utinyint' }),
          body: [call('place', [
            { kind: 'binop', operator: '+', left: ref('cell', 'usmallint'), right: ref('i'), type: 'usmallint' },
            { kind: 'stringByte', string: ref('s', 'string'), index: ref('i'), type: 'utinyint' },
          ])],
        }],
      },
      {
        name: 'place',
        params: [{ name: 'cell', type: 'usmallint' }, { name: 'code', type: 'utinyint' }],
        returnType: 'void',
        body: [{
          kind: 'memoryWrite',
          address: { kind: 'binop', operator: '+', left: { kind: 'const', value: 0x8000, type: 'usmallint' }, right: ref('cell', 'usmallint'), type: 'usmallint' },
          value: { kind: 'call', name: 'toScreen', args: [ref('code')], type: 'utinyint' },
        }],
      },
      {
        name: 'toScreen',
        params: [{ name: 'code', type: 'utinyint' }],
        returnType: 'utinyint',
        body: [ret({ kind: 'call', name: 'asciiToScreenCode', args: [ref('code')], type: 'utinyint' })],
      },
      {
        name: 'asciiToScreenCode',
        params: [{ name: 'code', type: 'utinyint' }],
        returnType: 'utinyint',
        body: [
          ifNode(
            bin('&&', bin('>=', ref('code'), constNum(97)), bin('<', ref('code'), constNum(123))),
            [ret({ kind: 'binop', operator: '-', left: ref('code'), right: constNum(96), type: 'utinyint' })],
          ),
          ret(ref('code')),
        ],
      },
    ],
    globals: [],
  };
  const out = optimizeReachable(ir);
  assert.deepEqual(out.functions.map((f) => f.name), ['main']);
  assert.equal(out.functions[0].body.length, 1);
  assert.equal(out.functions[0].body[0].kind, 'block');
  assert.equal(out.functions[0].body[0].origin, 'print');
  // Each store sits in its own `place` block: rule 9 wrote place() into
  // print()'s loop before main unrolled it, and a block is where an
  // inlined body's locals are scoped — none here, so the bytes are the
  // same eleven stores they always were.
  const flatten = (statements) => statements.flatMap((s) => (s.kind === 'block' ? flatten(s.body) : [s]));
  const stores = flatten(out.functions[0].body[0].body);
  assert.equal(stores.length, 2);
  assert.equal(stores[0].kind, 'memoryWrite');
  assert.equal(stores[0].address.value, 0x8000);
  assert.equal(stores[0].value.value, 72);
  assert.equal(stores[1].address.value, 0x8001);
  assert.equal(stores[1].value.value, 9); // 'i' 105 - 96
});

test('a counted for-loop that is not a string copy stays a loop', () => {
  const ir = {
    entry: 'main',
    functions: [{
      name: 'main',
      body: [{
        kind: 'for',
        init: { kind: 'local', name: 'i', type: 'utinyint', init: constNum(0) },
        test: bin('<', ref('i'), constNum(10)),
        update: assign('i', { kind: 'binop', operator: '+', left: ref('i'), right: constNum(1), type: 'utinyint' }),
        body: [assign('hit', ref('i'))],
      }],
    }],
    globals: [],
  };
  const out = optimizeIr(ir);
  assert.equal(out.functions[0].body.length, 1);
  assert.equal(out.functions[0].body[0].kind, 'for');
});

test('a parameter only an asm6502 block names is not unused: the call stays, with its argument passed', () => {
  // mos/lower's frameOperand lets the block read `s` as its zero-page
  // slot; the optimizer cannot see into the text, so the text counts as
  // reading every parameter — otherwise rule 6 would paste the body in
  // with `s` never bound, and the block's `lda s` would name nothing.
  const ir = {
    entry: 'main',
    functions: [
      { name: 'main', body: [call('print', [constNum(0, 'usmallint'), { kind: 'string', index: 0, type: 'string' }])] },
      {
        name: 'print',
        params: [{ name: 'cell', type: 'usmallint' }, { name: 's', type: 'string' }],
        returnType: 'void',
        body: [{ kind: 'asm', text: '    lda s\n    ldx s+1\n    jsr __8bs_c64_text_print' }],
      },
    ],
    globals: [],
    strings: [{ text: 'HI', bytes: [72, 73] }],
  };
  const out = optimizeReachable(ir);
  assert.deepEqual(out.functions.map((f) => f.name), ['main', 'print']);
  assert.equal(out.functions[0].body[0].kind, 'call');
  assert.equal(out.functions[0].body[0].args.length, 2);
});

test('a parameterless void body an asm6502 block names a local of is pasted in whole — the local and the block together', () => {
  const ir = {
    entry: 'main',
    functions: [
      { name: 'main', body: [call('flash', [])] },
      { name: 'flash', params: [], returnType: 'void', body: [local('c', 'utinyint', constNum(3)), { kind: 'asm', text: '    lda c\n    sta $D020' }] },
    ],
    globals: [],
  };
  const out = optimizeReachable(ir);
  const main = out.functions.find((fn) => fn.name === 'main');
  assert.equal(main.body[0].kind, 'block');
  assert.equal(main.body[0].body[0].kind, 'local');
  assert.equal(main.body[0].body[0].name, 'c', 'the local the block reads by name is still declared where the block is');
  assert.equal(main.body[0].body[1].kind, 'asm');
});

test('a single-site void call whose parameters are unused is the body — PET blank color args', () => {
  const ir = {
    entry: 'main',
    functions: [
      { name: 'main', body: [call('blank', [constNum(0), constNum(0)])] },
      {
        name: 'blank',
        params: [{ name: 'border', type: 'utinyint' }, { name: 'background', type: 'utinyint' }],
        returnType: 'void',
        body: [{ kind: 'memoryWrite', address: { kind: 'const', value: 0x8000, type: 'usmallint' }, value: constNum(32) }],
      },
    ],
    globals: [],
  };
  const out = optimizeReachable(ir);
  assert.deepEqual(out.functions.map((f) => f.name), ['main']);
  assert.equal(out.functions[0].body[0].kind, 'block');
  assert.equal(out.functions[0].body[0].origin, 'blank');
  assert.equal(out.functions[0].body[0].body[0].kind, 'memoryWrite');
  assert.equal(out.functions[0].body[0].body[0].value.value, 32);
});

// ---- 0.2.2: the new operators fold, constant multiplies reduce to shifts,
// and a body with a `return` never inlines ------------------------------------

test('the 0.2.2 operators fold between constants, wrapping at the declared width', () => {
  const cases = [
    ['*', 6, 7, 42],
    ['/', 42, 5, 8],
    ['%', 42, 5, 2],
    ['&', 0xc5, 0x1f, 0x05],
    ['|', 0xc0, 0x0f, 0xcf],
    ['^', 0xff, 0x0f, 0xf0],
    ['<<', 3, 2, 12],
    ['>>', 40, 3, 5],
  ];
  for (const [operator, left, right, expected] of cases) {
    const ir = {
      entry: 'main',
      functions: [{ name: 'main', body: [assign('out', bin(operator, constNum(left), constNum(right), 'utinyint'))] }],
      globals: [],
    };
    const out = optimizeIr(ir);
    assert.deepEqual(out.functions[0].body[0].value, constNum(expected), `${left} ${operator} ${right}`);
  }
  // The wrap: 20 * 20 as a utinyint is 144, the same answer the backends produce.
  const wrapped = optimizeIr({
    entry: 'main',
    functions: [{ name: 'main', body: [assign('out', bin('*', constNum(20), constNum(20), 'utinyint'))] }],
    globals: [],
  });
  assert.deepEqual(wrapped.functions[0].body[0].value, constNum(144));
});

test('dividing or reducing modulo zero never folds — the runtime shape stays the backend\'s own call', () => {
  for (const operator of ['/', '%']) {
    const ir = {
      entry: 'main',
      functions: [{ name: 'main', body: [assign('out', bin(operator, constNum(4), constNum(0), 'utinyint'))] }],
      globals: [],
    };
    const out = optimizeIr(ir);
    assert.equal(out.functions[0].body[0].value.kind, 'binop');
  }
});

test('a multiply by a power of two becomes one shift; a two-set-bit constant with a ref becomes two shifts and an add', () => {
  const pow2 = optimizeIr({
    entry: 'main',
    functions: [{ name: 'main', body: [assign('out', bin('*', ref('row'), constNum(4), 'utinyint'))] }],
    globals: [],
  });
  const shifted = pow2.functions[0].body[0].value;
  assert.equal(shifted.operator, '<<');
  assert.deepEqual(shifted.right, constNum(2));

  const twoBits = optimizeIr({
    entry: 'main',
    functions: [{ name: 'main', body: [assign('out', bin('*', ref('y', 'usmallint'), constNum(40, 'usmallint'), 'usmallint'))] }],
    globals: [],
  });
  const sum = twoBits.functions[0].body[0].value; // 40 = 32 + 8: (y << 5) + (y << 3)
  assert.equal(sum.operator, '+');
  assert.equal(sum.left.operator, '<<');
  assert.deepEqual(sum.left.right, constNum(5));
  assert.deepEqual(sum.right.right, constNum(3));

  // A two-set-bit constant over anything with work in it stays a multiply:
  // the rewrite duplicates its operand.
  const notARef = optimizeIr({
    entry: 'main',
    functions: [{ name: 'main', body: [assign('out', bin('*', bin('+', ref('a'), ref('b'), 'utinyint'), constNum(6), 'utinyint'))] }],
    globals: [],
  });
  assert.equal(notARef.functions[0].body[0].value.operator, '*');
});

test('x * 1 is x; x * 0 folds only for a bare ref, never over a call whose work would vanish', () => {
  const one = optimizeIr({
    entry: 'main',
    functions: [{ name: 'main', body: [assign('out', bin('*', ref('x'), constNum(1), 'utinyint'))] }],
    globals: [],
  });
  assert.deepEqual(one.functions[0].body[0].value, ref('x'));

  const zeroRef = optimizeIr({
    entry: 'main',
    functions: [{ name: 'main', body: [assign('out', bin('*', ref('x'), constNum(0), 'utinyint'))] }],
    globals: [],
  });
  assert.deepEqual(zeroRef.functions[0].body[0].value, constNum(0, 'utinyint'));

  const zeroCall = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [assign('out', bin('*', { kind: 'call', name: 'roll', args: [], type: 'utinyint' }, constNum(0), 'utinyint'))] },
      { name: 'roll', params: [], returnType: 'utinyint', body: [assign('g', constNum(1)), ret(constNum(0))] },
    ],
    globals: [{ name: 'g', type: 'utinyint', address: null, init: 0 }],
  });
  // roll() has one caller, so rule 9 writes its body ahead of the
  // assignment: the store to g runs, and what is left is `0 * 0`, which
  // folds. The work did not vanish; the call did.
  assert.deepEqual(zeroCall.functions[0].body, [{ kind: 'block', origin: 'roll', body: [assign('g', constNum(1)), assign('out', constNum(0, 'utinyint'))] }]);
});

test('a void callee with a return anywhere in its body is never inlined — the pasted return would leave the CALLER (2048\'s own spawnTile)', () => {
  const ir = {
    entry: 'main',
    functions: [
      { name: 'main', body: [call('spawn'), assign('after', constNum(1))] },
      {
        name: 'spawn',
        params: [],
        returnType: 'void',
        body: [
          ifNode(bin('==', ref('g'), constNum(0)), [ret()]),
          assign('g', constNum(9)),
        ],
      },
    ],
    globals: [{ name: 'g', type: 'utinyint', address: null, init: 0 }],
  };
  const out = optimizeIr(ir);
  assert.deepEqual(out.functions[0].body[0], call('spawn'), 'the call survives as a call');
});

// ---- a body more than one place calls is not written out once per call ------

// Eleven nodes or so: past INLINE_DUPLICATE_NODE_LIMIT without being large.
const wideBody = () => [
  assign('a', bin('+', ref('a'), constNum(1), 'utinyint')),
  assign('b', bin('+', ref('b'), constNum(2), 'utinyint')),
  assign('c', bin('+', ref('c'), constNum(3), 'utinyint')),
];

test('a parameterless void body stays a call when more than one place calls it — four copies of poll() is what this costs', () => {
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('poll'), call('poll')] },
      { name: 'poll', body: wideBody() },
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(
    body.map((statement) => statement.kind),
    ['call', 'call'],
    'both call sites stay calls rather than each carrying a copy of the body',
  );
  assert.ok(
    ir.functions.some((fn) => fn.name === 'poll'),
    'the callee survives for those calls to reach',
  );
});

test('one call site still inlines a body of any size — nothing is duplicated, so there is nothing to weigh', () => {
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('once')] },
      { name: 'once', body: wideBody() },
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.equal(body[0].kind, 'block', 'the single call is replaced by the body');
  assert.equal(body[0].origin, 'once');
});

test('a body that passes values along stays a call at several sites — each copy pays the loads and stores again', () => {
  // Five nodes, but three of them are arguments: pasted at three sites
  // this cost 2048's PET 2001 build 54 bytes where the call and its body
  // cost 31 (the board's Board(): the HUD's three values, then the tiles).
  const board = () => [call('drawHud', [ref('score', 'usmallint'), ref('over', 'bool'), ref('won', 'bool')]), call('tiles')];
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('board'), call('board'), call('board')] },
      { name: 'board', params: [], returnType: 'void', body: board() },
      { name: 'tiles', params: [], returnType: 'void', body: wideBody() },
      { name: 'drawHud', params: [{ name: 'score', type: 'usmallint' }, { name: 'over', type: 'bool' }, { name: 'won', type: 'bool' }], returnType: 'void', body: wideBody() },
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(body.map((statement) => statement.kind), ['call', 'call', 'call'], 'the three sites stay calls');
  assert.ok(ir.functions.some((fn) => fn.name === 'board'), 'the callee survives for them to reach');
});

test('a helper whose other callers fold away is inlined into the one left — prune, fold, prune, fold, prune', () => {
  // On a machine without the RAM for it the animated move folds away
  // (`if (false)`), and the repaint it shared with the settled board has
  // one live caller. The first round counted two and kept it a call.
  const ir = optimizeReachable({
    entry: 'main',
    functions: [
      { name: 'main', body: [ifNode(constNum(0, 'bool'), [call('animate')]), call('board'), call('board')] },
      { name: 'animate', params: [], returnType: 'void', body: [call('tiles'), assign('a', constNum(4))] },
      { name: 'board', params: [], returnType: 'void', body: [call('drawHud', [ref('score', 'usmallint'), ref('over', 'bool'), ref('won', 'bool')]), call('tiles')] },
      { name: 'tiles', params: [], returnType: 'void', body: wideBody() },
      { name: 'drawHud', params: [{ name: 'score', type: 'usmallint' }, { name: 'over', type: 'bool' }, { name: 'won', type: 'bool' }], returnType: 'void', body: wideBody() },
    ],
    globals: [],
  });
  assert.ok(!ir.functions.some((fn) => fn.name === 'animate'), 'the folded caller is gone');
  const board = ir.functions.find((fn) => fn.name === 'board');
  assert.deepEqual(board.body.map((statement) => statement.kind), ['block', 'block'], 'the tiles are written into the board, their one live caller — and so is the HUD, called from nowhere else (rule 9)');
  assert.deepEqual(board.body.map((statement) => statement.origin), ['drawHud', 'tiles']);
  assert.ok(!ir.functions.some((fn) => fn.name === 'tiles'), 'and nothing else needs the function');
});

test('a small body still inlines at several call sites — it is cheaper than the call it replaces', () => {
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('tick'), call('tick')] },
      { name: 'tick', body: [assign('a', constNum(1))] },
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(
    body.map((statement) => statement.kind),
    ['block', 'block'],
    'both sites take the body',
  );
});

// ---- rewrite 8: forwarders ---------------------------------------------------
//
// A body that is one call passing the function's own parameters through is
// that call at every site, run-time arguments and all: the site's argument
// stores go to the callee's slots instead of the forwarder's, and the
// forwarder's copies, jsr and rts are gone. 2048 #49 measured the wrapper
// at +36 bytes on the PET 2001 and the VIC-20; this is the rule that
// makes it zero.

const drawTileParams = () => [{ name: 'r', type: 'utinyint' }, { name: 'c', type: 'utinyint' }, { name: 'e', type: 'utinyint' }];
const runtime = (name) => ref(name, 'utinyint');
// A second caller of `name`, so the callee has two sites and rule 9 (one
// site: the body goes into the caller) leaves it a function these tests
// can see the forwarder rule point at. Its arguments are hardware reads —
// a side effect at every position — so this site is never itself
// forwarded away by rule 8 (a reorder or a drop would refuse it).
// A second statement keeps this caller from being a forwarder itself (a
// forwarder's sites are the callee's, and this one has none).
const elsewhere = (name, arity) => ({ name: `${name}Elsewhere`, params: [], returnType: 'void', body: [call(name, Array.from({ length: arity }, (_, i) => ({ kind: 'read', address: constNum(0xe800 + i, 'usmallint'), type: 'utinyint' }))), { kind: 'memoryWrite', address: constNum(0x8fff, 'usmallint'), value: constNum(1) }] });

test('a void forwarder is the call it wraps at every site, with run-time arguments — and the wrapper is pruned', () => {
  const ir = optimizeReachable({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('Tile', [runtime('x'), runtime('y'), runtime('z')]), call('Tile', [constNum(1), runtime('y'), bin('+', runtime('z'), constNum(1), 'utinyint')]), call('Tile', [runtime('a'), runtime('b'), runtime('c')])] },
      { name: 'Tile', component: true, params: [{ name: 'row', type: 'utinyint' }, { name: 'col', type: 'utinyint' }, { name: 'exponent', type: 'utinyint' }], returnType: 'void', body: [call('drawTile', [ref('row'), ref('col'), ref('exponent')])] },
      { name: 'drawTile', params: drawTileParams(), returnType: 'void', body: wideBody() },
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(body.map((statement) => statement.name), ['drawTile', 'drawTile', 'drawTile'], 'each site calls the callee directly');
  assert.deepEqual(body[1].args, [constNum(1), runtime('y'), bin('+', runtime('z'), constNum(1), 'utinyint')], "the site's own arguments, expressions included");
  assert.ok(!ir.functions.some((fn) => fn.name === 'Tile'), 'nothing calls the wrapper any more');
  assert.ok(ir.functions.some((fn) => fn.name === 'drawTile'), 'the callee is still one function');
});

test('a forwarder may reorder its parameters — the arguments land where the callee expects them', () => {
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('Swapped', [runtime('x'), runtime('y')])] },
      { name: 'Swapped', params: [{ name: 'a', type: 'utinyint' }, { name: 'b', type: 'utinyint' }], returnType: 'void', body: [call('draw', [ref('b'), ref('a')])] },
      { name: 'draw', params: [{ name: 'p', type: 'utinyint' }, { name: 'q', type: 'utinyint' }], returnType: 'void', body: wideBody() },
      elsewhere('draw', 2),
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(body[0].name, 'draw');
  assert.deepEqual(body[0].args, [runtime('y'), runtime('x')]);
});

test('a reordering forwarder keeps the call when an argument has a side effect — the order they run in would change (spec §104)', () => {
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('Swapped', [{ kind: 'call', name: 'readPort', args: [], type: 'utinyint' }, runtime('y')])] },
      { name: 'Swapped', params: [{ name: 'a', type: 'utinyint' }, { name: 'b', type: 'utinyint' }], returnType: 'void', body: [call('draw', [ref('b'), ref('a')])] },
      { name: 'draw', params: [{ name: 'p', type: 'utinyint' }, { name: 'q', type: 'utinyint' }], returnType: 'void', body: wideBody() },
      { name: 'readPort', params: [], returnType: 'utinyint', body: [ret({ kind: 'read', address: constNum(0xe810, 'usmallint'), type: 'utinyint' })] },
      // readPort() has a second site too, or rule 9 hoists its one read into
      // a local ahead of the call — which is right, and leaves nothing here
      // with a side effect for the reorder refusal to refuse.
      elsewhere('Swapped', 2),
      elsewhere('readPort', 0),
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.equal(body[0].name, 'Swapped', 'stays a call to the wrapper');
});

test('a forwarder that drops a parameter keeps the call when that argument has a side effect', () => {
  const functions = (arg) => [
    { name: 'main', body: [call('Partial', [runtime('x'), arg])] },
    { name: 'Partial', params: [{ name: 'a', type: 'utinyint' }, { name: 'unused', type: 'utinyint' }], returnType: 'void', body: [call('draw', [ref('a')])] },
    { name: 'draw', params: [{ name: 'p', type: 'utinyint' }], returnType: 'void', body: wideBody() },
    { name: 'readPort', params: [], returnType: 'utinyint', body: [ret({ kind: 'read', address: constNum(0xe810, 'usmallint'), type: 'utinyint' })] },
    elsewhere('Partial', 2),
    elsewhere('readPort', 0),
  ];
  const kept = optimizeIr({ entry: 'main', functions: functions({ kind: 'call', name: 'readPort', args: [], type: 'utinyint' }), globals: [] });
  assert.equal(kept.functions.find((fn) => fn.name === 'main').body[0].name, 'Partial', 'the read would vanish with the parameter');
  const dropped = optimizeIr({ entry: 'main', functions: functions(runtime('y')), globals: [] });
  const body = dropped.functions.find((fn) => fn.name === 'main').body;
  assert.equal(body[0].name, 'draw', 'a plain value is simply not passed');
  assert.deepEqual(body[0].args, [runtime('x')]);
});

test('a `return f(x);` forwarder is `f(x)` in the expression that called it — 2048\'s rng.range() delegate, +8 bytes on five targets before', () => {
  const ir = optimizeReachable({
    entry: 'main',
    functions: [
      { name: 'main', body: [assign('t', { kind: 'call', name: 'range', args: [runtime('empties')], type: 'utinyint' }), assign('t', { kind: 'call', name: 'random_range', args: [runtime('t')], type: 'utinyint' })] },
      { name: 'range', params: [{ name: 'bound', type: 'utinyint' }], returnType: 'utinyint', body: [ret({ kind: 'call', name: 'random_range', args: [ref('bound')], type: 'utinyint' })] },
      { name: 'random_range', params: [{ name: 'bound', type: 'utinyint' }], returnType: 'utinyint', body: [ret(bin('%', { kind: 'call', name: 'random_next', args: [], type: 'utinyint' }, ref('bound'), 'utinyint'))] },
      { name: 'random_next', params: [], returnType: 'utinyint', body: [assign('seed', bin('+', ref('seed'), constNum(1), 'utinyint')), ret(ref('seed'))] },
    ],
    globals: [{ name: 'seed', type: 'utinyint', init: constNum(0) }, { name: 't', type: 'utinyint' }, { name: 'empties', type: 'utinyint' }],
  });
  const main = ir.functions.find((fn) => fn.name === 'main');
  assert.equal(main.body[0].value.name, 'random_range', 'the delegate is skipped');
  assert.deepEqual(main.body[0].value.args, [runtime('empties')]);
  assert.ok(!ir.functions.some((fn) => fn.name === 'range'), 'and pruned');
});

test('a forwarder whose return type differs from the call it returns stays a call — a conversion would be skipped', () => {
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [assign('t', { kind: 'call', name: 'wide', args: [runtime('x')], type: 'usmallint' })] },
      { name: 'wide', params: [{ name: 'b', type: 'utinyint' }], returnType: 'usmallint', body: [ret({ kind: 'call', name: 'narrow', args: [ref('b')], type: 'utinyint' })] },
      { name: 'narrow', params: [{ name: 'b', type: 'utinyint' }], returnType: 'utinyint', body: [ret(ref('b'))] },
      elsewhere('wide', 1),
    ],
    globals: [],
  });
  assert.equal(ir.functions.find((fn) => fn.name === 'main').body[0].value.name, 'wide');
});

test('`f(); return;` is two statements, not a forwarder — the idiom that keeps a helper a call still does', () => {
  // 2048's game.8bs: compressLine/mergeLine end in `return;` so that four
  // directions × two helpers are not pasted into main.
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('slide'), call('slide')] },
      { name: 'slide', params: [], returnType: 'void', body: [call('compress', [runtime('a')]), ret()] },
      { name: 'compress', params: [{ name: 'p', type: 'utinyint' }], returnType: 'void', body: wideBody() },
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(body.map((statement) => statement.name), ['slide', 'slide']);
});

test('passing a global through is not forwarding — each copy would load it again', () => {
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('board'), call('board'), call('board')] },
      { name: 'board', params: [], returnType: 'void', body: [call('drawHud', [ref('score', 'usmallint'), ref('over', 'bool'), ref('won', 'bool')])] },
      { name: 'drawHud', params: [{ name: 'score', type: 'usmallint' }, { name: 'over', type: 'bool' }, { name: 'won', type: 'bool' }], returnType: 'void', body: wideBody() },
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(body.map((statement) => statement.name), ['board', 'board', 'board']);
});

test('a literal the forwarder adds is free at one site, and worth it while the copies cost less than the stores the sites stop making', () => {
  const fixed = (sites) => ({
    entry: 'main',
    functions: [
      { name: 'main', body: Array.from({ length: sites }, () => call('Red', [runtime('x')])) },
      // One parameter forwarded, two literals added: at two sites that is
      // two extra literal stores against one parameter store saved.
      { name: 'Red', params: [{ name: 'at', type: 'utinyint' }], returnType: 'void', body: [call('paint', [ref('at'), constNum(2), constNum(7)])] },
      { name: 'paint', params: [{ name: 'at', type: 'utinyint' }, { name: 'fg', type: 'utinyint' }, { name: 'bg', type: 'utinyint' }], returnType: 'void', body: wideBody() },
      elsewhere('paint', 3),
    ],
    globals: [],
  });
  const one = optimizeIr(fixed(1)).functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(one[0].name, 'paint');
  assert.deepEqual(one[0].args, [runtime('x'), constNum(2), constNum(7)]);
  const two = optimizeIr(fixed(2)).functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(two.map((statement) => statement.name), ['Red', 'Red'], 'two copies of two literals cost more than the one store saved');
});

test('a forwarder of a forwarder ends at the callee, and a forwarder of an empty function is nothing', () => {
  const ir = optimizeReachable({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('Outer', [runtime('x')]), call('Color', [runtime('x')]), call('draw', [runtime('y')])] },
      { name: 'Outer', params: [{ name: 'a', type: 'utinyint' }], returnType: 'void', body: [call('Inner', [ref('a')])] },
      { name: 'Inner', params: [{ name: 'b', type: 'utinyint' }], returnType: 'void', body: [call('draw', [ref('b')])] },
      { name: 'draw', params: [{ name: 'p', type: 'utinyint' }], returnType: 'void', body: wideBody() },
      { name: 'Color', params: [{ name: 'c', type: 'utinyint' }], returnType: 'void', body: [call('setColor', [ref('c')])] },
      { name: 'setColor', params: [{ name: 'c', type: 'utinyint' }], returnType: 'void', body: [] },
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(body.map((statement) => statement.name), ['draw', 'draw'], 'one chain collapsed to its end, the other to nothing');
  assert.deepEqual(ir.functions.map((fn) => fn.name).sort(), ['draw', 'main']);
});

// ---- rule 9: a single caller ------------------------------------------------
//
// A function with exactly one live call site is written into it, whatever
// its size and its arguments — the body replaces the call, the argument
// stores, the frame and the rts. 2048 #51 paid +56/+84 bytes for a tile
// split into two lib primitives and an element; this is the rule that
// makes the split free.

const memWrite = (address, value) => ({ kind: 'memoryWrite', address: constNum(address, 'usmallint'), value });
const local = (name, type, init) => ({ kind: 'local', name, type, init });

test('rule 9: a single-caller void body with run-time arguments is written into its caller — an expression argument becomes a local, a read of the caller\'s own local is the read itself', () => {
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [local('i', 'utinyint', constNum(3)), call('paint', [bin('+', ref('i'), constNum(1), 'utinyint'), ref('i')])] },
      { name: 'paint', params: [{ name: 'at', type: 'utinyint' }, { name: 'code', type: 'utinyint' }], returnType: 'void', body: [memWrite(0x8000, ref('at')), memWrite(0x8001, ref('code')), memWrite(0x8002, ref('at')), ...wideBody()] },
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.equal(body[1].kind, 'block');
  assert.equal(body[1].origin, 'paint');
  const [bound, first, second] = body[1].body;
  assert.equal(bound.kind, 'local', 'the expression argument is evaluated once, into a local');
  assert.deepEqual(bound.init, bin('+', ref('i'), constNum(1), 'utinyint'));
  assert.deepEqual(first.value, ref(bound.name), 'and read from there');
  assert.deepEqual(second.value, ref('i'), 'the plain read of a caller local is the read itself — no copy');
});

test('rule 9: an argument reading a global the body writes is copied first, as the call copied it', () => {
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('bump', [ref('cursor')])] },
      { name: 'bump', params: [{ name: 'n', type: 'utinyint' }], returnType: 'void', body: [assign('cursor', bin('+', ref('cursor'), constNum(2), 'utinyint')), memWrite(0x8000, ref('n')), ...wideBody()] },
    ],
    globals: [{ name: 'cursor', type: 'utinyint', address: null, init: 0 }],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body[0].body;
  assert.equal(body[0].kind, 'local');
  assert.deepEqual(body[0].init, ref('cursor'), 'the value before the body ran');
  assert.deepEqual(body[2].value, ref(body[0].name));
});

test('rule 9: a non-void single caller is hoisted ahead of the statement that used it, and `let r = f(x)` returning one of f\'s locals keeps that local as r', () => {
  const ir = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [local('origin', 'usmallint', ref('base', 'usmallint')), local('numRow', 'usmallint', { kind: 'call', name: 'paintTile', args: [ref('origin', 'usmallint')], type: 'usmallint' }), memWrite(0x9000, ref('numRow', 'usmallint'))] },
      { name: 'paintTile', params: [{ name: 'at', type: 'usmallint' }], returnType: 'usmallint', body: [local('row', 'usmallint', ref('at', 'usmallint')), memWrite(0x8000, ref('row', 'usmallint')), assign('row', bin('+', ref('row', 'usmallint'), constNum(40), 'usmallint')), ...wideBody(), ret(ref('row', 'usmallint'))] },
    ],
    globals: [{ name: 'base', type: 'usmallint', address: null, init: 0 }],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.ok(!body.some((s) => s.kind === 'call' || s.init?.kind === 'call'), 'the call is gone');
  const rows = body.filter((s) => s.kind === 'local' && s.name === 'numRow');
  assert.equal(rows.length, 1, "the callee's `row` is the caller's `numRow` — one local, not a copy");
  assert.deepEqual(rows[0].init, ref('origin', 'usmallint'), 'initialised where the callee initialised its own');
  assert.deepEqual(body[body.length - 1].value, ref('numRow', 'usmallint'));
  assert.ok(!ir.functions.find((fn) => fn.name === 'main').body.some((s) => s.kind === 'return'), 'the callee\'s return did not come along');
});

test('rule 9 refuses: a void body with a return, a non-void body with an early return, an asm6502 body, and a free name the caller binds', () => {
  const stays = (functions, globals = []) => {
    const ir = optimizeIr({ entry: 'main', functions, globals });
    return ir.functions.find((fn) => fn.name === 'main').body[0].kind === 'call';
  };
  assert.ok(stays([
    { name: 'main', body: [call('helper', [runtime('x')])] },
    { name: 'helper', params: [{ name: 'n', type: 'utinyint' }], returnType: 'void', body: [memWrite(0x8000, ref('n')), ret()] },
  ]), 'the `f(); return;` idiom keeps a call');
  // A non-void body with an early return: the call stays as the
  // assignment's value (x is assigned first, so rule 5 cannot evaluate it).
  const early = optimizeIr({
    entry: 'main',
    functions: [
      { name: 'main', body: [assign('x', { kind: 'read', address: constNum(0xe810, 'usmallint'), type: 'utinyint' }), { kind: 'assign', target: 'out', value: { kind: 'call', name: 'pick', args: [runtime('x')], type: 'utinyint' } }] },
      { name: 'pick', params: [{ name: 'n', type: 'utinyint' }], returnType: 'utinyint', body: [ifNode(bin('==', ref('n'), constNum(0)), [ret(constNum(9))]), memWrite(0x8000, ref('n')), ret(ref('n'))] },
    ],
    globals: [{ name: 'out', type: 'utinyint', address: null, init: 0 }, { name: 'x', type: 'utinyint', address: null, init: 0 }],
  });
  assert.equal(early.functions.find((fn) => fn.name === 'main').body[1].value.kind, 'call', 'an early return would leave the caller — the call stays');
  assert.ok(stays([
    { name: 'main', body: [call('poke', [runtime('x')])] },
    { name: 'poke', params: [{ name: 'n', type: 'utinyint' }], returnType: 'void', body: [{ kind: 'asm', text: ' lda #1' }, memWrite(0x8000, ref('n'))] },
  ]), 'asm6502 may name its own frame');
  assert.ok(stays([
    { name: 'main', body: [call('show', [runtime('x')]), local('cursor', 'utinyint', constNum(1))] },
    { name: 'show', params: [{ name: 'n', type: 'utinyint' }], returnType: 'void', body: [assign('cursor', bin('+', ref('cursor'), constNum(1), 'utinyint')), memWrite(0x8000, ref('cursor')), memWrite(0x8001, ref('n')), ...wideBody()] },
  ], [{ name: 'cursor', type: 'utinyint', address: null, init: 0 }]), "the body's global `cursor` would be captured by the caller's local of that name");
});

test('rule 9 counts a forwarder\'s sites as the callee\'s: one wrapper called from three places is three sites, not one', () => {
  const ir = optimizeReachable({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('Tile', [runtime('x')]), call('Tile', [runtime('y')]), call('Tile', [runtime('z')])] },
      { name: 'Tile', component: true, params: [{ name: 'e', type: 'utinyint' }], returnType: 'void', body: [call('drawTile', [ref('e')])] },
      { name: 'drawTile', params: [{ name: 'p', type: 'utinyint' }], returnType: 'void', body: wideBody() },
    ],
    globals: [],
  });
  const body = ir.functions.find((fn) => fn.name === 'main').body;
  assert.deepEqual(body.map((statement) => statement.name), ['drawTile', 'drawTile', 'drawTile'], 'the wrapper is the call at each site');
  assert.ok(ir.functions.some((fn) => fn.name === 'drawTile'), 'and the callee is one function — it was never a single caller');
});

test('a body is sized with its callees in it: a small wrapper that inlines a large single-caller child is not pasted at three sites (2048 #52)', () => {
  const ir = optimizeReachable({
    entry: 'main',
    functions: [
      { name: 'main', body: [call('board'), assign('g', constNum(1)), call('board'), assign('g', constNum(2)), call('board')] },
      // Two statements, so it is not a forwarder; small as written.
      { name: 'board', params: [], returnType: 'void', body: [call('scoreBar'), assign('g', constNum(3))] },
      { name: 'scoreBar', params: [], returnType: 'void', body: [...wideBody(), ...wideBody(), memWrite(0x9000, ref('g'))] },
    ],
    globals: [{ name: 'g', type: 'utinyint', address: null, init: 0 }],
  });
  const main = ir.functions.find((fn) => fn.name === 'main');
  assert.deepEqual(main.body.filter((s) => s.kind === 'call').map((s) => s.name), ['board', 'board', 'board'], 'board stays a function at its three sites');
  const board = ir.functions.find((fn) => fn.name === 'board');
  assert.ok(board, 'board is a function');
  assert.ok(!ir.functions.some((fn) => fn.name === 'scoreBar'), 'holding its one-caller child');
});
