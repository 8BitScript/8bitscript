// Hover, completion and go-to-definition for a program's own names — the
// binder-backed half of intellisense/index.mjs, which answers for the
// built-ins the same token-level way it always has.
//
// A module is tokenized, parsed and bound (src/binder), and its imports
// are bound one level deep — the module they name is read and bound too,
// so a name that comes from another file resolves to that file's
// declaration: a component in `<MenuBar />` or in a `.8bs` file's
// `MenuBar();` (spec §4.5), a function, a const. What a symbol *is*
// is rendered from its own declaration's source: the header of a
// function or component up to its body, a variable's whole statement,
// and the doc comment tightly above it (the same rule the built-in
// member hover uses — no blank line between).
//
// Positions are decided on tokens, because the 8BX lexer already knows
// where a tag is: `<`, `>`, `/>` and `</` are their own token kinds in
// `.8bx`, and a `{ … }` inside one is ordinary tokens between braces.
import { readFileSync } from 'node:fs';

import { NodeType, walk } from '../ast/index.mjs';
import { bind, bindImports, componentOf, resolveSymbol, SymbolKind } from '../binder/index.mjs';
import { tokenize, TokenKind } from '../lexer/index.mjs';
import { parse } from '../parser/index.mjs';
import { machineOfVariant, resolveSpecifier } from '../resolver/index.mjs';
import { MACHINES, sourceKindOf } from '../source/index.mjs';
import { isMediaKind } from '../media/kinds.mjs';

/**
 * The file a `.8bs` import specifier names, from `fromFile`, when one can
 * be found without knowing the build's machine: the plain resolution, or —
 * for a specifier whose resolution is target-dependent (a package entry
 * keyed by machine, or a file with machine twins beside it) — one
 * machine's branch, flagged `conditional`. Which machine: `machine` when
 * the caller has one (the file's own twin, or the project's single
 * target — see the language server) and the specifier has a branch for it;
 * otherwise the first machine in `8bs targets` order that does. Null when
 * nothing on disk answers.
 *
 * @param {string} specifier
 * @param {string|null} fromFile
 * @param {string|null|undefined} checkout
 * @param {string|null} [machine]
 * @returns {{ path: string, conditional: boolean, machine?: string } | null}
 */
export function resolveModuleFile(specifier, fromFile, options = {}) {
  const { checkout = null, machine = null, importAliases = null } = options;
  if (!fromFile) return null;
  const resolverOptions = { checkout, ...(importAliases ? { importAliases } : {}) };
  const plain = resolveSpecifier(specifier, fromFile, resolverOptions);
  if (plain?.code) return null;
  if (plain?.path) return { path: plain.path, conditional: false };
  if (plain?.path !== null) return null;

  const order = machine ? [machine, ...MACHINES.filter((m) => m !== machine)] : MACHINES;
  for (const candidate of order) {
    const branch = resolveSpecifier(specifier, fromFile, { ...resolverOptions, machine: candidate });
    if (branch?.path) return { path: branch.path, conditional: true, machine: candidate };
  }
  return null;
}

/**
 * Every machine's file for a target-dependent specifier — the branches a
 * hover merges into the portable view. `conditional: false` with one
 * `path` when the specifier resolves to a single file for every machine;
 * otherwise `branches`, in `8bs targets` order, one per machine the
 * specifier has a file for (a machine the package or twin set leaves out
 * is simply absent). Null when nothing on disk answers.
 *
 * @returns {{ conditional: false, path: string } | { conditional: true, branches: { machine: string, path: string }[] } | null}
 */
export function resolvePortableModule(specifier, fromFile, options = {}) {
  const { checkout = null, importAliases = null } = options;
  if (!fromFile) return null;
  const resolverOptions = { checkout, ...(importAliases ? { importAliases } : {}) };
  const plain = resolveSpecifier(specifier, fromFile, resolverOptions);
  if (plain?.code) return null;
  if (plain?.path) return { conditional: false, path: plain.path };
  if (plain?.path !== null) return null;

  const branches = [];
  for (const machine of MACHINES) {
    const branch = resolveSpecifier(specifier, fromFile, { ...resolverOptions, machine });
    if (branch?.path) branches.push({ machine, path: branch.path });
  }
  return branches.length > 0 ? { conditional: true, branches } : null;
}

