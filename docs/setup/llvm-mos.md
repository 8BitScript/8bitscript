---
title: LLVM-MOS
nav_order: 3
---

# LLVM-MOS

LLVM-MOS is an LLVM backend that targets the MOS 6502 and its relatives. It is
the piece of the toolchain that turns 8BitScript's machine-independent output
into real 6502 machine code, and 8BitScript delegates the whole of that job to
it rather than writing a code generator of its own.

That delegation buys a great deal. LLVM-MOS handles register allocation across
the 6502's three awkward registers — `A`, `X`, and `Y` — where a conventional
allocator expects a dozen interchangeable ones. It performs whole-program
zero-page allocation, treating the fast first page of memory as a pool of
pseudo-registers and handing it out across the entire program rather than one
function at a time. It implements the calling convention, including the
static-stack optimisation that gives functions fixed storage instead of pushing
frames onto the hardware stack, which on a 256-byte stack matters enormously. It
runs link-time optimisation over the result, assembles the output, and packages
it into a loadable Commodore executable.

Reimplementing any one of those well is a multi-year project. Reimplementing all
of them is the reason 8BitScript does not ship its own 6502 code generator: the
compiler's job is to produce good machine-independent code and let LLVM-MOS do
what it already does better.

## Download the SDK

Install the official prebuilt SDK archives from the
[llvm-mos/llvm-mos-sdk releases](https://github.com/llvm-mos/llvm-mos-sdk/releases)
page. Take the archive that matches your host:

| Host  | Archive                |
| ----- | ---------------------- |
| macOS | `llvm-mos-macos.tar.xz` |
| Linux | `llvm-mos-linux.tar.xz` |

Fetching the latest release from the command line, on Linux:

```bash
curl -sLO https://github.com/llvm-mos/llvm-mos-sdk/releases/latest/download/llvm-mos-linux.tar.xz
```

and on macOS:

```bash
curl -sLO https://github.com/llvm-mos/llvm-mos-sdk/releases/latest/download/llvm-mos-macos.tar.xz
```

The `latest/download` path always resolves to the newest release, so neither
command needs updating when a new SDK ships.

Do not build LLVM-MOS from source. A source build is a full LLVM build — hours
of compilation and several gigabytes of disk — and produces nothing the
prebuilt archive does not already give you. The prebuilt SDKs are the supported
installation route.

### macOS

Downloaded archives carry a quarantine attribute, and macOS refuses to run the
binaries extracted from a quarantined archive. Strip it *before* extracting:

```bash
xattr -d com.apple.quarantine llvm-mos-macos.tar.xz
```

Skip that step and the extraction itself will appear to succeed, but the first
attempt to run a tool from the SDK fails — Gatekeeper reports that the binary
"cannot be opened because the developer cannot be verified", or the shell simply
reports the process as `killed`. Neither message points at quarantine, which is
what makes this failure worth heading off rather than diagnosing.

### Install

The remaining steps are the same on macOS and Linux. Create a home for the SDK
and extract into it:

```bash
mkdir -p "$HOME/.local/opt/llvm-mos"
tar -xJf llvm-mos-macos.tar.xz -C "$HOME/.local/opt/llvm-mos" --strip-components=1
```

On Linux, substitute `llvm-mos-linux.tar.xz` for the archive name.

Then record the install location where every shell will see it — including
the non-interactive ones an editor starts to run a task. That is `~/.zshenv`
where zsh is the default shell (macOS, and Linux hosts set up for zsh), and
`~/.profile` on a bash Linux host:

```bash
export LLVM_MOS_HOME="$HOME/.local/opt/llvm-mos"
```

Not `~/.zshrc` or `~/.bashrc`: those are read by interactive shells only, so a
variable exported there works at the prompt and is invisible to `8bs doctor`
when an editor runs it as a task. (The VS Code extension papers over this by
looking in the install location above when the variable is missing, and has an
`8bitscript.llvmMosHome` setting for an SDK kept elsewhere; other editors do
not.) Open a new shell — or `source` the file in the current one — and confirm
the variable points where you expect:

```bash
echo "$LLVM_MOS_HOME"
```

> **Do not add `$LLVM_MOS_HOME/bin` to your global `PATH`.**
>
> The SDK ships tools under the ordinary LLVM names — `clang`, `lld`, `llvm-ar`,
> and the rest. If you have a normal LLVM or Clang installed, putting the SDK on
> `PATH` makes those names ambiguous, and which one wins depends on the order of
> your `PATH` entries. The failures that follow are miserable: an unrelated C
> project suddenly compiles for the 6502, or the 6502 build quietly picks up
> host headers. 8BitScript never relies on `PATH` for these tools. It invokes
> them by absolute path through `LLVM_MOS_HOME`, which is exactly why the
> environment variable exists.

## Target drivers

The SDK provides a separate compiler driver per target machine. Each one knows
its machine's memory map, startup code, and executable format, so choosing a
target is a matter of choosing a driver rather than passing a pile of flags.

The Commodore drivers are:

| Driver           | Machine |
| ---------------- | ------- |
| `mos-vic20-clang` | VIC-20  |
| `mos-c64-clang`   | C64     |
| `mos-c128-clang`  | C128    |
| `mos-pet-clang`   | PET     |

The SDK also ships drivers for a much wider family of 6502 machines — the Atari
8-bit line and the 2600, the NES, the Commander X16, the Atari Lynx, and others.
Those are later targets, not current ones. Only `mos-vic20-clang` and
`mos-c64-clang` matter for the early work: the VIC-20 is the primary target and
the C64 is the second, and both need to work before any other machine is worth
discussing.

## Verify

Both Commodore drivers this project cares about should report a version:

```bash
"$LLVM_MOS_HOME/bin/mos-vic20-clang" --version
"$LLVM_MOS_HOME/bin/mos-c64-clang" --version
```

Each prints a clang version banner that identifies itself as an LLVM-MOS build.
The quoting matters — keep the path quoted so it survives a `$HOME` containing a
space.

A version banner does not prove the SDK can build a program, so finish with a
real compile. Write a one-line C program and build it for both machines:

```bash
cat > /tmp/smoke.c <<'SMOKE'
#include <stdio.h>
int main(void) { puts("HELLO FROM 8BITSCRIPT TOOLCHAIN"); return 0; }
SMOKE
"$LLVM_MOS_HOME/bin/mos-vic20-clang" -Os -o /tmp/smoke-vic20.prg /tmp/smoke.c
"$LLVM_MOS_HOME/bin/mos-c64-clang" -Os -o /tmp/smoke-c64.prg /tmp/smoke.c
```

Both commands should complete silently and leave a `.prg` of a couple of
hundred bytes. The first two bytes of a `.prg` are its load address,
little-endian, and each machine has a characteristic one — checking them
confirms the right driver produced the right executable:

```bash
xxd -l 2 /tmp/smoke-vic20.prg
xxd -l 2 /tmp/smoke-c64.prg
```

| File | Expected first bytes | Meaning |
| ---- | -------------------- | ------- |
| `smoke-vic20.prg` | `0112` | Loads at `$1201` — the SDK's own default is a RAM-expanded VIC-20 |
| `smoke-c64.prg` | `0108` | Loads at `$0801`, the C64 BASIC start |

(`8bs build` pins the VIC-20 target to the **unexpanded** machine instead, so
its `.prg` files load at `$1001`. The smoke test above calls the driver
directly and therefore sees the SDK default; both addresses are correct for
what produced them.)

If both addresses match, the compiler, linker, and per-machine startup code are
all in place. Once VICE is installed, the same files double as a first program
to load in the emulator.

## Troubleshooting

**"cannot be opened because the developer cannot be verified", or a `killed`
process.** This is macOS quarantine, and it is the single most common failure
here. The attribute was on the archive and got inherited by everything extracted
from it. Delete the extracted directory, run `xattr -d com.apple.quarantine` on
the `.tar.xz` as described above, and extract again. Clearing quarantine after
the fact is possible but fiddlier than starting over.

**Wrong architecture.** The releases page publishes separate archives per CPU
architecture, and an archive for the wrong one produces binaries that will not
execute. On macOS, Apple Silicon and Intel need different builds; on Linux,
`x86_64` and `aarch64` do. Check what you are running:

```bash
uname -m
```

`arm64` on macOS means Apple Silicon; `x86_64` means Intel. On Linux the same
command reports `x86_64` or `aarch64` directly. Match the archive to that before
re-downloading.

**A nested directory after extraction.** Archives that carry a top-level
directory extract into `llvm-mos/llvm-mos/bin` rather than `llvm-mos/bin` if the
`--strip-components=1` flag above is omitted or does not apply to that release's
layout. `LLVM_MOS_HOME` must point at the directory that *directly* contains
`bin`, so check what actually landed:

```bash
ls "$LLVM_MOS_HOME/bin"
```

If that lists nothing useful but `ls "$LLVM_MOS_HOME"` shows a single
subdirectory, point `LLVM_MOS_HOME` one level deeper — or move the contents up
one level, which keeps the path in your rc file tidy. Either way, the `ls` above
should list `mos-vic20-clang` among many other tools when it is right.

## Next

With the 6502 compiler in place, install the emulator that will run its output:
[VICE](vice.md).
