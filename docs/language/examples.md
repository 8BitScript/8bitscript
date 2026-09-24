---
title: "Worked examples"
nav_order: 8
---

# Worked examples

## §7.1 hello-bx, end to end

The full example ships at `packages/examples/hello-bx` — see [§0.2](index.md#02-hello-world-both-ways) for the two files. Its PET build is byte-identical to `hello-world`'s: the elaborated call costs exactly what the hand-written `text.print(0, "Hello World!")` would.

## §7.2 2048's Screen.8bx, byte for byte

The first real mixed program: `2048.8bs` is the program and the move logic's driver, `game.8bs` the rules and board, `Screen.8bx` the arrangement of what's on-screen — with no screen address anywhere in it:

*2048 — src/Screen.8bx (trimmed)*

```8bx
import { board, shown, score, over, won, started } from "./game.8bs";
import { drawHud, drawTile, drawTitleScreen } from "./tile.8bs";

export component Title() {
    drawTitleScreen();
}

export component Tiles() {
    for (let i: utinyint = 0; i < 16; i++) {
        if (board[i] != shown[i]) {
            drawTile(i >> 2, i & 3, board[i]);
            shown[i] = board[i];
        }
    }
}

export component Board() {
    drawHud(score, over, won);
    <Tiles />;
}

export component Screen() {
    return (<>{started ? <Board /> : <Title />}</>);
}
```

Measured against the 0.11.0 toolchain, against the same functions this replaced when they were still hand-written calls in `2048.8bs`:

| Build | Before | After |
| --- | --- | --- |
| PET 2001 (4K) | 2763 | 2763 |
| VIC-20 unexpanded | 3490 | 3490 |
| PET 4032, C64, C128, Atari 8-bit, X16, MEGA65 | — | −60 bytes each |

The animated builds get *smaller*: the between-steps repaint and the settled board now share one `<Tiles />`, where the hand-written version kept a second copy of the same loop specifically so the 4K builds wouldn't move.

## §7.3 media-walk, one sprite and one song

The full example ships at `packages/examples/media-walk`. One `.8bg` file names a PNG, one `.8ba` file names a WAV and a two-note pulse song, and `media-walk.8bs` places the sprite and plays both. The compiler adapts per machine and reports the choice (`8BS2111`, `8BS2210`, `8BS2211`). See [portable graphics](../project/graphics.md) and [portable audio](../project/audio.md).
