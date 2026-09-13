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
  const stores = out.functions[0].body[0].body;
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
  assert.equal(zeroCall.functions[0].body[0].value.operator, '*');
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