/**
 * Tokenize, parse and bind `text` as `file`, with every import bound one
 * level deep. Returns the module record hover, completion and definition
 * read from: its tokens and AST, the binder's result, and the records of
 * the modules its imports resolved to, by specifier.
 *
 * @param {string} text
 * @param {string|null} file
 * @param {{ sourceKind?: string|null, checkout?: string|null, machine?: string|null, importAliases?: Record<string, string>|null }} [options]
 *   `machine`: the machine a target-dependent import should be read for
 *   — the file's own twin, or the project's single target (see
 *   resolveModuleFile); without one, the first in `8bs targets` order.
 */
export function bindModule(text, file, { sourceKind = null, checkout = null, machine = null, importAliases = null } = {}) {
  const kind = sourceKind ?? sourceKindOf(file ?? '') ?? '.8bs';
  const name = file ?? '<unknown>';
  const { tokens } = tokenize(text, name, { sourceKind: kind });
  const { ast } = parse(tokens, text, name, { sourceKind: kind });
  const bound = bind(ast, name);
  const modules = new Map();
  bindImports(bound, (specifier) => {
    const resolved = resolveModuleFile(specifier, file, { checkout, machine, importAliases });
    if (!resolved) return null;
    let other;
    try {
      other = readFileSync(resolved.path, 'utf8');
    } catch {
      return null;
    }
    const otherKind = sourceKindOf(resolved.path) ?? '.8bs';
    const otherTokens = tokenize(other, resolved.path, { sourceKind: otherKind }).tokens;
    const otherAst = parse(otherTokens, other, resolved.path, { sourceKind: otherKind }).ast;
    const record = { text: other, tokens: otherTokens, ast: otherAst, bound: bind(otherAst, resolved.path), file: resolved.path };
    modules.set(specifier, record);
    return record.bound;
  });
  return { text, tokens, ast, bound, file, modules };
}

/** The declaration a symbol stands for, following an Import to its target. */
function declared(sym) {
  return sym.kind === SymbolKind.Import ? sym.target : sym;
}

/** The module record the symbol's declaration is in: `module` itself, or one of the modules it imports. */
function moduleOf(module, sym) {
  const target = declared(sym);
  if (!target) return null;
  if (target.file === module.bound.file) return module;
  return [...module.modules.values()].find((m) => m.file === target.file) ?? null;
}

/**
 * The innermost scope containing `offset`: the module's, or that of the
 * smallest function, component, namespace or block whose range covers it.
 */
export function scopeAt(module, offset) {
  let best = null;
  let bestLength = Infinity;
  walk(module.ast, (n) => {
    const scope = module.bound.scopeOf.get(n);
    if (!scope) return;
    if (offset >= n.start && offset <= n.start + n.length && n.length < bestLength) {
      best = scope;
      bestLength = n.length;
    }
  });
  return best ?? module.bound.scopes[0];
}

/** Every symbol visible from `scope`, innermost first; a name shadowed further out appears once. */
export function visibleSymbols(scope) {
  const seen = new Set();
  const out = [];
  for (let s = scope; s; s = s.parent) {
    for (const sym of s.symbols.values()) {
      if (seen.has(sym.name)) continue;
      seen.add(sym.name);
      out.push(sym);
    }
  }
  return out;
}

// ---- where the cursor is, in 8BX terms ------------------------------------

/**
 * What the tokens before `offset` say about the 8BX position: the tag
 * the cursor is in (its name token, if typed yet, and whether it is a
 * closing tag), whether it is inside a `{ … }` there, and the names of
 * the elements still open around it, innermost last.
 *
 * @returns {{ tag: { name: object|null, closing: boolean, nameDone?: boolean } | null, inExpression: boolean, open: string[] }}
 */
export function bxPosition(tokens, offset) {
  const open = [];
  let tag = null;
  let braces = 0; // `{` depth inside the current tag
  let exprTag = null;
  for (const t of tokens) {
    if (t.start >= offset) break;
    if (tag && braces > 0) {
      if (t.text === '{') braces += 1;
      else if (t.text === '}') braces -= 1;
      continue;
    }
    switch (t.kind) {
      case TokenKind.BxTagOpen:
        tag = { name: null, closing: false, nameDone: false };
        break;
      case TokenKind.BxClosingTagOpen:
        tag = { name: null, closing: true, nameDone: false };
        break;
      case TokenKind.BxTagEnd:
        // A fragment opens as '' so its `</>` pops its own entry.
        if (tag?.closing) open.pop();
        else if (tag) open.push(tag.name ? tag.name.text : '');
        tag = null;
        break;
      case TokenKind.BxSelfClose:
        tag = null;
        break;
      case TokenKind.Identifier:
        if (tag && !tag.name) tag.name = t;
        break;
      case TokenKind.Punctuation:
        if (tag && t.text === '{') { braces = 1; exprTag = tag; }
        break;
      default:
        break;
    }
  }
  // The name is done once the cursor is past it: `<Me|` is still typing it.
  if (tag?.name) tag.nameDone = offset > tag.name.start + tag.name.length;
  return { tag, inExpression: tag !== null && braces > 0 && exprTag === tag, open };
}

