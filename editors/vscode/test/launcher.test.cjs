// The launcher page, end to end over a real DOM: media/launcher.js runs in a
// vm context against linkedom (test/support/launcherDom.cjs), is sent the
// states in test/support/launcherFixtures.cjs, and is clicked and typed at the
// way a person would. What it draws, what it lets the keyboard reach, and every
// message it posts is asserted — not strings of HTML.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mountLauncher } = require('./support/launcherDom.cjs');
const { vegas, single, RUNNING, HISTORY } = require('./support/launcherFixtures.cjs');

const mount = (state, saved) => {
  const page = mountLauncher({ saved });
  page.send(state);
  return page;
};
/** Pick a program the way a person does: open the Program picker, click the program. */
const choose = (page, id) => { page.click(page.byKey('picker:Program')); page.click(page.byKey(`prog:${id}`)); };
const menuItems = (page, name) => page.all(`[data-menu="${name}"] [role="menuitemradio"]`);
const keys = (page, selector) => page.all(selector).map((el) => el.getAttribute('data-key'));
// Text as a person reads it: icon glyphs (private-use codepoints) are not words.
const norm = (el) => el.textContent.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
const pick = (select, value) => { Array.from(select.querySelectorAll('option')).forEach((o) => { o.selected = o.getAttribute('value') === value; }); };

test('the page announces itself once and draws nothing until it has a state', () => {
  const page = mountLauncher();
  assert.deepEqual(page.posted, [{ type: 'ready' }]);
  assert.equal(page.app.children.length, 0);
});

test('a state is accepted only from the editor: its own origin or the frame that embeds the page', () => {
  const page = mountLauncher();
  const state = vegas();
  const send = (from) => page.sendFrom(from, { type: 'state', state });
  send({ origin: 'https://evil.example', source: { name: 'another window' } });
  assert.equal(page.app.children.length, 0, 'a foreign origin from a foreign window draws nothing');
  send({ origin: undefined, source: undefined });
  assert.equal(page.app.children.length, 0, 'a message with no origin and no source draws nothing');
  send({ origin: 'https://evil.example', source: page.host });
  assert.ok(page.app.children.length > 0, 'the embedding frame is trusted whatever origin it reports');
  const second = mountLauncher();
  second.sendFrom({ origin: second.window.location.origin, source: { name: 'a same-origin frame' } }, { type: 'state', state });
  assert.ok(second.app.children.length > 0, 'and so is the page\'s own origin');
});

test('loading draws a busy skeleton and nothing else', () => {
  const page = mount({ phase: 'loading', notices: [] });
  const skeleton = page.one('.skeleton');
  assert.equal(skeleton.getAttribute('aria-busy'), 'true');
  assert.equal(page.all('.prow').length, 0);
});

test('no project draws the empty state, and its three buttons post their messages', () => {
  const page = mount({ phase: 'empty' });
  assert.match(norm(page.app), /No 8BitScript project here/);
  page.click(page.byKey('empty:open'));
  page.click(page.byKey('empty:example'));
  page.click(page.byKey('empty:learn'));
  assert.deepEqual(page.posted.slice(1).map((m) => m.type), ['openFolder', 'tryExample', 'learn']);
});

test('a project with several programs has the same head as one: the project, System, then a Program picker', () => {
  const page = mount(vegas());
  assert.match(norm(page.one('.project')), /Vegas Nights/);
  assert.ok(page.byKey('picker:Project'), 'the heading switches projects');
  assert.deepEqual(page.all('.strip .picker').map((el) => el.getAttribute('data-key')), ['picker:System', 'picker:Program'], 'one per row, never side by side');
  assert.ok(page.all('.strip').every((el) => el.className === 'strip one'));
  assert.match(norm(page.byKey('picker:System')), /C64\s*NTSC/);
  assert.match(norm(page.byKey('picker:Program')), /3×3 Slot\s*Slots/, 'the program and its group');
  assert.match(norm(page.one('.summary')), /Commodore 64 · 64 KB · NTSC · English/);
  assert.deepEqual(page.all('.seg .tab').map((el) => el.querySelector('span:not(.badge):not(.dot)').textContent), ['Program', 'Running'], 'two panes');
  assert.equal(page.byKey('tab:programs').getAttribute('aria-selected'), 'true', 'the program first');
  assert.equal(page.all('.drawer').length, 1, 'the pane holds the selected program, not a list of them');
  assert.equal(page.one('.drawer').getAttribute('aria-label'), '3×3 Slot details');
});

test('the tiles are three labelled run buttons, in the order Editor, Browser, Native', () => {
  const page = mount(vegas({ system: 'vic20' }));
  const buttons = page.all('.runs [data-action="run"]');
  assert.deepEqual(buttons.map((b) => b.getAttribute('data-runtime')), ['editor', 'browser', 'native']);
  assert.equal(page.one('.runs').getAttribute('aria-label'), 'Run in');
  assert.match(buttons[0].getAttribute('aria-label'), /^Run 3×3 Slot on Commodore VIC-20 in editor tab/);
  assert.match(buttons[2].getAttribute('aria-label'), /native emulator \(verification\)/);
});

test('the filled tile is the primary runtime, and it is the last one used', () => {
  const page = mount(vegas({ system: 'vic20', remembered: { slot3x3: 'native' } }));
  const filled = page.all('.runs .run.primary');
  assert.equal(filled.length, 1);
  assert.equal(filled[0].getAttribute('data-key'), 'big:slot3x3:native');
  const fresh = mount(vegas({ system: 'vic20' }));
  assert.equal(fresh.all('.runs .run.primary')[0].getAttribute('data-key'), 'big:slot3x3:editor', 'with nothing remembered the default is the Editor tab');
});

