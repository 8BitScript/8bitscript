// Programs inside JS/TS test files and Markdown fences, for `8bs migrate`
// (notes/port/p3-frontend-spec.md section 5, "Modes"). Throwaway, like the
// rest of the converter.
//
// Two literal shapes are taken from a script: a backtick template, and an array
// of string literals closed by `.join('\n')`. A literal that looks like an
// old-syntax program is converted through the `convert` callback (which also
// proves the result); one that cannot be is listed and left untouched.
// `${expr}` is swapped for the placeholder identifier `__m0__`... before the
// program is parsed and restored afterwards, so the expression survives
// verbatim.

/** A literal that looks like old-syntax 8BitScript rather than prose or JS. */
const OLD_MARKER = new RegExp([
  String.raw`\bfunction\s+[A-Za-z_]\w*\s*\(`,
  String.raw`\bexport\s+(?:function|let|const|component)\b`,
  String.raw`\bimport\s*(?:\{[^}]*\}\s*from\s*)?["'](?:\.{1,2}\/|@8bitscript|[^"'\n]*\.8b[sxga])`,
  String.raw`\bnamespace\s+\w+\s*\{`,
  String.raw`\b(?:let|const)\s+[A-Za-z_]\w*\s*(?::[^;=]+)?=[^;]*;`,
  String.raw`\basm6502\s*\{`,
].join('|'));

/** Words that mark a literal as JavaScript rather than 8BitScript. */
const JS_ONLY = /=>|\bfrom\s+['"]node:|\bexport\s+default\b|\brequire\(|\bdocument\.|\bwindow\.|\bconsole\.|\basync\b|\bawait\b|\bthis\./;

const PLACEHOLDER = /__m(\d+)__/g;
const WORD = /[A-Za-z0-9_$]/;
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do']);
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

const lineAt = (src, offset) => {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (src[i] === '\n') line += 1;
  return line;
};

/** The JS escapes of a string or template segment, resolved. */
function cook(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    i += 1;
    const e = raw[i];
    if (e === 'n') out += '\n';
    else if (e === 't') out += '\t';
    else if (e === 'r') out += '\r';
    else if (e === 'b') out += '\b';
    else if (e === 'f') out += '\f';
    else if (e === 'v') out += '\v';
    else if (e === '0' && !/\d/.test(raw[i + 1] ?? '')) out += '\0';
    else if (e === 'x') {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (e === 'u' && raw[i + 1] === '{') {
      const close = raw.indexOf('}', i);
      out += String.fromCodePoint(Number.parseInt(raw.slice(i + 2, close), 16));
      i = close;
    } else if (e === 'u') {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (e === '\n') {
      // line continuation
    } else out += e;
  }
  return out;
}

/**
 * Scan JS source from `i` for literals. Stops at the `closer` that ends the
 * enclosing group (`}` of a `${}`, `]` of an array), or at `end`.
 *
 * @returns {number} the index of the closer, or `src.length`
 */
function scanCode(src, from, hooks, closer = null) {
  let i = from;
  let depth = 0;
  let prev = '';
  let prevWord = '';
  const significant = (c) => {
    prev = c;
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
    } else if (c === '"' || c === "'") {
      i = skipString(src, i);
      significant('"');
    } else if (c === '`') {
      const template = readTemplate(src, i, hooks);
      hooks.template(template);
      i = template.end;
      significant('`');
    } else if (c === '[' && hooks.array && tryArray(src, i, hooks)) {
      i = hooks.lastArrayEnd;
      significant(']');
    } else if (c === '/' && (prev === '' || (!WORD.test(prev) && prev !== ')' && prev !== ']') || KEYWORDS_BEFORE_REGEX.has(prevWord))) {
      i = skipRegex(src, i);
      significant('/');
      prevWord = '';
    } else if (WORD.test(c)) {
      let j = i;
      while (j < src.length && WORD.test(src[j])) j += 1;
      prevWord = src.slice(i, j);
      significant(c);
      i = j;
    } else {
      if (OPEN.has(c)) depth += 1;
      else if (CLOSE.has(c)) {
        if (depth === 0 && c === closer) return i;
        depth -= 1;
      }
      if (!/\s/.test(c)) {
        significant(c);
        prevWord = '';
      }
      i += 1;
    }
  }
  return src.length;
}

function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
  return j + 1;
}

function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length && src[j] !== '\n') {
    if (src[j] === '\\') j += 1;
    else if (src[j] === '[') inClass = true;
    else if (src[j] === ']') inClass = false;
    else if (src[j] === '/' && !inClass) break;
    j += 1;
  }
  j += 1;
  while (j < src.length && /[a-z]/.test(src[j])) j += 1;
  return j;
}

/**
 * A template literal: text segments (raw) and `${}` expressions (raw source).
 * @returns {{ start: number, end: number, segments: string[], expressions: string[] }}
 */
