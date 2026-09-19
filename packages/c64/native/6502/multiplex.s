; @8bitscript/c64 — the sprite multiplexer's frame, in native code.
;
; Linked through this package's "8bitscript".native list beside raster.s,
; in its own section so a program that never calls it carries none of it.
; `multiplex.update()` (src/multiplex.8bs) is the one caller: it shares
; the raster list's build state, does `jsr __8bs_c64_multiplex_update`,
; and takes the state back. Everything this routine reads and writes is
; at a fixed address in page $06 — the KERNAL's dead screen, as the frame
; tables are in $04 and $05 — so nothing here depends on where the
; compiler placed a variable, and no zero page is touched:
;
; $0600-$0617  vxLo[24]      the virtual sprites, index 0-23: X low byte
; $0618-$062F  vxHi[24]      X bit 8
; $0630-$0647  vy[24]        Y, 255 hidden
; $0648-$065F  vShape[24]    shape block
; $0660-$0677  vColor[24]
; $0678-$068F  order[24]     the sort order, kept from frame to frame
; $0690-$0697  hwY[8]        what each hardware sprite holds as the list
; $0698-$069F  hwXLo[8]      runs down the frame (this frame's working
; $06A0-$06A7  hwXHi[8]      copy; rebuilt from the eight topmost)
; $06A8-$06AF  hwShape[8]
; $06B0-$06B7  hwColor[8]
; $06B8        count         virtual sprites in use
; $06B9        dropped       out: how many this frame could not fit
; $06BA        shown         out: how many will draw
; $06C0        buildPage     in: the list page being built, 2 or 3
; $06C1        buildEnd      in/out: its entries * 4
; $06C2        lastLine      in/out: its last entry's line
; $06C8-$06CD  LANDING[6]    lines after an entry's own by which n entries
;                            on it have landed (multiplex.8bs's table,
;                            copied here by setCount)
; $06D0-$06D7  BIT[8]        1 << n
; $06D8-$06DF  NOT_BIT[8]    255 - BIT[n]
; $06E0-$06E8  ENABLE_MASK[9] (1 << n) - 1
; $06F0-$06FB  scratch, this routine's own
;
; What it does is exactly what multiplex.8bs's header describes and its
; update() did in 8BitScript until 2026-09-19, when that took ~16,000
; cycles a frame for sixteen sprites under the compiler's generic code
; (a whole NTSC frame is 17,095): the same three steps, the same order
; of checks, the same drops —
;
; 1. the insertion sort of `order` by vy, nearly free when little crossed
;    since last frame;
; 2. the eight topmost into the BUILD page's frame table ($0400 for page
;    2, $0500 for page 3: the operand bytes below are patched on entry,
;    as raster.s patches its own at a swap), and the working copy of what
;    each hardware sprite holds;
; 3. for each further sprite k in y order, hardware sprite k & 7 at the
;    earliest line it may — its last Y + 21, or the line the entries so
;    far land by, or the list's last line, whichever is lowest down —
;    with the Y entry first and then only the registers that differ;
;    dropped if the entries would not land before the new Y, and every
;    later sprite dropped too if the list is full.
;
; Bytes, not sixteen bits: a line past 255 (a carry out of the + 21 or
; the landing add) cannot land before any Y, so it drops the sprite the
; way the sixteen-bit compare did. About 25 cycles an already-ordered
; sprite in the sort, ~70 a hardware sprite for the table, and ~400 a
; reused sprite with three entries (each entry is four stores whose page
; byte is patched on entry — twenty operands, ~120 cycles a call, against
; a subroutine per entry).