// ---- what a symbol is ------------------------------------------------------

/** One `//` or `/* *\/` comment token's text, without its delimiters. */
function commentText(token) {
  const raw = token.text;
  if (raw.startsWith('//')) return raw.slice(2).trim();
  return raw.slice(2, -2).split('\n').map((line) => line.replace(/^\s*\*?\s?/, '')).join(' ').trim();
}

/**
 * The doc comment of the declaration starting at `start` in `module`:
 * the comments tightly above it — each on a line of its own, with no
 * blank line between it and the declaration or the next comment up — or
 * else the comment on the declaration's own line, after it
 * (`let over: bool = false; // no move left`). A comment ending the
 * previous line is that line's, not this declaration's.
 */
function docOf(module, decl) {
  const { tokens, text } = module;
  const first = tokens.findIndex((t) => t.start >= decl.start);
  let k = first - 1;
  let cursor = decl.start;
  const lines = [];
  while (k >= 0 && tokens[k].kind === TokenKind.Comment && ownsItsLine(text, tokens[k])) {
    const comment = tokens[k];
    const gap = text.slice(comment.start + comment.length, cursor);
    if ((gap.match(/\n/g) ?? []).length > 1) break;
    lines.unshift(commentText(comment));
    cursor = comment.start;
    k -= 1;
  }
  if (lines.length > 0) return lines.join(' ');
  const end = decl.start + decl.length;
  const after = tokens.find((t) => t.start >= end);
  if (after?.kind === TokenKind.Comment && !text.slice(end, after.start).includes('\n')) return commentText(after);
  return null;
}

/** Whether nothing but whitespace precedes `token` on its line. */
function ownsItsLine(text, token) {
  const lineStart = text.lastIndexOf('\n', token.start - 1) + 1;
  return text.slice(lineStart, token.start).trim() === '';
}

const KIND_LABEL = {
  [SymbolKind.Variable]: 'variable',
  [SymbolKind.Constant]: 'constant',
  [SymbolKind.Function]: 'function',
  [SymbolKind.Namespace]: 'namespace',
  [SymbolKind.Parameter]: 'parameter',
  [SymbolKind.Component]: 'component',
  [SymbolKind.State]: 'state',
  [SymbolKind.Import]: 'import',
};

// A declaration longer than this — a table's initializer, say — is cut in
// the hover; the doc comment says what it is, the file says the rest.
const SIGNATURE_MAX = 120;

/** One line, spaces collapsed, the way a hover signature is shown. */
function collapseWs(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32) {
      gap = true;
    } else {
      if (out.length > 0 && gap) out += ' ';
      out += text[i];
      gap = false;
    }
  }
  return out;
}

/** The source of a declaration's header — up to its body's `{` — or the whole statement, on one line. */
function signatureOf(module, sym) {
  const decl = sym.declaration;
  let end = decl.start + decl.length;
  if (decl.type === NodeType.NamespaceDeclaration) end = module.text.indexOf('{', decl.start);
  else if (decl.body) end = decl.body.start;
  let raw = collapseWs(module.text.slice(decl.start, end));
  if (raw.endsWith(';')) raw = raw.slice(0, -1).trimEnd();
  return raw.length > SIGNATURE_MAX ? `${raw.slice(0, SIGNATURE_MAX)}…` : raw;
}

/**
 * Hover markdown for `sym` as seen from `module`: what it is, its
 * declaration, its doc comment, and — for an import — where it is from.
 *
 * @returns {string|null}
 */