test('clicking a run button posts that runtime for that program, the system and only the changed inputs', () => {
  const page = mount(vegas({ system: 'vic20', program: 'slot5x5', values: { slot5x5: { SEED: 10, FORCE_BONUS: true } } }));
  page.click(page.byKey('big:slot5x5:browser'));
  assert.deepEqual(page.last(), { type: 'run', runtime: 'browser', program: 'slot5x5', system: 'vic20', inputs: { SEED: 10, FORCE_BONUS: true } });
  choose(page, 'slot3x3');
  page.click(page.byKey('big:slot3x3:native'));
  assert.deepEqual(page.last(), { type: 'run', runtime: 'native', program: 'slot3x3', system: 'vic20', inputs: {} }, 'another program carries none of those');
});

test('Native does not need Editor: it posts on its own, and the others are separate messages', () => {
  const page = mount(vegas({ system: 'cx16' }));
  page.click(page.byKey('big:slot3x3:native'));
  page.click(page.byKey('big:slot3x3:editor'));
  page.click(page.byKey('big:slot3x3:browser'));
  assert.deepEqual(page.messages('run').map((m) => m.runtime), ['native', 'editor', 'browser']);
});

test('a runtime that cannot work stays focusable, says why, and does not run', () => {
  const page = mount(vegas({ system: 'c64' }));
  const editor = page.byKey('big:slot3x3:editor');
  assert.equal(editor.getAttribute('aria-disabled'), 'true');
  assert.equal(editor.hasAttribute('disabled'), false, 'aria-disabled, never disabled, so a keyboard can reach it');
  assert.match(editor.getAttribute('aria-label'), /unavailable/);
  assert.match(editor.getAttribute('title'), /No wasm build for c64 yet/);
  page.click(editor);
  assert.equal(page.messages('run').length, 0, 'clicking it runs nothing');
  assert.equal(page.active().getAttribute('data-key'), 'reason:slot3x3', 'it moves focus to the reason instead');
  assert.match(norm(page.active()), /Preview and Browser are unavailable/);
});

test('the Web system disables Native with the right reason and offers Editor instead', () => {
  const page = mount(vegas({ system: 'web' }));
  assert.equal(page.byKey('big:slot3x3:native').getAttribute('aria-disabled'), 'true');
  const reason = page.byKey('reason:slot3x3');
  assert.match(norm(reason), /Emulate is unavailable\. The browser has no native emulator; it runs in the browser\./);
  assert.equal(page.byKey('use:editor'), null, 'Editor is already the primary, so there is nothing to switch to');
});

test('a missing emulator is a fixable, amber note with an install button and Doctor', () => {
  const page = mount(vegas({ system: 'vic20', missing: ['xvic'], remembered: { slot3x3: 'native' } }));
  const reason = page.byKey('reason:slot3x3');
  assert.match(reason.className, /warn/);
  assert.match(norm(reason), /xvic is not installed/);
  assert.match(norm(page.app), /Emulate is unavailable here, so Preview is the default/, 'and the primary moved, saying so');
  page.click(page.byKey('fix:emulator'));
  page.click(page.byKey('fix:doctor'));
  assert.deepEqual(page.posted.slice(-2), [{ type: 'fix', kind: 'emulator' }, { type: 'doctor' }]);
});

test('when WASM and the emulator are both unavailable the note says each reason once and offers the fix, not a switch to the broken one', () => {
  const page = mount(vegas({ system: 'c64', missing: ['x64sc'] }));
  const reason = page.byKey('reason:slot3x3');
  const lines = Array.from(reason.querySelectorAll('.why-line')).map(norm);
  assert.deepEqual(lines, [
    'Preview and Browser are unavailable. No wasm build for c64 yet.',
    'Emulate is unavailable. x64sc is not installed.',
  ]);
  assert.ok(page.byKey('fix:emulator'), 'the install is offered');
  assert.equal(page.byKey('use:native'), null, 'and so is no switch to the runtime that is itself unavailable');
  assert.equal(page.byKey('use:editor'), null);
});

