; @8bitscript/c64 — text.print, text.printNumber and text.fill, in native code.
;
; Linked through this package's "8bitscript".native list beside raster.s
; and multiplex.s, one section a routine, so a program that prints
; strings and never a number carries only the string routine. The
; callers are src/text.8bs's print(), printNumber() and fill(): each
; copies its parameters to page $07 from an asm6502 block that names
; them (`lda cell` / `sta 0x0700` — an asm operand may name the
; function's own frame) and does `jsr`. Everything these routines read
; is at a fixed address in page $07 — the KERNAL's dead screen, as the
; raster list's frame tables are in $04 and $05 and the multiplexer's
; tables in $06 — so nothing here depends on where the compiler placed a
; variable, and no zero page is touched:
;
; $0700-$0701  cell       in: the first cell, 0-999
; $0702        color      in: the current text color (text.setColor)
; $0703        reverse    in: 0, or $80 after text.setReverse(true)
; $0704-$0705  print: the string's address (its length byte, then the
;                       characters — the compiler's own string layout)
;              printNumber: the value
;              fill: how many cells
; $0706        printNumber: the width, in cells
;              fill: the character, ASCII
; $0707-$070A  scratch, these routines' own
;
; The screen is VIC bank 3's matrix at $E000 and color RAM the fixed
; $D800 (src/geometry.8bs), so a cell's two bytes are $E000 + cell and
; $D800 + cell: each routine adds the cell into the operands of its own
; `sta $E000,y` / `sta $D800,y` on entry (the way multiplex.s patches its
; entry stores) and then indexes with Y alone, and the color and the
; reverse bit go into the operands of an immediate load and an `ora` the
; same way — nothing is read from memory inside a loop but the
; character itself. ASCII becomes a screen code as src/text.8bs's
; asciiToScreenCode() says: in the mixed-case set only 'a'-'z' (97-122)
; move, to 1-26; everything else the portable set holds is its own
; code. Comparing beats a 256-byte table here: a table would be a
; quarter of hello-world's whole program for two cycles a character.
;
; Why native: under the compiler's generic code these three took 1,908
; cycles for a nine-character print (~210 a character: a call to
; place() and two more inside it for every cell), 2,944 for a
; five-digit number and 8,078 to fill forty cells — measured with CIA 2
; timer A around each call (test/text-timing-probe.8bs, 2026-09-19),
; about a fifth of an NTSC frame for one HUD line. The same three calls
; through these routines: 498, 1,265 and 1,110 — of which ~150 is the
; compiled call and prepare() around each — ~28 cycles a character,
; ~20 a filled cell, and a number is its place-value subtractions (as
; the 8BitScript version was: the 6502 has no divide; ~40 each, fifteen
; for 12345) plus ~60 a digit.

; ---- text.print --------------------------------------------------------
;
; Y counts the characters down from the length to 1, reading character
; y-1 through `lda string,y` (offset 0 is the length byte) and storing
; it at cell - 1 + y — so the store operands hold cell - 1, and one
; index serves both. An empty string stores nothing.

.section .text.__8bs_c64_text_print,"ax",@progbits
.global __8bs_c64_text_print
__8bs_c64_text_print:
    lda 0x0704                  ; the string's address into both loads
    sta __8bs_c64_tx_plen+1
    sta __8bs_c64_tx_pchr+1
    lda 0x0705
    sta __8bs_c64_tx_plen+2
    sta __8bs_c64_tx_pchr+2
    lda #0xFF                   ; cell - 1 + $E000 = cell + $DFFF ...
    clc
    adc 0x0700
    sta __8bs_c64_tx_pscr+1
    sta __8bs_c64_tx_pcol+1     ; ... and + $D7FF: the same low byte
    lda #0xDF
    adc 0x0701
    sta __8bs_c64_tx_pscr+2
    sec
    sbc #8
    sta __8bs_c64_tx_pcol+2
    lda 0x0702
    sta __8bs_c64_tx_pink+1
    lda 0x0703
    sta __8bs_c64_tx_prev+1
    ldy #0
__8bs_c64_tx_plen:
    lda 0xFFFF,y                ; the length byte
    tay
    beq __8bs_c64_tx_pdone
__8bs_c64_tx_pchr:
    lda 0xFFFF,y                ; character y - 1
    cmp #97
    bcc __8bs_c64_tx_pcode
    cmp #123
    bcs __8bs_c64_tx_pcode
    sbc #95                     ; carry clear: 'a'-'z' - 96 = 1-26
__8bs_c64_tx_pcode:
__8bs_c64_tx_prev:
    ora #0                      ; or $80: the ROM's inverted copy
__8bs_c64_tx_pscr:
    sta 0xE000,y
__8bs_c64_tx_pink:
    lda #0
__8bs_c64_tx_pcol:
    sta 0xD800,y
    dey
    bne __8bs_c64_tx_pchr
__8bs_c64_tx_pdone:
    rts

; ---- text.printNumber --------------------------------------------------
;
; `width` cells from `cell`, zero-padded and right-aligned: leading zeros
; for a width past five, then each of the five decimal places of the
; value in turn, counting how many times its place value comes out of
; what is left (10000 at most six times, the others at most nine) — a
; field narrower than five skips that many high places, so it shows the
; low digits, as the 8BitScript version did. Y is the next cell to
; write; $0707 counts the places still to skip; $0708-$0709 the current
; place value; $070A the digit being counted up from '0'.

.section .text.__8bs_c64_text_number,"ax",@progbits
.global __8bs_c64_text_number
__8bs_c64_text_number:
    lda 0x0700                  ; cell + $E000 and cell + $D800 into the stores
    sta __8bs_c64_tx_nscr+1
    sta __8bs_c64_tx_ncol+1
    lda 0x0701
    clc
    adc #0xE0
    sta __8bs_c64_tx_nscr+2
    sec
    sbc #8
    sta __8bs_c64_tx_ncol+2
    lda 0x0702
    sta __8bs_c64_tx_nink+1
    lda 0x0703
    sta __8bs_c64_tx_nrev+1
    ldy #0
    lda 0x0706                  ; width - 5: zeros to lead with, or places to skip
    sec
    sbc #5
    bcc __8bs_c64_tx_nshort
    beq __8bs_c64_tx_nfive
    tax
__8bs_c64_tx_nzero:
    lda #48                     ; '0'
    jsr __8bs_c64_tx_nput
    dex
    bne __8bs_c64_tx_nzero
__8bs_c64_tx_nfive:
    lda #0
    sta 0x0707                  ; skip no place
    beq __8bs_c64_tx_nplaces
__8bs_c64_tx_nshort:
    eor #0xFF                   ; 5 - width
    clc
    adc #1
    sta 0x0707
__8bs_c64_tx_nplaces:
    lda #0x10                   ; 10000 = $2710
    sta 0x0708
    lda #0x27
    sta 0x0709
    jsr __8bs_c64_tx_ndigit
    lda #0xE8                   ; 1000 = $03E8
    sta 0x0708
    lda #0x03
    sta 0x0709
    jsr __8bs_c64_tx_ndigit
    lda #100
    sta 0x0708
    lda #0
    sta 0x0709
    jsr __8bs_c64_tx_ndigit
    lda #10
    sta 0x0708
    jsr __8bs_c64_tx_ndigit
    lda #1
    sta 0x0708
    jsr __8bs_c64_tx_ndigit
    rts

; One place: the digit is how many times $0708-$0709 fits in the value,
; the value keeps the remainder; then the digit goes out unless this
; place is one the width skips. The subtraction is done first and kept
; only when it did not borrow — one pass over the two bytes per try,
; rather than a compare and then a subtraction.
__8bs_c64_tx_ndigit:
    lda #48                     ; '0'
    sta 0x070A
__8bs_c64_tx_nfit:
    lda 0x0704                  ; value - place, low byte in X ...
    sec
    sbc 0x0708
    tax
    lda 0x0705                  ; ... high byte in A
    sbc 0x0709
    bcc __8bs_c64_tx_nplace     ; borrowed: the place did not fit, value untouched
    stx 0x0704
    sta 0x0705
    inc 0x070A
    bcs __8bs_c64_tx_nfit       ; carry still set: always
__8bs_c64_tx_nplace:
    lda 0x0707
    beq __8bs_c64_tx_nshow
    dec 0x0707                  ; skipped: a place above the field
    rts
__8bs_c64_tx_nshow:
    lda 0x070A
__8bs_c64_tx_nput:
__8bs_c64_tx_nrev:
    ora #0                      ; the digit's screen code is its ASCII code
__8bs_c64_tx_nscr:
    sta 0xE000,y
__8bs_c64_tx_nink:
    lda #0
__8bs_c64_tx_ncol:
    sta 0xD800,y
    iny
    rts

; ---- text.fill ---------------------------------------------------------
;
; `count` cells from `cell`, up to the whole screen: whole pages of 256
; first, Y running round once per page with the stores' page byte
; stepped between them, then the rest of a page counted down. The
; character is translated once and stored from an immediate, like the
; color: the loop is two stores and the index.

.section .text.__8bs_c64_text_fill,"ax",@progbits
.global __8bs_c64_text_fill
__8bs_c64_text_fill:
    lda 0x0700                  ; cell + $E000 and cell + $D800 into the stores
    sta __8bs_c64_tx_fscr+1
    sta __8bs_c64_tx_fcol+1
    sta __8bs_c64_tx_fscr2+1
    sta __8bs_c64_tx_fcol2+1
    lda 0x0701
    clc
    adc #0xE0
    sta __8bs_c64_tx_fscr+2
    sta __8bs_c64_tx_fscr2+2
    sec
    sbc #8
    sta __8bs_c64_tx_fcol+2
    sta __8bs_c64_tx_fcol2+2
    lda 0x0702
    sta __8bs_c64_tx_fink+1
    sta __8bs_c64_tx_fink2+1
    lda 0x0706                  ; the character, to a screen code, once
    cmp #97
    bcc __8bs_c64_tx_fcode
    cmp #123
    bcs __8bs_c64_tx_fcode
    sbc #95
__8bs_c64_tx_fcode:
    ora 0x0703
    sta __8bs_c64_tx_fchr+1
    sta __8bs_c64_tx_fchr2+1
    ldx 0x0705                  ; whole pages
    beq __8bs_c64_tx_frest
__8bs_c64_tx_fpage:
    ldy #0
__8bs_c64_tx_fcell:
__8bs_c64_tx_fchr:
    lda #0
__8bs_c64_tx_fscr:
    sta 0xE000,y
__8bs_c64_tx_fink:
    lda #0
__8bs_c64_tx_fcol:
    sta 0xD800,y
    iny
    bne __8bs_c64_tx_fcell
    inc __8bs_c64_tx_fscr+2     ; the next page of both
    inc __8bs_c64_tx_fcol+2
    inc __8bs_c64_tx_fscr2+2
    inc __8bs_c64_tx_fcol2+2
    dex
    bne __8bs_c64_tx_fpage
__8bs_c64_tx_frest:
    ldy 0x0704                  ; the rest, cells count-1 down to 0
    beq __8bs_c64_tx_fdone
__8bs_c64_tx_flast:
    dey
__8bs_c64_tx_fchr2:
    lda #0
__8bs_c64_tx_fscr2:
    sta 0xE000,y
__8bs_c64_tx_fink2:
    lda #0
__8bs_c64_tx_fcol2:
    sta 0xD800,y
    cpy #0
    bne __8bs_c64_tx_flast
__8bs_c64_tx_fdone:
    rts
