---
"@8bitscript/compiler": minor
---

8BX composition is conditional the ordinary way: `{cond ? <A /> : <B />}`
and `{cond && <A />}` between tags, and `return (<…/>)` in a component
body, elaborate to an `if` with a composition in each arm. A compile-time
test — `Video.SPRITES > 0` — is a constant `if`, and the arm that cannot
run leaves the program, component and all: on a machine without sprites
the sprite arm costs nothing (measured). An element where a value is
expected is refused (`8BS2024`), and a `{…}` child that is not a
composition is, for now, too (`8BS2023`).
