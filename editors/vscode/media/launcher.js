// The launcher page. A real .js file rather than a template literal in the
// provider: a `\n` inside a template became a real newline in the generated
// script, which failed to parse, and every dropdown filled from here stayed
// empty. It keeps no state — the extension posts the whole panel on every
// change and this redraws it.
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

function fill(select, options, selected) {
  select.textContent = '';
  let group = null;
  for (const option of options) {
    if (option.group) {
      group = document.createElement('optgroup');
      group.label = option.group;
      select.appendChild(group);
      continue;
    }
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = (option.where && option.where !== option.label
      ? option.label + '  —  ' + option.where
      : option.label)
      + (option.runnable === false ? '  (not a target)' : '')
      + (option.muted ? '  (emulator not installed)' : '')
      + (option.short ? '  (too small)' : '');
    el.selected = option.id === selected;
    (group ?? select).appendChild(el);
  }
}

/** The sliver menu under Open Studio: a group label or an item per row, the System chooser's own list shape. */
function renderStudioMenu(options) {
  const menu = $('studio-menu');
  menu.textContent = '';
  for (const option of options) {
    if (option.group) {
      const group = document.createElement('div');
      group.className = 'menu-group';
      group.textContent = option.group;
      menu.appendChild(group);
      continue;
    }
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.setAttribute('role', 'menuitem');
    item.dataset.id = option.id;
    item.textContent = option.where && option.where !== option.label
      ? option.label + '  —  ' + option.where
      : option.label;
    if (option.short) item.textContent += '  (too small)';
    item.addEventListener('click', (e) => {
      e.studioMenu = true;
      closeStudioMenu();
      vscode.postMessage({ type: 'command', id: option.command || '8bitscript.openStudio', system: option.id });
    });
    menu.appendChild(item);
  }
}

function openStudioMenu() {
  $('studio-menu').hidden = false;
  $('studio-more').setAttribute('aria-expanded', 'true');
}

function closeStudioMenu() {
  $('studio-menu').hidden = true;
  $('studio-more').setAttribute('aria-expanded', 'false');
}

function renderPackages(rows) {
  const root = $('package-rows');
  root.textContent = '';
  for (const entry of rows) {
    const row = document.createElement('div');
    row.className = 'pkg-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.label;
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = [entry.detail, entry.packageManager].filter(Boolean).join(' · ')
      + (entry.installed || entry.action === 'install' ? '' : ' · not installed');
    const install = document.createElement('button');
    install.className = 'link';
    install.textContent = entry.action === 'install' ? 'Install' : 'Update';
    install.addEventListener('click', () => vscode.postMessage({
      type: 'command',
      id: '8bitscript.install',
      toolchain: entry.kind === 'toolchain',
      dir: entry.dir,
      name: entry.label,
      packageManager: entry.packageManager,
    }));
    row.append(name, detail, install);
    root.appendChild(row);
  }
  // Only what needs doing is listed; with everything installed the block
  // is not there at all (8BitScript: Install Dependencies on the palette
  // still updates on request).
  $('packages-block').hidden = rows.length === 0;
}

/** The Running machines section: one expandable tree per `8bs run`/`boot`. */
const openMachines = new Map();

function machineKey(entry) {
  return (entry.dir || '') + '\0' + (entry.target ?? '') + '\0' + entry.command;
}

function kv(label, value) {
  if (value === null || value === undefined || value === '') return null;
  const row = document.createElement('div');
  row.className = 'kv';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = 'v';
  v.textContent = String(value);
  row.append(k, v);
  return row;
}

function branch(title, children) {
  if (!children || children.length === 0) return null;
  const details = document.createElement('details');
  details.className = 'branch';
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = title;
  details.append(summary, ...children);
  return details;
}

function renderMachineTree(machine) {
  const tree = document.createElement('div');
  tree.className = 'tree';
  if (machine.lanUrl) {
    const lan = document.createElement('div');
    lan.className = 'lan';
    if (machine.qrSvg) {
      const qr = document.createElement('div');
      qr.className = 'lan-qr';
      qr.setAttribute('title', 'Scan to open on a phone on this Wi-Fi');
      qr.innerHTML = machine.qrSvg;
      lan.appendChild(qr);
    }
    const url = document.createElement('code');
    url.className = 'lan-url';
    url.textContent = machine.lanUrl;
    lan.appendChild(url);
    tree.appendChild(lan);
  }
  const rows = [
    kv('Elapsed', machine.elapsed),
    kv('Emulator', machine.emulator),
    kv('Image', machine.outFile),
    kv('Hardware', machine.fitted),
    kv('Memory', machine.memory?.line),
  ].filter(Boolean);
  tree.append(...rows);
  if (machine.url) tree.append(kv('Local', machine.url));
  if (machine.live) {
    if (machine.live.error) tree.append(kv('Live', machine.live.error));
    else if (machine.live.done) tree.append(kv('Live', 'finished'));
    else if (machine.live.fps !== null) {
      tree.append(kv('Live', 'FPS ' + machine.live.fps + (machine.live.frames != null ? ' · ' + machine.live.frames + ' frames' : '')));
    } else {
      tree.append(kv('Live', 'waiting for the page…'));
    }
  }
  if (machine.size.length > 0) {
    const table = document.createElement('table');
    table.className = 'size';
    for (const entry of machine.size) {
      const tr = document.createElement('tr');
      const n = document.createElement('td');
      n.className = 'n';
      n.textContent = String(entry.bytes);
      const pct = document.createElement('td');
      pct.className = 'pct';
      pct.textContent = entry.pct + '%';
      const name = document.createElement('td');
      name.textContent = entry.name;
      tr.append(n, pct, name);
      table.appendChild(tr);
    }
    const sizeBranch = branch('Size', [table]);
    if (sizeBranch) tree.appendChild(sizeBranch);
  }
  const optionRows = machine.options.map((o) => kv(o.key, o.value)).filter(Boolean);
  const optionsBranch = branch('Fitted options', optionRows);
  if (optionsBranch) tree.appendChild(optionsBranch);
  const factRows = machine.facts.map((f) => kv(f.key, f.value)).filter(Boolean);
  const factsBranch = branch('Facts', factRows);
  if (factsBranch) tree.appendChild(factsBranch);
  return tree;
}

