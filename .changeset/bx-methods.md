---
"@8bitscript/compiler": minor
---

8BX components have methods: a `function` at the top of a component body
works on the instance's own state and is instanced with it — `damage(5)`
inside one `<Player />` touches that player's health and nobody else's —
and inlines away like the rest when its arguments are compile-time. A
method sees state, not props: naming a prop in one is `8BS2025`, with the
fix (pass it as an argument). Nothing outside the component can call a
method yet, since a static instance has no name to call it on.
