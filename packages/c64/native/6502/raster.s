; @8bitscript/c64 — the CPU's vectors, and the raster interrupt's handler.
;
; Linked into every C64 program through this package's "8bitscript".native
; list (package.json; docs/packages.md). Three pieces, in their own
; sections so the linker keeps only what a program reaches:
;
;   .init.250            runs before main() in every program: points the
;                        NMI and IRQ vectors at $FFFA/$FFFE — RAM under
;                        the KERNAL ROM, which @8bitscript/c64's
;                        setupVideo() banks out for good — at a bare rti,
;                        so RESTORE does nothing and a stray IRQ returns.
;   __8bs_c64_raster_install   called (jsr, from raster.8bs's enable())
;                        to move the IRQ vector to the handler. Dropped
;                        from a program that never enables the interrupt,
;                        and the handler with it: a program that does not
;                        import @8bitscript/c64/raster carries the vector
;                        stub only.
;   __8bs_c64_raster_irq  the handler: a list of (line, address, value)
;                        entries at $0200, applied at their raster lines.
;
; ---- the list -------------------------------------------------------------
;
; $0200-$02FB  up to 63 entries of 4 bytes: raster line (0-255), address
;              low, address high, value. In ascending line order; entries
;              on one line are applied together, first to last.
; $0300        end: the number of entries times 4 (an index limit).
; $0301        the index (times 4) of the next entry to apply.
; $0302        the line of the entry just applied (the handler's own).
;
; raster.8bs owns the same numbers (RasterList.*). The KERNAL's tables at
; $0200-$03FF are dead once the program owns the machine, and nothing in
; the SDK's link scripts (link.ld, commodore.ld) claims them; the REU
; probe's byte is at $033C, above all of this.
;
; ---- the handler ------------------------------------------------------------
;
; On the raster interrupt: acknowledge it, apply every entry from the
; current index whose line equals the first one's, set the raster compare
; to the next entry's line (or the first entry's, past the end — which is
; a lower line, so it fires next frame), return. The store goes through
; its own operand (self-modifying code: the program is in RAM), so no zero
; page is touched — the compiler owns $02-$8F, and the handler must not.
; A and X are saved; Y is not used. Cost: about 30 cycles before the first
; store and 25 per entry, plus the up-to-7-cycle wait for the instruction
; the interrupt lands in — the write lands a few cycles into the line, in
; the border with lines chosen so, in the picture otherwise.
;
; Interrupt sources: only the VIC's raster compare. raster.8bs clears both
; CIAs' interrupt masks before the first cli, so nothing else reaches
; this handler — the KERNAL's timer would, and the acknowledge here is
; $D019's alone.

.section .init.250,"ax",@progbits
    lda #<__8bs_c64_rti
    sta 0xFFFA
    sta 0xFFFE
    lda #>__8bs_c64_rti
    sta 0xFFFB
    sta 0xFFFF

.section .text.__8bs_c64_rti,"ax",@progbits
.global __8bs_c64_rti
__8bs_c64_rti:
    rti

.section .text.__8bs_c64_raster_install,"ax",@progbits
.global __8bs_c64_raster_install
__8bs_c64_raster_install:
    pha
    lda #<__8bs_c64_raster_irq
    sta 0xFFFE
    lda #>__8bs_c64_raster_irq
    sta 0xFFFF
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
    ldx 0x0301
__8bs_c64_raster_apply:
    cpx 0x0300
    bcs __8bs_c64_raster_wrap
    lda 0x0201,x
    sta __8bs_c64_raster_store+1
    lda 0x0202,x
    sta __8bs_c64_raster_store+2
    lda 0x0203,x
__8bs_c64_raster_store:
    sta 0xFFFF              ; the operand is rewritten above
    lda 0x0200,x
    sta 0x0302
    inx
    inx
    inx
    inx
    cpx 0x0300
    bcs __8bs_c64_raster_wrap
    lda 0x0200,x
    cmp 0x0302
    beq __8bs_c64_raster_apply   ; the next entry is on this line too
    sta 0xD012
    stx 0x0301
    pla
    tax
    pla
    rti
__8bs_c64_raster_wrap:
    ldx #0
    stx 0x0301
    lda 0x0200
    sta 0xD012
    pla
    tax
    pla
    rti
