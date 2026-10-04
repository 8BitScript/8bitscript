// The launcher page.
//
// It holds no truth of its own. The extension posts one `state` message (the
// shape is documented at the top of src/launcherState.cjs), this script draws
// it, and every click goes back as one typed message. The only things kept
// here are the page's own conveniences — the filter text, which disclosures
// are open, which groups are folded — and they survive a reload through the
// webview's own state.
//
// Everything is built with createElement (h() below), never markup strings, so
// nothing a project names can become HTML.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('app');

  // Codicon codepoints, from the subset font in media/codicon.woff2.
  const CP = {
    play: 60204, 'open-preview': 60200, globe: 60161, 'device-desktop': 60026, tools: 60269, 'debug-stop': 60119,
    'go-to-file': 60052, info: 60020, 'settings-gear': 60241, 'debug-restart': 60114, 'chevron-down': 60084,
    'chevron-right': 60086, 'chevron-up': 60087, ellipsis: 60028, refresh: 60215, pulse: 60209, rocket: 60228,
    check: 60082, close: 60022, warning: 60012, error: 60039, copy: 60364, 'folder-opened': 60151,
    'link-external': 60180, search: 60013, package: 60201, terminal: 60037, add: 60000,
  };

  let state = null;
  const saved = vscode.getState() || {};
  const ui = {
    filter: '',
    open: {},            // disclosure id -> true
    collapsed: {},       // group name -> true/false (overrides the state's default)
    menu: null,          // 'project' | 'system' | 'more' | null
    navKey: null,        // the one list control in the tab order
    ...saved,
  };
  const persist = () => vscode.setState({ filter: ui.filter, open: ui.open, collapsed: ui.collapsed, navKey: ui.navKey });
  const post = (message) => vscode.postMessage(message);

  /** A posted state with every list a list, so a short or older message cannot break the page. */
  function fill(raw) {
    const list = (v) => (Array.isArray(v) ? v : []);
    return {
      ...raw,
      phase: raw.phase || 'ready',
      runtimes: list(raw.runtimes).length ? raw.runtimes : [
        { id: 'editor', label: 'Editor', icon: 'open-preview', long: 'Editor tab', what: 'Runs the WASM build in a tab inside the editor.' },
        { id: 'browser', label: 'Browser', icon: 'globe', long: 'Web browser', what: 'Runs the WASM build in your web browser.' },
        { id: 'native', label: 'Native', icon: 'device-desktop', long: 'Native emulator', what: 'Runs the real emulator for this machine.' },
      ],
      notices: list(raw.notices), projects: list(raw.projects), systems: list(raw.systems), programs: list(raw.programs),
      collapsedGroups: list(raw.collapsedGroups), running: list(raw.running), history: list(raw.history),
      command: raw.command || '',
    };
  }

  // ── building blocks ───────────────────────────────────────────────────────
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    const add = (kid) => {
      if (kid === null || kid === undefined || kid === false) return;
      if (Array.isArray(kid)) kid.forEach(add);
      else el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
    };
    kids.forEach(add);
    return el;
  }
  /** Append nodes, flattening nested lists and skipping the falsy ones a condition leaves. */
  function appendAll(parent, kids) {
    for (const kid of [].concat(kids)) {
      if (Array.isArray(kid)) appendAll(parent, kid);
      else if (kid) parent.appendChild(kid);
    }
  }
  const icon = (name) => {
    const el = h('i', { class: 'codicon', 'aria-hidden': 'true' });
    el.textContent = String.fromCodePoint(CP[name]);
    return el;
  };
  const runtimeOf = (id) => state.runtimes.find((r) => r.id === id);
  const programOf = (id) => state.programs.find((p) => p.id === id);
  const systemOf = (id) => state.systems.find((s) => s.id === id);
  const selected = () => programOf(state.program);

  // ── pieces ────────────────────────────────────────────────────────────────
  function sectionLabel(text, count) {
    return h('div', { class: 'sec' }, h('span', null, text), count != null && h('span', { class: 'count' }, count), h('span', { class: 'grow' }));
  }

  function notice(n) {
    return h('div', { class: `notice ${n.kind || 'info'}`, role: n.kind === 'error' ? 'alert' : 'status' },
      icon(n.icon || (n.kind === 'warn' ? 'warning' : n.kind === 'error' ? 'error' : 'info')),
      h('div', { class: 'body' },
        n.title && h('b', null, `${n.title} `), n.text,
        n.actions && n.actions.length > 0 && h('div', { class: 'acts' },
          n.actions.map((a, i) => h('button', { class: `btn sm${i === 0 && n.kind === 'warn' ? ' primary' : ''}`, 'data-action': 'notice', 'data-notice': n.id, 'data-index': i, 'data-key': `notice:${n.id}:${i}` },
            a.icon && icon(a.icon), a.label)))));
  }

  function skeleton() {
    return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading programs' }, h('i'), h('i'), h('i'), h('i'), h('i'));
  }

  function emptyState() {
    return h('div', { class: 'empty' },
      h('img', { src: root.dataset.logo || '', alt: '' }),
      h('h2', null, 'No 8BitScript project here'),
      h('p', null, 'Open a folder that has an ', h('span', { class: 'mono' }, '8bitscript.config.8bs'), ', or start from an example.'),
      h('button', { class: 'btn primary', 'data-action': 'openFolder', 'data-key': 'empty:open' }, icon('folder-opened'), 'Open Folder…'),
      h('button', { class: 'btn', 'data-action': 'tryExample', 'data-key': 'empty:example' }, icon('rocket'), 'Try an example…'),
      h('button', { class: 'link small', 'data-action': 'learn', 'data-key': 'empty:learn' }, 'What is 8BitScript?'));
  }

  function picker(label, labelId, value, sub, action, expanded) {
    return h('div', { class: 'sel' },
      h('span', { class: 'field-label', id: labelId }, label),
      h('button', { class: 'picker', 'aria-labelledby': labelId, 'aria-haspopup': 'menu', 'aria-expanded': String(expanded), 'data-action': action, 'data-key': `picker:${label}` },
        h('span', { class: 't' }, value, sub && h('span', { class: 'sm' }, sub)), icon(expanded ? 'chevron-up' : 'chevron-down')));
  }

  function menuItem(label, props, kids) {
    return h('button', { class: 'it', role: props.role || 'menuitem', tabindex: -1, ...props }, kids || null, h('span', { class: 'who' }, label));
  }

  function projectMenu() {
    const groups = [];
    for (const p of state.projects) {
      let g = groups.find((x) => x.name === p.group);
      if (!g) groups.push(g = { name: p.group, items: [] });
      g.items.push(p);
    }
    return h('div', { class: 'menu', role: 'menu', 'aria-label': 'Project', 'data-menu': 'project' },
      groups.map((g) => [g.name && h('div', { class: 'grp' }, g.name),
        g.items.map((p) => menuItem(p.label, {
          role: 'menuitemradio', 'aria-checked': String(p.id === state.project?.id), 'data-action': 'select-project', 'data-project': p.id, 'data-key': `pm:${p.id}`, title: p.where || null,
        }, h('span', { class: 'tick' }, p.id === state.project?.id && icon('check'))))]));
  }

  function systemMenu() {
    const groups = [];
    for (const s of state.systems) {
      let g = groups.find((x) => x.name === (s.group || 'Machines'));
      if (!g) groups.push(g = { name: s.group || 'Machines', items: [] });
      g.items.push(s);
    }
    return h('div', { class: 'menu', role: 'menu', 'aria-label': 'System', 'data-menu': 'system' },
      groups.map((g) => [h('div', { class: 'grp' }, g.name),
        g.items.map((s) => h('button', {
          class: 'it', role: 'menuitemradio', tabindex: -1, 'aria-checked': String(s.id === state.system), 'aria-disabled': s.enabled === false ? 'true' : null,
          'data-action': 'select-system', 'data-system': s.id, 'data-key': `sm:${s.id}`, title: s.enabled === false ? (s.reason || `${selected()?.title || 'This program'} doesn't target ${s.name}`) : `${s.name} · ${s.spec}`,
        }, h('span', { class: 'tick' }, s.id === state.system && icon('check')), h('span', { class: 'who' }, s.name), h('span', { class: 'spec' }, s.spec))) ]),
      h('hr'),
      menuItem('Hardware, region & language…', { 'data-action': 'configureSystem', 'data-key': 'sm:configure' }, [h('span', { class: 'tick' }), icon('settings-gear')]),
      menuItem('Save as a named system…', { 'data-action': 'saveSystem', 'data-key': 'sm:save' }, [h('span', { class: 'tick' }), icon('add')]));
  }

  function moreMenu(p) {
    return h('div', { class: 'menu', role: 'menu', 'aria-label': `More actions for ${p.title}`, 'data-menu': 'more' },
      menuItem('Open bare emulator', { 'data-action': 'boot', 'data-key': 'more:boot', title: 'Open the emulator with nothing loaded', 'aria-disabled': systemOf(state.system)?.emulator ? null : 'true' }, icon('device-desktop')),
      menuItem('Copy command', { 'data-action': 'copy', 'data-key': 'more:copy' }, icon('copy')),
      menuItem('Reveal in Explorer', { 'data-action': 'reveal', 'data-program': p.id, 'data-key': 'more:reveal' }, icon('go-to-file')));
  }

  /** A command that wraps between flags and never inside one; --define is dimmed. */
  function cmdNodes(cmd) {
    const parts = cmd.split(' --');
    return parts.map((part, i) => {
      if (i === 0) return h('span', { class: 'nb' }, part, ' ');
      const [flag, ...rest] = part.split(' ');
      return h('span', { class: 'nb' }, flag === 'define' ? h('span', { class: 'dim' }, '--define') : `--${flag}`, rest.length > 0 && ` ${rest.join(' ')}`, ' ');
    });
  }

  function codeBlock(cmd, id, key) {
    return h('div', { class: 'panel', id }, h('div', { class: 'code' },
      h('span', { class: 'cmd' }, cmdNodes(cmd)),
      h('button', { class: 'ibtn', 'data-action': 'copy', 'data-text': cmd, 'data-key': key, title: 'Copy command', 'aria-label': 'Copy command' }, icon('copy'))));
  }

  function disclosure(id, label, count, note, open, body) {
    return h('div', null,
      h('button', { class: 'disclosure', 'data-action': 'toggle', 'data-open': id, 'aria-expanded': String(open), 'aria-controls': `panel-${id}`, 'data-key': `dis:${id}` },
        icon('chevron-right'), h('span', null, label), count != null && h('span', { class: 'badge' }, count), h('span', { class: 'grow' }), note && h('span', { class: 'note' }, note)),
      open ? h('div', { class: 'panel form', id: `panel-${id}` }, body) : null);
  }

  function inputControl(p, i) {
    const id = `in-${p.id}-${i.name}`;
    const changed = i.value !== i.def;
    const attrs = { id, 'data-input': i.name, 'data-program': p.id, 'data-kind': i.kind, 'data-key': `input:${p.id}:${i.name}` };
    const chg = changed && h('span', { class: 'chg' }, 'changed');
    if (i.kind === 'bool') {
      return h('div', { class: changed ? 'changed' : '' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', ...attrs, checked: i.value ? true : null }), h('span', { class: 'box' }, i.value && icon('check')), h('span', null, i.label)),
        h('div', { class: 'f-help f-split' }, h('span', null, i.help), h('span', { class: 'var' }, i.name), chg));
    }
    const head = h('div', { class: 'f-label' }, h('label', { for: id }, i.label), h('span', { class: 'var' }, i.name), chg);
    if (i.kind === 'select') {
      return h('div', { class: changed ? 'changed' : '' }, head,
        h('div', { class: 'select-wrap' }, h('select', { class: 'select', ...attrs }, i.options.map((o) => h('option', { value: o, selected: String(o) === String(i.value) ? true : null }, o))), icon('chevron-down')),
        i.help && h('div', { class: 'f-help' }, i.help));
    }
    return h('div', { class: changed ? 'changed' : '' }, head,
      h('input', { class: 'input', type: i.kind === 'number' ? 'number' : 'text', value: i.value === undefined ? '' : i.value, ...attrs }),
      i.help && h('div', { class: 'f-help' }, i.help));
  }

  function inputsBlock(p) {
    if (p.inputs.length === 0) return null;
    const changed = p.inputs.filter((i) => i.value !== i.def).length;
    const id = `inputs:${p.id}`;
    return disclosure(id, 'Inputs', p.inputs.length, changed ? `${changed} changed` : 'defaults', Boolean(ui.open[id]), [
      p.inputs.map((i) => inputControl(p, i)),
      changed > 0 && h('div', null, h('button', { class: 'btn ghost sm', 'data-action': 'inputsReset', 'data-program': p.id, 'data-key': `reset:${p.id}` }, icon('debug-restart'), 'Reset to defaults')),
    ]);
  }

  function reasonBlock(p) {
    const bad = state.runtimes.filter((r) => !p.runtimes[r.id].ok);
    if (bad.length === 0) return null;
    // One paragraph per distinct reason: Editor and Browser usually share one,
    // Native has its own, and both can be true at once.
    const groups = [];
    for (const r of bad) {
      const a = p.runtimes[r.id];
      let g = groups.find((x) => x.reason === (a.reason || ''));
      if (!g) groups.push(g = { reason: a.reason || '', runtimes: [], a });
      g.runtimes.push(r);
    }
    const fixable = bad.map((r) => p.runtimes[r.id]).find((a) => a.fixable);
    const fixer = groups.length === 1 ? groups[0].a : null;
    const use = fixer && state.runtimes.find((r) => r.id === fixer.use);
    let fix = null;
    if (fixable) {
      fix = h('div', { class: 'acts' },
        h('button', { class: 'btn sm primary', 'data-action': 'fix', 'data-kind': 'emulator', 'data-key': 'fix:emulator' }, icon('package'), `Install ${fixable.emulator}`),
        h('button', { class: 'btn sm', 'data-action': 'doctor', 'data-key': 'fix:doctor' }, icon('pulse'), 'Run Doctor'));
    } else if (use && use.id !== p.primary && p.runtimes[use.id].ok) {
      fix = h('div', { class: 'acts' }, h('button', { class: 'btn sm', 'data-action': 'selectRuntime', 'data-runtime': use.id, 'data-program': p.id, 'data-key': `use:${use.id}` }, icon(use.icon), `Use ${use.label} instead`));
    }
    const names = (g) => g.runtimes.map((r) => r.label).join(' and ');
    return h('div', { class: `reason${fixable ? ' warn' : ''}`, id: `reason-${p.id}`, role: 'note', tabindex: -1, 'data-key': `reason:${p.id}` },
      icon(fixable ? 'warning' : 'info'),
      h('div', { class: 'why' },
        groups.map((g) => h('p', { class: 'why-line' }, h('b', null, `${names(g)} ${g.runtimes.length > 1 ? 'are' : 'is'} unavailable. `), g.reason)),
        fix));
  }

  function runButtons(p) {
    const sys = systemOf(state.system) || { name: state.system };
    const buttons = state.runtimes.map((r) => {
      const a = p.runtimes[r.id];
      const ok = p.onSystem && a.ok;
      const isPrimary = ok && r.id === p.primary;
      const label = `Run ${p.title} on ${sys.name} in ${r.long.toLowerCase()}${isPrimary ? ' (default)' : ''}`;
      return h('button', {
        class: `btn run${isPrimary ? ' primary' : ''}`, 'data-action': 'run', 'data-runtime': r.id, 'data-program': p.id, 'data-hint': r.what,
        'aria-disabled': ok ? null : 'true', 'aria-describedby': ok ? null : `reason-${p.id}`, title: ok ? label : `${r.long} unavailable: ${a.reason || ''}`, 'aria-label': ok ? label : `${r.long} unavailable`,
        'data-key': `big:${p.id}:${r.id}`,
      }, icon(r.icon), h('span', null, r.label));
    });
    const lead = state.runtimes.find((r) => r.id === p.primary);
    const hint = lead ? (lead.id === 'native' && sys.emulator ? `Runs the real ${sys.emulator} emulator with ${p.title} loaded.` : lead.what) : 'Nothing can run this combination.';
    return [h('div', { class: 'runs', role: 'group', 'aria-label': 'Run in' }, buttons), h('p', { class: 'hint', id: 'hint', 'aria-live': 'polite' }, hint)];
  }

  function drawer(p, single) {
    const cmdId = `command:${p.id}`;
    const cmdOpen = Boolean(ui.open[cmdId]);
    const reason = !p.onSystem
      ? h('div', { class: 'reason', id: `reason-${p.id}`, role: 'note', tabindex: -1, 'data-key': `reason:${p.id}` }, icon('info'),
        h('div', { class: 'why' }, h('b', null, 'Not on this system. '), `${p.title} doesn't target ${systemOf(state.system)?.name || state.system}.`))
      : reasonBlock(p);
    const inputs = inputsBlock(p);
    return h('div', { class: `drawer${single ? ' single' : ''}`, role: 'region', 'aria-label': `${p.title} details` },
      p.description && h('p', { class: 'desc' }, p.description),
      p.entry && h('button', { class: 'source', 'data-action': 'openSource', 'data-program': p.id, 'data-key': `source:${p.id}`, title: `Open the entry file of ${p.title}`, 'aria-label': `Open source file ${p.entry}` }, icon('go-to-file'), h('span', null, p.entry)),
      single && h('div', { class: 'subh' }, runButtons(p)),
      p.primaryMoved && h('p', { class: 'hint' }, p.primaryMoved),
      reason,
      inputs && h('div', { class: 'subh' }, inputs),
      h('div', { class: 'tools-row' },
        h('button', { class: 'btn ghost sm', 'data-action': 'build', 'data-program': p.id, 'data-key': `build:${p.id}`, title: `Compile ${p.id} to dist/${p.id}.prg and show the size report. Nothing runs.` }, icon('tools'), 'Build'),
        h('button', { class: 'btn ghost sm', 'data-action': 'toggle', 'data-open': cmdId, 'aria-expanded': String(cmdOpen), 'aria-controls': `panel-${cmdId}`, 'data-key': `cmd:${p.id}`, title: 'Show the exact command a click runs' }, icon('terminal'), 'Command'),
        h('span', { class: 'grow' }),
        h('button', { class: 'ibtn', 'data-action': 'menu', 'data-menu-name': 'more', 'aria-haspopup': 'menu', 'aria-expanded': String(ui.menu === 'more'), 'data-key': `more:${p.id}`, title: 'More: open a bare emulator, copy the command, reveal in Explorer', 'aria-label': 'More actions' }, icon('ellipsis'))),
      ui.menu === 'more' && moreMenu(p),
      cmdOpen && codeBlock(state.command, `panel-${cmdId}`, `copy:${p.id}`));
  }

  // ── the list ──────────────────────────────────────────────────────────────
  let navRow = 0;
  function programRow(p) {
    const sel = p.id === state.program;
    const sys = systemOf(state.system) || { name: state.system };
    const ri = navRow++;
    const live = p.live.length > 0;
    const btns = state.runtimes.map((r, col) => {
      const a = p.runtimes[r.id];
      const ok = p.onSystem && a.ok;
      const isLive = p.live.includes(r.id);
      const isPrimary = ok && sel && r.id === p.primary;
      const tip = !p.onSystem ? `${p.title} doesn't target ${sys.name}` : ok
        ? (isLive ? `${r.long}: running. Click to restart it.` : `Run ${p.title} on ${sys.name} in ${r.long.toLowerCase()}`)
        : `${r.long} unavailable: ${a.reason || ''}`;
      return h('button', {
        class: `ibtn${isPrimary ? ' primary' : ''}${isLive ? ' live' : ''}`, 'data-action': 'run', 'data-runtime': r.id, 'data-program': p.id,
        'data-nav-row': ri, 'data-nav-col': col + 1, 'data-key': `run:${p.id}:${r.id}`, tabindex: -1, 'aria-disabled': ok ? null : 'true', title: tip, 'aria-label': tip,
      }, icon(r.icon));
    });
    const lead = state.runtimes.find((r) => r.id === p.primary);
    const nameLabel = [p.title, live ? 'running' : null, !p.onSystem ? `not on ${sys.name}` : null].filter(Boolean).join(', ');
    return h('div', { class: `prow${sel ? ' sel' : ''}`, role: 'listitem' },
      h('span', { class: `st${live ? ' live' : ''}`, title: live ? 'Running' : null }),
      h('button', {
        class: `name${p.onSystem ? '' : ' dim'}`, 'data-action': 'select-program', 'data-program': p.id, 'data-nav-row': ri, 'data-nav-col': 0, 'data-key': `row:${p.id}`, tabindex: -1,
        'aria-expanded': String(sel), 'aria-current': sel ? 'true' : null, 'aria-label': nameLabel, 'aria-keyshortcuts': 'Enter', title: lead && p.onSystem ? `${p.title} · Enter runs in ${lead.label}` : p.title,
      }, p.title),
      h('span', { class: 'acts', role: 'group', 'aria-label': `Run ${p.title} in` }, btns));
  }

  function programList(single) {
    const q = ui.filter.trim().toLowerCase();
    const shown = state.programs.filter((p) => !q || p.title.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    const groups = [];
    for (const p of shown) {
      let g = groups.find((x) => x.name === p.group);
      if (!g) groups.push(g = { name: p.group, items: [] });
      g.items.push(p);
    }
    const out = [];
    for (const g of groups) {
      const collapsed = !q && g.name && (g.name in ui.collapsed ? ui.collapsed[g.name] : state.collapsedGroups.includes(g.name));
      // The header takes its place in the keyboard walk before the rows under it.
      const ri = g.name ? navRow++ : -1;
      const rows = collapsed ? [] : g.items.map((p) => [programRow(p), p.id === state.program ? drawer(p, false) : null]);
      if (!g.name) { out.push(h('div', { role: 'group', 'aria-label': 'Programs' }, rows)); continue; }
      out.push(h('div', { role: 'group', 'aria-label': g.name },
        h('button', { class: 'group-head', 'aria-expanded': String(!collapsed), 'data-action': 'toggle-group', 'data-group': g.name, 'data-nav-row': ri, 'data-nav-col': 0, 'data-key': `group:${g.name}`, tabindex: -1 },
          icon(collapsed ? 'chevron-right' : 'chevron-down'), h('span', null, g.name), h('span', { class: 'grow' }), h('span', { class: 'n' }, g.items.length)),
        rows));
    }
    return [
      state.programs.length > 7 && h('div', { class: 'filter' }, icon('search'),
        h('input', { class: 'input', 'data-filter': 'true', 'data-key': 'filter', placeholder: 'Filter programs', 'aria-label': 'Filter programs', value: ui.filter })),
      h('div', { class: 'legend', 'aria-hidden': 'true' }, h('span', { class: 'lead' }, 'Programs'), state.runtimes.map((r) => h('span', null, icon(r.icon), h('span', { class: 'lbl' }, r.label)))),
      h('div', { role: 'list', 'aria-label': 'Programs' }, out.length > 0 ? out : h('p', { class: 'none' }, `No programs match “${ui.filter}”.`)),
    ];
  }

  // ── running ───────────────────────────────────────────────────────────────
  function tag(runtimeId) {
    const r = runtimeOf(runtimeId);
    return h('span', { class: 'tag' }, icon(r.icon), r.label);
  }
  function runItem(r) {
    const sys = systemOf(r.system);
    const cmdId = `rc:${r.id}`;
    const moreId = `rm:${r.id}`;
    const hasMore = (r.details && r.details.length) || (r.size && r.size.length) || r.qrSvg || (r.facts && r.facts.length);
    const qr = r.qrSvg ? h('div', { class: 'qr', role: 'img', 'aria-label': 'QR code for the network address' }) : null;
    if (qr) qr.innerHTML = r.qrSvg; // host-generated SVG (src/qr.cjs), never user text
    return h('div', { class: 'run-item', role: 'listitem' },
      h('div', { class: 'top' }, h('span', { class: 'dot', title: 'Running' }), h('span', { class: 'ttl' }, r.title), h('span', { class: 'time', title: 'Time running' }, r.elapsed)),
      h('div', { class: 'meta' }, h('span', { class: 'tag' }, sys ? sys.short : r.system), tag(r.runtime), r.fps && h('span', null, r.fps)),
      r.detail && h('div', { class: 'meta detail' }, r.detail),
      r.error && h('div', { class: 'meta' }, h('span', { class: 'bad' }, r.error)),
      h('div', { class: 'acts' },
        r.runtime === 'editor' && h('button', { class: 'btn sm', 'data-action': 'focus', 'data-run': r.id, 'data-key': `show:${r.id}` }, icon('open-preview'), 'Show tab'),
        r.runtime === 'editor' && h('button', { class: 'btn sm', 'data-action': 'openInBrowser', 'data-run': r.id, 'data-key': `ob:${r.id}` }, icon('link-external'), 'Open in browser'),
        h('button', { class: 'btn sm', 'data-action': 'stop', 'data-run': r.id, 'data-key': `stop:${r.id}` }, icon('debug-stop'), 'Stop'),
        h('button', { class: 'btn ghost sm', 'data-action': 'toggle', 'data-open': cmdId, 'aria-expanded': String(Boolean(ui.open[cmdId])), 'aria-controls': `panel-${cmdId}`, 'data-key': `rcb:${r.id}` }, icon('terminal'), 'Command')),
      ui.open[cmdId] && h('div', { class: 'rc' }, codeBlock(r.command, `panel-${cmdId}`, `rcc:${r.id}`)),
      hasMore && h('div', { class: 'more' }, disclosure(moreId, 'Details', null, '', Boolean(ui.open[moreId]), [
        r.details && r.details.length > 0 && h('dl', { class: 'facts' }, r.details.map((d) => [h('dt', null, d.label), h('dd', { class: d.mono ? 'mono' : '' }, d.value)])),
        r.size && r.size.length > 0 && h('table', { class: 'sizes', 'aria-label': 'Size by section' }, r.size.map((s) => h('tr', null, h('td', null, s.name), h('td', null, s.text)))),
        qr,
      ])));
  }
  function historyRow(x) {
    const sys = systemOf(x.system);
    const r = runtimeOf(x.runtime);
    return h('div', { class: 'hist-row', role: 'listitem' }, h('span', { class: `dot ${x.ok ? 'off' : 'bad'}` }),
      h('div', { class: 'who' }, h('div', { class: 'ttl' }, x.title), h('div', { class: 'meta' }, `${sys ? sys.short : x.system} · ${r ? r.label : x.runtime}`),
        h('div', { class: 'meta' }, h('span', { class: x.ok ? '' : 'bad' }, x.result), ` · ${x.when}`)),
      h('button', { class: 'ibtn', 'data-action': 'rerun', 'data-history': x.id, 'data-key': `again:${x.id}`, title: 'Run again', 'aria-label': `Run ${x.title} again` }, icon('debug-restart')));
  }

  function tools() {
    const row = (ico, name, sub, action) => h('button', { class: 'row-btn', 'data-action': action, 'data-key': `tool:${action}` }, icon(ico), h('span', { class: 'who' }, h('div', null, name), h('div', { class: 'sub' }, sub)), icon('chevron-right'));
    // Studio opens in an editor tab on our own wasm build; the real emulator is a
    // separate, labelled button beside it, not a hidden fallback.
    const studio = h('div', { class: 'row-split' },
      row('rocket', 'Studio', 'Edit sprites, sound and tiles, in an editor tab', 'studio'),
      h('button', { class: 'ibtn', 'data-action': 'studioNative', 'data-key': 'tool:studioNative', title: 'Open Studio in the native emulator (x16emu)', 'aria-label': 'Open Studio in the native emulator' }, icon('device-desktop')));
    return [sectionLabel('Tools'), h('div', { class: 'rows' }, studio, row('pulse', 'Doctor', 'Check the toolchains and emulators', 'doctor'), row('info', 'Project details', 'Config, packages, systems', 'details'))];
  }

  // ── the whole page ────────────────────────────────────────────────────────
  function view() {
    navRow = 0;
    const out = [];
    state.notices.forEach((n) => out.push(notice(n)));
    if (state.phase === 'loading') { out.push(skeleton()); return out; }
    if (state.phase === 'empty' || !state.project) { out.push(emptyState()); return out; }

    const sys = systemOf(state.system);
    const several = state.programs.length > 1;
    const p = selected();
    if (several) {
      out.push(h('div', { class: 'strip' },
        picker('Project', 'lbl-project', state.project.name, null, 'menu-project', ui.menu === 'project'),
        picker('System', 'lbl-system', sys ? sys.short : state.system, sys && sys.region && sys.region !== '—' ? sys.region : sys && !sys.emulator ? 'browser' : null, 'menu-system', ui.menu === 'system')));
    } else {
      out.push(h('div', { class: 'project' }, h('img', { src: root.dataset.logo || '', alt: '' }),
        h('div', { class: 'who' }, h('div', { class: 'name' }, state.project.name), state.project.sub && state.project.sub !== state.project.name && h('div', { class: 'sub' }, state.project.sub)),
        h('button', { class: 'ibtn', 'data-action': 'details', 'data-key': 'project:details', title: 'Project details', 'aria-label': 'Project details' }, icon('info'))));
      out.push(h('div', { class: 'strip one' }, picker('System', 'lbl-system', sys ? sys.short : state.system, sys && sys.region && sys.region !== '—' ? sys.region : null, 'menu-system', ui.menu === 'system')));
    }
    if (ui.menu === 'project') out.push(projectMenu());
    if (ui.menu === 'system') out.push(systemMenu());
    if (state.summary) {
      out.push(h('div', { class: 'summary row' },
        h('span', null, h('b', null, state.summary.name), ` · ${state.summary.text}`),
        h('button', { class: 'ibtn', 'data-action': 'configureSystem', 'data-key': 'summary:options', title: 'Hardware, region and language for this run', 'aria-label': 'Hardware, region and language' }, icon('settings-gear'))));
    }
    if (state.programs.length === 0) out.push(h('p', { class: 'none' }, 'No programs found in this project. Add one to the config’s programs.'));
    else if (several) out.push(programList());
    else if (p) {
      if (p.title !== state.project.name) out.push(h('div', { class: 'ptitle' }, p.title));
      out.push(drawer(p, true));
    }
    out.push(sectionLabel('Running', state.running.length));
    out.push(state.running.length === 0
      ? h('p', { class: 'muted small' }, 'Nothing is running. Run a program above and it shows up here.')
      : h('div', { class: 'items', role: 'list' }, state.running.map(runItem)));
    if (state.history.length > 0) out.push(sectionLabel('Recent'), h('div', { class: 'hist', role: 'list' }, state.history.map(historyRow)));
    out.push(...tools());
    return out;
  }

  // ── rendering, focus and roving tabindex ──────────────────────────────────
  function navCells() {
    const rows = [];
    root.querySelectorAll('[data-nav-row]').forEach((el) => {
      const r = Number(el.getAttribute('data-nav-row'));
      (rows[r] = rows[r] || []).push(el);
    });
    return rows.filter(Boolean).map((cells) => cells.sort((a, b) => Number(a.getAttribute('data-nav-col')) - Number(b.getAttribute('data-nav-col'))));
  }
  function applyRoving() {
    const cells = [].concat(...navCells());
    if (cells.length === 0) return;
    const current = cells.find((el) => el.getAttribute('data-key') === ui.navKey)
      || cells.find((el) => el.getAttribute('data-key') === `row:${state.program}`) || cells[0];
    cells.forEach((el) => el.setAttribute('tabindex', el === current ? '0' : '-1'));
  }

  function render() {
    if (!state) return;
    const active = document.activeElement;
    const key = active && active.getAttribute ? active.getAttribute('data-key') : null;
    const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    while (root.firstChild) root.removeChild(root.firstChild);
    appendAll(root, view());
    applyRoving();
    if (key) {
      const again = Array.from(root.querySelectorAll('[data-key]')).find((el) => el.getAttribute('data-key') === key);
      if (again && again.focus) {
        again.focus({ preventScroll: true });
        if (caret && again.setSelectionRange) try { again.setSelectionRange(caret[0], caret[1]); } catch (e) { /* number inputs have no caret */ }
      }
    }
  }

  function focusKey(key) {
    const el = Array.from(root.querySelectorAll('[data-key]')).find((x) => x.getAttribute('data-key') === key);
    if (el && el.focus) el.focus();
    return el;
  }

  // ── actions ───────────────────────────────────────────────────────────────
  function changedInputs(p) {
    return Object.fromEntries(p.inputs.filter((i) => i.value !== i.def).map((i) => [i.name, i.value]));
  }
  function runMessage(p, runtime) {
    return { type: 'run', runtime, program: p.id, system: state.system, inputs: changedInputs(p) };
  }
  function setMenu(name, triggerKey) {
    ui.menu = ui.menu === name ? null : name;
    render();
    if (ui.menu) {
      const first = root.querySelector(`[data-menu="${ui.menu}"] [role^="menuitem"]:not([aria-disabled="true"])`);
      if (first) first.focus();
    } else if (triggerKey) focusKey(triggerKey);
  }
  function closeMenu(returnTo) {
    if (!ui.menu) return false;
    ui.menu = null;
    render();
    if (returnTo) focusKey(returnTo);
    return true;
  }

  function act(el) {
    const a = el.getAttribute('data-action');
    const prog = programOf(el.getAttribute('data-program') || state.program);
    switch (a) {
      case 'run': if (prog) { ui.menu = null; post(runMessage(prog, el.getAttribute('data-runtime'))); render(); } break;
      case 'build': if (prog) post({ type: 'build', program: prog.id, system: state.system }); break;
      case 'boot': ui.menu = null; post({ type: 'boot', system: state.system }); render(); break;
      case 'select-program':
        if (prog) { ui.navKey = `row:${prog.id}`; state.program = prog.id; ui.menu = null; post({ type: 'select', program: prog.id }); persist(); render(); focusKey(`row:${prog.id}`); }
        break;
      case 'select-system': ui.menu = null; post({ type: 'select', system: el.getAttribute('data-system') }); render(); focusKey('picker:System'); break;
      case 'select-project': ui.menu = null; post({ type: 'select', project: el.getAttribute('data-project') }); render(); focusKey('picker:Project'); break;
      case 'menu-project': setMenu('project', 'picker:Project'); break;
      case 'menu-system': setMenu('system', 'picker:System'); break;
      case 'menu': setMenu(el.getAttribute('data-menu-name'), `more:${state.program}`); break;
      case 'toggle': { const id = el.getAttribute('data-open'); ui.open[id] = !ui.open[id]; persist(); render(); break; }
      case 'toggle-group': {
        const name = el.getAttribute('data-group');
        const now = name in ui.collapsed ? ui.collapsed[name] : state.collapsedGroups.includes(name);
        ui.collapsed[name] = !now; persist(); render(); break;
      }
      case 'inputsReset': if (prog) { prog.inputs.forEach((i) => { i.value = i.def; }); post({ type: 'inputsReset', program: prog.id }); render(); } break;
      case 'openSource': post({ type: 'openSource', program: el.getAttribute('data-program') || state.program }); break;
      case 'reveal': ui.menu = null; post({ type: 'reveal', program: el.getAttribute('data-program') || state.program }); render(); break;
      case 'copy': ui.menu = null; post({ type: 'copy', text: el.getAttribute('data-text') || state.command }); render(); break;
      case 'stop': post({ type: 'stop', runId: el.getAttribute('data-run') }); break;
      case 'focus': post({ type: 'focus', runId: el.getAttribute('data-run') }); break;
      case 'openInBrowser': post({ type: 'openInBrowser', runId: el.getAttribute('data-run') }); break;
      case 'rerun': post({ type: 'rerun', historyId: el.getAttribute('data-history') }); break;
      case 'fix': post({ type: 'fix', kind: el.getAttribute('data-kind') }); break;
      case 'selectRuntime': if (prog) { prog.primary = el.getAttribute('data-runtime'); post({ type: 'selectRuntime', program: prog.id, runtime: prog.primary }); render(); } break;
      case 'notice': {
        const n = state.notices.find((x) => x.id === el.getAttribute('data-notice'));
        const action = n && n.actions[Number(el.getAttribute('data-index'))];
        if (action) post(action.msg);
        break;
      }
      default:
        // doctor, details, configureSystem, saveSystem, studio, studioNative, openFolder, tryExample, learn
        post({ type: a });
        if (ui.menu) { ui.menu = null; render(); }
    }
  }

  // A disabled control stays focusable so its reason can be reached; using it
  // only moves focus to the reason, in the drawer of its own program.
  function disabled(el) {
    const id = el.getAttribute('data-program');
    if (!id) return;
    if (id !== state.program) { state.program = id; ui.navKey = `row:${id}`; post({ type: 'select', program: id }); render(); }
    focusKey(`reason:${id}`);
  }

  root.addEventListener('click', (event) => {
    const el = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!el) return;
    if (el.getAttribute('aria-disabled') === 'true') { disabled(el); return; }
    act(el);
  });

  root.addEventListener('change', (event) => {
    const el = event.target;
    if (!el || !el.getAttribute || !el.getAttribute('data-input')) return;
    const prog = programOf(el.getAttribute('data-program'));
    const input = prog && prog.inputs.find((i) => i.name === el.getAttribute('data-input'));
    if (!input) return;
    let value;
    if (input.kind === 'bool') value = el.checked === true;
    else if (input.kind === 'number') { value = Number(el.value); if (!Number.isFinite(value) || el.value === '') value = input.def; } else value = el.value;
    input.value = value;
    post({ type: 'input', program: prog.id, name: input.name, value });
    render();
  });

  root.addEventListener('input', (event) => {
    const el = event.target;
    if (!el || !el.getAttribute || el.getAttribute('data-filter') !== 'true') return;
    ui.filter = el.value;
    persist();
    render();
  });

  function showHint(el) {
    const owner = el && el.closest ? el.closest('[data-hint]') : null;
    const hint = root.querySelector('#hint');
    if (owner && hint) hint.textContent = owner.getAttribute('data-hint');
  }

  root.addEventListener('focusin', (event) => {
    const el = event.target;
    showHint(el);
    if (!el || !el.getAttribute || !el.hasAttribute('data-nav-row')) return;
    ui.navKey = el.getAttribute('data-key');
    applyRoving();
  });

  root.addEventListener('pointerover', (event) => showHint(event.target));

  root.addEventListener('keydown', (event) => {
    const el = event.target;
    const key = event.key;
    if (!el || !el.getAttribute) return;

    // Menus: arrows move, Escape closes and returns to the trigger.
    const menu = el.closest ? el.closest('[data-menu]') : null;
    if (menu) {
      const items = Array.from(menu.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])'));
      const at = items.indexOf(el);
      if (key === 'ArrowDown') { event.preventDefault(); items[(at + 1) % items.length].focus(); return; }
      if (key === 'ArrowUp') { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); return; }
      if (key === 'Home') { event.preventDefault(); items[0].focus(); return; }
      if (key === 'End') { event.preventDefault(); items[items.length - 1].focus(); return; }
      if (key === 'Escape' || key === 'Tab') {
        event.preventDefault();
        closeMenu({ project: 'picker:Project', system: 'picker:System', more: `more:${state.program}` }[menu.getAttribute('data-menu')]);
        return;
      }
    }
    if (key === 'Escape' && ui.menu) { closeMenu(); return; }

    // The program list is one tab stop; arrows move inside it.
    if (el.hasAttribute('data-nav-row')) {
      const rows = navCells();
      const r = rows.findIndex((cells) => cells.includes(el));
      if (r < 0) return;
      const c = rows[r].indexOf(el);
      const go = (rr, cc) => { const row = rows[Math.max(0, Math.min(rows.length - 1, rr))]; const target = row[Math.min(cc, row.length - 1)]; if (target) { event.preventDefault(); target.focus(); } };
      if (key === 'ArrowDown') return go(r + 1, c);
      if (key === 'ArrowUp') return go(r - 1, c);
      if (key === 'ArrowRight') return go(r, c + 1);
      if (key === 'ArrowLeft') return go(r, c - 1);
      if (key === 'Home') return go(0, c);
      if (key === 'End') return go(rows.length - 1, c);
      // Enter on a program's name runs what the row's primary button runs.
      if (key === 'Enter' && el.getAttribute('data-action') === 'select-program') {
        const prog = programOf(el.getAttribute('data-program'));
        if (prog && prog.primary && prog.onSystem) { event.preventDefault(); post(runMessage(prog, prog.primary)); }
      }
    }
  });

  document.addEventListener('click', (event) => {
    if (!ui.menu) return;
    const t = event.target;
    if (t && t.closest && (t.closest('[data-menu]') || t.closest('[data-action^="menu"]'))) return;
    closeMenu();
  });

  // Only the editor, which embeds this page, may send it a state: a message must
  // come from this page's own origin or from the frame that contains it. Anything
  // else — another window, another origin — is not the extension and is ignored.
  window.addEventListener('message', (event) => {
    const own = window.location ? window.location.origin : undefined;
    if (event.origin !== own && event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== 'state') return;
    state = fill(data.state || {});
    if (ui.menu && !state.project) ui.menu = null;
    render();
  });

  post({ type: 'ready' });
}());
