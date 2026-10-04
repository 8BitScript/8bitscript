// Building blocks shared by both directions, so the two differ in layout and
// not in vocabulary, icons or behaviour.
import { ic, RUNTIMES } from './icons.mjs';
import { SYSTEMS, system } from './data.mjs';

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Why a program cannot use the WASM runtimes on a machine. Fixture data: in the
// real extension this comes from the CLI's capability report.
export const WASM_BLOCK = {
  'tile-test@vic20': "The VIC-20's WASM build can't redefine characters yet, and Tile Test draws with them.",
};

/** What each runtime can do for this program on this system. */
export function availability(prog, sysId, { missingEmulators = [] } = {}) {
  const sys = system(sysId);
  const av = { editor: { ok: true }, browser: { ok: true }, native: { ok: true } };
  const block = WASM_BLOCK[`${prog.id}@${sysId}`];
  if (block) {
    av.editor = { ok: false, reason: block, use: 'native' };
    av.browser = { ok: false, reason: block, use: 'native' };
  }
  if (!sys.emulator) {
    av.native = { ok: false, reason: 'The Web system runs in a browser, so it has no native emulator.', use: 'editor' };
  } else if (missingEmulators.includes(sys.emulator)) {
    av.native = { ok: false, fixable: true, emulator: sys.emulator,
      reason: `${sys.emulator} isn't installed, so Native can't run.`, use: 'editor' };
  }
  return av;
}

/** The exact command a click would run (inputs are the proposed --define flag). */
export function command(prog, sysId, runtime, { defines = [] } = {}) {
  const parts = ['8bs', 'run', sysId];
  if (prog.id !== 'main') parts.push('--program', prog.id);
  if (runtime === 'editor') parts.push('--web', '--no-open', '--port 0');
  if (runtime === 'browser') parts.push('--web');
  for (const d of defines) parts.push('--define', d);
  return parts.join(' ');
}

export const changedInputs = (prog) => prog.inputs.filter((i) => i.value !== i.def);
export const defineFlags = (prog) => changedInputs(prog).map((i) => `${i.name}=${i.value}`);

// ── pieces ──────────────────────────────────────────────────────────────────
export function sectionLabel(text, { count, right } = {}) {
  return `<div class="sec"><span>${esc(text)}</span>${count != null ? `<span class="count">${count}</span>` : ''}<span class="grow"></span>${right ?? ''}</div>`;
}

export function projectHeader(project) {
  return `<div class="project">
    <img src="../../../media/8bitscript-icon.svg" alt="">
    <div class="who"><div class="name">${esc(project.name)}</div><div class="sub">${esc(project.dir)} · ${esc(project.cli)}</div></div>
    <button class="ibtn" title="Project details" aria-label="Project details">${ic('info')}</button>
  </div>`;
}

export function chips(prog, selected, { id = 'sys-chips' } = {}) {
  const items = SYSTEMS.map((s) => {
    const ok = prog.targets.includes(s.id);
    const on = s.id === selected;
    const title = ok ? `${s.name} · ${s.spec}` : `${prog.title} doesn't target ${s.name}`;
    return `<button class="chip" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" ${ok ? '' : 'disabled'} title="${esc(title)}" data-system="${s.id}">${esc(s.short)}</button>`;
  });
  return `<div class="chips" role="radiogroup" aria-label="System" id="${id}">${items.join('')}</div>`;
}

/** "SYSTEM" label on the left, the Options toggle on the right. */
export function systemHead({ open = false, controls = 'sysopts' } = {}) {
  return `<div class="field-head"><span class="field-label" id="sl">System</span>
    <button class="btn ghost sm" data-toggle="${controls}" aria-expanded="${open}" aria-controls="${controls}" title="Hardware, region and language for this run">${ic('settings-gear')}Options</button></div>`;
}

