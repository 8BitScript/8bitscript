// Direction A — "the launch card".
//
// One card per run, read top to bottom as a sentence: WHAT (the program), WHERE
// (the system), WITH (the inputs), HOW (the runtime). The three runtime buttons
// sit at the foot, where the eye ends up, so choosing where to run is the last
// thing you do and the only thing that launches. Running machines and tools
// live below the card.
import { ic, RUNTIMES } from './icons.mjs';
import { VEGAS, TWENTY_FORTY_EIGHT, RUNNING, HISTORY, program, system } from './data.mjs';
import {
  esc, availability, command, defineFlags, sectionLabel, projectHeader, chips, systemHead, systemSummary, systemOptions,
  inputsBlock, commandPanel, reasonBlock, runButtons, secondaryRow, noticeBlock, runningBlock, historyBlock,
  toolsBlock, emptyState,
} from './ui.mjs';

function card({ project, prog, sysId, primary, inputsOpen = false, cmdOpen = false, optsOpen = false, missing = [], multi = true }) {
  const av = availability(prog, sysId, { missingEmulators: missing });
  const cmd = command(prog, sysId, primary, { defines: defineFlags(prog) });
  const head = multi
    ? `<span class="field-label" id="pl">Program</span>
       <button class="picker" aria-haspopup="listbox" aria-labelledby="pl" data-toggle="picker"><span class="t">${esc(prog.title)}${prog.group ? `<span class="g">${esc(prog.group)}</span>` : ''}</span>${ic('chevron-down')}</button>`
    : (prog.title === project.name ? '' : `<div class="ptitle">${esc(prog.title)}</div>`);
  const sysPart = `${systemHead({ open: optsOpen })}${chips(prog, sysId)}${systemSummary(sysId)}${systemOptions(sysId, { open: optsOpen })}`;
  const inputs = prog.inputs.length ? `<div class="part">${inputsBlock(prog, { open: inputsOpen })}</div>` : '';
  const needsReason = RUNTIMES.some((r) => !av[r.id].ok);
  return `<section class="card" aria-label="${esc(prog.title)} launcher">
    <div class="part">${head}${prog.desc ? `<p class="desc${head ? '' : ' first'}">${esc(prog.desc)}</p>` : ''}
      <button class="source" title="Open the entry file of ${esc(prog.title)}" aria-label="Open source file ${esc(prog.entry)}">${ic('go-to-file')}<span>${esc(prog.entry)}</span></button></div>
    <div class="part">${sysPart}</div>
    ${inputs}
    <div class="part"><span class="field-label" id="rl">Run in</span>${runButtons(av, primary, { prog, sysId })}${needsReason ? reasonBlock(av, { primary }) : ''}
      ${secondaryRow({ prog, cmdOpen })}${commandPanel(cmd, { open: cmdOpen })}</div>
  </section>`;
}

const running = (runs = RUNNING, hist = HISTORY) =>
  `${sectionLabel('Running', { count: runs.length })}${runningBlock(runs)}
   ${hist.length ? `${sectionLabel('Recent')}${historyBlock(hist)}` : ''}`;
const tools = () => `${sectionLabel('Tools')}${toolsBlock()}`;

function pickerMenu() {
  const groups = ['Slots', 'Labs', 'Test rigs'];
  const items = groups.map((g) => {
    const ps = VEGAS.programs.filter((p) => p.group === g);
    return `<div class="grp">${esc(g)} <span style="font-weight:400;letter-spacing:0">${ps.length}</span></div>${ps.map((p) =>
      `<button class="it${p.id === 'slot3x3' ? ' is-hover' : ''}" role="option"><span class="tick">${p.id === 'slot3x3' ? ic('check') : ''}</span><span class="who">${esc(p.title)}</span><span class="spec">${p.targets.length < 5 ? `${p.targets.length} systems` : ''}</span></button>`).join('')}`;
  }).join('');
  return `<div class="menu" id="picker" role="listbox" aria-label="Program">
    <div class="filter" style="margin:4px 4px 6px"><i class="codicon" aria-hidden="true">&#60013;</i><input class="input" placeholder="Filter programs" aria-label="Filter programs"></div>${items}</div>`;
}

