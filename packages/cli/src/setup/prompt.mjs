// Interactive input for `8bs setup`. Line-based (a filesystem path, unlike
// doctor.mjs's single-keypress install offer) so a pasted path with spaces
// reads back correctly.
import { createInterface } from 'node:readline/promises';

export async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question, { defaultValue = false } = {}) {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await promptLine(`${question} [${suffix}] `)).toLowerCase();
  if (!answer) return defaultValue;
  return answer.startsWith('y');
}

/** Both ends of the terminal have to be interactive — stdin AND stdout — for
 * a prompt to have anywhere to go; a `8bs setup mega65` run piped into a log
 * file, or invoked from CI, must never block waiting on input that will
 * never arrive. Mirrors doctor.mjs's own canPromptInteractively(). */
export function canPromptInteractively() {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}
