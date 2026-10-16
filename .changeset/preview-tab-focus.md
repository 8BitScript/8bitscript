---
"8bitscript-lang": patch
---

**The Preview tab gives the program the keyboard.** A machine in the editor's tab runs in a cross-origin frame, and its keys reach it only while that frame has focus. A freshly opened tab, and a click on Reset or Rebuild, left focus on the page around it, so a PET or C64 program's arrow keys did nothing until someone thought to click the screen. The tab now hands focus to the frame whenever it loads, whenever the tab's page gains focus, and whenever the tab is brought forward.