export function symbolMarkdown(module, sym) {
  const target = declared(sym);
  if (!target) {
    return sym.kind === SymbolKind.Import
      ? [`**${sym.name}**`, '', `Imported from \`${sym.source}\`${sym.resolved ? ' — not exported there, or not found' : ''}.`].join('\n')
      : null;
  }
  const home = moduleOf(module, sym) ?? module;
  const lines = [`**${target.name}** — ${KIND_LABEL[target.kind]}`, '', '```8bs', signatureOf(home, target), '```'];
  const doc = target.kind === SymbolKind.Parameter ? null : docOf(home, target.declaration);
  if (doc) lines.push('', doc);
  if (sym.kind === SymbolKind.Import) lines.push('', `Imported from \`${sym.source}\`.`);
  return lines.join('\n');
}

/** A component's props with the source text of each type, from the module that declares it. */
export function propsOf(module, sym) {
  const component = componentOf(sym);
  if (!component) return [];
  const home = moduleOf(module, sym) ?? module;
  return component.props.map((p) => ({
    name: p.name,
    type: p.typeAnnotation ? home.text.slice(p.typeAnnotation.start, p.typeAnnotation.start + p.typeAnnotation.length) : null,
    optional: p.optional,
  }));
}

// ---- the symbol under the cursor ------------------------------------------

/**
 * The symbol the identifier token at `index` names, resolved from the
 * scope the cursor is in — or, for `object.member`, the member of the
 * namespace `object` names (its own, or the one it imports).
 *
 * @returns {{ symbol: object, token: object } | null}
 */
export function symbolAt(module, offset) {
  const { tokens } = module;
  const index = tokens.findIndex((t) => offset >= t.start && offset <= t.start + t.length);
  const token = tokens[index];
  if (token?.kind !== TokenKind.Identifier) return null;
  const scope = scopeAt(module, token.start);
  const dot = tokens[index - 1];
  const object = tokens[index - 2];
  if (dot?.text === '.' && object?.kind === TokenKind.Identifier) {
    const owner = resolveSymbol(scope, object.text);
    const namespace = owner ? declared(owner) : null;
    const member = namespace?.members?.get(token.text);
    return member ? { symbol: member, token } : null;
  }
  const symbol = resolveSymbol(scope, token.text);
  return symbol ? { symbol, token } : null;
}

/**
 * Where the symbol at `offset` is declared: its file and the range of
 * its name. An import's target is in the other file; an import with no
 * target (not found, or not exported) has no definition.
 *
 * @param {string} text
 * @param {number} offset
 * @param {{ path?: string|null, checkout?: string|null, sourceKind?: string|null, machine?: string|null }} [options]
 *   `machine`: the project's single target, for a target-dependent import (see bindModule).
 * @returns {{ path: string, start: number, length: number } | null}
 */
export function getDefinition(text, offset, options = {}) {
  const kind = options.sourceKind ?? sourceKindOf(options.path ?? '') ?? '.8bs';
  if (isMediaKind(kind)) return null;
  // A twin's own machine outranks the project's target — `x.pet.8bs` is
  // the PET's file whatever the project builds (intellisense/index.mjs's
  // machineFor is the same rule).
  const machine = (options.path ? machineOfVariant(options.path) : null) ?? options.machine ?? null;
  const first = definitionIn(bindModule(text, options.path ?? null, { ...options, machine }), offset);
  if (first) return first;
  // A member one machine's module lacks (`input.touch()` read for the
  // PET): the jump lands in the first machine's module that has it, the
  // same rule the hover states — tried in `8bs targets` order, and only
  // for a `name.member` the first binding could not place.
  if (!options.path || !isMemberAccessAt(text, offset)) return null;
  for (const other of MACHINES) {
    if (other === machine) continue;
    const found = definitionIn(bindModule(text, options.path, { ...options, machine: other }), offset);
    if (found) return found;
  }
  return null;
}

/** getDefinition's answer within one bound module, or null. */
function definitionIn(module, offset) {
  const hit = symbolAt(module, offset);
  if (!hit) return null;
  const target = declared(hit.symbol);
  if (!target) return null;
  const home = moduleOf(module, hit.symbol);
  if (!home?.file) return null;
  return { path: home.file, start: target.node.start, length: target.node.length };
}

/** Whether the identifier at `offset` follows a `.` — `object.member`. */
function isMemberAccessAt(text, offset) {
  const { tokens } = tokenize(text, '<definition>', { sourceKind: sourceKindOf('') ?? '.8bs' });
  const index = tokens.findIndex((tk) => offset >= tk.start && offset <= tk.start + tk.length);
  return index > 0 && tokens[index].kind === TokenKind.Identifier && tokens[index - 1].text === '.';
}
