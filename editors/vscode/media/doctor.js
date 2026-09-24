// Doctor page. Holds no state — the host posts the whole model.
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const STATUS = { ready: 'ready', missing: 'missing', broken: 'cannot boot' };

window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  const n = data.selected === null ? data.total : data.selected.length;
  $('count').textContent = data.selected === null
    ? `All ${data.total} emulators`
    : `${n} of ${data.total} emulators`;

  const root = $('list');
  root.textContent = '';
  let group = null;
  for (const emu of data.emulators) {
    if (emu.group !== group) {
      group = emu.group;
      const heading = document.createElement('h2');
      heading.className = 'section-label';
      heading.textContent = group;
      root.appendChild(heading);
    }
    const checked = data.selected === null || data.selected.includes(emu.id);
    const row = document.createElement('label');
    row.className = 'emu';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => {
      vscode.postMessage({ type: 'toggle', id: emu.id, checked: input.checked });
    });
    const text = document.createElement('span');
    text.className = 'emu-text';
    const title = document.createElement('span');
    title.className = 'emu-title';
    title.textContent = emu.label;
    const detail = document.createElement('span');
    detail.className = 'emu-detail';
    detail.textContent = emu.detail;
    text.append(title, detail);
    if (emu.status && STATUS[emu.status]) {
      const badge = document.createElement('span');
      badge.className = 'status ' + emu.status;
      badge.textContent = STATUS[emu.status];
      text.appendChild(badge);
    }
    if (!emu.installable) {
      const note = document.createElement('span');
      note.className = 'emu-note';
      note.textContent = 'no package-manager plan on this host — see the setup page';
      text.appendChild(note);
    }
    row.append(input, text);
    root.appendChild(row);
  }
});

$('install-selected').addEventListener('click', () => vscode.postMessage({ type: 'install' }));
$('run').addEventListener('click', () => vscode.postMessage({ type: 'run' }));
$('all').addEventListener('click', () => vscode.postMessage({ type: 'all' }));
$('project').addEventListener('click', () => vscode.postMessage({ type: 'project' }));
$('none').addEventListener('click', () => vscode.postMessage({ type: 'none' }));
