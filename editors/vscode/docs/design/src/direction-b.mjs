// Direction B — "the program list".
//
// Programs are rows, like tests in a test explorer; each row carries its own
// three run buttons (Editor, Browser, Native), so any program is one click from
// running in any place. The system is chosen once, in a strip above the list,
// and applies to every row. The selected row opens a drawer for the things you
// set rarely: inputs, the entry file, the command.
import { ic, RUNTIMES } from './icons.mjs';
import { VEGAS, TWENTY_FORTY_EIGHT, RUNNING, HISTORY, SYSTEMS, program, system } from './data.mjs';
import {
  esc, availability, command, defineFlags, sectionLabel, projectHeader, inputsBlock, commandPanel, reasonBlock,
  runButtons, secondaryRow, noticeBlock, runningBlock, historyBlock, toolsBlock, emptyState,
} from './ui.mjs';

function strip(sysId, { menu = false, project = VEGAS } = {}) {
  const s = system(sysId);
  return `<div class="strip">
    <div class="sel"><span class="field-label" id="pl">Project</span><button class="picker" aria-labelledby="pl"><span class="t">${esc(project.name)}</span>${ic('chevron-down')}</button></div>
    <div class="sel"><span class="field-label" id="sl">System</span><button class="picker" aria-labelledby="sl" aria-haspopup="menu" aria-expanded="${menu}" data-toggle="sysmenu"><span class="t">${esc(s.short)}<span class="sm">${s.id === 'web' ? 'browser' : s.region}</span></span>${ic(menu ? 'chevron-up' : 'chevron-down')}</button></div>
  </div>`;
}

function systemMenu(sysId, prog) {
  const items = SYSTEMS.map((s) => {
    const ok = prog.targets.includes(s.id);
    return `<button class="it${s.id === 'vic20' ? ' is-hover' : ''}" role="menuitemradio" aria-checked="${s.id === sysId}" ${ok ? '' : 'disabled'}><span class="tick">${s.id === sysId ? ic('check') : ''}</span><span class="who">${esc(s.name)}</span><span class="spec">${esc(s.spec)}</span></button>`;
  }).join('');
  return `<div class="menu" id="sysmenu" role="menu" aria-label="System"><div class="grp">Machines</div>${items}<hr>
    <button class="it" role="menuitem"><span class="tick"></span>${ic('settings-gear')}<span class="who">Hardware, region &amp; language…</span></button>
    <button class="it" role="menuitem"><span class="tick"></span>${ic('add')}<span class="who">Save as a named system…</span></button></div>`;
}

const legend = () => `<div class="legend" aria-hidden="true"><span class="lead">Programs</span>${RUNTIMES.map((r) => `<span>${ic(r.icon)}<span class="lbl">${r.label}</span></span>`).join('')}</div>`;

function row(prog, sysId, { sel = false, primary = 'editor', live = [], missing = [], hover = false } = {}) {
  const targets = prog.targets.includes(sysId);
  const av = availability(prog, sysId, { missingEmulators: missing });
  const sys = system(sysId);
  const btns = RUNTIMES.map((r) => {
    const a = av[r.id];
    const ok = targets && a.ok;
    const isLive = live.includes(r.id);
    const isPrimary = ok && sel && r.id === primary;
    const tip = !targets ? `${prog.title} doesn't target ${sys.name}` : ok ? (isLive ? `${r.long}: running. Click to focus it.` : `Run ${prog.title} on ${sys.name} in ${r.long.toLowerCase()}`) : `${r.long} unavailable: ${a.reason}`;
    return `<button class="ibtn${isPrimary ? ' primary' : ''}${isLive ? ' live' : ''}" ${ok ? '' : 'disabled aria-disabled="true"'} title="${esc(tip)}" aria-label="${esc(tip)}">${ic(r.icon)}</button>`;
  }).join('');
  const dim = targets ? '' : ' style="color:var(--muted)"';
  return `<div class="prow${sel ? ' sel' : ''}${hover ? ' is-hover' : ''}" role="listitem"${sel ? ' aria-current="true"' : ''}>
    <span class="st${live.length ? ' live' : ''}" title="${live.length ? 'Running' : ''}"></span>
    <span class="name"${dim} title="${esc(prog.title)}">${esc(prog.title)}</span><span class="acts" role="group" aria-label="Run ${esc(prog.title)} in">${btns}</span></div>`;
}

function drawer(prog, sysId, { primary, inputsOpen = false, cmdOpen = false, missing = [], labelled = false }) {
  const av = availability(prog, sysId, { missingEmulators: missing });
  const cmd = command(prog, sysId, primary, { defines: defineFlags(prog) });
  const needsReason = RUNTIMES.some((r) => !av[r.id].ok);
  return `<div class="drawer">
    ${prog.desc ? `<p class="desc">${esc(prog.desc)}</p>` : ''}
    <button class="source" title="Open the entry file of ${esc(prog.title)}" aria-label="Open source file ${esc(prog.entry)}">${ic('go-to-file')}<span>${esc(prog.entry)}</span></button>
    ${labelled ? `<div class="subh">${runButtons(av, primary, { prog, sysId })}</div>` : ''}
    ${needsReason ? reasonBlock(av, { primary }) : ''}
    ${prog.inputs.length ? `<div class="subh">${inputsBlock(prog, { open: inputsOpen })}</div>` : ''}
    ${secondaryRow({ prog, cmdOpen })}${commandPanel(cmd, { open: cmdOpen })}
  </div>`;
}

