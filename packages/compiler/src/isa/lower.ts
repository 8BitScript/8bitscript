// IR → shared ops. 8-bit values only. A construct with no rule fails by name.
import type { Op } from './ops.ts';

interface IrExpr {
  kind: string;
  value?: number;
  name?: string;
  type?: string | null;
  operator?: string;
  left?: IrExpr;
  right?: IrExpr;
  argument?: IrExpr;
  address?: IrExpr;
  port?: IrExpr;
}

interface IrStatement {
  kind: string;
  name?: string;
  target?: string;
  value?: IrExpr;
  // local's initializer is an expression; for's init clause is a statement
  // (`local` or `assign`). Same field name in the real IR, so this is a union.
  init?: IrExpr | IrStatement;
  address?: IrExpr;
  port?: IrExpr;
  test?: IrExpr;
  then?: IrStatement[];
  else?: IrStatement[];
  body?: IrStatement[];
  update?: IrStatement;
  args?: IrExpr[];
}

interface IrParam { name: string; type: string }
interface IrFunction {
  name: string;
  isEntry?: boolean;
  params?: IrParam[];
  body: IrStatement[];
}
interface IrGlobal { name: string; type?: string; init?: number; address?: number }

export type LowerResult =
  | { ok: true; ops: Op[]; ramBytes: number }
  | { ok: false; error: string };