export function systemSummary(sysId, { region = 'NTSC', lang = 'English' } = {}) {
  const s = system(sysId);
  const bits = [s.spec, s.id === 'web' ? null : region, lang].filter(Boolean).map(esc).join(' · ');
  return `<div class="summary"><b>${esc(s.name)}</b> · ${bits}</div>`;
}

export function systemOptions(sysId, { id = 'sysopts', open = true, region = 'NTSC' } = {}) {
  const hw = sysId === 'c64' ? ['Stock 64 KB', 'With REU 512 KB'] : sysId === 'vic20' ? ['8 KB expansion', '16 KB expansion', '3 KB expansion'] : ['Stock'];
  return `<div class="panel form" id="${id}" ${open ? '' : 'hidden'}>
    <div><label class="f-label" for="${id}-hw"><span>Hardware</span><span class="var">--hardware</span></label><div class="select-wrap"><select class="select" id="${id}-hw">${hw.map((h) => `<option>${esc(h)}</option>`).join('')}</select>${ic('chevron-down')}</div></div>
    <div><span class="f-label"><span>Region</span><span class="var">--pal</span></span><div class="seg" role="radiogroup" aria-label="Region"><button role="radio" aria-checked="${region === 'NTSC'}">NTSC</button><button role="radio" aria-checked="${region === 'PAL'}">PAL</button></div></div>
    <div><label class="f-label" for="${id}-lang"><span>Language</span><span class="var">--locale</span></label><div class="select-wrap"><select class="select" id="${id}-lang"><option>English</option><option>Deutsch</option><option>Français</option></select>${ic('chevron-down')}</div></div>
    <div><button class="btn sm">${ic('add')}Save as a named system…</button></div>
  </div>`;
}