.section .text.__8bs_c64_multiplex_update,"ax",@progbits
.global __8bs_c64_multiplex_update
__8bs_c64_multiplex_update:
    lda 0x06C0                  ; the list page into the twenty entry stores ...
    sta __8bs_c64_mx_y0+2
    sta __8bs_c64_mx_y1+2
    sta __8bs_c64_mx_y2+2
    sta __8bs_c64_mx_y3+2
    sta __8bs_c64_mx_p0+2
    sta __8bs_c64_mx_p1+2
    sta __8bs_c64_mx_p2+2
    sta __8bs_c64_mx_p3+2
    sta __8bs_c64_mx_x0+2
    sta __8bs_c64_mx_x1+2
    sta __8bs_c64_mx_x2+2
    sta __8bs_c64_mx_x3+2
    sta __8bs_c64_mx_h0+2
    sta __8bs_c64_mx_h1+2
    sta __8bs_c64_mx_h2+2
    sta __8bs_c64_mx_h3+2
    sta __8bs_c64_mx_c0+2
    sta __8bs_c64_mx_c1+2
    sta __8bs_c64_mx_c2+2
    sta __8bs_c64_mx_c3+2
    clc
    adc #2                      ; ... and its frame table's into the seven table stores
    sta __8bs_c64_mx_ft_pos+2
    sta __8bs_c64_mx_ft_y+2
    sta __8bs_c64_mx_ft_ptr+2
    sta __8bs_c64_mx_ft_col+2
    sta __8bs_c64_mx_ft_xhi+2
    sta __8bs_c64_mx_ft_en+2
    sta __8bs_c64_mx_ft_flag+2

    ; ---- 1. sort `order` by vy: insertion, from an order that persists
    lda #1
    sta 0x06F0                  ; i
__8bs_c64_mx_sort:
    lda 0x06F0
    cmp 0x06B8
    bcs __8bs_c64_mx_sorted
    tax                         ; j = i
    lda 0x0678,x                ; moving = order[i]
    sta 0x06F9
    tay
    lda 0x0630,y                ; its y
    sta 0x06FA
__8bs_c64_mx_sort_in:
    cpx #0
    beq __8bs_c64_mx_sort_put
    lda 0x0677,x                ; below = order[j - 1]
    tay
    lda 0x0630,y
    cmp 0x06FA
    beq __8bs_c64_mx_sort_put   ; vy[below] <= y: in place
    bcc __8bs_c64_mx_sort_put
    tya
    sta 0x0678,x                ; order[j] = below
    dex
    jmp __8bs_c64_mx_sort_in
__8bs_c64_mx_sort_put:
    lda 0x06F9
    sta 0x0678,x                ; order[j] = moving
    inc 0x06F0
    jmp __8bs_c64_mx_sort
__8bs_c64_mx_sorted:

    ; ---- 2. the eight topmost: hardware sprites 0-7, through the frame table
    lda #0
    sta 0x06BA                  ; shown
    sta 0x06F8                  ; xHigh
    lda 0x06B8
    cmp #8
    bcc 1f
    lda #8
1:  sta 0x06FA                  ; first = min(count, 8)
    ldx #0
__8bs_c64_mx_ft:
    lda #0xFF
    sta 0x06F3                  ; y = HIDDEN
    cpx 0x06FA
    bcs __8bs_c64_mx_ft_hidden
    ldy 0x0678,x                ; v = order[h]
    lda 0x0630,y
    sta 0x06F3
    cmp #0xFF
    beq __8bs_c64_mx_ft_hidden
    lda 0x0618,y                ; hwXHi[h] = vxHi[v], and its bit in xHigh
    sta 0x06A0,x
    beq 2f
    lda 0x06F8
    ora 0x06D0,x
    sta 0x06F8
2:  lda 0x0600,y                ; hwXLo[h] = vxLo[v]
    sta 0x0698,x
    sta 0x06FB
    lda 0x0648,y                ; hwShape[h] = vShape[v], into the table's pointer
    sta 0x06A8,x
__8bs_c64_mx_ft_ptr:
    sta 0x0412,x
    lda 0x0660,y                ; hwColor[h] = vColor[v], into the table's color
    sta 0x06B0,x
__8bs_c64_mx_ft_col:
    sta 0x041A,x
    txa
    asl a
    tay
    lda 0x06FB
__8bs_c64_mx_ft_pos:
    sta 0x0400,y                ; the table's X low
    lda 0x06F3
__8bs_c64_mx_ft_y:
    sta 0x0401,y                ; and Y
    inc 0x06BA
__8bs_c64_mx_ft_hidden:
    lda 0x06F3
    sta 0x0690,x                ; hwY[h] = y, hidden or not
    inx
    cpx #8
    bne __8bs_c64_mx_ft
    lda 0x06F8
