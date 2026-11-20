// Recording helpers for the front tap (see register.mjs). A shim wraps one real
// function of the semantic front end with `tapped`, which writes one JSON line per
// call to `$EIGHTBS_FRONT_TAP/<thread>.jsonl`. With EIGHTBS_FRONT_TAP unset,
// a wrapped function is the real function itself.
//
// Same record format as the mos tap (`{seq, fn, args, result, after?}`), copied
// rather than shared because that tap names its environment variable in code.
// The values go through `Encoder` (graph.mjs): cyclic data has one canonical form.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

import { Encoder, encodeGraph, tokenize } from './graph.mjs';

export { encodeGraph, noteBound, tokenize } from './graph.mjs';

const TOKENS = [['project', '<project>'], ['toolchain', '<toolchain>']];

/** The roots a record replaces with tokens, from `$EIGHTBS_FRONT_TAP_ROOTS` ({ toolchain, project }). */
export function rootsFrom(env = process.env) {
  try {
    const parsed = JSON.parse(env.EIGHTBS_FRONT_TAP_ROOTS ?? '{}');
    return TOKENS.map(([key, token]) => [parsed[key], token]).filter(([root]) => typeof root === 'string' && root !== '');
  } catch {
    return [];
  }
}

function sink(env) {
  const dir = env.EIGHTBS_FRONT_TAP;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  return join(dir, `${threadId}.jsonl`);
}

let seq = 0;

/** Append one record whose fields are already encoded; `seq` and `fn` come first. */
export function record(fn, fields = {}, env = process.env, at = seq++) {
  const file = sink(env);
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ seq: at, fn, ...fields })}\n`);
}

const isTree = (value) => value !== null && typeof value === 'object' && typeof value.type === 'string';

/**
 * `real` wrapped so each call is recorded as `{seq, fn, args, result, after?}`.
 * The arguments are encoded before the call (the real function may mutate
 * them); `after(args, result)` is encoded once it has returned. Each of the
 * three fields is its own encoding: its ids start at 0 and its AST nodes are
 * numbered in the tree as it is at that moment. `asts(args)` names the trees
 * (default: every argument with a string `type`). A thrown error is recorded as
 * `{throw: message}` and rethrown.
 */
export function tapped(fn, real, { after, asts = (args) => args.filter(isTree) } = {}, env = process.env) {
  return function tap(...args) {
    if (!env.EIGHTBS_FRONT_TAP) return real(...args);
    const paths = rootsFrom(env);
    const encoder = () => new Encoder({ asts: asts(args), paths });
    const mine = seq++;
    const before = encoder();
    const encoded = args.map((arg) => before.encode(arg));
    let result;
    try {
      result = real(...args);
    } catch (error) {
      record(fn, { args: encoded, throw: error?.message ?? String(error) }, env, mine);
      throw error;
    }
    const fields = { args: encoded, result: encoder().encode(result) ?? null };
    if (after) fields.after = encoder().encode(after(args, result));
    record(fn, fields, env, mine);
    return result;
  };
}

/**
 * `bindImportedComponents(bound, lookup)` wrapped. `lookup` is a function, so the
 * record carries what it answered: `args` is `[bound, { lookups: [[source, other], ...] }]`
 * (the answers share the bound's ids), `after` the bound once linked.
 */
export function tappedBindImports(fn, real, env = process.env) {
  return function tap(bound, lookup, ...rest) {
    if (!env.EIGHTBS_FRONT_TAP) return real(bound, lookup, ...rest);
    const paths = rootsFrom(env);
    const mine = seq++;
    const encoder = new Encoder({ paths });
    const before = encoder.encode(bound);
    const answers = [];
    const recording = (source) => {
      const other = lookup(source);
      answers.push([source, other ?? null]);
      return other;
    };
    let result;
    try {
      result = real(bound, recording, ...rest);
    } catch (error) {
      record(fn, { args: [before], throw: error?.message ?? String(error) }, env, mine);
      throw error;
    }
    const args = [before, { lookups: encoder.encode(answers) }];
    record(fn, { args, result: encodeGraph(result, { paths }) ?? null, after: encodeGraph(bound, { paths }) }, env, mine);
    return result;
  };
}