function inputControl(i, idx) {
  const id = `in-${i.name.toLowerCase()}`;
  const changed = i.value !== i.def;
  const head = `<div class="f-label"><label for="${id}">${esc(i.label)}</label><span class="var">${i.name}</span></div>`;
  if (i.kind === 'bool') {
    return `<div class="${changed ? 'changed' : ''}"><label class="check"><input type="checkbox" id="${id}" ${i.value ? 'checked' : ''}><span class="box">${i.value ? ic('check') : ''}</span><span>${esc(i.label)}</span></label><div class="f-help f-split"><span>${esc(i.help)}</span><span class="var mono">${i.name}</span></div></div>`;
  }
  if (i.kind === 'select') {
    return `<div class="${changed ? 'changed' : ''}">${head}<div class="select-wrap"><select class="select" id="${id}">${i.options.map((o) => `<option ${o === i.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>${ic('chevron-down')}</div><div class="f-help">${esc(i.help)}</div></div>`;
  }
  return `<div class="${changed ? 'changed' : ''}">${head}<input class="input" id="${id}" type="number" value="${esc(i.value)}"><div class="f-help">${esc(i.help)}</div></div>`;
}

export function inputsBlock(prog, { open = false, id = 'inputs' } = {}) {
  if (!prog.inputs.length) return '';
  const n = changedInputs(prog).length;
  const note = n ? `${n} changed` : 'defaults';
  return `<div><button class="disclosure" data-toggle="${id}" aria-expanded="${open}" aria-controls="${id}">${ic('chevron-right')}<span>Inputs</span><span class="badge">${prog.inputs.length}</span><span class="grow"></span><span class="note">${note}</span></button>
    <div class="panel form" id="${id}" ${open ? '' : 'hidden'}>${prog.inputs.map(inputControl).join('')}
      ${n ? `<div><button class="btn ghost sm">${ic('debug-restart')}Reset to defaults</button></div>` : ''}</div></div>`;
}

/** A command as HTML that wraps between flags, never inside one. */
export function cmdHtml(cmd) {
  const nb = (t) => `<span class="nb">${t}</span>`;
  const [head, ...defs] = cmd.split(' --define ');
  const parts = head.split(' --').map((t, i) => nb(i ? `--${esc(t)}` : esc(t)));
  return parts.join(' ') + defs.map((d) => ` ${nb(`<span class="dim">--define</span> ${esc(d)}`)}`).join('');
}

/** The exact command a click runs, hidden until the Command button asks for it. */
export function commandPanel(cmd, { open = false, id = 'cmd' } = {}) {
  return `<div class="panel" id="${id}" ${open ? '' : 'hidden'}><div class="code"><span class="cmd">${cmdHtml(cmd)}</span><button class="ibtn" title="Copy command" aria-label="Copy command">${ic('copy')}</button></div></div>`;
}

export function reasonBlock(av, { id = 'reason', primary } = {}) {
  const bad = RUNTIMES.filter((r) => !av[r.id].ok);
  if (!bad.length) return '';
  const first = av[bad[0].id];
  const names = bad.map((r) => r.label).join(' and ');
  const use = RUNTIMES.find((r) => r.id === first.use);
  let fix = '';
  if (first.fixable) {
    fix = `<div class="acts"><button class="btn sm primary">${ic('package')}Install ${esc(first.emulator)}</button><button class="btn sm">${ic('pulse')}Run Doctor</button></div>`;
  } else if (use && use.id !== primary) {
    fix = `<div class="acts"><button class="btn sm">${ic(use.icon)}Use ${esc(use.label)} instead</button></div>`;
  }
  return `<div class="reason${first.fixable ? ' warn' : ''}" id="${id}" role="note">${ic(first.fixable ? 'warning' : 'info')}<div class="why"><b>${esc(names)} ${bad.length > 1 ? 'are' : 'is'} unavailable.</b> ${esc(first.reason)}${fix}</div></div>`;
}

export function runButtons(av, primary, { prog, sysId }) {
  const sys = system(sysId);
  const buttons = RUNTIMES.map((r) => {
    const a = av[r.id];
    const isPrimary = a.ok && r.id === primary;
    const what = r.id === 'native' && sys.emulator ? `Runs the real ${sys.emulator} emulator with ${prog.title} loaded.` : r.what;
    const label = `Run ${prog.title} on ${sys.name} in ${r.long.toLowerCase()}${isPrimary ? ' (default)' : ''}`;
    const tip = a.ok ? label : `${r.long} unavailable: ${a.reason}`;
    return `<button class="btn run${isPrimary ? ' primary' : ''}" data-runtime="${r.id}" data-hint="${esc(what)}" ${a.ok ? '' : 'disabled aria-disabled="true" aria-describedby="reason"'} title="${esc(tip)}" aria-label="${esc(label)}">${ic(r.icon)}<span>${r.label}</span></button>`;
  });
  const lead = RUNTIMES.find((r) => r.id === primary && av[r.id].ok) ?? RUNTIMES.find((r) => av[r.id].ok);
  const hint = lead ? (lead.id === 'native' && sys.emulator ? `Runs the real ${sys.emulator} emulator with ${prog.title} loaded.` : lead.what) : 'Nothing can run this combination.';
  return `<div class="runs" role="group" aria-label="Run in">${buttons.join('')}</div><p class="hint" id="hint" aria-live="polite">${esc(hint)}</p>`;
}

/** Build, the command, and the overflow menu: everything that is not "run it". */
export function secondaryRow({ prog, cmdOpen = false, cmdId = 'cmd' }) {
  return `<div class="tools-row">
    <button class="btn ghost sm" title="Compile ${esc(prog.id)} to dist/${esc(prog.id)}.prg and show the size report. Nothing runs.">${ic('tools')}Build</button>
    <button class="btn ghost sm" data-toggle="${cmdId}" aria-expanded="${cmdOpen}" aria-controls="${cmdId}" title="Show the exact command a click runs">${ic('terminal')}Command</button>
    <span class="grow"></span>
    <button class="ibtn" title="More: open a bare emulator, copy the command, reveal in Explorer" aria-label="More actions" aria-haspopup="menu">${ic('ellipsis')}</button></div>`;
}

export function noticeBlock(kind, icon, body, actions = []) {
  return `<div class="notice ${kind}" role="status">${ic(icon)}<div class="body">${body}${actions.length ? `<div class="acts">${actions.join('')}</div>` : ''}</div></div>`;
}

const tag = (r) => `<span class="tag">${ic(RUNTIMES.find((x) => x.id === r).icon)}${RUNTIMES.find((x) => x.id === r).label}</span>`;
const sysTag = (id) => `<span class="tag">${esc(system(id).short)}</span>`;

export function runningBlock(runs) {
  if (!runs.length) return `<p class="muted" style="margin:0;font-size:12px">Nothing is running. Run a program above and it shows up here.</p>`;
  return `<div class="items" role="list">${runs.map((r, i) => `
    <div class="run-item" role="listitem">
      <div class="top"><span class="dot" title="Running"></span><span class="ttl">${esc(r.title)}</span><span class="time" title="Time running">${r.elapsed}</span></div>
      <div class="meta">${sysTag(r.system)}${tag(r.runtime)}<span>${r.fps}</span></div>
      <div class="meta detail">${esc(r.detail)}</div>
      <div class="acts">
        ${r.runtime === 'editor' ? `<button class="btn sm">${ic('open-preview')}Show tab</button><button class="btn sm">${ic('link-external')}Open in browser</button>` : ''}
        ${r.runtime === 'browser' ? `<button class="btn sm">${ic('link-external')}Show browser</button>` : ''}
        <button class="btn sm">${ic('debug-stop')}Stop</button>
        <button class="btn ghost sm" data-toggle="rc-${r.id}" aria-expanded="${i === 0}" aria-controls="rc-${r.id}">${ic('terminal')}Command</button>
      </div>
      <div class="panel rc" id="rc-${r.id}" ${i === 0 ? '' : 'hidden'}><div class="code"><span class="cmd">${cmdHtml(r.cmd)}</span><button class="ibtn" title="Copy command" aria-label="Copy command">${ic('copy')}</button></div></div>
    </div>`).join('')}</div>`;
}

export function historyBlock(hist) {
  return `<div class="hist" role="list">${hist.map((h) => `
    <div class="hist-row" role="listitem"><span class="dot ${h.ok ? 'off' : 'bad'}"></span>
      <div class="who"><div class="ttl">${esc(h.title)}</div><div class="meta">${esc(system(h.system).short)} · ${RUNTIMES.find((x) => x.id === h.runtime).label}</div><div class="meta"><span class="${h.ok ? '' : 'bad'}">${esc(h.result)}</span> · ${h.when}</div></div>
      <button class="ibtn" title="Run again" aria-label="Run ${esc(h.title)} again">${ic('debug-restart')}</button></div>`).join('')}</div>`;
}

export function toolsBlock() {
  const row = (icon, name, sub) => `<button class="row-btn">${ic(icon)}<span class="who"><div>${name}</div><div class="sub">${sub}</div></span>${ic('chevron-right')}</button>`;
  return `<div class="rows">${row('rocket', 'Studio', 'Edit sprites, sound and tiles')}${row('pulse', 'Doctor', 'Check the toolchains and emulators')}${row('info', 'Project details', 'Config, packages, systems')}</div>`;
}

export function emptyState() {
  return `<div class="empty"><img src="../../../media/8bitscript-icon.svg" alt="">
    <h2>No 8BitScript project here</h2>
    <p>Open a folder that has an <span class="mono">8bitscript.config.8bs</span>, or start from an example.</p>
    <button class="btn primary">${ic('folder-opened')}Open Folder…</button>
    <button class="btn">${ic('rocket')}Try an example…</button>
    <button class="link" style="font-size:12px">What is 8BitScript?</button></div>`;
}