__8bs_c64_mx_ft_xhi:
    sta 0x0410                  ; the table's $D010
    ldx 0x06BA
    lda 0x06E0,x                ; ENABLE_MASK[shown]
__8bs_c64_mx_ft_en:
    sta 0x0411                  ; its $D015
    lda #1
__8bs_c64_mx_ft_flag:
    sta 0x0422                  ; and its flag: write it at line 0

    ; ---- 3. the rest: list entries, hardware sprite k & 7, earliest line
    lda #0
    sta 0x06B9                  ; dropped
    sta 0x06F5                  ; busy: the line the entries so far land by
    lda 0x06C1
    sta 0x06FB                  ; off = buildEnd
    lda #8
    sta 0x06F0                  ; k
__8bs_c64_mx_reuse:
    lda 0x06F0
    cmp 0x06B8
    bcs __8bs_c64_mx_done
    tax
    ldy 0x0678,x                ; v = order[k]
    sty 0x06F2
    lda 0x0630,y                ; y; hidden sprites sank to the end: done
    cmp #0xFF
    beq __8bs_c64_mx_done
    sta 0x06F3
    txa
    and #7
    sta 0x06F1                  ; h = k & 7
    tax
    lda 0x0690,x                ; hwY[h]
    cmp #0xFF
    beq __8bs_c64_mx_done       ; fewer than eight shown: nothing to reuse
    clc
    adc #21                     ; line = hwY[h] + ROWS
    bcs __8bs_c64_mx_drop       ; past 255: cannot land before any y
    cmp 0x06F5
    bcs 3f
    lda 0x06F5                  ; line = busy
3:  cmp 0x06C2
    bcs 4f
    lda 0x06C2                  ; line = lastLine: an entry cannot go above the list's last
4:  sta 0x06F4
    lda #0                      ; which: bits 1 pointer, 2 X, 4 $D010, 8 color
    sta 0x06F6
    lda #1                      ; entries: Y, and one per bit
    sta 0x06F7
    ldy 0x06F2
    lda 0x0648,y
    cmp 0x06A8,x
    beq 5f
    lda 0x06F6
    ora #1
    sta 0x06F6
    inc 0x06F7
5:  lda 0x0600,y
    cmp 0x0698,x
    beq 6f
    lda 0x06F6
    ora #2
    sta 0x06F6
    inc 0x06F7
6:  lda 0x0618,y
    cmp 0x06A0,x
    beq 7f
    lda 0x06F6
    ora #4
    sta 0x06F6
    inc 0x06F7
7:  lda 0x0660,y
    cmp 0x06B0,x
    beq 8f
    lda 0x06F6
    ora #8
    sta 0x06F6
    inc 0x06F7
8:  ldx 0x06F7                  ; landing = line + LANDING[entries]
    lda 0x06F4
    clc
    adc 0x06C8,x
    bcs __8bs_c64_mx_drop       ; past 255
    cmp 0x06F3
    bcs __8bs_c64_mx_drop       ; landing + 1 > y: too late for this frame
    sta 0x06F9                  ; landing
    lda 0x06F6                  ; xHigh's bit for h, if $D010 changes
    and #4
    beq __8bs_c64_mx_room
    ldx 0x06F1
    lda 0x0618,y                ; Y is still v
    beq 9f
    lda 0x06F8
    ora 0x06D0,x
    sta 0x06F8
    jmp __8bs_c64_mx_room
9:  lda 0x06F8
    and 0x06D8,x
    sta 0x06F8
__8bs_c64_mx_room:
    lda 0x06F7                  ; needed = entries * 4; the list holds 252
    asl a
    asl a
    sta 0x06FA
    lda #252
    sec
    sbc 0x06FA
    cmp 0x06FB
    bcc __8bs_c64_mx_full       ; off > 252 - needed: not all would fit
    ldx 0x06FB                  ; X: the list offset; each entry is four patched stores
    lda 0x06F4                  ; Y first: line, $D001 + 2h, $D0, y
__8bs_c64_mx_y0:
    sta 0x0200,x
    lda 0x06F1
    asl a
    ora #1
__8bs_c64_mx_y1:
    sta 0x0201,x
    lda #0xD0
