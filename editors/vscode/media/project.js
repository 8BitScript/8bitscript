// Project details page. Holds no state — the host posts the whole model.
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

function kv(label, value) {
  const row = document.createElement('div');
  row.className = 'kv-row';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = 'v';
  v.textContent = value;
  row.append(k, v);
  return row;
}

window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  $('title').textContent = data.empty ? 'Project' : data.name;
  $('lede').textContent = data.empty
    ? 'No 8BitScript project here yet. A project is a directory with an 8bitscript.config.ts.'
    : data.where;
  const notice = $('notice');
  notice.hidden = data.installed || data.empty;
  notice.textContent = data.installed || data.empty
    ? ''
    : data.name + ' has dependencies that are not installed.';

  const meta = $('meta');
  meta.textContent = '';
  if (!data.empty) {
    meta.append(
      kv('Path', data.dir),
      kv('Config', data.config),
      kv('Entry', data.entry),
      kv('Targets', data.targets.join(', ') || '—'),
    );
  }

  const systems = $('systems');
  systems.textContent = '';
  if (data.systems.length === 0) {
    const none = document.createElement('p');
    none.className = 'none';
    none.textContent = 'No named systems yet. Configure System to advertise one, or save it for this clone.';
    systems.appendChild(none);
  } else {
    for (const system of data.systems) {
      systems.appendChild(kv(
        system.name,
        system.target + (system.label && system.label !== 'stock' ? ' · ' + system.label : '') + ' · ' + system.origin,
      ));
    }
  }

  const packages = $('packages');
  packages.textContent = '';
  if (!data.empty) {
    packages.append(
      kv('Package manager', data.packageManager + (data.lockfile ? ' · ' + data.lockfile : '')),
      kv('Toolchain', data.toolchain),
    );
    for (const [name, spec] of Object.entries(data.versions)) {
      packages.appendChild(kv(name, spec));
    }
  }

  $('install').textContent = 'Run ' + data.packageManager + ' install';
  $('install').hidden = data.empty;
  $('refresh').hidden = data.empty;
  $('use-local').hidden = data.empty || Boolean(data.checkout);
  $('use-published').hidden = data.empty || !data.checkout;
  $('open-config').hidden = data.empty;
  $('open-entry').hidden = data.empty;
});

$('install').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.install' }));
$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.refresh' }));
$('use-local').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.useLocal' }));
$('use-published').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.usePublished' }));
$('open-config').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.openConfig' }));
$('open-entry').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.openEntry' }));
$('configure').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.configureSystem' }));

vscode.postMessage({ type: 'ready' });
