# @8bitscript/timeline

Frame-counted cues for 8BitScript programs — at frame 120 the logo drops,
at 300 the bars start — the same pure code on every target. A counter the
program ticks once a frame, and predicates that fold against literal
frame numbers, so a showcase is a sequence rather than a loop:

```bash
pnpm add @8bitscript/timeline
```

```
import { timeline } from "@8bitscript/timeline";

timeline.start();                   // frame 0 is now
while (true) {
    waitFrame();
    timeline.tick();                // once a frame, first thing
    if (timeline.at(120)) { ... }   // exactly once, on frame 120
    if (timeline.after(300)) { ... }
    if (timeline.every(8)) { ... }  // frames 0, 8, 16, ...
}
```

| Call | What it does |
| --- | --- |
| `start()` | Frame 0 is now |
| `tick()` | One frame has passed — once per `waitFrame()` |
| `frame()` | Frames since `start()`, usmallint |
| `at(f)` | True on exactly that frame |
| `after(f)` | True from that frame on |
| `between(a, b)` | True on frames `a` up to, not including, `b` |
| `every(n)` | True once every `n` frames — exact for `n` dividing 256, off by a beat at the wrap otherwise (`%` is 8-bit on the 6502 targets) |

In `.8bx` a cue is the conditional the language already has —
`{timeline.at(120) && <Logo />}` — not a wrapper component: a slotted
component runs its children unconditionally between its two halves and
could not gate anything. A frame is one `tick()`: whatever the machine's
own frame sync decided a frame is. [`examples/swarm`](../examples/swarm)'s
`Scene.8bx` is a part list written this way; the design is
[docs/project/frame.md](../../docs/project/frame.md).