__8bs_c64_mx_y2:
    sta 0x0202,x
    lda 0x06F3
__8bs_c64_mx_y3:
    sta 0x0203,x
    inx
    inx
    inx
    inx
    ldy 0x06F2
    lda 0x06F6
    and #1
    beq __8bs_c64_mx_no_ptr
    lda 0x06F4                  ; the pointer: line, $E3F8 + h, $E3, vShape[v]
__8bs_c64_mx_p0:
    sta 0x0200,x
    lda 0x06F1
    clc
    adc #0xF8
__8bs_c64_mx_p1:
    sta 0x0201,x
    lda #0xE3
__8bs_c64_mx_p2:
    sta 0x0202,x
    lda 0x0648,y
__8bs_c64_mx_p3:
    sta 0x0203,x
    inx
    inx
    inx
    inx
__8bs_c64_mx_no_ptr:
    lda 0x06F6
    and #2
    beq __8bs_c64_mx_no_x
    lda 0x06F4                  ; X low: line, $D000 + 2h, $D0, vxLo[v]
__8bs_c64_mx_x0:
    sta 0x0200,x
    lda 0x06F1
    asl a
__8bs_c64_mx_x1:
    sta 0x0201,x
    lda #0xD0
__8bs_c64_mx_x2:
    sta 0x0202,x
    lda 0x0600,y
__8bs_c64_mx_x3:
    sta 0x0203,x
    inx
    inx
    inx
    inx
__8bs_c64_mx_no_x:
    lda 0x06F6
    and #4
    beq __8bs_c64_mx_no_xhi
    lda 0x06F4                  ; $D010: line, $10, $D0, the shared X-high byte as it now is
__8bs_c64_mx_h0:
    sta 0x0200,x
    lda #0x10
__8bs_c64_mx_h1:
    sta 0x0201,x
    lda #0xD0
__8bs_c64_mx_h2:
    sta 0x0202,x
    lda 0x06F8
__8bs_c64_mx_h3:
    sta 0x0203,x
    inx
    inx
    inx
    inx
__8bs_c64_mx_no_xhi:
    lda 0x06F6
    and #8
    beq __8bs_c64_mx_placed
    lda 0x06F4                  ; the color: line, $D027 + h, $D0, vColor[v]
__8bs_c64_mx_c0:
    sta 0x0200,x
    lda 0x06F1
    clc
    adc #0x27
__8bs_c64_mx_c1:
    sta 0x0201,x
    lda #0xD0
__8bs_c64_mx_c2:
    sta 0x0202,x
    lda 0x0660,y
__8bs_c64_mx_c3:
    sta 0x0203,x
    inx
    inx
    inx
    inx
__8bs_c64_mx_placed:
    stx 0x06FB                  ; off, past the entries
    lda 0x06F4
    sta 0x06C2                  ; lastLine = line
    ldx 0x06F1                  ; hardware sprite h now holds v: what changed ...
    lda 0x06F6
    lsr a
    bcc 10f
    lda 0x0648,y
    sta 0x06A8,x
10: lda 0x06F6
    and #2
    beq 11f
    lda 0x0600,y
    sta 0x0698,x
11: lda 0x06F6
    and #4
    beq 12f
    lda 0x0618,y
    sta 0x06A0,x
12: lda 0x06F6
    and #8
    beq 13f
    lda 0x0660,y
    sta 0x06B0,x
13: lda 0x06F3
    sta 0x0690,x                ; ... and its y: free again 21 lines on
    lda 0x06F9
    sta 0x06F5                  ; busy = landing
    inc 0x06BA                  ; shown
    jmp __8bs_c64_mx_next
__8bs_c64_mx_drop:
    inc 0x06B9                  ; this one, this frame
__8bs_c64_mx_next:
    inc 0x06F0
    jmp __8bs_c64_mx_reuse
__8bs_c64_mx_full:
    lda 0x06B8                  ; every sprite from k on: lower still, and no room
    sec
    sbc 0x06F0
    clc
    adc 0x06B9
    sta 0x06B9
__8bs_c64_mx_done:
    lda 0x06FB
    sta 0x06C1                  ; buildEnd = off
    rts
