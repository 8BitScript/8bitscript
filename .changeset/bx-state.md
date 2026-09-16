---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
"8bitscript-lang": minor
---

8BX components keep state. `state count: utinyint = 0;` at the top of a
component body is storage per static instance: every element — and every
call from `.8bs` — is an instance with its own copy of the function and
its own globals, laid out at compile time and named after the instance
(`__bx_Counter__count__i1`), the template dropped, and a stateless
component that contains a stateful one instanced per site too, so two
`<Pair />` holding a `<Tally />` are four tallies. The two halves of a
slotted component share one instance. Nothing is allocated at run time;
`8bs build --size` lists every instance and the bytes of state it holds.
`state` belongs at the top of a component body, typed, once per name,
unshadowed (`8BS2022`); the initializer is a literal or a const, as for
any global. Component methods and arrays of state are later.