test('a program that does not target the system is dimmed and explained', () => {
  const page = mount(vegas({ system: 'web', program: 'tile-test' }));
  page.click(page.byKey('picker:Program'));
  const item = page.byKey('prog:tile-test');
  assert.match(item.className, /dim/, 'the menu dims it');
  assert.match(norm(item), /Tile Test not on Web/);
  assert.match(item.getAttribute('aria-label'), /not on Web/);
  assert.equal(item.getAttribute('aria-disabled'), null, 'but it can still be picked: picking it moves the machine');
  assert.equal(page.byKey('big:tile-test:editor').getAttribute('aria-disabled'), 'true');
  assert.match(norm(page.byKey('reason:tile-test')), /Not on this system\. Tile Test doesn't target Web\./);
});

test('picking a program posts select, shows its drawer, and returns focus to the picker', () => {
  const page = mount(vegas());
  page.click(page.byKey('picker:Program'));
  assert.equal(page.byKey('prog:slot3x3').getAttribute('aria-checked'), 'true');
  page.click(page.byKey('prog:slot5x5'));
  assert.deepEqual(page.messages('select').at(-1), { type: 'select', program: 'slot5x5' });
  assert.equal(page.all('[data-menu="program"]').length, 0, 'picking closes the menu');
  assert.equal(page.all('.drawer').length, 1);
  assert.equal(page.one('.drawer').getAttribute('aria-label'), '5×5 Ways Slot details');
  assert.equal(page.active().getAttribute('data-key'), 'picker:Program');
  assert.match(norm(page.byKey('picker:Program')), /5×5 Ways Slot/);
});

test('the drawer names the source file, and clicking it opens THAT program\'s entry', () => {
  const page = mount(vegas({ program: 'slot5x5' }));
  const source = page.byKey('source:slot5x5');
  assert.equal(norm(source), 'src/labs/slot5x5/main.8bs');
  assert.match(source.getAttribute('aria-label'), /Open source file src\/labs\/slot5x5\/main\.8bs/);
  page.click(source);
  assert.deepEqual(page.last(), { type: 'openSource', program: 'slot5x5' });
});

test('Build says what it produces, and posts the selected program', () => {
  const page = mount(vegas({ program: 'slot5x5' }));
  const build = page.byKey('build:slot5x5');
  assert.match(build.getAttribute('title'), /Compile slot5x5 to dist\/slot5x5\.prg and show the size report\. Nothing runs\./);
  page.click(build);
  assert.deepEqual(page.last(), { type: 'build', program: 'slot5x5', system: 'c64' });
});

test('Inputs: a count, a form per kind, and what changed', () => {
  const page = mount(vegas({ program: 'slot5x5', values: { slot5x5: { SEED: 10 } } }), { open: { 'inputs:slot5x5': true } });
  assert.match(norm(page.byKey('dis:inputs:slot5x5')), /^Inputs41 changed$/);
  assert.equal(page.one('input[data-kind="number"]').getAttribute('type'), 'number');
  assert.equal(page.one('input[data-kind="bool"]').getAttribute('type'), 'checkbox');
  assert.equal(page.one('select[data-kind="select"]').getAttribute('data-input'), 'THEME');
  assert.equal(page.all('.chg').length, 1, 'only SEED differs from its default');
  assert.ok(page.byKey('reset:slot5x5'), 'and there is a way back');
});

test('Inputs stay hidden until opened, and the disclosure remembers it', () => {
  const page = mount(vegas({ program: 'slot5x5' }));
  assert.equal(page.all('input[data-input]').length, 0);
  assert.equal(page.byKey('dis:inputs:slot5x5').getAttribute('aria-expanded'), 'false');
  page.focus(page.byKey('dis:inputs:slot5x5'));
  page.click(page.byKey('dis:inputs:slot5x5'));
  assert.equal(page.all('input[data-input], select[data-input]').length, 4);
  assert.equal(page.state().open['inputs:slot5x5'], true, 'persisted for the next time the view opens');
  assert.equal(page.active().getAttribute('data-key'), 'dis:inputs:slot5x5', 'focus stays on the disclosure');
});

test('editing an input posts it, draws it as changed, and the next run carries it', () => {
  const page = mount(vegas({ program: 'slot5x5' }), { open: { 'inputs:slot5x5': true } });
  const seed = page.one('input[data-input="SEED"]');
  seed.value = '42';
  page.change(seed);
  assert.deepEqual(page.messages('input').at(-1), { type: 'input', program: 'slot5x5', name: 'SEED', value: 42 }, 'a number, not text');
  assert.equal(page.all('.chg').length, 1);
  const bonus = page.one('input[data-input="FORCE_BONUS"]');
  bonus.checked = true;
  page.change(bonus);
  assert.deepEqual(page.messages('input').at(-1), { type: 'input', program: 'slot5x5', name: 'FORCE_BONUS', value: true });
  const theme = page.one('select[data-input="THEME"]');
  pick(theme, 'cosmic');
  page.change(theme);
  assert.deepEqual(page.messages('input').at(-1), { type: 'input', program: 'slot5x5', name: 'THEME', value: 'cosmic' });
  page.click(page.byKey('big:slot5x5:native'));
  assert.deepEqual(page.last().inputs, { SEED: 42, FORCE_BONUS: true, THEME: 'cosmic' });
});

test('a number input cleared to nothing falls back to its default instead of posting NaN', () => {
  const page = mount(vegas({ program: 'slot5x5' }), { open: { 'inputs:slot5x5': true } });
  const seed = page.one('input[data-input="SEED"]');
  seed.value = '';
  page.change(seed);
  assert.equal(page.messages('input').at(-1).value, 7);
});

test('Reset to defaults posts and clears every changed mark', () => {
  const page = mount(vegas({ program: 'slot5x5', values: { slot5x5: { SEED: 10, START_CREDITS: 5000 } } }), { open: { 'inputs:slot5x5': true } });
  assert.equal(page.all('.chg').length, 2);
  page.click(page.byKey('reset:slot5x5'));
  assert.deepEqual(page.last(), { type: 'inputsReset', program: 'slot5x5' });
  assert.equal(page.all('.chg').length, 0);
  assert.equal(page.byKey('reset:slot5x5'), null);
});

test('Command shows the exact line, wraps between flags, and copies it', () => {
  const page = mount(vegas({ program: 'slot5x5', values: { slot5x5: { SEED: 10 } }, system: 'c64' }), { open: { 'command:slot5x5': true } });
  assert.equal(norm(page.one('.code .cmd')), '8bs run c64 --program slot5x5 --define SEED=10 --size');
  assert.ok(page.all('.code .nb').length >= 4, 'every flag is its own unbreakable chunk');
  page.click(page.byKey('copy:slot5x5'));
  assert.deepEqual(page.last(), { type: 'copy', text: '8bs run c64 --program slot5x5 --define SEED=10 --size' });
});

test('the ⋯ menu offers a bare emulator, copying the command and revealing the file, and closes on Escape', () => {
  const page = mount(vegas());
  page.click(page.byKey('more:slot3x3'));
  assert.equal(page.byKey('more:slot3x3').getAttribute('aria-expanded'), 'true');
  const items = page.all('[data-menu="more"] [role="menuitem"]');
  assert.deepEqual(items.map(norm), ['Open bare emulator', 'Copy command', 'Reveal in Explorer']);
  assert.equal(page.active(), items[0], 'focus moves into the menu');
  page.key(items[0], 'ArrowDown');
  assert.equal(page.active(), items[1]);
  page.key(items[1], 'End');
  assert.equal(page.active(), items[2]);
  page.key(items[2], 'Home');
  assert.equal(page.active(), items[0]);
  const esc = page.key(items[0], 'Escape');
  assert.equal(esc.defaultPrevented, true);
  assert.equal(page.one('[data-menu="more"]'), null, 'closed');
  assert.equal(page.active().getAttribute('data-key'), 'more:slot3x3', 'and focus returns to the trigger');
});

test('each ⋯ item posts its own message', () => {
  const page = mount(vegas());
  page.click(page.byKey('more:slot3x3'));
  page.click(page.byKey('more:boot'));
  assert.deepEqual(page.last(), { type: 'boot', system: 'c64' });
  page.click(page.byKey('more:slot3x3'));
  page.click(page.byKey('more:copy'));
  assert.deepEqual(page.last(), { type: 'copy', text: '8bs run c64 --program slot3x3 --size' });
  page.click(page.byKey('more:slot3x3'));
  page.click(page.byKey('more:reveal'));
  assert.deepEqual(page.last(), { type: 'reveal', program: 'slot3x3' });
});

test('Open bare emulator is unavailable for the Web, which has no emulator', () => {
  const page = mount(vegas({ system: 'web' }));
  page.click(page.byKey('more:slot3x3'));
  assert.equal(page.byKey('more:boot').getAttribute('aria-disabled'), 'true');
});

test('the System menu lists machines, disables ones the program does not target, and selects', () => {
  const state = vegas({ program: 'tile-test' });
  const page = mount(state);
  page.click(page.one('[data-action="menu-system"]'));
  const menu = page.one('[data-menu="system"]');
  const items = Array.from(menu.querySelectorAll('[role="menuitemradio"]'));
  assert.deepEqual(items.map((el) => el.getAttribute('data-system')), ['pet', 'vic20', 'c64', 'cx16', 'web']);
  assert.equal(items.find((el) => el.getAttribute('data-system') === 'c64').getAttribute('aria-checked'), 'true');
  const web = items.find((el) => el.getAttribute('data-system') === 'web');
  assert.equal(web.getAttribute('aria-disabled'), 'true');
  assert.match(web.getAttribute('title'), /doesn't target Web/);
  page.click(web);
  assert.equal(page.messages('select').filter((m) => m.system).length, 0, 'a disabled system cannot be picked');
  page.click(items[0]);
  assert.deepEqual(page.messages('select').at(-1), { type: 'select', system: 'pet' });
  assert.equal(page.one('[data-menu="system"]'), null, 'a pick closes the menu');
  assert.equal(page.active().getAttribute('data-key'), 'picker:System');
});

test('the System menu has the two actions the old Options had', () => {
  const page = mount(vegas());
  page.click(page.one('[data-action="menu-system"]'));
  page.click(page.byKey('sm:configure'));
  assert.equal(page.last().type, 'configureSystem');
  page.click(page.one('[data-action="menu-system"]'));
  page.click(page.byKey('sm:save'));
  assert.equal(page.last().type, 'saveSystem');
  page.click(page.byKey('summary:options'));
  assert.equal(page.last().type, 'configureSystem', 'and the gear beside the summary does the same');
});

test('a click anywhere else closes an open menu', () => {
  const page = mount(vegas());
  page.click(page.one('[data-action="menu-system"]'));
  assert.ok(page.one('[data-menu="system"]'));
  page.document.dispatchEvent(new page.window.Event('click', { bubbles: true }));
  assert.equal(page.one('[data-menu="system"]'), null);
});

test('the Project menu groups projects and posts the pick', () => {
  const page = mount(vegas());
  page.click(page.one('[data-action="menu-project"]'));
  const items = page.all('[data-menu="project"] [role="menuitemradio"]');
  assert.deepEqual(items.map(norm), ['Vegas Nights vegas-nights', '2048'], 'where it lives, unless that is its name');
  assert.equal(items[0].getAttribute('aria-checked'), 'true');
  page.click(items[1]);
  assert.deepEqual(page.last(), { type: 'select', project: '/2048' });
});

test('a project with one program still switches projects: its name is the Project picker', () => {
  const page = mount(single());
  const name = page.byKey('picker:Project');
  assert.ok(name, 'the heading is a button when there is somewhere else to go');
  assert.equal(name.getAttribute('aria-haspopup'), 'menu');
  page.click(name);
  assert.equal(page.byKey('picker:Project').getAttribute('aria-expanded'), 'true');
  const items = page.all('[data-menu="project"] [role="menuitemradio"]');
  assert.deepEqual(items.map((el) => el.getAttribute('data-project')), ['/v', '/2048']);
  page.click(items[0]);
  assert.deepEqual(page.last(), { type: 'select', project: '/v' });
  assert.equal(page.all('[data-menu="project"]').length, 0, 'picking closes the menu');
});

test('a project alone in its workspace is a heading, not a picker', () => {
  const state = single();
  state.projects = state.projects.filter((p) => p.id === '/2048');
  const page = mount(state);
  assert.equal(page.byKey('picker:Project'), null);
  assert.match(norm(page.one('.project')), /2048/);
});

/** A workspace beside a checkout of the repository: two programs, six examples, Studio and conform. */
function crowded() {
  const state = single();
  const ex = ['hello-world', 'joystick', 'fancy', 'hello-8bx', 'swarm', 'media-walk'];
  state.projects = [
    { id: '/2048', label: '2048', where: '2048', group: 'Programs' },
    { id: '/v', label: 'vegas-nights', where: 'vegas-nights', group: 'Programs' },
    ...ex.map((name) => ({ id: `/ex/${name}`, label: name, where: `packages/examples/${name}`, group: 'Examples', quiet: true })),
    { id: '/studio', label: 'Studio', where: '@8bitscript/studio', group: 'Apps' },
    { id: '/conform', label: 'conform', where: 'packages/cli/conform', group: '8BitScript repository', quiet: true },
  ];
  return state;
}

test('the Project menu folds examples and the repository\'s own projects until asked, and remembers it', () => {
  const page = mount(crowded());
  page.click(page.byKey('picker:Project'));
  const shown = () => page.all('[data-menu="project"] [role="menuitemradio"]').map((el) => el.getAttribute('data-project'));
  assert.deepEqual(shown(), ['/2048', '/v', '/studio'], 'the quiet groups start folded');
  const examples = page.byKey('project-group:Examples');
  assert.equal(examples.getAttribute('aria-expanded'), 'false');
  assert.match(norm(examples), /Examples 6/, 'a folded group says how many it holds');
  page.click(examples);
  assert.equal(shown().length, 9, 'unfolded');
  assert.equal(page.active().getAttribute('data-key'), 'project-group:Examples', 'focus stays on the group');
  assert.equal(page.state().projectFolds.Examples, false, 'and the choice is kept');
  page.click(page.byKey('project-group:Programs'));
  assert.ok(!shown().includes('/2048'), 'any group folds');
});

test('a quiet group holding the open project starts unfolded', () => {
  const state = crowded();
  state.project = { id: '/conform', name: 'conform', sub: 'packages/cli/conform' };
  const page = mount(state);
  page.click(page.byKey('picker:Project'));
  assert.equal(page.byKey('project-group:8BitScript repository').getAttribute('aria-expanded'), 'true');
  assert.equal(page.byKey('project-group:Examples').getAttribute('aria-expanded'), 'false');
});

test('a long Project menu opens on a filter that searches folded groups too', () => {
  const page = mount(crowded());
  page.click(page.byKey('picker:Project'));
  const filter = page.byKey('project-filter');
  assert.ok(filter, 'ten projects get a filter');
  assert.equal(page.active(), filter, 'and the menu opens on it');
  page.type(filter, 'hello');
  assert.deepEqual(page.all('[data-menu="project"] [role="menuitemradio"]').map((el) => el.getAttribute('data-project')), ['/ex/hello-world', '/ex/hello-8bx']);
  assert.equal(page.active().getAttribute('data-key'), 'project-filter', 'typing keeps focus in the field');
  page.key(page.byKey('project-filter'), 'ArrowDown');
  assert.equal(page.active().getAttribute('data-key'), 'project-group:Examples', 'the arrow leaves the field for the list');
  assert.equal(page.key(page.byKey('project-filter'), 'Home').defaultPrevented, false, 'Home and End move the caret, not the focus');
  assert.equal(page.active().getAttribute('data-key'), 'project-group:Examples');
  page.focus(page.byKey('project-filter'));
  assert.equal(page.key(page.byKey('project-filter'), 'End').defaultPrevented, false);
  assert.equal(page.active().getAttribute('data-key'), 'project-filter');
  page.type(page.byKey('project-filter'), 'zzz');
  assert.match(norm(page.one('[data-menu="project"] .none')), /No projects match “zzz”\./);
  assert.equal(page.key(page.byKey('project-filter'), 'ArrowDown').defaultPrevented, false, 'nothing to move to');
  page.key(page.byKey('project-filter'), 'Escape');
  assert.equal(page.all('[data-menu="project"]').length, 0);
  assert.equal(page.active().getAttribute('data-key'), 'picker:Project');
  assert.equal(mount(single()).byKey('project-filter'), null, 'two projects need no filter');
});

test('the Program menu folds a group the config folds, and a fold is kept and survives the next state', () => {
  const page = mount(vegas());
  page.click(page.byKey('picker:Program'));
  const shown = () => menuItems(page, 'program').map((el) => el.getAttribute('data-program'));
  assert.equal(page.byKey('program-group:Test rigs').getAttribute('aria-expanded'), 'false', 'Test rigs starts folded');
  assert.equal(page.byKey('program-group:Slots').getAttribute('aria-expanded'), 'true');
  const all = shown().length;
  page.click(page.byKey('program-group:Labs'));
  assert.equal(page.state().collapsed.Labs, true);
  assert.equal(page.active().getAttribute('data-key'), 'program-group:Labs', 'focus stays on the group');
  assert.equal(shown().length, all - 3, 'Labs folded');
  page.click(page.byKey('program-group:Test rigs'));
  assert.equal(shown().length, all - 3 + 4, 'Test rigs opened');
  page.send(vegas());
  assert.equal(page.byKey('program-group:Labs').getAttribute('aria-expanded'), 'false', 'a new state does not unfold it');
});

test('a saved fold is restored when the view reopens', () => {
  const page = mount(vegas(), { collapsed: { Slots: true } });
  page.click(page.byKey('picker:Program'));
  assert.equal(page.byKey('prog:slot5x5'), null);
});

test('a long project folds every group but the selected program\'s', () => {
  const many = require('./support/launcherFixtures.cjs').PROGRAMS;
  const programs = Array.from({ length: 3 }, (_, i) => many.map((p) => ({ ...p, id: `${p.id}-${i}`, group: `${p.group} ${i}` }))).flat();
  const page = mount(vegas({ programs, program: programs[0].id }));
  page.click(page.byKey('picker:Program'));
  const open = page.all('[data-menu="program"] .grp').filter((el) => el.getAttribute('aria-expanded') === 'true').map((el) => el.getAttribute('data-group'));
  assert.deepEqual(open, [programs[0].group]);
});

test('a long Program menu opens on a filter that searches folded groups and says when nothing matches', () => {
  const page = mount(vegas());
  page.click(page.byKey('picker:Program'));
  const filter = page.byKey('program-filter');
  assert.ok(filter, 'eight or more programs');
  assert.equal(page.active(), filter);
  page.type(filter, 'ruler');
  assert.deepEqual(menuItems(page, 'program').map(norm), ['slot3x3-ruler', 'slot5x5-retrigger-jackpot-seeded-ruler'], 'matches are shown even inside a folded group');
  assert.equal(page.active().getAttribute('data-key'), 'program-filter', 'typing keeps focus in the field');
  page.type(page.byKey('program-filter'), 'zzz');
  assert.match(norm(page.one('[data-menu="program"] .none')), /No programs match “zzz”\./);
  page.key(page.byKey('program-filter'), 'Escape');
  assert.equal(page.active().getAttribute('data-key'), 'picker:Program');
});

test('a short list has no filter, and a single program has no picker', () => {
  const four = mount(vegas({ programs: require('./support/launcherFixtures.cjs').PROGRAMS.slice(0, 4), program: 'slot3x3' }));
  four.click(four.byKey('picker:Program'));
  assert.equal(four.byKey('program-filter'), null);
  assert.equal(mount(single()).byKey('picker:Program'), null);
});

test('the Program menu is walked with the arrows, and Escape returns to the picker', () => {
  const page = mount(vegas());
  page.click(page.byKey('picker:Program'));
  page.key(page.active(), 'ArrowDown');
  assert.equal(page.active().getAttribute('data-key'), 'program-group:Slots', 'headers are part of the walk');
  page.key(page.active(), 'ArrowDown');
  assert.equal(page.active().getAttribute('data-key'), 'prog:slot3x3');
  page.key(page.active(), 'End');
  assert.equal(page.active().getAttribute('data-key'), 'program-group:Test rigs');
  page.key(page.active(), 'Home');
  assert.equal(page.active().getAttribute('data-key'), 'program-group:Slots');
  page.key(page.active(), 'Escape');
  assert.equal(page.all('[data-menu="program"]').length, 0);
  assert.equal(page.active().getAttribute('data-key'), 'picker:Program');
});

test('the hint under the big buttons follows hover and focus', () => {
  const page = mount(single({ system: 'c64' }));
  assert.match(norm(page.one('#hint')), /Runs the real x64sc emulator with 2048 loaded\./);
  const editor = page.byKey('big:main:editor');
  page.focus(editor);
  assert.equal(norm(page.one('#hint')), 'Runs the WASM build in a tab inside the editor. The primary way to run a program.');
  const over = new page.window.Event('pointerover', { bubbles: true });
  page.byKey('big:main:browser').dispatchEvent(over);
  assert.equal(norm(page.one('#hint')), 'Runs the WASM build in your web browser: the page you can share.');
});

test('a project with one program has no program list: the header, the system and big run buttons', () => {
  const page = mount(single({ system: 'vic20' }));
  assert.equal(page.all('.strip .picker').length, 1, 'just System');
  assert.match(norm(page.one('.focus-name')), /Program\s*2048/, 'the one program is named, not picked');
  assert.match(norm(page.one('.project')), /2048/);
  const big = page.all('.runs .run');
  assert.deepEqual(big.map((b) => b.getAttribute('data-runtime')), ['editor', 'browser', 'native']);
  assert.equal(big.filter((b) => b.className.includes('primary')).length, 1);
  assert.equal(page.one('.runs').getAttribute('aria-label'), 'Run in');
  page.click(big[2]);
  assert.deepEqual(page.last(), { type: 'run', runtime: 'native', program: 'main', system: 'vic20', inputs: {} });
  page.click(page.byKey('project:details'));
  assert.equal(page.last().type, 'details');
});

test('Running: one card per run with its own Stop, Show tab and Open in browser', () => {
  const page = mount(vegas({ program: 'slot5x5', running: RUNNING, history: HISTORY, live: { slot5x5: ['editor', 'native'] } }), { tab: 'running' });
  assert.equal(page.all('.run-item').length, 2);
  assert.match(norm(page.one('.sec + .items, .items')), /5×5 Ways Slot/);
  assert.match(norm(page.all('.run-item')[0]), /C64Emulate50 fps/);
  assert.match(norm(page.all('.run-item')[1]), /C64Preview60 fps/);
  assert.equal(page.byKey('show:r1'), null, 'a native run has no tab to show');
  page.click(page.byKey('show:r2'));
  page.click(page.byKey('ob:r2'));
  page.click(page.byKey('stop:r1'));
  page.click(page.byKey('stop:r2'));
  assert.deepEqual(page.posted.slice(-4), [
    { type: 'focus', runId: 'r2' }, { type: 'openInBrowser', runId: 'r2' }, { type: 'stop', runId: 'r1' }, { type: 'stop', runId: 'r2' },
  ]);
  page.click(page.byKey('tab:programs'));
  page.click(page.byKey('picker:Program'));
  assert.ok(page.byKey('prog:slot5x5').querySelector('.dot'), 'and the Program menu shows which program is running');
  assert.match(page.byKey('prog:slot5x5').getAttribute('aria-label'), /running/);
});

test('a run\'s Command and Details open independently and show what was kept', () => {
  const page = mount(vegas({ program: 'slot5x5', running: RUNNING, live: { slot5x5: ['native'] } }), { tab: 'running' });
  page.click(page.byKey('rcb:r1'));
  assert.equal(norm(page.one('.rc .cmd')), '8bs run c64 --program slot5x5 --size');
  page.click(page.byKey('dis:rm:r1'));
  const facts = norm(page.one('.facts'));
  assert.match(facts, /Hardwarestock machine/);
  assert.match(facts, /Imagedist\/slot5x5\.prg/);
  assert.match(facts, /Memory105 bytes RAM/);
  assert.match(norm(page.one('.sizes')), /program10899 B · 100\.0%reel tables2840 B · 26\.1%/);
});

test('a run can carry a QR code for the network address, drawn from the host\'s SVG', () => {
  const run = { ...RUNNING[1], qrSvg: '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>' };
  const page = mount(vegas({ running: [run] }), { open: { 'rm:r2': true }, tab: 'running' });
  const qr = page.one('.qr');
  assert.equal(qr.getAttribute('role'), 'img');
  assert.match(qr.getAttribute('aria-label'), /QR code/);
  assert.ok(qr.querySelector('svg'));
});

test('Recent lists past runs with a failure in words and a way to run it again', () => {
  const page = mount(vegas({ running: RUNNING, history: HISTORY }), { tab: 'running' });
  const rows = page.all('.hist-row');
  assert.equal(rows.length, 2);
  assert.match(norm(rows[1]), /Tile TestVIC-20 · EmulateBuild failed · 2 errors · 13:48/);
  page.click(page.byKey('again:h2'));
  assert.deepEqual(page.last(), { type: 'rerun', historyId: 'h2' });
});

test('Tools: Studio, Doctor and Project details each post their own message', () => {
  const page = mount(vegas());
  page.click(page.byKey('tool:studio'));
  page.click(page.byKey('tool:doctor'));
  page.click(page.byKey('tool:details'));
  assert.deepEqual(page.posted.slice(-3).map((m) => m.type), ['studio', 'doctor', 'details']);
});

test('Tools: Studio opens in the editor tab, and the native emulator is its own labelled button beside it', () => {
  const page = mount(vegas());
  const native = page.byKey('tool:studioNative');
  assert.ok(native, 'a separate button for the native emulator');
  assert.match(native.getAttribute('aria-label'), /native emulator/i);
  assert.match(native.getAttribute('title'), /native emulator/i);
  assert.match(norm(page.byKey('tool:studio')), /Studio/);
  assert.match(page.byKey('tool:studio').getAttribute('title'), /editor tab/);
  page.click(native);
  assert.equal(page.last().type, 'studioNative');
  page.click(page.byKey('tool:studio'));
  assert.equal(page.last().type, 'studio');
});

test('notices render by kind with their actions, and an action posts its own message', () => {
  const page = mount(vegas({ notices: [
    { id: 'pkg', kind: 'warn', icon: 'package', title: 'Packages need installing.', text: 'Vegas Nights is missing node_modules.', actions: [{ label: 'Install packages', icon: 'package', msg: { type: 'fix', kind: 'packages', dir: '/v' } }] },
    { id: 'dev', kind: 'error', text: 'It did not build.', actions: [{ label: 'Rebuild', msg: { type: 'rebuildExtension' } }] },
    { id: 'i', kind: 'info', text: 'FYI', actions: [] },
  ] }));
  const notices = page.all('.notice');
  assert.deepEqual(notices.map((n) => n.className.replace('notice ', '')), ['warn', 'error', 'info']);
  assert.equal(notices[1].getAttribute('role'), 'alert');
  assert.equal(notices[0].getAttribute('role'), 'status');
  page.click(page.byKey('notice:pkg:0'));
  page.click(page.byKey('notice:dev:0'));
  assert.deepEqual(page.posted.slice(-2), [{ type: 'fix', kind: 'packages', dir: '/v' }, { type: 'rebuildExtension' }]);
});

test('"Use Emulate instead" changes what the primary button means', () => {
  const page = mount(vegas({ system: 'web', program: 'slot3x3' }));
  // On the Web, Preview is the default; on a machine where it cannot run the
  // note offers the other runtime.
  const wasm = mount(vegas({ system: 'c64', program: 'tile-test' }));
  assert.equal(wasm.byKey('use:native'), null, 'Native is already the primary there');
  const forced = mount((() => { const s = vegas({ system: 'vic20', program: 'tile-test' }); s.programs.find((p) => p.id === 'tile-test').primary = 'editor'; return s; })());
  const use = forced.byKey('use:native');
  assert.ok(use, 'a reason that points elsewhere offers the switch');
  forced.click(use);
  assert.deepEqual(forced.messages('selectRuntime').at(-1), { type: 'selectRuntime', program: 'tile-test', runtime: 'native' });
  assert.match(norm(page.byKey('picker:Program')), /3×3 Slot/);
});

test('every control that posts is a real button, and nothing is clickable but buttons and inputs', () => {
  const page = mount(vegas({ program: 'slot5x5', running: RUNNING, history: HISTORY }), { open: { 'inputs:slot5x5': true, 'command:slot5x5': true } });
  for (const el of page.all('[data-action]')) {
    assert.equal(el.tagName, 'BUTTON', `${el.getAttribute('data-action')} should be a button`);
  }
  for (const menu of ['picker:Program', 'picker:Project']) {
    page.click(page.byKey(menu));
    const open = page.all('[data-menu] [data-action]');
    assert.ok(open.length > 0, `${menu} opened`);
    for (const el of open) {
      assert.equal(el.tagName, 'BUTTON', `${el.getAttribute('data-action')} in ${menu} should be a button`);
      assert.ok(el.getAttribute('aria-label') || norm(el), `${el.getAttribute('data-key')} has no name`);
    }
    page.key(page.active(), 'Escape');
  }
});

test('every icon-only button has an accessible name', () => {
  const page = mount(vegas({ program: 'slot5x5', running: RUNNING, history: HISTORY }));
  for (const el of page.all('.ibtn')) {
    assert.ok(el.getAttribute('aria-label') || norm(el), `${el.getAttribute('data-key')} has no name`);
  }
});

test('icons are decoration: hidden from assistive technology', () => {
  const page = mount(vegas());
  for (const icon of page.all('i.codicon')) assert.equal(icon.getAttribute('aria-hidden'), 'true');
});

test('untrusted text is never read as markup', () => {
  const state = vegas();
  state.programs[0].title = '<img src=x onerror=alert(1)>';
  state.programs[0].description = '<b>bold</b>';
  const page = mount(state);
  assert.equal(page.all('img[src="x"]').length, 0);
  assert.match(page.text(), /<img src=x onerror=alert\(1\)>/, 'it is shown as text');
});

test('a state with a project but no programs says so instead of drawing an empty list', () => {
  const state = vegas();
  state.programs = [];
  state.program = null;
  const page = mount(state);
  assert.match(norm(page.one('.none')), /No programs found in this project/);
});

test('narrow and wide are one layout: the markup does not change with width (CSS container queries do the work)', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'launcher.css'), 'utf8');
  assert.match(css, /^\.run \{[^}]*flex-direction: column/m, 'icon over the name over where it opens, at every width');
  assert.match(css, /@container \(max-width: 256px\)[\s\S]*\.runs \.run \{[^}]*padding/, 'narrow only tightens the tile');
  assert.match(css, /container-type: inline-size/);
});

