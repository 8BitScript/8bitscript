---
"@8bitscript/pet": patch
---

The PET's keyboard is its own hardware option, and the 3032B and 4032B are profiles you can build for.

Those two machines are a business keyboard on a 40-column board, and that combination is exactly what the old arrangement could not express. A model's tag chooses *every* twin carrying it, and `8032` carried two: `keys.pet.8032.8bs`, the business key matrix, and `geometry.pet.8032.8bs`, eighty columns. A 4032B needs the first and must not have the second, so it could not simply borrow the 8032's tag — and giving it a tag of its own would have meant a second copy of a hundred-line key table, which is the one thing a table like that must never have.

So the keyboard is the fourth axis, beside `model`, `ram` and `speaker`, the way `packages/pet/AGENTS.md` already describes those three: `keyboard: graphics | business`. `keys.pet.8032.8bs` becomes `keys.pet.business.8bs`, named for the thing it is rather than for one machine that has it, and `video.bootsInTextMode` moves onto the business value, where it belongs — it is the business *editor ROM* that boots in lower-case text, which is why the 8032, 4032B and 3032B all do and the 4032 does not.

The keyboard value carries no `build`. That is deliberate and load-bearing: a build value becomes a word in the artifact's filename, and `main-pet-8032-32` is already sixteen bytes — CBM DOS's entire directory entry. A fourth word would have made the 8032 unbuildable under any ordinary program name. A tag without a build chooses the twin and stays out of the name.

`--profile 8032` means what it always did: the preset now pins `keyboard: business` alongside its model, RAM and speaker. Three profiles are new — `3032B`, `4032B`, and the `business` keyboard on its own — and `xpet` is told with `-model 3032B` / `-model 4032B`, which are VICE's own names for them. `--hardware model=8032` without the profile now gets the graphics matrix and `video.bootsInTextMode: false`, since the keyboard is a separate choice and the fact belongs to it. That is the honest consequence of decoupling two things that were welded together, and the presets are, as ever, how a whole real machine is named: `--profile 8032` sets both.

One property this shares with every other catalog and does not introduce: an option that carries a tag but no `build` changes what is compiled without changing the artifact's name. Every C64 option is already of that kind — a build with a 512K REU and one without are the same filename and different bytes, because `memory.bankedKib` folds into the program. `checkArtifactCollisions` only refuses two *different* names that truncate together, so this case is not new and is not caught; it is what naming artifacts after build values alone means.

Resolved: `--profile 4032B` is 40 columns, business keyboard, boots in text mode, `-model 4032B -ramsize 32`. `--profile 8032` is 80 columns and business, unchanged.
