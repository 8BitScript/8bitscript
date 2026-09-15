// A `vscode` stand-in for `node --test`: the real module only exists
// inside the extension host, so every file that does
// `const vscode = require('vscode')` at module scope has never been
// loadable — let alone executed — under plain Node. This intercepts
// Module._load for the bare specifier 'vscode' (before Node ever tries
// to resolve it on disk) and hands back a small, controllable fake with
// just the surface settings.cjs / systemView.cjs / projectView.cjs /
// runner.cjs actually call.
//
// Each test file installs its own copy — `node --test` runs each test
// file in its own process, so this never leaks across files — and calls
// `vscodeMock.reset()` between cases that need a clean command registry
// or event listener set.
'use strict';

const Module = require('module');

function makeDisposable(dispose = () => {}) {
  return { dispose };
}

function makeEmitter() {
  const listeners = [];
  const event = (listener) => {
    listeners.push(listener);
    return makeDisposable(() => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    });
  };
  return {
    event,
    fire(payload) {
      for (const listener of [...listeners]) listener(payload);
    },
    dispose() {
      listeners.length = 0;
    },
  };
}

function makeConfig(store) {
  return {
    get(key) {
      return store.has(key) ? store.get(key) : undefined;
    },
    update(key, value) {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function defaultOpenTextDocument(uri) {
  return Promise.resolve({
    uri,
    getText: () => '',
    positionAt: (offset) => ({ offset }),
    save: () => Promise.resolve(true),
  });
}

function createVscodeMock() {
  const configStore = new Map();
  const commandHandlers = new Map();
  const queues = {
    showQuickPick: [],
    showInputBox: [],
    showOpenDialog: [],
    showWarningMessage: [],
    showInformationMessage: [],
    showErrorMessage: [],
  };
  const calls = {
    showInformationMessage: [],
    showWarningMessage: [],
    showErrorMessage: [],
  };
  const taskEmitters = {
    onDidStartTask: makeEmitter(),
    onDidEndTask: makeEmitter(),
    onDidEndTaskProcess: makeEmitter(),
  };
  const executedTasks = [];
  const executedCommands = [];

  function nextFrom(name) {
    return queues[name].length > 0 ? queues[name].shift() : undefined;
  }

  class EventEmitter {
    constructor() {
      const emitter = makeEmitter();
      this.event = emitter.event;
      this.fire = (payload) => emitter.fire(payload);
      this.dispose = () => emitter.dispose();
    }
  }

  class Task {
    constructor(definition, scope, name, source, execution) {
      this.definition = definition;
      this.scope = scope;
      this.name = name;
      this.source = source;
      this.execution = execution;
    }
  }

  class ShellExecution {
    constructor(commandLine, args, options) {
      if (Array.isArray(args)) {
        this.commandLine = commandLine;
        this.args = args;
        this.options = options;
      } else {
        this.commandLine = commandLine;
        this.options = args;
      }
    }
  }

  class WorkspaceEdit {
    constructor() {
      this.edits = [];
    }

    replace(uri, range, text) {
      this.edits.push({ uri, range, text });
    }
  }

  class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  }

  class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  }

  const uriFor = (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` });

  const vscode = {
    env: { appName: 'Visual Studio Code' },
    EventEmitter,
    Task,
    ShellExecution,
    WorkspaceEdit,
    Range,
    RelativePattern,
    ViewColumn: { Active: 1 },
    TaskScope: { Workspace: 1 },
    TaskGroup: { Build: 'build' },
    TaskRevealKind: { Always: 1 },
    TaskPanelKind: { Dedicated: 1 },
    ShellQuoting: { Strong: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    QuickPickItemKind: { Separator: -1 },
    Uri: {
      file: uriFor,
      parse: uriFor,
    },
    window: {
      workspaceState: undefined,
      showInformationMessage: (...args) => {
        calls.showInformationMessage.push(args);
        return Promise.resolve(nextFrom('showInformationMessage'));
      },
      showWarningMessage: (...args) => {
        calls.showWarningMessage.push(args);
        return Promise.resolve(nextFrom('showWarningMessage'));
      },
      showErrorMessage: (...args) => {
        calls.showErrorMessage.push(args);
        return Promise.resolve(nextFrom('showErrorMessage'));
      },
      showQuickPick: (...args) => Promise.resolve(nextFrom('showQuickPick')),
      showInputBox: (...args) => Promise.resolve(nextFrom('showInputBox')),
      showOpenDialog: (...args) => Promise.resolve(nextFrom('showOpenDialog')),
      showTextDocument: (docOrUri) => Promise.resolve({
        document: docOrUri,
        selection: { active: { line: 0, character: 0 } },
        edit: (builder) => {
          const inserted = [];
          builder({ insert: (position, text) => inserted.push({ position, text }) });
          return Promise.resolve(true);
        },
      }),
      registerWebviewViewProvider: () => makeDisposable(),
      createWebviewPanel(viewType, title, column, options) {
        const messageEmitter = makeEmitter();
        const disposeEmitter = makeEmitter();
        const posted = [];
        return {
          viewType,
          title,
          column,
          options,
          posted,
          webview: {
            cspSource: 'vscode-webview:',
            html: '',
            postMessage: (message) => {
              posted.push(message);
              return Promise.resolve(true);
            },
            onDidReceiveMessage: messageEmitter.event,
            __fire: (message) => messageEmitter.fire(message),
          },
          reveal: () => {},
          onDidDispose: disposeEmitter.event,
          __dispose: () => disposeEmitter.fire(),
        };
      },
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => makeConfig(configStore),
      getWorkspaceFolder: () => undefined,
      findFiles: () => Promise.resolve([]),
      openTextDocument: defaultOpenTextDocument,
      applyEdit: (edit) => {
        executedCommands.push({ applyEdit: edit });
        return Promise.resolve(true);
      },
      createFileSystemWatcher: () => ({
        onDidCreate: () => makeDisposable(),
        onDidDelete: () => makeDisposable(),
        onDidChange: () => makeDisposable(),
        dispose() {},
      }),
      onDidChangeWorkspaceFolders: () => makeDisposable(),
      onDidChangeConfiguration: () => makeDisposable(),
    },
    tasks: {
      taskExecutions: [],
      onDidStartTask: taskEmitters.onDidStartTask.event,
      onDidEndTask: taskEmitters.onDidEndTask.event,
      onDidEndTaskProcess: taskEmitters.onDidEndTaskProcess.event,
      registerTaskProvider: () => makeDisposable(),
      executeTask: (task) => {
        const execution = { task, terminate: () => {} };
        executedTasks.push(execution);
        return Promise.resolve(execution);
      },
    },
    commands: {
      registerCommand: (id, handler) => {
        commandHandlers.set(id, handler);
        return makeDisposable(() => commandHandlers.delete(id));
      },
      executeCommand: (id, ...args) => {
        executedCommands.push({ id, args });
        const handler = commandHandlers.get(id);
        return handler ? Promise.resolve(handler(...args)) : Promise.resolve(undefined);
      },
    },

    // Test-only surface, namespaced so it can never collide with a real
    // vscode export: queue interactive responses, inspect what fired, and
    // trigger the events production code subscribed to.
    __mock: {
      configStore,
      commandHandlers,
      queues,
      calls,
      executedTasks,
      executedCommands,
      taskEmitters,
      trigger: (id, ...args) => {
        const handler = commandHandlers.get(id);
        if (!handler) throw new Error(`no command registered for '${id}'`);
        return handler(...args);
      },
      // Clears mutable state in place rather than replacing this object:
      // production modules captured `const vscode = require('vscode')`
      // once at their own load time, so a test's `reset()` between cases
      // has to mutate the same object they are holding, not swap it out.
      reset() {
        configStore.clear();
        commandHandlers.clear();
        for (const queue of Object.values(queues)) queue.length = 0;
        for (const list of Object.values(calls)) list.length = 0;
        executedTasks.length = 0;
        executedCommands.length = 0;
        vscode.workspace.workspaceFolders = undefined;
        vscode.workspace.openTextDocument = defaultOpenTextDocument;
        vscode.tasks.taskExecutions = [];
        vscode.env.appName = 'Visual Studio Code';
      },
    },
  };

  return vscode;
}

let installed = false;
let current = null;

/**
 * Intercepts require('vscode') for the rest of this process (each
 * `node --test` file gets its own process, so this never leaks across
 * files) and returns the single mock instance for it. Safe to call
 * again — later calls return the same instance so already-loaded
 * production modules keep seeing it; use `vscode.__mock.reset()` between
 * test cases instead of calling this twice.
 */
function installVscodeMock() {
  if (!installed) {
    installed = true;
    current = createVscodeMock();
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'vscode') return current;
      return originalLoad.call(this, request, parent, isMain);
    };
  }
  return current;
}

module.exports = { installVscodeMock };