test('the stylesheet uses theme variables, not colours, and respects reduced motion and high contrast', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'launcher.css'), 'utf8');
  assert.doesNotMatch(css.replace(/#fff/g, ''), /#[0-9a-fA-F]{3,8}\b/, 'no hard-coded colours (the QR background is the one white)');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /forced-colors: active/);
  assert.match(css, /\{\{CODICON\}\}/, 'the icon font url is filled in by the view');
});

test('each big run button says where it will open: the editor, the default browser, the emulator binary', () => {
  const page = mount({ ...single({ system: 'vic20' }), host: { editor: 'Cursor', browser: 'Arc' } });
  const where = (id) => page.byKey(`big:main:${id}`);
  assert.equal(where('editor').querySelector('.name').textContent, 'Preview');
  assert.equal(where('editor').querySelector('.where').textContent, 'Cursor');
  assert.equal(where('browser').querySelector('.name').textContent, 'Browser');
  assert.equal(where('browser').querySelector('.where').textContent, 'Arc');
  assert.equal(where('native').querySelector('.name').textContent, 'Emulate');
  assert.equal(where('native').querySelector('.where').textContent, 'xvic', 'the machine\'s own emulator binary');
});

test('a name nobody could find is no second line, not a guess', () => {
  const page = mount({ ...single({ system: 'web' }), host: { editor: 'VS Code', browser: null } });
  assert.equal(page.byKey('big:main:editor').querySelector('.where').textContent, 'VS Code');
  assert.equal(page.byKey('big:main:browser').querySelector('.where'), null);
  assert.equal(page.byKey('big:main:native').querySelector('.where'), null, 'the web has no emulator');
});