export function lowerToOps(ir: {
  entry: string;
  functions: IrFunction[];
  globals: IrGlobal[];
}, ramOrigin: number): LowerResult {
  const bindings = new Map<string, number>();
  let ram = ramOrigin;
  for (const g of ir.globals) {
    if (typeof g.address === 'number') bindings.set(g.name, g.address);
    else {
      bindings.set(g.name, ram);
      ram += 1;
    }
  }
  const functions = ir.functions.filter((fn) => fn.body);
  const labels = new Set(functions.map((fn) => fn.name));
  const out: Op[] = [];
  let seq = 0;
  const fresh = (prefix: string) => `${prefix}_${seq++}`;

  const addrOf = (name: string): number | null => {
    const a = bindings.get(name);
    return typeof a === 'number' ? a : null;
  };

  const expr = (node: IrExpr | undefined): string | null => {
    if (!node) return 'an empty expression is not lowered yet';
    switch (node.kind) {
      case 'const':
        out.push({ kind: 'loadImm', value: (node.value ?? 0) & 0xff });
        return null;
      case 'ref': {
        const a = addrOf(node.name ?? '');
        if (a === null) return `'${node.name}' has no address`;
        out.push({ kind: 'loadAbs', address: a });
        return null;
      }
      case 'memoryRead': {
        if (node.address?.kind === 'const') {
          out.push({ kind: 'loadAbs', address: (node.address.value ?? 0) & 0xffff });
          return null;
        }
        return 'memory.read of a computed address is not lowered yet on this CPU';
      }
      case 'portRead': {
        if (node.port?.kind === 'const') {
          out.push({ kind: 'in', port: (node.port.value ?? 0) & 0xff });
          return null;
        }
        return 'port.read of a computed port is not lowered yet';
      }
      case 'binop': {
        if (!node.left || !node.right) return 'binop needs two operands';
        if (node.operator !== '+' && node.operator !== '-' && node.operator !== '==' && node.operator !== '!=' && node.operator !== '<' && node.operator !== '>') {
          return `'${node.operator}' is not lowered yet on this CPU`;
        }
        const errR = expr(node.right);
        if (errR) return errR;
        const tmpName = fresh('t');
        const tmp = ram++;
        bindings.set(tmpName, tmp);
        out.push({ kind: 'storeAbs', address: tmp });
        const errL = expr(node.left);
        if (errL) return errL;
        if (node.operator === '+') out.push({ kind: 'addAbs', address: tmp });
        else if (node.operator === '-') out.push({ kind: 'subAbs', address: tmp });
        else out.push({ kind: 'cmpAbs', address: tmp });
        return null;
      }
      default:
        return `${node.kind} is not lowered yet on this CPU`;
    }
  };

  const emitTest = (node: IrExpr, failLabel: string): string | null => {
    if (node.kind === 'binop' && (node.operator === '<' || node.operator === '>' || node.operator === '==' || node.operator === '!=') && node.left && node.right) {
      if (node.right.kind === 'const') {
        const err = expr(node.left);
        if (err) return err;
        out.push({ kind: 'cmpImm', value: (node.right.value ?? 0) & 0xff });
      } else {
        const err = expr(node);
        if (err) return err;
        out.push({ kind: 'cmpImm', value: 0 });
        out.push({ kind: 'jumpZ', name: failLabel });
        return null;
      }
      if (node.operator === '<') out.push({ kind: 'jumpGE', name: failLabel });
      else if (node.operator === '>') out.push({ kind: 'jumpLT', name: failLabel });
      else if (node.operator === '==') out.push({ kind: 'jumpNZ', name: failLabel });
      else out.push({ kind: 'jumpZ', name: failLabel });
      return null;
    }
    const err = expr(node);
    if (err) return err;
    out.push({ kind: 'cmpImm', value: 0 });
    out.push({ kind: 'jumpZ', name: failLabel });
    return null;
  };

  const block = (stmts: IrStatement[] | undefined, brk: string | null, cont: string | null): string | null => {
    for (const s of stmts ?? []) {
      const err = stmt(s, brk, cont);
      if (err) return err;
    }
    return null;
  };

  const stmt = (s: IrStatement, brk: string | null, cont: string | null): string | null => {
    switch (s.kind) {
      case 'assign': {
        const err = expr(s.value);
        if (err) return err;
        const name = s.target ?? s.name ?? '';
        const a = addrOf(name);
        if (a === null) return `'${name}' has no address`;
        out.push({ kind: 'storeAbs', address: a });
        return null;
      }
      case 'local': {
        const name = s.name ?? '';
        if (!bindings.has(name)) bindings.set(name, ram++);
        const init = (s.value ?? s.init) as IrExpr | undefined;
        if (init) {
          const err = expr(init);
          if (err) return err;
          out.push({ kind: 'storeAbs', address: addrOf(name)! });
        }
        return null;
      }
      case 'memoryWrite': {
        const err = expr(s.value);
        if (err) return err;
        if (s.address?.kind !== 'const') return 'memory.write of a computed address is not lowered yet on this CPU';
        out.push({ kind: 'storeAbs', address: (s.address.value ?? 0) & 0xffff });
        return null;
      }
      case 'portWrite': {
        const err = expr(s.value);
        if (err) return err;
        if (s.port?.kind !== 'const') return 'port.write of a computed port is not lowered yet';
        out.push({ kind: 'out', port: (s.port.value ?? 0) & 0xff });
        return null;
      }
      case 'waitFrame':
        out.push({ kind: 'waitFrame' });
        return null;
      case 'call':
        if (!s.name || !labels.has(s.name)) return `call '${s.name}' is not lowered yet on this CPU`;
        out.push({ kind: 'call', name: s.name });
        return null;
      case 'return':
        out.push({ kind: 'ret' });
        return null;
      case 'if': {
        const elseL = fresh('else');
        const endL = fresh('endif');
        const err = expr(s.test);
        if (err) return err;
        out.push({ kind: 'cmpImm', value: 0 });
        out.push({ kind: 'jumpZ', name: s.else?.length ? elseL : endL });
        const t = block(s.then, brk, cont);
        if (t) return t;
        if (s.else?.length) {
          out.push({ kind: 'jump', name: endL });
          out.push({ kind: 'label', name: elseL });
          const e = block(s.else, brk, cont);
          if (e) return e;
        }
        out.push({ kind: 'label', name: endL });
        return null;
      }
      case 'while':
      case 'for': {
        const start = fresh('loop');
        const end = fresh('endloop');
        const upd = fresh('cont');
        if (s.kind === 'for' && s.init) {
          const i = stmt(s.init as IrStatement, brk, cont);
          if (i) return i;
        }
        out.push({ kind: 'label', name: start });
        if (s.test) {
          const testErr = emitTest(s.test, end);
          if (testErr) return testErr;
        }
        const b = block(s.body, end, s.kind === 'for' ? upd : start);
        if (b) return b;
        out.push({ kind: 'label', name: upd });
        if (s.kind === 'for' && s.update) {
          const u = stmt(s.update, brk, cont);
          if (u) return u;
        }
        out.push({ kind: 'jump', name: start });
        out.push({ kind: 'label', name: end });
        return null;
      }
      case 'break':
        if (!brk) return 'break outside a loop';
        out.push({ kind: 'jump', name: brk });
        return null;
      case 'continue':
        if (!cont) return 'continue outside a loop';
        out.push({ kind: 'jump', name: cont });
        return null;
      case 'block':
        return block(s.body, brk, cont);
      default:
        return `${s.kind} is not lowered yet on this CPU`;
    }
  };

  const entry = functions.find((fn) => fn.name === ir.entry) ?? functions[0];
  if (!entry) return { ok: false, error: 'no entry function' };
  out.push({ kind: 'label', name: entry.name });
  const err = block(entry.body, null, null);
  if (err) return { ok: false, error: err };
  out.push({ kind: 'halt' });
  for (const fn of functions) {
    if (fn.name === entry.name) continue;
    out.push({ kind: 'label', name: fn.name });
    const e = block(fn.body, null, null);
    if (e) return { ok: false, error: e };
    out.push({ kind: 'ret' });
  }
  return { ok: true, ops: out, ramBytes: ram - ramOrigin };
}
