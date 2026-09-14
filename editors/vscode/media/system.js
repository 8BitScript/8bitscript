// System builder page. Holds no state — the host posts the whole model.
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

function showTab(tab) {
  for (const button of document.querySelectorAll('#tabs [data-tab]')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  for (const id of ['machine', 'hardware', 'region', 'facts', 'save']) {
    $('pane-' + id).hidden = id !== tab;
  }
}

window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  showTab(data.tab);
  $('lede').textContent = data.project
    ? data.project + ' · ' + (data.draft.name || data.draft.target) + ' · ' + data.fitted
    : 'No project here yet.';
  fillSelect($('target'), data.machines, data.draft.target);
  $('region').value = data.draft.region;
  $('region').disabled = !data.machine;
  $('region-note').textContent = data.machine
    ? ''
    : (data.draft.target === 'pet'
      ? 'The PET has no region: its refresh is the model\'s.'
      : 'This machine has no NTSC/PAL choice.');
  renderHardware($('options'), $('profile'), data.hardware, vscode);
  renderFacts($('facts'), data.hardware?.facts ?? []);
  $('name').value = data.draft.name;
  fillSelect($('layer'), data.layers.map((layer) => ({
    id: layer.id,
    label: layer.label + (layer.where ? '  —  ' + layer.where : ''),
  })), data.draft.layer);
  const note = $('save-note');
  if (data.collision.reason === 'more-specific') {
    note.textContent = 'This name already exists on this clone, so a save lands there.';
  } else if (data.collision.reason === 'shadowed') {
    note.textContent = 'A personal system already uses this name and would still win over an advertised one.';
  } else {
    note.textContent = '';
  }
});

for (const button of document.querySelectorAll('#tabs [data-tab]')) {
  button.addEventListener('click', () => vscode.postMessage({ type: 'set', key: 'tab', value: button.dataset.tab }));
}
$('target').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'target', value: e.target.value }));
$('region').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'region', value: e.target.value }));
$('profile').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'profile', value: e.target.value }));
$('name').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'name', value: e.target.value }));
$('layer').addEventListener('change', (e) => vscode.postMessage({ type: 'set', key: 'layer', value: e.target.value }));
$('save').addEventListener('click', () => vscode.postMessage({ type: 'save' }));
$('open-config').addEventListener('click', () => vscode.postMessage({ type: 'command', id: '8bitscript.openConfig' }));

vscode.postMessage({ type: 'ready' });
