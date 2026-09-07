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
    el.textContent = option.label;
    el.selected = option.id === selected;
    (group ?? select).appendChild(el);
  }
}

function renderHardware(hardware) {
  const root = $('options');
  root.textContent = '';
  $('fitted').textContent = hardware ? hardware.summary : '';
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
      span.textContent = ' ' + tags.join(' \u00b7 ');
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

window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  fill($('project'), data.projects, data.project);
  $('project').disabled = data.projects.length === 0;
  fill($('system'), data.systems.map((s) => ({
    id: s.id,
    label: s.title === s.id ? s.id : s.id + ' \u2014 ' + s.title,
  })), data.system);
  $('region').value = data.region;
  const machine = data.systems.find((s) => s.id === data.system)?.machine ?? false;
  $('region').disabled = !machine;
  $('run').disabled = !data.runnable;
  $('build').disabled = !data.runnable;
  renderHardware(data.hardware);
  const hint = $('hint');
  hint.className = 'hint' + (data.warning ? ' warn' : '');
  if (data.warning) {
    hint.textContent = data.warning;
  } else {
    hint.replaceChildren(
      Object.assign(document.createElement('code'), { textContent: data.command }),
    );
  }
});

$('project').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'project', value: e.target.value }));
for (const key of ['system', 'region']) {
  $(key).addEventListener('change', (e) => vscode.postMessage({ type: 'set', key, value: e.target.value }));
}
$('profile').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'profile', value: e.target.value }));
$('run').addEventListener('click', () => vscode.postMessage({ type: 'launch', action: 'run' }));
$('build').addEventListener('click', () => vscode.postMessage({ type: 'launch', action: 'build' }));

vscode.postMessage({ type: 'ready' });
