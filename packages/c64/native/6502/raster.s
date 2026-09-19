; @8bitscript/c64 — the CPU's vectors, and the raster interrupt's handler.
;
; Linked into every C64 program through this package's "8bitscript".native
; list (package.json; docs/packages.md). Five pieces, in their own
; sections so the linker keeps only what a program reaches:
;
;   .init.250            runs before main() in every program: points the
;                        NMI vector at $FFFA at a bare rti in program text
;                        (RESTORE does nothing), writes a bare rti at $FD
;                        and points the IRQ vector at $FFFE at THAT — page
;                        zero, for the VIC's sake (below).
;   __8bs_c64_raster_install   called (jsr, from raster.8bs's enable())
;                        to route the IRQ to the handler: `jmp` to it at
;                        $FD-$FF, the vector still $00FD. Dropped from a
;                        program that never enables the interrupt, and the
;                        handler with it: a program that does not import
;                        @8bitscript/c64/raster carries the vector stub only.
;   __8bs_c64_raster_swap  makes a committed list the live one (the
;                        handler at the end of each pass, and install).
;   __8bs_c64_raster_restore  writes the live page's frame table — the
;                        eight sprites' registers for the next frame — if
;                        it has one (the same two callers).
;   __8bs_c64_raster_irq  the handler: a list of (line, address, value)
;                        entries, applied at their raster lines.
;
; ---- why the IRQ goes through page zero ---------------------------------
;
; The picture is in VIC bank 3 ($C000-$FFFF; geometry.8bs). Whenever the
; VIC is in its idle state — above the first text row and below the last,
; the gap a YSCROLL other than 3 opens, an opened vertical border — it
; fetches its graphics from the last byte of its bank, $3FFF ($39FF with
; ECM set) — in bank 3, $FFFF, which is the high byte of the 6510's IRQ
; vector, and draws that byte's bits as black pixels over the background
; color, eight per cell across the line. With the handler in program RAM
; the vector's page number is on screen: a handler at $0Axx drew
; `....#.#.` down the gap under x64sc (packages/c64/AGENTS.md, "Idle
; graphics and the ghost byte"). So the IRQ target is in page zero —
; $FD-$FF, which the compiler leaves out of its zero-page budget for this
; (packages/compiler/src/mos/index.ts, C64_ZP_BUDGET) — and $FFFF is 0:
; idle graphics are transparent in every C64 program, at the cost of three
; cycles' `jmp` per interrupt. The ECM byte, $F9FF, is plain RAM (the pad
; byte of sprite block 231) and @8bitscript/c64/idle sets it to draw a
; chosen pattern instead, in the lines a program has put ECM on.
;
; ---- the list -------------------------------------------------------------
;
; Two pages, so a program builds the next frame's list while the handler
; applies this frame's — a rebuild takes tens of raster lines, and the
; entries at the top of the frame (an opened border's sprites, the $D011
; restore at line 50) would be applied from a half-built list otherwise:
;
; $0200-$02FB  page A: up to 63 entries of 4 bytes — raster line (0-255),
;              address low, address high, value — in ascending line
;              order; entries on one line are applied together, first to
;              last.
; $0300-$03FB  page B, the same shape.
; $02FC        end of the live list: its entries times 4 (an index limit).
; $02FD        the index (times 4) of the next entry to apply.
; $02FE        the line of the entry just applied (the handler's own).
; $02FF        the live page: $02 or $03.
; $03FC        the committed page, $02 or $03, or 0 for none: raster.8bs's
;              commit() writes $03FD then this; the swap below reads them
;              and clears this. One byte, so the hand-over is atomic.
; $03FD        the committed list's end.
; $03FE        1 between the pass's end at 255 and line 0: the next
;              interrupt writes the frame table, not an entry.
; $03FF        @8bitscript/c64/reu's probe byte.
; $0400-$0422  page A's FRAME TABLE, $0500-$0522 page B's: the eight
;              sprites' registers as the next frame starts — 16 bytes
;              for $D000-$D00F, then $D010, $D015, the eight pointers
;              ($E3F8-$E3FF) and the eight colors ($D027-$D02E) — and a
;              flag byte at +34 that says whether to write them (0: no).
;              Written by the handler at line 0 of every frame, from the
;              page the pass's end at 255 made live: a multiplexer's list
;              moves the eight down the frame, and this puts them back
;              for the top of the next one — never a frame apart from the
;              list, since the swap and this are one pass's end.
; $0600-$06FF  the sprite multiplexer's page (multiplex.s maps it):
;              its virtual sprites, the list's build state at $06C0
;              while its update runs, its scratch.
;
; raster.8bs owns the same numbers. The KERNAL's tables at $0200-$03FF and
; its screen at $0400-$07FF are dead once the program owns the machine
; (the picture is at $E000), and the compiler's linker places nothing there
; (a program is $0801 up; its zero-page budget is $02-$FC).
;
; ---- the handler ------------------------------------------------------------
;
; On the raster interrupt: acknowledge it, apply every entry from the
; current index whose line equals the first one's — or whose line the
; raster has already reached or passed (a late entry is applied at once
; rather than a frame later: an interrupt that lands on a bad line, or
; behind a long window under I/O, or behind another entry's own cost,
; catches up instead of arming a compare the raster is past) — set the
; raster compare to the next entry's line, and if the raster reached that
; line while it was being set (Bauer's §3.12 tests the compare once, in
; cycle 0 of a line; whether a write in the line itself fires is not
; stated), apply it now unless $D019 shows the compare did fire — return.
; Past the end: arm line 255 (or, at or past it already, go on at once),
; and there take a committed list if there is one and arm line 0 with
; $03FE set; at line 0 — vertical blanking, on every C64 — write the live
; page's frame table if it is flagged and arm the first entry's line
; through the same late check as any other (the table takes ~420 cycles,
; so the raster is at line 6 or 7 by then: an entry on a line under that
; is applied at once, invisibly). So a pass always ends at line 255,
; whatever the last entry's line: a list committed before 255 is live
; from the next frame, and the sprite registers a list moved are put back
; at the top of the next one — after a sprite in an opened lower border
; (Y above 234) has drawn its last row, which is why the table is not
; written at 255 (it was, and a sprite reused there jumped to its next
; frame's X for its last three rows). The store goes through its own operand
; (self-modifying code: the program is in RAM) and the page byte of every
; list access is patched at a swap, so no zero page is touched but the
; three bytes of trampoline at $FD, and no register but $D011 (read),
; $D012 and $D019 besides the entries' own. A and X are saved; Y is not
; used.
;
; Cost, from the interrupt: up to 6 cycles finishing the instruction
; under way, 7 for the interrupt sequence, 3 for the jmp at $FD, then 48
; to the first entry's store — so the first write lands 58-64 cycles into
; the line, i.e. in its right border (the display window ends at cycle
; ~57): an entry at line L takes effect from line L+1's left edge, which
; is what "the border color changes at line L" looks like on screen. Each
; further entry on the line lands 25 cycles after the one before, and a
; bad line (every eighth inside the picture) holds the CPU for ~43 of
; them. The whole interrupt is about 100 cycles plus 25 an entry, the
; pass's end at 255 another ~100, and line 0 ~60 plus ~420 for a frame
; table, out of a frame's 17000-19000.
;
; Interrupt sources: only the VIC's raster compare. raster.8bs clears both
; CIAs' interrupt masks before the first cli, so nothing else reaches
; this handler — the KERNAL's timer would, and the acknowledge here is
; $D019's alone.

.section .init.250,"ax",@progbits
    lda #<__8bs_c64_rti
    sta 0xFFFA              ; NMI: the rti in program text (RESTORE does nothing)
    lda #>__8bs_c64_rti
    sta 0xFFFB
    lda #0x40               ; rti, at $FD: the IRQ target until raster.enable()
    sta 0x00FD
    lda #0xFD
    sta 0xFFFE              ; IRQ: page zero, so the VIC's idle byte $FFFF ...
    lda #0
    sta 0xFFFF              ; ... is 0 and idle graphics are transparent

.section .text.__8bs_c64_rti,"ax",@progbits
.global __8bs_c64_rti
__8bs_c64_rti:
    rti

; Take the committed list, if any: its page into every list access's
; operand and $02FF, its page + 2 into every frame-table access's, its end
; into $02FC; then the index to 0. A is clobbered — the handler has saved
; it, and install saves it.
.section .text.__8bs_c64_raster_swap,"ax",@progbits
.global __8bs_c64_raster_swap
__8bs_c64_raster_swap:
    lda 0x03FC
    beq __8bs_c64_raster_swap_done
    sta 0x02FF
    sta __8bs_c64_raster_lo+2
    sta __8bs_c64_raster_hi+2
    sta __8bs_c64_raster_val+2
    sta __8bs_c64_raster_line+2
    sta __8bs_c64_raster_next+2
    sta __8bs_c64_raster_first+2
    clc
    adc #2                  ; the page's frame table: $04 for A, $05 for B
    sta __8bs_c64_raster_table_flag+2
    sta __8bs_c64_raster_table_pos+2
    sta __8bs_c64_raster_table_xhi+2
    sta __8bs_c64_raster_table_en+2
    sta __8bs_c64_raster_table_ptr+2
    sta __8bs_c64_raster_table_col+2
    lda 0x03FD
    sta 0x02FC
    lda #0
    sta 0x03FC
__8bs_c64_raster_swap_done:
    lda #0
    sta 0x02FD
    rts

; The live page's frame table into the sprite registers, if its flag is
; set: 16 position bytes, X-high, enable, eight pointers, eight colors.
; About 420 cycles. A and X are clobbered.
.section .text.__8bs_c64_raster_restore,"ax",@progbits
.global __8bs_c64_raster_restore
__8bs_c64_raster_restore:
__8bs_c64_raster_table_flag:
    lda 0x0422              ; the page byte of these six is patched by the swap
    beq __8bs_c64_raster_restore_done
    ldx #15
__8bs_c64_raster_restore_pos:
__8bs_c64_raster_table_pos:
    lda 0x0400,x
    sta 0xD000,x
    dex
    bpl __8bs_c64_raster_restore_pos
__8bs_c64_raster_table_xhi:
    lda 0x0410
    sta 0xD010
__8bs_c64_raster_table_en:
    lda 0x0411
    sta 0xD015
    ldx #7
__8bs_c64_raster_restore_each:
__8bs_c64_raster_table_ptr:
    lda 0x0412,x
    sta 0xE3F8,x
__8bs_c64_raster_table_col:
    lda 0x041A,x
    sta 0xD027,x
    dex
    bpl __8bs_c64_raster_restore_each
__8bs_c64_raster_restore_done:
    rts

.section .text.__8bs_c64_raster_install,"ax",@progbits
.global __8bs_c64_raster_install
__8bs_c64_raster_install:
    pha
    lda #0x4C               ; jmp __8bs_c64_raster_irq, at $FD-$FF
    sta 0x00FD
    lda #<__8bs_c64_raster_irq
    sta 0x00FE
    lda #>__8bs_c64_raster_irq
    sta 0x00FF
    lda #0xFD               ; the IRQ vector at it (as .init.250 left it)
    sta 0xFFFE
    lda #0
    sta 0xFFFF
    sta 0x03FE              ; no line-0 phase pending (RAM is not zero under VICE)
    txa
    pha
    jsr __8bs_c64_raster_swap   ; the committed list is live at once
    jsr __8bs_c64_raster_restore   ; and its frame table, if it has one
    pla
    tax
    pla
    rts

.section .text.__8bs_c64_raster_irq,"ax",@progbits
.global __8bs_c64_raster_irq
__8bs_c64_raster_irq:
    pha
    txa
    pha
    lda #0x01
    sta 0xD019              ; acknowledge the raster interrupt
    lda 0x03FE
    bne __8bs_c64_raster_top     ; line 0: the frame table, then the first entry
    ldx 0x02FD
__8bs_c64_raster_apply:
    cpx 0x02FC
    bcs __8bs_c64_raster_wrap
__8bs_c64_raster_lo:
    lda 0x0201,x            ; the page byte of these six is patched by the swap
    sta __8bs_c64_raster_store+1
__8bs_c64_raster_hi:
    lda 0x0202,x
    sta __8bs_c64_raster_store+2
__8bs_c64_raster_val:
    lda 0x0203,x
__8bs_c64_raster_store:
    sta 0xFFFF              ; the operand is rewritten above
__8bs_c64_raster_line:
    lda 0x0200,x
    sta 0x02FE
    inx
    inx
    inx
    inx
    cpx 0x02FC
    bcs __8bs_c64_raster_wrap
__8bs_c64_raster_next:
    lda 0x0200,x            ; the next entry's line
    cmp 0x02FE
    beq __8bs_c64_raster_apply   ; on this line too
    bit 0xD011
    bmi __8bs_c64_raster_arm     ; raster 256 and up: nothing is late
    cmp 0xD012
    beq __8bs_c64_raster_apply   ; the raster is on its line: now
    bcc __8bs_c64_raster_apply   ; or past it: now, late
__8bs_c64_raster_arm:
    sta 0xD012
    stx 0x02FD
    bit 0xD011
    bmi __8bs_c64_raster_done
    cmp 0xD012
    bcc __8bs_c64_raster_apply   ; the raster passed the line while arming: now
    bne __8bs_c64_raster_done    ; still ahead of it: the compare will fire
    lda 0xD019
    and #0x01
    bne __8bs_c64_raster_done    ; on its line, and the compare fired: after rti
    beq __8bs_c64_raster_apply   ; on its line, and it did not: now
__8bs_c64_raster_done:
    pla
    tax
    pla
    rti
__8bs_c64_raster_wrap:
    bit 0xD011
    bmi __8bs_c64_raster_end     ; raster 256 and up: the pass ends now
    lda 0xD012
    cmp #0xFF
    bcs __8bs_c64_raster_end     ; on 255: now
    lda #0xFF
    jmp __8bs_c64_raster_arm     ; else at 255, with the same race check
__8bs_c64_raster_end:
    jsr __8bs_c64_raster_swap
    lda #0x01
    sta 0x03FE              ; the next interrupt is line 0's
    lda #0
    sta 0xD012
    pla
    tax
    pla
    rti
__8bs_c64_raster_top:
    lda #0
    sta 0x03FE
    jsr __8bs_c64_raster_restore   ; ~420 cycles: the raster is at line 6-7 after
    ldx #0
__8bs_c64_raster_first:
    lda 0x0200              ; the first entry's line, this frame
    jmp __8bs_c64_raster_arm     ; already on or past it: applied now
