// The canonical JSON form of the front end's cyclic values (plan T3, `encodeGraph`).
//
// Plain data is plain JSON: Map as `[[k, v], ...]`, Set as an array, typed
// arrays as arrays of numbers, a class instance as its own fields, a string
// with the absolute roots replaced by tokens. The cycles are cut by ids:
//
//   AST      the root of an AST is written out once per encoder, as plain JSON. Every
//            other reference to an AST node is `{"$node": n}`, n the pre-order index of the
//            node in its own tree (what `syntax::number_nodes` assigns). A node that no
//            registered tree holds is written out in place.
//   scope    first encounter `{"$scope": n, "parent": ..., "symbols": [[name, ref], ...]}`,
//            then `{"$scope": n}`. The id is the order of first encounter, walking
//            the value in key order, a scope's parent before its symbols.
//   symbol   first encounter `{"$sym": n, ...fields}` in the object's own key order, then
//            `{"$sym": n}`. A Map-valued field (`members`) is the scope's `symbols` map.
//
// An encoder keeps its ids across `encode` calls, so one encoder gives one id space to
// all the arguments of a call. A function is `{"$fn": name}` and a BigInt `{"$bigint": text}`.
import { walk } from '../../../packages/compiler/src/ast/index.mjs';

const KINDS = new Set(['Variable', 'Constant', 'Function', 'Namespace', 'Parameter', 'Import', 'Component', 'State']);

/** The tree a bound result was made from, and the tree each of its scopes belongs to. */
const boundAst = new WeakMap();
const scopeAst = new WeakMap();

/** Remember that `bound` (a `bind()` result) and all its scopes were made from `ast`. */
export function noteBound(bound, ast) {
  if (!bound || !ast) return;
  boundAst.set(bound, ast);
  const scopes = [...(bound.scopes ?? []), ...(bound.scopeOf?.values() ?? [])];
  for (let scope of scopes) {
    for (; scope && !scopeAst.has(scope); scope = scope.parent) scopeAst.set(scope, ast);
  }
}

const isScope = (v) => v.symbols instanceof Map && 'parent' in v && Object.keys(v).length === 2;
const isSymbol = (v) => typeof v.kind === 'string' && KINDS.has(v.kind) && typeof v.name === 'string' && isScope(v.scope ?? {});
const isBound = (v) => Array.isArray(v.scopes) && v.scopeOf instanceof Map;
const escapeRegExp = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** `text` with every absolute root replaced by its token (project first: it may live inside the toolchain). */
export function tokenize(text, roots) {
  let out = text;
  for (const [root, token] of roots) out = out.replaceAll(new RegExp(`${escapeRegExp(root)}${String.raw`(?![\w.-])`}`, 'g'), token);
  return out;
}

export class Encoder {
  /**
   * @param {{ asts?: object[], paths?: [string, string][] }} options `asts` are the trees whose
   *   roots are written out in full; `paths` are the (root, token) pairs strings pass through.
   */
  constructor({ asts = [], paths = [] } = {}) {
    this.paths = paths;
    this.nodes = new Map();
    this.registered = new Set();
    this.roots = new Set();
    this.emitted = new Set();
    this.scopes = new Map();
    this.symbols = new Map();
    this.active = new Set();
    this.plain = 0;
    for (const ast of asts) {
      if (ast && typeof ast === 'object') {
        this.roots.add(ast);
        this.register(ast);
      }
    }
  }

  /** Number the nodes of `ast` in pre-order, once. */
  register(ast) {
    if (!ast || this.registered.has(ast)) return;
    this.registered.add(ast);
    let n = 0;
    walk(ast, (node) => {
      if (!this.nodes.has(node)) this.nodes.set(node, n);
      n++;
    });
  }

  encode(value) {
    if (typeof value === 'string') return this.paths.length > 0 ? tokenize(value, this.paths) : value;
    if (typeof value === 'function') return { $fn: value.name };
    if (typeof value === 'bigint') return { $bigint: String(value) };
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) return Array.from(value);
    return this.object(value);
  }

  object(value) {
    if (this.nodes.has(value)) return this.node(value);
    if (value instanceof Map) return [...value].map(([k, v]) => [this.encode(k), this.encode(v)]);
    if (value instanceof Set) return [...value].map((v) => this.encode(v));
    if (Array.isArray(value)) return value.map((v) => this.encode(v));
    if (isScope(value)) return this.scope(value);
    if (isSymbol(value)) return this.symbol(value);
    if (isBound(value)) this.register(boundAst.get(value));
    return this.fields({}, value);
  }

  node(value) {
    const n = this.nodes.get(value);
    const inside = this.plain > 0;
    const writeOut = !this.emitted.has(value) && (inside || this.roots.has(value));
    if (!writeOut) return { $node: n };
    this.emitted.add(value);
    this.plain++;
    try {
      return this.fields({}, value);
    } finally {
      this.plain--;
    }
  }

  fields(out, value) {
    if (this.active.has(value)) return { $cycle: true };
    this.active.add(value);
    try {
      for (const [key, v] of Object.entries(value)) {
        if (v !== undefined) out[key] = this.encode(v);
      }
    } finally {
      this.active.delete(value);
    }
    return out;
  }

  scope(value) {
    if (this.scopes.has(value)) return { $scope: this.scopes.get(value) };
    const id = this.scopes.size;
    this.scopes.set(value, id);
    this.register(scopeAst.get(value));
    return { $scope: id, parent: this.encode(value.parent), symbols: this.encode(value.symbols) };
  }

  symbol(value) {
    if (this.symbols.has(value)) return { $sym: this.symbols.get(value) };
    const id = this.symbols.size;
    this.symbols.set(value, id);
    this.register(scopeAst.get(value.scope));
    return this.fields({ $sym: id }, value);
  }
}

/** The canonical JSON form of `value` (see the header). `asts` are the tree roots it may hold. */
export function encodeGraph(value, options = {}) {
  return new Encoder(options).encode(value);
}
