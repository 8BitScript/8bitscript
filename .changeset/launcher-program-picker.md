---
"8bitscript-lang": patch
---

The launcher's head has the same shape for every project: the project, then **System**, then **Program**, each on its own row. Before, a project with several programs put Project and System side by side. Several programs are now a **Program** picker instead of a list in the pane below. The picker:

- groups programs by their `group`, or by the folder their entry file is in when the config names none;
- folds every group but the selected program's once a project has more than twelve programs;
- gets a filter, pinned to the top of the menu, at eight or more;
- dims a program the machine can't run and marks a running one.

The pane below shows the selected program's details. Menus open above the pane instead of under it.
