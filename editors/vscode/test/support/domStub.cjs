// A hand-rolled DOM, just big enough to run the webview scripts
// (media/*.js) for real under `vm.runInContext` and collect genuine V8
// coverage — not jsdom (not a dependency here), just createElement,
// appendChild/append, textContent, classList/dataset, addEventListener,
// and the one querySelectorAll shape this codebase actually uses
// (`'#id [data-attr]'`).
'use strict';

function createElement(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    hidden: false,
    disabled: false,
    selected: false,
    checked: false,
    value: '',
    title: '',
    colSpan: undefined,
    dataset: {},
    attributes: {},
    children: [],
    parentNode: null,
    classList: {
      add(name) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        set.add(name);
        el.className = [...set].join(' ');
      },
      remove(name) {
        el.className = el.className.split(/\s+/).filter((n) => n && n !== name).join(' ');
      },
      toggle(name, force) {
        const has = el.className.split(/\s+/).includes(name);
        const want = force === undefined ? !has : force;
        if (want) el.classList.add(name); else el.classList.remove(name);
      },
      contains(name) {
        return el.className.split(/\s+/).includes(name);
      },
    },
    get textContent() {
      return el._text ?? '';
    },
    set textContent(value) {
      el._text = String(value);
      el.children = [];
    },
    appendChild(child) {
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    append(...nodes) {
      for (const node of nodes) el.appendChild(node);
    },
    replaceChildren(...nodes) {
      el.children = [];
      el._text = '';
      for (const node of nodes) el.appendChild(node);
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const arr = listeners.get(type);
      if (!arr) return;
      const at = arr.indexOf(handler);
      if (at >= 0) arr.splice(at, 1);
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) ?? []) handler({ target: el, ...event });
    },
    querySelectorAll(selector) {
      return matchDescendants(el, selector);
    },
  };
  return el;
}

// Only the one shape this repo's webview scripts use: an id selector
// followed by an attribute-presence selector on a `data-*` name, e.g.
// `'#tabs [data-tab]'`. Good enough for these pages; not a CSS engine.
function matchDescendants(root, selector) {
  const match = /^\[data-([a-z-]+)\]$/.exec(selector.trim());
  if (!match) return [];
  const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const found = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.dataset && child.dataset[key] !== undefined) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function createDomStub() {
  const elementsById = new Map();
  const windowListeners = new Map();

  function getElementById(id) {
    if (!elementsById.has(id)) {
      const el = createElement('div');
      el.id = id;
      elementsById.set(id, el);
    }
    return elementsById.get(id);
  }

  function querySelectorAll(selector) {
    const scoped = /^#([\w-]+)\s+(.+)$/.exec(selector.trim());
    if (scoped) {
      const [, id, rest] = scoped;
      return matchDescendants(getElementById(id), rest);
    }
    return matchDescendants({ children: [...elementsById.values()] }, selector);
  }

  const document = {
    createElement,
    getElementById,
    querySelectorAll,
  };

  const window = {
    document,
    location: { origin: 'https://webview.test', href: 'https://webview.test/' },
    URL,
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const arr = windowListeners.get(type);
      if (!arr) return;
      const at = arr.indexOf(handler);
      if (at >= 0) arr.splice(at, 1);
    },
    dispatch(type, event = {}) {
      for (const handler of windowListeners.get(type) ?? []) handler(event);
    },
  };

  return { document, window, elementsById, windowListeners, getElementById, seed: (id, el) => elementsById.set(id, el) };
}

module.exports = { createDomStub, createElement };
