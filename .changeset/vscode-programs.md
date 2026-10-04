---
"8bitscript-lang": minor
---

Run and Build work in a project with several `programs`. The launcher gets an **Entry** dropdown (shown only when a project lists more than one program) that passes `--program <name>` to `8bs run` and `8bs build`; the System list narrows to the machines that program's own `targets` allow; and the choice is remembered per project in the new `8bitscript.program` setting. With a `main` and nothing chosen, `main` runs; with several programs and no `main`, Run asks once and remembers the answer instead of stopping at the CLI's "say which with --program". Tasks: Run Task lists each program on each machine it is set up for, and a `tasks.json` entry can carry `"program"`. A project with one program is unchanged: no dropdown, no flag.
