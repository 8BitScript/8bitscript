---
"@8bitscript/cli": patch
---

A release's assets are now one file per thing you can actually run. The attach step uploaded `dist/**/*` flattened, which scattered the web bundle's own internals across the release listing: `index.html`, `worker.js`, a Cloudflare `_headers` file, and a `program.wasm` that was a byte-for-byte copy of the `main.wasm` listed above it. The machine artifacts now upload as themselves and the web bundle uploads as a single `web-bundle.zip`, which is the only form it works in — its four files are one deployable unit, useless apart. The loose `.wasm` is left out for the same reason: it is already in the bundle, and alone it has no runtime to load it.

`8bs build` also now says when an artifact's name is longer than the medium it is meant for can hold. CBM DOS gives a directory entry exactly sixteen characters for a filename and truncates anything longer with no error at all (measured with `c1541` on a real D64: a twenty-character name came back sixteen), so two builds whose names differ only past the sixteenth character are one file once they reach a floppy. It is a note rather than a refusal — every part of a generated name is there because it can change the bytes, so the build is valid, just awkward to carry to a disk.