// ── the fixed layout ────────────────────────────────────────────────────────
// The panel is three bands and only the middle one scrolls: the pickers, the
// selected program's run tiles and the tools never move, however long the
// list is.

test('the head holds the pickers and the selected program\'s tiles; the program\'s details scroll; the tools are the foot', () => {
  const page = mount(vegas({ program: 'slot5x5' }));
  const bands = Array.from(page.app.children).map((el) => el.className);
  assert.deepEqual(bands, ['hdr', 'body', 'foot']);
  const hdr = page.one('.hdr');
  assert.equal(hdr.querySelectorAll('.strip .picker').length, 2);
  assert.match(norm(hdr.querySelector('[data-key="picker:Program"]')), /5×5 Ways Slot/, 'the tiles sit under the program they run');
  assert.deepEqual(Array.from(hdr.querySelectorAll('.runs .run .name')).map((el) => el.textContent), ['Preview', 'Browser', 'Emulate']);
  assert.ok(page.one('.body .scroll .drawer'), 'the details live in the scrolling pane');
  assert.equal(page.one('.body > .filter'), null, 'no list, so no filter over it');
  assert.deepEqual(Array.from(page.one('.foot').querySelectorAll('[data-key]')).map((el) => el.getAttribute('data-key')), ['tool:studio', 'tool:studioNative', 'tool:doctor', 'tool:details']);
  assert.equal(page.one('.drawer .runs'), null, 'the drawer no longer repeats the tiles');
});

