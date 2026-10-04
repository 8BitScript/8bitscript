// `8bs <command> --help` / `-h`: print that command's own block of the usage
// text and exit 0, before the command is dispatched. bin/8bs.mjs used to
// forward every argument after the command to the command's handler, so
// `8bs run pet --help` treated `--help` as an unknown flag, went on to build,
// and opened the emulator.

/** Whether the arguments after a command ask for its help. */
export function wantsHelp(args) {
  return args.some((arg) => arg === '--help' || arg === '-h');
}

/**
 * The lines of `usageText` that belong to `command`: every block that starts
 * with the command name at two spaces of indent (`build` has two), together
 * with the option and description lines under it. A block ends at the next
 * command line, a blank line, or an unindented line (a section heading).
 * Null when the usage text has no block for the command.
 *
 * @param {string} command
 * @param {string} usageText
 * @returns {string | null}
 */
export function usageFor(command, usageText) {
  const out = [];
  let inside = false;
  for (const line of usageText.split('\n')) {
    const head = /^ {2}([a-z][a-z0-9-]*)\b/.exec(line);
    if (head) inside = head[1] === command;
    else if (line === '' || /^\S/.test(line)) inside = false;
    if (inside) out.push(line);
  }
  return out.length > 0 ? `Usage: 8bs ${command}\n\n${out.join('\n')}\n` : null;
}

/**
 * What `8bs <command> ...args` prints when `args` ask for help, or null when
 * they do not (so the command runs as usual). A command with no block of its
 * own gets the whole usage text.
 *
 * @param {string | undefined} command
 * @param {string[]} args
 * @param {string} usageText
 * @returns {string | null}
 */
export function helpFor(command, args, usageText) {
  if (!command || command.startsWith('-') || !wantsHelp(args)) return null;
  return usageFor(command, usageText) ?? usageText;
}
