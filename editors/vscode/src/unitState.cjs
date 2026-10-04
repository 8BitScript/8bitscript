// What the launcher remembers about each program, per workspace.
//
// Run scratch is not a preference: the last runtime a program ran in, the
// system it last ran on, the values someone typed into its inputs, which
// disclosures are open. None of it belongs in settings.json (where it would
// land in a file people commit); it lives in the editor's `workspaceState`
// memento, per project and per program.
//
// The memento is injected (`get(key, fallback)` / `update(key, value)`), so
// this file does not touch the `vscode` API and `node --test` runs it.
//
// ---- the API (stable) ------------------------------------------------------
//
//   const state = new UnitState(memento)
//
//   state.runtime(dir, program)              -> 'editor'|'browser'|'native'|null
//   state.setRuntime(dir, program, runtime)  -> Promise
//   state.system(dir, program)               -> string|null   last machine/named system
//   state.setSystem(dir, program, system)    -> Promise
//   state.inputs(dir, program)               -> { NAME: value }   changed inputs only
//   state.setInput(dir, program, name, value)-> Promise           value === undefined clears it
//   state.resetInputs(dir, program)          -> Promise
//   state.ui(dir)                            -> { collapsedGroups: string[], open: string[] }
//   state.setUi(dir, patch)                  -> Promise
//
// Keys (the design's §7): launcher.runtime, launcher.system, launcher.inputs,
// launcher.ui — each `{ [projectDir]: { [program]: value } }`.
'use strict';

const { RUNTIMES } = require('./units.cjs');

const KEYS = {
  runtime: 'launcher.runtime',
  system: 'launcher.system',
  inputs: 'launcher.inputs',
  ui: 'launcher.ui',
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

class UnitState {
  /** @param {{ get: Function, update: Function }} memento */
  constructor(memento) {
    this.memento = memento;
  }

  table(key) {
    const stored = this.memento.get(key, {});
    return isObject(stored) ? stored : {};
  }

  /** Change one `[dir][program]` slot, leaving the rest of the table as it is. */
  async write(key, dir, program, value) {
    const table = { ...this.table(key) };
    const forDir = { ...(isObject(table[dir]) ? table[dir] : {}) };
    if (value === undefined || value === null) delete forDir[program];
    else forDir[program] = value;
    if (Object.keys(forDir).length === 0) delete table[dir];
    else table[dir] = forDir;
    await this.memento.update(key, table);
  }

  read(key, dir, program) {
    const forDir = this.table(key)[dir];
    return isObject(forDir) ? forDir[program] : undefined;
  }

  runtime(dir, program) {
    const value = this.read(KEYS.runtime, dir, program ?? '');
    return RUNTIMES.includes(value) ? value : null;
  }

  setRuntime(dir, program, runtime) {
    return this.write(KEYS.runtime, dir, program ?? '', RUNTIMES.includes(runtime) ? runtime : undefined);
  }

  system(dir, program) {
    const value = this.read(KEYS.system, dir, program ?? '');
    return typeof value === 'string' && value !== '' ? value : null;
  }

  setSystem(dir, program, system) {
    return this.write(KEYS.system, dir, program ?? '', typeof system === 'string' && system !== '' ? system : undefined);
  }

  inputs(dir, program) {
    const value = this.read(KEYS.inputs, dir, program ?? '');
    return isObject(value) ? { ...value } : {};
  }

  async setInput(dir, program, name, value) {
    const next = this.inputs(dir, program);
    if (value === undefined) delete next[name];
    else next[name] = value;
    await this.write(KEYS.inputs, dir, program ?? '', Object.keys(next).length > 0 ? next : undefined);
  }

  resetInputs(dir, program) {
    return this.write(KEYS.inputs, dir, program ?? '', undefined);
  }

  ui(dir) {
    const value = this.table(KEYS.ui)[dir];
    return {
      collapsedGroups: Array.isArray(value?.collapsedGroups) ? value.collapsedGroups.filter((g) => typeof g === 'string') : [],
      open: Array.isArray(value?.open) ? value.open.filter((g) => typeof g === 'string') : [],
    };
  }

  async setUi(dir, patch) {
    const table = { ...this.table(KEYS.ui) };
    table[dir] = { ...this.ui(dir), ...patch };
    await this.memento.update(KEYS.ui, table);
  }
}

module.exports = { KEYS, UnitState };