test('the head\'s tiles run the selected program, and picking another moves them', () => {
  const page = mount(vegas({ system: 'vic20' }));
  page.click(page.byKey('big:slot3x3:browser'));
  assert.deepEqual(page.last(), { type: 'run', runtime: 'browser', program: 'slot3x3', system: 'vic20', inputs: {} });
  choose(page, 'slot5x5');
  assert.ok(page.byKey('big:slot5x5:editor'));
  assert.equal(page.byKey('big:slot3x3:editor'), null, 'one set of tiles, for the selected program');
});

test('Programs and Running are two panes of the same middle; the choice is kept across reloads', () => {
  const page = mount(vegas({ running: RUNNING, history: HISTORY }));
  assert.equal(page.all('.run-item').length, 0, 'the running list is not drawn under the programs');
  assert.match(norm(page.byKey('tab:running')), /Running\s*2/);
  assert.ok(page.byKey('tab:running').querySelector('.dot'), 'something is running: the tab says so from the other pane');
  page.click(page.byKey('tab:running'));
  assert.equal(page.byKey('tab:running').getAttribute('aria-selected'), 'true');
  assert.equal(page.all('.run-item').length, 2);
  assert.equal(page.all('.hist-row').length, 2, 'Recent is under Running');
  assert.equal(page.one('.drawer'), null, 'the program\'s details are on the other pane');
  assert.equal(page.state().tab, 'running');
  assert.equal(page.posted.filter((m) => m.type === 'tab').length, 0, 'a pane is the page\'s own business, nothing is posted');
  page.click(page.byKey('tab:programs'));
  assert.equal(page.all('.drawer').length, 1);
});