function renderRunning(running) {
  const section = $('running');
  const rows = $('running-rows');
  rows.textContent = '';
  section.hidden = running.length === 0;
  for (const entry of running) {
    const stop = document.createElement('button');
    stop.className = 'icon';
    stop.title = 'Stop ' + entry.label;
    stop.innerHTML = ICON_STOP;
    stop.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'stop', dir: entry.dir, target: entry.target });
    });
    if (entry.machine) {
      const wrap = document.createElement('details');
      wrap.className = 'run-machine';
      const key = machineKey(entry);
      wrap.open = openMachines.get(key) ?? true;
      wrap.addEventListener('toggle', () => openMachines.set(key, wrap.open));
      const summary = document.createElement('summary');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.label;
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = entry.detail + (entry.machine.elapsed ? ' · ' + entry.machine.elapsed : '');
      summary.append(name, detail, stop);
      wrap.append(summary, renderMachineTree(entry.machine));
      rows.appendChild(wrap);
    } else {
      const row = document.createElement('div');
      row.className = 'run-row';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.label;
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = entry.detail;
      row.append(name, detail, stop);
      rows.appendChild(row);
    }
  }
}

window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  const empty = data.projects.length === 0;

  renderPackages(data.packages ?? []);
  fill($('project'), data.projects, data.project);
  $('project').disabled = empty;
  $('open').disabled = empty;
  $('details').disabled = empty;
  fill($('system'), data.systems, data.system);
  // Studio's own dropdown, and the button's line says what it will open.
  const studio = data.studio;
  $('studio').disabled = !studio;
  $('studio-more').disabled = !studio;
  $('studio-sub').textContent = studio ? 'on the Commander X16' : 'not installed';
  renderStudioMenu(studio ? studio.systems : []);
  closeStudioMenu();

  $('run-title').textContent = empty ? 'Run' : 'Run ' + data.projectLabel;
  $('run-sub').textContent = data.subtitle
    ?? [data.systemTitle, data.fitted, data.regionLabel].filter(Boolean).join(' · ');
  $('run').disabled = !data.runnable;
  $('build').disabled = data.buildable === undefined ? !data.runnable : !data.buildable;
  $('boot').disabled = !data.bootable;
  $('boot-label').textContent = data.bootable ? 'Boot ' + (data.systemTitle ?? 'Machine') : 'Boot Machine';
  $('boot').title = data.bootable
    ? 'Boot ' + data.systemTitle + ' with nothing loaded — just the hardware'
    : (data.systemTitle ?? 'this system') + ' has no bare emulator to boot without a program';

  const notice = $('notice');
  notice.hidden = !data.warning;
  notice.textContent = data.warning ?? '';

  const reload = $('dev-reload');
  const rebuildBtn = $('rebuild-extension');
  const reloadBtn = $('reload-window');
  const reloadMsg = $('dev-reload-msg');
  const phase = data.devReload?.phase ?? 'idle';
  const error = data.devReload?.error;
  reload.hidden = phase === 'idle';
  rebuildBtn.hidden = phase !== 'dirty' && phase !== 'error';
  reloadBtn.hidden = phase !== 'ready';
  reloadMsg.textContent = phase === 'dirty'
    ? 'The local 8BitScript extension has changed.'
    : phase === 'building'
      ? 'Rebuilding the local extension…'
      : phase === 'ready'
        ? 'The local 8BitScript extension was rebuilt successfully.'
        : (error || '');

  $('fitted').textContent = 'fitted as ' + (data.subtitle ?? data.fitted);
  renderRunning(data.running);

  const hint = $('hint');
  hint.replaceChildren(
    Object.assign(document.createElement('code'), { textContent: data.command }),
  );
});

$('project').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'project', value: e.target.value }));
$('system').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'system', value: e.target.value }));
$('studio').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.openStudio' }));
$('studio-more').addEventListener('click', (e) => {
  e.studioMenu = true;
  if ($('studio-menu').hidden) openStudioMenu(); else closeStudioMenu();
});
// A click anywhere else, or Escape, closes the menu; the sliver and the
// menu's own items mark their events so this leaves them alone.
window.addEventListener('click', (e) => { if (!e.studioMenu) closeStudioMenu(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeStudioMenu(); });
$('run').addEventListener('click', () => vscode.postMessage({ type: 'launch', action: 'run' }));
$('build').addEventListener('click', () => vscode.postMessage({ type: 'launch', action: 'build' }));
$('boot').addEventListener('click', () => vscode.postMessage({ type: 'launch', action: 'boot' }));
$('open').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.openEntry' }));
$('details').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.showProject' }));
$('fitted').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.configureSystem' }));
$('rebuild-extension').addEventListener('click', () => vscode.postMessage({ type: 'rebuildExtension' }));
$('reload-window').addEventListener('click', () => vscode.postMessage({ type: 'reloadWindow' }));

vscode.postMessage({ type: 'ready' });