function list({ sysId, selId, primary = 'native', live = {}, missing = [], inputsOpen = false, cmdOpen = false, hoverId = null, collapseRigs = true, filter = true }) {
  const groups = ['Slots', 'Labs', 'Test rigs'];
  const html = groups.map((g) => {
    const ps = VEGAS.programs.filter((p) => p.group === g);
    const collapsed = g === 'Test rigs' && collapseRigs;
    const rows = collapsed ? '' : ps.map((p) => `${row(p, sysId, { sel: p.id === selId, primary, live: live[p.id] ?? [], missing, hover: p.id === hoverId })}${p.id === selId ? drawer(p, sysId, { primary, inputsOpen, cmdOpen, missing }) : ''}`).join('');
    return `<div role="group" aria-label="${esc(g)}"><button class="group-head" aria-expanded="${!collapsed}">${ic(collapsed ? 'chevron-right' : 'chevron-down')}<span>${esc(g)}</span><span class="grow"></span><span class="n">${ps.length}</span></button>${rows}</div>`;
  }).join('');
  return `${filter ? `<div class="filter"><i class="codicon" aria-hidden="true">&#60013;</i><input class="input" placeholder="Filter programs" aria-label="Filter programs"></div>` : ''}${legend()}<div role="list" aria-label="Programs">${html}</div>`;
}

const tools = () => `${sectionLabel('Tools')}${toolsBlock()}`;
const running = (runs = RUNNING, hist = HISTORY) => `${sectionLabel('Running', { count: runs.length })}${runningBlock(runs)}${hist.length ? `${sectionLabel('Recent')}${historyBlock(hist)}` : ''}`;

export const B = {
  '01-program-3x3': () => `${strip('c64')}${list({ sysId: 'c64', selId: 'slot3x3', primary: 'native' })}${tools()}`,

  '02-program-5x5-inputs': () => `${strip('c64')}${list({ sysId: 'c64', selId: 'slot5x5', primary: 'native', inputsOpen: true, cmdOpen: true })}${tools()}`,

  '03-runtime-disabled': () => `${strip('vic20')}${list({ sysId: 'vic20', selId: 'tile-test', primary: 'native' })}${tools()}`,

  '03b-runtime-disabled-web': () => `${strip('web')}${list({ sysId: 'web', selId: 'slot3x3', primary: 'editor' })}${tools()}`,

  '04-running': () => `${strip('c64')}${list({ sysId: 'c64', selId: 'slot5x5', primary: 'native', live: { slot5x5: ['editor', 'native'] } })}${running()}${tools()}`,

  '05-single-program': () => {
    const p = TWENTY_FORTY_EIGHT.programs[0];
    return `${projectHeader(TWENTY_FORTY_EIGHT)}<div class="strip" style="grid-template-columns:1fr"><div class="sel"><span class="field-label">System</span><button class="picker" aria-haspopup="menu"><span class="t">VIC-20<span class="sm">NTSC</span></span>${ic('chevron-down')}</button></div></div>
      ${p.title === TWENTY_FORTY_EIGHT.name ? '' : `<div class="ptitle" style="margin-top:16px">${esc(p.title)}</div>`}<div class="drawer" style="margin:16px 0 0">${drawer(p, 'vic20', { primary: 'editor', labelled: true }).replace(/^<div class="drawer">|<\/div>$/g, '')}</div>${tools()}`;
  },

  '06-empty': () => emptyState(),

  '07-notice-missing-emulator': () => `${noticeBlock('warn', 'package', '<b>Packages need installing.</b> This project is missing <span class="mono">node_modules</span>.', [`<button class="btn sm primary">${ic('package')}Install packages</button>`])}
    ${strip('c64')}${list({ sysId: 'c64', selId: 'slot3x3', primary: 'editor', missing: ['x64sc'] })}${tools()}`,

  '08-system-options': () => `${strip('c64', { menu: true })}${systemMenu('c64', program('slot3x3'))}${list({ sysId: 'c64', selId: 'slot3x3', primary: 'native', filter: false })}`,

  '11-components': () => `<div class="sheet">
    <h3>Program rows</h3>
    <div role="list">
      ${row(program('slot3x3'), 'c64', {})}
      ${row(program('slot3x3'), 'c64', { hover: true })}
      ${row(program('slot5x5'), 'c64', { sel: true, primary: 'native' })}
      ${row(program('slot5x5'), 'c64', { live: ['editor', 'native'] })}
      ${row(program('tile-test'), 'vic20', {})}
      ${row(program('tile-test'), 'web', {})}
      ${row(program('slot5x5-retrigger-jackpot-seeded-ruler'), 'c64', {})}
    </div>
    <p class="cap muted" style="font-size:11px;margin:4px 0 0">Default · hover · selected (last-used filled) · running · runtime unavailable · not on this system · long name</p>
    <h3>System strip</h3>${strip('c64')}
  </div>`,
};

export const B_WIDTHS = {
  '01-program-3x3': [300, 420, 260], '02-program-5x5-inputs': [300, 420], '04-running': [300, 260],
  '11-components': [300],
};
