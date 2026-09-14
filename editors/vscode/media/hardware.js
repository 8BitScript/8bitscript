// Shared hardware / facts rendering for the System builder. The launcher
// no longer draws this matrix; one copy lives here so the fold and the
// tab cannot drift.
function fillSelect(select, options, selected) {
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
    el.textContent = option.label + (option.runnable === false ? '  (not a target)' : '');
    el.selected = option.id === selected;
    (group ?? select).appendChild(el);
  }
}

function renderFacts(root, facts) {
  root.textContent = '';
  if (!facts || facts.length === 0) {
    const none = document.createElement('p');
    none.className = 'none';
    none.textContent = 'No toolchain found to ask what a program can rely on.';
    root.appendChild(none);
    return;
  }
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
    row.append(name, value);
    table.appendChild(row);
  }
  root.appendChild(table);
}

function renderHardware(root, profileSelect, hardware, vscode) {
  root.textContent = '';
  if (!hardware) {
    fillSelect(profileSelect, [{ id: '', label: 'Stock machine' }], '');
    profileSelect.disabled = true;
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'No toolchain found to ask about hardware.';
    root.appendChild(none);
    return;
  }
  profileSelect.disabled = false;
  fillSelect(profileSelect, hardware.profiles, hardware.selection.profile ?? '');
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
    const select = document.createElement('select');
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
    row.append(label, select);
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
}
