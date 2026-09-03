// Shared step-reporting for `8bs setup <target>` — one line per step, in the
// spirit of doctor.mjs's own `ok`/`FAIL`/`warn` markers but reused across
// setup targets rather than tied to doctor's specific check shape.
const MARK = { ok: '  ok', running: '  ..', attn: '  !!' };

export function reportStep(status, label, detail = '') {
  const mark = MARK[status] ?? '  ??';
  process.stdout.write(`${mark}  ${label.padEnd(14)} ${detail}\n`);
}

export function reportLine(text = '') {
  process.stdout.write(`${text}\n`);
}
