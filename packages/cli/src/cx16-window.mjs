// Commander X16 window behavior for `8bs run` / `8bs boot`: x16emu's
// `-capture` (mouse/keyboard grab) and `-fullscreen`. The stock catalog
// deliberately omits both so a terminal launch keeps the pointer free for
// the editor; the VS Code extension opts in via `--capture-mouse` and
// `--fullscreen` (see editors/vscode settings).

/**
 * @param {string[]} args
 * @returns {{ ok: true, captureMouse: boolean|null, fullscreen: boolean|null, consumed: Set<number> } | { ok: false, error: string }}
 */
export function cx16WindowArgs(args) {
  const consumed = new Set();
  let captureMouse = null;
  let fullscreen = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--capture-mouse') {
      if (captureMouse !== null) return { ok: false, error: '--capture-mouse and --no-capture-mouse cannot both be set' };
      captureMouse = true;
      consumed.add(i);
    } else if (arg === '--no-capture-mouse') {
      if (captureMouse !== null) return { ok: false, error: '--capture-mouse and --no-capture-mouse cannot both be set' };
      captureMouse = false;
      consumed.add(i);
    } else if (arg === '--fullscreen') {
      if (fullscreen !== null) return { ok: false, error: '--fullscreen and --no-fullscreen cannot both be set' };
      fullscreen = true;
      consumed.add(i);
    } else if (arg === '--no-fullscreen') {
      if (fullscreen !== null) return { ok: false, error: '--fullscreen and --no-fullscreen cannot both be set' };
      fullscreen = false;
      consumed.add(i);
    }
  }
  return { ok: true, captureMouse, fullscreen, consumed };
}

/**
 * Merge launch flags into an x16emu argv list. Omitted options leave the
 * list unchanged (stock catalog: no `-capture`, windowed).
 *
 * @param {string[]} emulatorArgs
 * @param {{ captureMouse: boolean|null, fullscreen: boolean|null }} options
 * @returns {string[]}
 */
export function applyCx16WindowFlags(emulatorArgs, { captureMouse, fullscreen }) {
  let next = [...emulatorArgs];
  if (captureMouse === true && !next.includes('-capture')) next.push('-capture');
  if (captureMouse === false) next = next.filter((a) => a !== '-capture');
  if (fullscreen === true && !next.includes('-fullscreen')) next.push('-fullscreen');
  if (fullscreen === false) next = next.filter((a) => a !== '-fullscreen');
  return next;
}

export const CX16_WINDOW_USAGE = '                 [--capture-mouse] [--no-capture-mouse]  cx16 only: x16emu mouse grab (default: free)\n'
  + '                 [--fullscreen] [--no-fullscreen]     cx16 only: start fullscreen (default: windowed)\n';
