// Recording helpers for the mos tap (see register.mjs). A shim wraps one real
// function of the 6502 back end with `tapped`, which writes one JSON line per
// call to `$EIGHTBS_MOS_TAP/<thread>.jsonl`. With EIGHTBS_MOS_TAP unset,
// a wrapped function is the real function itself.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

const TOKENS = [['project', '<project>'], ['toolchain', '<toolchain>']];

/** The roots a record replaces with tokens, from `$EIGHTBS_MOS_TAP_ROOTS` ({ toolchain, project }). */
export function rootsFrom(env = process.env) {
  try {
    const parsed = JSON.parse(env.EIGHTBS_MOS_TAP_ROOTS ?? '{}');
    return TOKENS.map(([key, token]) => [parsed[key], token]).filter(([root]) => typeof root === 'string' && root !== '');
  } catch {
    return [];
  }
}

const escapeRegExp = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** `text` with every absolute root replaced by its token (project first: it may live inside the toolchain). */
export function tokenize(text, roots) {
  let out = text;
  for (const [root, token] of roots) out = out.replaceAll(new RegExp(`${escapeRegExp(root)}${String.raw`(?![\w.-])`}`, 'g'), token);
  return out;
}

/**
 * The JSON form of `value`: Map as `[[k, v], ...]`, Set as an array,
 * Uint8Array as an array of numbers, a class instance as its own fields, and
 * `prov` dropped. Strings pass through `tokenize`.
 */
export function encode(value, roots = []) {
  if (typeof value === 'string') return roots.length > 0 ? tokenize(value, roots) : value;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) return [...value].map(([k, v]) => [encode(k, roots), encode(v, roots)]);
  if (value instanceof Set) return [...value].map((v) => encode(v, roots));
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map((v) => encode(v, roots));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (key !== 'prov' && v !== undefined) out[key] = encode(v, roots);
  }
  return out;
}

function sink(env) {
  const dir = env.EIGHTBS_MOS_TAP;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  return join(dir, `${threadId}.jsonl`);
}

let seq = 0;

/** Append one record; `fields` are encoded, `seq` and `fn` come first. */
export function record(fn, fields = {}, env = process.env, at = seq++) {
  const file = sink(env);
  if (!file) return;
  const roots = rootsFrom(env);
  const line = { seq: at, fn };
  for (const [key, value] of Object.entries(fields)) line[key] = encode(value, roots);
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

/**
 * `real` wrapped so each call is recorded as `{seq, fn, args, result, after?}`.
 * The arguments are deep-copied before the call (the real function may mutate
 * them); `after(args)` runs on the live arguments once it has returned. A
 * thrown error is recorded as `{throw: message}` and rethrown.
 */
export function tapped(fn, real, after, env = process.env) {
  return function tap(...args) {
    if (!env.EIGHTBS_MOS_TAP) return real(...args);
    const before = structuredClone(args);
    const mine = seq++;
    const write = (fields) => record(fn, fields, env, mine);
    let result;
    try {
      result = real(...args);
    } catch (error) {
      write({ args: before, throw: error?.message ?? String(error) });
      throw error;
    }
    const fields = { args: before, result };
    if (after) fields.after = after(args);
    write(fields);
    return result;
  };
}

/** `real` (a no-argument reset function) wrapped so each call records `{fn: "reset:<name>"}`. */
export function tappedReset(name, real, env = process.env) {
  return function tapReset(...args) {
    if (env.EIGHTBS_MOS_TAP) record(`reset:${name}`, {}, env);
    return real(...args);
  };
}