test('the page never scrolls as a whole: the head and the foot are fixed and the pane between them scrolls', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'launcher.css'), 'utf8');
  assert.match(css, /html, body \{[^}]*height: 100%;[^}]*overflow: hidden/);
  assert.match(css, /#app \{[^}]*display: flex; flex-direction: column/);
  assert.match(css, /\.hdr \{[^}]*flex: none/);
  assert.match(css, /\.hdr \{[^}]*position: relative; z-index: 2/, 'above the pane, so a menu hanging out of the head is never under it');
  assert.match(css, /\.scroll \{ flex: 1; min-height: 0; overflow-y: auto/);
  assert.match(css, /\.foot \{ flex: none/);
  assert.match(css, /html, body \{ margin: 0; padding: 0;/, 'the editor pads a webview body 20px a side; the gutter is the page\'s own');
  assert.match(css, /#app\.plain \{ display: block; overflow-y: auto/, 'loading and empty states are a plain column');
  assert.equal(mount({ phase: 'empty' }).app.className, 'plain');
  // A short view (dragged into the bottom panel, or a head tall with notices)
  // gives the bands up and scrolls as one page, so nothing is clipped.
  assert.match(css, /@media \(max-height: 520px\) \{\s*html, body \{ overflow: auto; \}\s*#app \{ display: block; height: auto; \}/);
});

test('a greyed tile explains itself even from the Running pane: it moves to Programs, where the reason is', () => {
  const page = mount(vegas({ system: 'vic20', program: 'tile-test' }), { tab: 'running' });
  assert.equal(page.one('.reason'), null, 'no drawer on this pane');
  page.click(page.byKey('big:tile-test:editor'));
  assert.equal(page.byKey('tab:programs').getAttribute('aria-selected'), 'true');
  assert.equal(page.document.activeElement.getAttribute('data-key'), 'reason:tile-test');
  assert.equal(page.state().tab, 'programs');
});

test('the Running pane with nothing running says so, and still lists Recent', () => {
  const page = mount(vegas({ history: HISTORY }), { tab: 'running' });
  assert.match(norm(page.one('.scroll')), /Nothing is running\. Run a program and it shows up here\./);
  assert.equal(page.all('.hist-row').length, 2);
  assert.equal(page.byKey('tab:running').querySelector('.dot'), null, 'no dot when nothing runs');
});