function readTemplate(src, start, hooks) {
  const segments = [];
  const expressions = [];
  let segStart = start + 1;
  let j = start + 1;
  while (j < src.length) {
    if (src[j] === '\\') j += 2;
    else if (src[j] === '`') break;
    else if (src[j] === '$' && src[j + 1] === '{') {
      segments.push(src.slice(segStart, j));
      const close = scanCode(src, j + 2, hooks, '}');
      expressions.push(src.slice(j, close + 1));
      j = close + 1;
      segStart = j;
    } else j += 1;
  }
  segments.push(src.slice(segStart, j));
  return { start, end: j + 1, segments, expressions };
}

/** Read one string-like literal at `i`: a quoted string or a template. */
function readStringLike(src, i, hooks) {
  const c = src[i];
  if (c === '"' || c === "'") {
    const end = skipString(src, i);
    return { start: i, end, segments: [src.slice(i + 1, end - 1)], expressions: [] };
  }
  if (c === '`') return readTemplate(src, i, hooks);
  return null;
}

const skipSpace = (src, i) => {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  return j;
};

/**
 * `[ 'a', "b", `c` ].join('\n')` at `i`: the array's elements when it is one.
 * A group that holds other things as well still counts (so that it can be
 * listed), flagged `mixed`.
 */
