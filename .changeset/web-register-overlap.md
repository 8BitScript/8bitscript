---
"@8bitscript/web": patch
---

The Modern (resizable) web host's register agreement no longer overlaps
the program's data. Its map is sized for the largest grid the host hands
out, so INPUT_OFFSET is 8196 and the raster list runs to 8392 — and the
wasm backend placed every string literal and const array from a fixed
8192, inside it: a program's first literal sat under the input byte, the
page's input writes corrupted it, and the program read its own string
back as input and as a raster list (2048's "v0.2.0" booted pressing
RIGHT + CONFIRM + CANCEL and rendered as "v0. .0"). The agreement's end
is now a build input: the CLI computes the layout once
(`agreementFor().reservedEnd`), hands it to the backend, and data starts
on the next 256-byte boundary at or above it (8448 on the Modern host).
The fixed skins' agreements end far below the old base, so their images
are byte-identical; a Modern build is the same size, its data addresses
moved.
