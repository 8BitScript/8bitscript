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
      // A machine this project does not build for is still in the list,
      // so choosing it explains itself rather than simply not being there.
      + (option.runnable === false ? '  (not a target)' : '')
      + (option.short ? '  (too small)' : '');
    el.selected = option.id === selected;
    (group ?? select).appendChild(el);
  }
}

function renderHardware(hardware) {
  const root = $('options');
  root.textContent = '';
  if (!hardware) {
    fill($('profile'), [{ id: '', label: 'Stock machine' }], '');
    $('profile').disabled = true;
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'No toolchain found to ask about hardware.';
    root.appendChild(none);
    return;
  }
  $('profile').disabled = false;
  fill($('profile'), hardware.profiles, hardware.selection.profile ?? '');
  for (const option of hardware.options) {
    const row = document.createElement('div');
    row.className = 'option' + (option.id in hardware.selection.options ? ' set' : '');
    const probes = [...new Set(option.values
      .filter((v) => v.detect && v.id !== option.default).map((v) => v.detect))];
    const label = document.createElement('label');
    label.textContent = option.label;
    const tags = [];
    if (option.values.some((v) => v.affectsBuild)) tags.push('build');
    if (probes.length > 0) tags.push('probe');
    if (tags.length > 0) {
      const span = document.createElement('span');
      span.className = 'tags';
      span.textContent = ' ' + tags.join(' · ');
      label.appendChild(span);
    }
    label.title = option.label + ' (--hardware ' + option.id + '=...)'
      + (probes.length > 0
        ? '\nFound on the machine at run time by ' + probes.join(', ')
          + ': one build serves those values, and fitting one here compiles the probe in.'
        : '\nChosen at build time: each value is its own build.');
    const select = document.createElement('select');
    select.title = label.title;
    for (const value of option.values) {
      const el = document.createElement('option');
      el.value = value.id;
      const marks = [];
      if (value.affectsBuild) marks.push('build');
      if (value.detect && value.id !== option.default) marks.push('probe');
      el.textContent = value.label + (marks.length > 0 ? '  [' + marks.join(', ') + ']' : '');
      el.selected = value.id === hardware.effective[option.id];
      select.appendChild(el);
    }
    select.addEventListener('change', (e) => vscode.postMessage({
      type: 'set', key: 'option', option: option.id, value: e.target.value,
    }));
    row.appendChild(label);
    row.appendChild(select);
    root.appendChild(row);
  }
  if (hardware.options.length === 0) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'Nothing to fit on this system.';
    root.appendChild(none);
  }
  const reset = document.createElement('button');
  reset.className = 'link';
  reset.textContent = 'Back to stock';
  reset.addEventListener('click', () => vscode.postMessage({ type: 'set', key: 'stock' }));
  root.appendChild(reset);
  renderFacts(root, hardware.facts);
}

function renderFacts(root, facts) {
  if (!facts || facts.length === 0) return;
  const details = document.createElement('details');
  details.className = 'facts';
  const summary = document.createElement('summary');
  summary.textContent = 'What a program can rely on';
  details.appendChild(summary);
  const table = document.createElement('table');
  table.className = 'facts';
  let group = null;
  for (const fact of facts) {
    const [head, ...rest] = fact.key.split('.');
    if (head !== group) {
      group = head;
      const row = document.createElement('tr');
      row.className = 'group';
      const cell = document.createElement('td');
      cell.colSpan = 2;
      cell.textContent = head[0].toUpperCase() + head.slice(1);
      row.appendChild(cell);
      table.appendChild(row);
    }
    const row = document.createElement('tr');
    row.title = fact.doc + (fact.when === 'run'
      ? ' (run time: the build may use it; the machine says whether it is there)'
      : '');
    const name = document.createElement('td');
    name.textContent = rest.join('.').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
    const value = document.createElement('td');
    value.className = 'value' + (fact.when === 'run' ? ' run' : '');
    value.textContent = fact.type === 'flag'
      ? (fact.value ? (fact.when === 'run' ? 'may use' : 'yes') : 'no')
      : String(fact.value);
    row.appendChild(name);
    row.appendChild(value);
    table.appendChild(row);
  }
  details.appendChild(table);
  root.appendChild(details);
}

/** The Running section: one row per `8bs` task, each with its own Stop. */
function renderRunning(running) {
  const section = $('running');
  const rows = $('running-rows');
  rows.textContent = '';
  section.hidden = running.length === 0;
  for (const entry of running) {
    const row = document.createElement('div');
    row.className = 'run-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.label;
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = entry.detail;
    const stop = document.createElement('button');
    stop.className = 'icon';
    stop.title = 'Stop ' + entry.label;
    stop.innerHTML = ICON_STOP;
    stop.addEventListener('click', () => vscode.postMessage({
      type: 'stop', dir: entry.dir, target: entry.target,
    }));
    row.append(name, detail, stop);
    rows.appendChild(row);
  }
}

window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  const empty = data.projects.length === 0;

  fill($('project'), data.projects, data.project);
  $('project').disabled = empty;
  $('open').disabled = empty;
  // The System dropdown holds two kinds of entry when the project's config
  // declares systems: those first, then the bare machines.
  fill($('system'), data.systems, data.system);
  $('region').value = data.region;
  $('region').disabled = !data.machine;

  // The button says what it will do, so nothing has to be read off the
  // dropdowns to know what Run means. On one of the project's own systems
  // the name is the whole answer, and the machine it stands for goes on
  // the line below.
  $('run-title').textContent = empty ? 'Run' : 'Run ' + data.projectLabel;
  $('run-sub').textContent = data.subtitle
    ?? [data.systemTitle, data.fitted, data.regionLabel].filter(Boolean).join(' · ');
  $('run').disabled = !data.runnable;
  $('build').disabled = !data.runnable;

  const notice = $('notice');
  notice.hidden = !data.warning;
  notice.textContent = data.warning ?? '';

  const install = $('install');
  install.hidden = data.installed || empty;
  install.textContent = 'Run ' + data.packageManager + ' install';

  $('fitted').textContent = data.fitted;
  renderHardware(data.hardware);
  renderRunning(data.running);

  const hint = $('hint');
  hint.replaceChildren(
    Object.assign(document.createElement('code'), { textContent: data.command }),
  );
});

$('project').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'project', value: e.target.value }));
for (const key of ['system', 'region']) {
  $(key).addEventListener('change', (e) => vscode.postMessage({ type: 'set', key, value: e.target.value }));
}
$('profile').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'profile', value: e.target.value }));
$('run').addEventListener('click', () => vscode.postMessage({ type: 'launch', action: 'run' }));
$('build').addEventListener('click', () => vscode.postMessage({ type: 'launch', action: 'build' }));
$('open').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.openEntry' }));
$('install').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.install' }));

vscode.postMessage({ type: 'ready' });