export const A = {
  '01-program-3x3': () => `${projectHeader(VEGAS)}<div style="height:8px"></div>${card({ project: VEGAS, prog: program('slot3x3'), sysId: 'c64', primary: 'native' })}${tools()}`,

  '02-program-5x5-inputs': () => `${projectHeader(VEGAS)}<div style="height:8px"></div>${card({ project: VEGAS, prog: program('slot5x5'), sysId: 'c64', primary: 'native', inputsOpen: true, cmdOpen: true })}${tools()}`,

  '03-runtime-disabled': () => `${projectHeader(VEGAS)}<div style="height:8px"></div>${card({ project: VEGAS, prog: program('tile-test'), sysId: 'vic20', primary: 'native' })}${tools()}`,

  '03b-runtime-disabled-web': () => `${projectHeader(VEGAS)}<div style="height:8px"></div>${card({ project: VEGAS, prog: program('slot3x3'), sysId: 'web', primary: 'editor' })}${tools()}`,

  '04-running': () => `${projectHeader(VEGAS)}<div style="height:8px"></div>${card({ project: VEGAS, prog: program('slot5x5'), sysId: 'c64', primary: 'native' })}${running()}${tools()}`,

  '05-single-program': () => `${projectHeader(TWENTY_FORTY_EIGHT)}<div style="height:8px"></div>${card({ project: TWENTY_FORTY_EIGHT, prog: TWENTY_FORTY_EIGHT.programs[0], sysId: 'vic20', primary: 'editor', multi: false })}${tools()}`,

  '06-empty': () => emptyState(),

  '07-notice-missing-emulator': () => `${projectHeader(VEGAS)}
    ${noticeBlock('warn', 'package', '<b>Packages need installing.</b> This project is missing <span class="mono">node_modules</span>.', [`<button class="btn sm primary">${ic('package')}Install packages</button>`])}
    <div style="height:8px"></div>${card({ project: VEGAS, prog: program('slot3x3'), sysId: 'c64', primary: 'editor', missing: ['x64sc'] })}${tools()}`,

  '08-system-options': () => `${projectHeader(VEGAS)}<div style="height:8px"></div>${card({ project: VEGAS, prog: program('slot3x3'), sysId: 'c64', primary: 'native', optsOpen: true })}${tools()}`,

  '10-program-picker': () => `${projectHeader(VEGAS)}<div style="height:8px"></div>
    <section class="card"><div class="part"><span class="field-label">Program</span><button class="picker" aria-expanded="true" aria-haspopup="listbox"><span class="t">3×3 Slot<span class="g">Slots</span></span>${ic('chevron-up')}</button>${pickerMenu()}</div></section>`,

  '11-components': () => `<div class="sheet">
    <h3>Buttons</h3>
    <div class="line"><button class="btn primary">${ic('device-desktop')}Primary</button><button class="btn primary is-hover">Hover</button><button class="btn primary is-focus">Focus</button><button class="btn primary" disabled>Disabled</button></div>
    <div class="line"><button class="btn">${ic('globe')}Secondary</button><button class="btn is-hover">Hover</button><button class="btn is-focus">Focus</button><button class="btn" disabled>Disabled</button></div>
    <div class="line"><button class="btn ghost sm">${ic('tools')}Build</button><button class="btn ghost sm is-hover">Hover</button><button class="btn ghost sm is-focus">Focus</button><button class="ibtn">${ic('ellipsis')}</button><button class="ibtn is-hover">${ic('info')}</button></div>
    <h3>System chips</h3>
    <div class="chips" role="radiogroup" aria-label="System"><button class="chip" role="radio" aria-checked="true">C64</button><button class="chip" role="radio" aria-checked="false">PET</button><button class="chip is-hover" role="radio" aria-checked="false">VIC-20</button><button class="chip is-focus" role="radio" aria-checked="false">X16</button><button class="chip" role="radio" aria-checked="false" disabled>Web</button></div>
    <h3>Runtime row</h3>
    ${runButtons(availability(program('slot3x3'), 'c64'), 'native', { prog: program('slot3x3'), sysId: 'c64' })}
    <h3>Fields</h3>
    <div class="form"><div><div class="f-label"><label>Seed</label><span class="var">SEED</span></div><input class="input" type="number" value="7"></div>
    <div><div class="f-label"><label>Seed</label><span class="var">SEED</span></div><input class="input is-focus" type="number" value="10"></div>
    <div class="changed"><div class="f-label"><label>Starting credits</label><span class="var">START_CREDITS</span></div><input class="input" type="number" value="5000"></div></div>
    <h3>Notices</h3>
    ${noticeBlock('warn', 'warning', "<b>x64sc isn't installed.</b> Native can't run.", [`<button class="btn sm primary">Install</button>`])}
    ${noticeBlock('info', 'info', 'Editor runs use the WASM build.')}
    <h3>Status</h3>
    <div class="line"><span class="tag">${ic('device-desktop')}Native</span><span class="tag">${ic('open-preview')}Editor</span><span class="tag">C64</span><span class="dot"></span><span class="dot off"></span><span class="dot bad"></span></div>
  </div>`,
};

// Which widths each state is drawn at.
export const A_WIDTHS = {
  '01-program-3x3': [300, 420, 260], '02-program-5x5-inputs': [300, 420], '04-running': [300, 260],
  '11-components': [300],
};