function tryArray(src, i, hooks) {
  const noHooks = { template: () => {}, array: false };
  const elements = [];
  let mixed = false;
  let j = i + 1;
  let closed = false;
  for (;;) {
    j = skipSpace(src, j);
    if (src[j] === ']') {
      closed = true;
      break;
    }
    const element = readStringLike(src, j, noHooks);
    if (!element) {
      mixed = true;
      break;
    }
    elements.push(element);
    j = skipSpace(src, element.end);
    if (src[j] === ',') j += 1;
    else if (src[j] !== ']') {
      mixed = true;
      break;
    }
  }
  if (mixed) {
    const close = scanCode(src, j, noHooks, ']');
    j = close;
  }
  if (!closed && !mixed) return false;
  const after = /^\s*\.join\(\s*(['"])\\n\1\s*\)/.exec(src.slice(j + 1, j + 60));
  if (!after || elements.length === 0) return false;
  hooks.array({ start: i, end: j + 1 + after[0].length, closeAt: j, elements, mixed });
  hooks.lastArrayEnd = j + 1 + after[0].length;
  return true;
}

/** Cook a literal's segments, swapping each `${}` for a placeholder. */
function cookLiteral(literal, placeholders) {
  let out = '';
  for (let i = 0; i < literal.segments.length; i += 1) {
    out += cook(literal.segments[i]);
    if (i < literal.expressions.length) {
      out += `__m${placeholders.length}__`;
      placeholders.push(literal.expressions[i]);
    }
  }
  return out;
}

const countPlaceholders = (text) => (text.match(PLACEHOLDER) ?? []).map((m) => m).sort().join(',');

const restore = (text, placeholders) => text.replace(PLACEHOLDER, (m, n) => placeholders[Number(n)] ?? m);

const escapeTemplate = (text) => text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

/** Convert program text with placeholders; null with a reason when it cannot be. */
function convertProgram(body, convert) {
  let last = { status: 'failed', message: 'does not parse' };
  for (const sourceKind of ['.8bs', '.8bx']) {
    const result = convert(body, sourceKind);
    if (result.status !== 'failed') return result;
    if (sourceKind === '.8bs') last = result;
  }
  return last;
}

const looksOld = (text) => OLD_MARKER.test(text) && !JS_ONLY.test(text);

/** A template: keep its leading newline and closing indent, convert the core. */
function convertTemplate(literal, convert) {
  const placeholders = [];
  const cooked = cookLiteral(literal, placeholders);
  if (!looksOld(cooked)) return null;
  const lead = /^[ \t]*\n/.exec(cooked)?.[0] ?? '';
  const rest = cooked.slice(lead.length);
  const trailing = /\s*$/.exec(rest)[0];
  const core = rest.slice(0, rest.length - trailing.length);
  const lines = core.split('\n');
  const indents = lines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)[0].length);
  const indent = lead ? Math.min(...indents) : 0;
  const dedented = lines.map((l) => l.slice(Math.min(indent, /^[ \t]*/.exec(l)[0].length))).join('\n');
  const result = convertProgram(dedented, convert);
  if (result.status === 'already-new') return { same: true };
  if (result.status !== 'converted') return { failure: result };
  if (countPlaceholders(dedented) !== countPlaceholders(result.text)) {
    return { failure: { status: 'failed', message: 'a ${} expression did not survive the conversion' } };
  }
  const pad = ' '.repeat(indent);
  const body = result.text.replace(/\n$/, '').split('\n').map((l) => (l === '' ? l : pad + l)).join('\n');
  return { text: restore(escapeTemplate(lead + body + trailing), placeholders), same: result.text === `${dedented}\n` };
}

const quoteLine = (line, placeholders) => {
  if (/__m\d+__/.test(line)) return `\`${restore(escapeTemplate(line), placeholders)}\``;
  const quote = line.includes("'") && !line.includes('"') ? '"' : "'";
  const body = line.replace(/\\/g, '\\\\').replaceAll(quote, `\\${quote}`);
  return `${quote}${body}${quote}`;
};

/** An array of lines: convert the joined text and rewrite one line per element. */
function convertArray(src, array, convert) {
  const placeholders = [];
  const joined = array.elements.map((e) => cookLiteral(e, placeholders)).join('\n');
  if (!looksOld(joined)) return null;
  if (array.mixed) return { failure: { status: 'failed', message: 'the array has elements that are not string literals' } };
  const result = convertProgram(joined, convert);
  if (result.status === 'already-new') return { same: true };
  if (result.status !== 'converted') return { failure: result };
  if (countPlaceholders(joined) !== countPlaceholders(result.text)) {
    return { failure: { status: 'failed', message: 'a ${} expression did not survive the conversion' } };
  }
  const lineStart = (at) => src.lastIndexOf('\n', at) + 1;
  const indentAt = (at) => /^[ \t]*/.exec(src.slice(lineStart(at)))[0];
  const outer = indentAt(array.start);
  const firstOnOwnLine = src.slice(array.start, array.elements[0].start).includes('\n');
  const elementIndent = firstOnOwnLine ? indentAt(array.elements[0].start) : `${outer}  `;
  const lines = result.text.replace(/\n$/, '').split('\n');
  const text = `[\n${lines.map((l) => `${elementIndent}${quoteLine(l, placeholders)},`).join('\n')}\n${outer}]`;
  return { text, same: result.text === `${joined}\n` };
}

/**
 * Convert every old-syntax program literal in a JS/TS source.
 *
 * @param {string} src
 * @param {(body: string, sourceKind: '.8bs'|'.8bx') => { status: string, text?: string, message?: string }} convert
 * @returns {{ text: string, converted: number, unchanged: number, failures: { line: number, status: string, message: string }[] }}
 */
export function convertEmbedded(src, convert) {
  const found = [];
  const hooks = {
    template: (t) => found.push({ kind: 'template', start: t.start, end: t.end, template: t }),
    array: (a) => found.push({ kind: 'array', start: a.start, end: a.end, array: a }),
    lastArrayEnd: 0,
  };
  scanCode(src, 0, hooks);
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const edits = [];
  const failures = [];
  let converted = 0;
  let unchanged = 0;
  let coveredTo = 0;
  for (const item of found) {
    if (item.start < coveredTo) continue;
    const outcome = item.kind === 'template'
      ? convertTemplate(item.template, convert)
      : convertArray(src, item.array, convert);
    if (!outcome) continue;
    coveredTo = item.end;
    if (outcome.failure) {
      failures.push({ line: lineAt(src, item.start), status: outcome.failure.status, message: outcome.failure.message });
    } else if (outcome.same) {
      unchanged += 1;
    } else {
      converted += 1;
      edits.push({ start: item.kind === 'template' ? item.start + 1 : item.start, end: item.kind === 'template' ? item.end - 1 : item.array.closeAt + 1, text: outcome.text });
    }
  }
  let text = src;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return { text, converted, unchanged, failures };
}

/**
 * Convert the ```8bs fences of a Markdown file.
 *
 * @param {string} md
 * @param {(body: string, sourceKind: '.8bs'|'.8bx') => { status: string, text?: string, message?: string }} convert
 */
export function convertFences(md, convert) {
  const lines = md.split('\n');
  const out = [];
  const failures = [];
  let converted = 0;
  let unchanged = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(\s*)```8bs\s*$/.exec(lines[i]);
    out.push(lines[i]);
    if (!open) continue;
    let close = i + 1;
    while (close < lines.length && !/^\s*```\s*$/.test(lines[close])) close += 1;
    if (close >= lines.length) continue;
    const indent = open[1];
    const body = lines.slice(i + 1, close).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n');
    let result = convert(`${body}\n`, '.8bs');
    if (result.status === 'failed') {
      const retry = convert(`${body}\n`, '.8bx');
      if (retry.status !== 'failed') result = retry;
    }
    if (result.status === 'already-new') {
      out.push(...lines.slice(i + 1, close));
    } else if (result.status === 'converted') {
      const printed = result.text.replace(/\n$/, '');
      if (printed === body) unchanged += 1;
      else converted += 1;
      out.push(...printed.split('\n').map((l) => (l === '' ? l : indent + l)));
    } else {
      failures.push({ line: i + 1, status: result.status, message: result.message });
      out.push(...lines.slice(i + 1, close));
    }
    i = close - 1;
  }
  return { text: out.join('\n'), converted, unchanged, failures };
}
