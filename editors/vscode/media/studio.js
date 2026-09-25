// The Studio tab's page.
//
// A real .js file, for the reason launcher.js records (a `\n` in a
// template literal once became a real newline and emptied every control).
// It keeps no state of the run's: the host posts `{ type: 'state' }` and
// this redraws. The one thing it knows that the host cannot is the mouse
// — the framed emulator page reports its pointer lock here by
// postMessage, because a cross-origin frame's pointerLockElement is not
// readable from outside and the host is further away still.

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

/** The last state the host posted. Null until the first one arrives. */
let state = null;

/**
 * How the emulator was launched, as its page reports (`mode`): with
 * `-capture` a click on the screen takes the mouse; with the stock free
 * launch only the emulator's own grab key does. Null until reported.
 */
let mode = null;

const MOUSE = {
  captured: 'Studio has the mouse — Esc gives it back.',
  refused: 'This tab isn’t allowed to capture the mouse — use Open in browser.',
};

function grabHint() {
  if (mode && !mode.captured) return (mode.grabKey || 'Ctrl+M') + ' on the screen gives it to Studio for exact tracking';
  return 'click the screen to give it to Studio';
}

function mouse(kind) {
  const line = $('mouse');
  line.textContent = kind === 'idle'
    ? 'Your mouse is free — ' + grabHint() + '; Esc gives it back.'
    : kind === 'free'
      ? 'The mouse is yours — ' + grabHint() + '.'
      : MOUSE[kind];
  line.classList.toggle('warn', kind === 'refused');
  line.hidden = !state || state.phase !== 'running';
}

function render() {
  if (!state) return;
  const running = state.phase === 'running';
  const stopped = state.phase === 'stopped';
  $('status').textContent = state.phase === 'building'
    ? 'Building Studio… (the build prints in its terminal)'
    : running
      ? ['Running', state.program != null ? state.program + ' bytes of program' : null, state.emulator].filter(Boolean).join(' · ')
      : 'Stopped';
  $('restart').disabled = !running;
  $('browser').disabled = !running;
  $('stop').disabled = stopped;
  $('rebuild').textContent = stopped ? 'Start Studio' : 'Rebuild';
  const empty = $('empty');
  empty.hidden = running;
  empty.textContent = stopped ? 'Studio is not running.' : 'Studio is being built…';
  if (!running) mouse('idle');
  else if ($('mouse').hidden) mouse('idle');
}

function postMessageOriginAllowed(event) {
  const origin = event.origin;
  if (!origin) return true;
  if (origin === window.location.origin) return true;
  const frame = $('frame');
  const frameUrl = frame?.src || frame?.getAttribute?.('src');
  if (!frameUrl) return false;
  try {
    return origin === new URL(frameUrl, window.location.href).origin;
  } catch {
    return false;
  }
}

window.addEventListener('message', (event) => {
  if (!postMessageOriginAllowed(event)) return;
  const data = event.data;
  if (!data) return;
  const frame = $('frame');
  // The emulator page, and only it: same window as the frame we made.
  if (data.source === '8bs-x16emu' && frame && frame.contentWindow && event.source === frame.contentWindow) {
    if (data.type === 'mode') {
      mode = { captured: Boolean(data.captured), grabKey: typeof data.grabKey === 'string' ? data.grabKey : 'Ctrl+M' };
      mouse('idle');
    }
    if (data.type === 'pointerlock') mouse(data.error ? 'refused' : data.locked ? 'captured' : 'free');
    return;
  }
  if (data.type === 'state') {
    state = data;
    render();
  }
});

$('restart').addEventListener('click', () => {
  // A reload of the frame is a cold boot of the machine with the same build.
  const frame = $('frame');
  const url = frame?.src;
  if (url) {
    frame.src = '';
    frame.src = url;
    mouse('idle');
  }
});
$('rebuild').addEventListener('click', () => vscode.postMessage({ type: 'rebuild' }));
$('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
$('browser').addEventListener('click', () => vscode.postMessage({ type: 'browser' }));

vscode.postMessage({ type: 'ready' });
