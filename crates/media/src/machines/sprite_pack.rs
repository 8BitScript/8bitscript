//! The sprite-pack helpers, ported from `packages/graphics-tools/src/sprite-pack.cjs:1-70`.
//! A sprite's own palette of 12-bit colours (most-used first) and the
//! linear 4bpp packing of a frame, shared by the cx16 and web modules.

use crate::machine::Frame;
use indexmap::IndexMap;
use jsnum::to_int32;

pub(crate) const PALETTE_COLORS: usize = 15;
pub(crate) const SIZES: [f64; 4] = [8.0, 16.0, 32.0, 64.0];

/// `rgba[o]`: a read past the end is `undefined`, which compares as NaN
/// and is 0 under `>> 4`.
pub(crate) fn px(rgba: &[u8], o: usize) -> f64 {
    rgba.get(o).map_or(f64::NAN, |v| f64::from(*v))
}

pub(crate) fn legal_size(n: f64) -> f64 {
    for s in SIZES {
        if n <= s {
            return s;
        }
    }
    64.0
}

pub(crate) fn rgb12(rgba: &[u8], o: usize) -> [i32; 3] {
    [
        to_int32(px(rgba, o)) >> 4,
        to_int32(px(rgba, o + 1)) >> 4,
        to_int32(px(rgba, o + 2)) >> 4,
    ]
}

/// `{colors, distinct}`: the sprite's own picture colours, most-used first,
/// quantized to VERA's 12 bits.
pub(crate) fn build_palette(frames: &[&Frame]) -> (Vec<i32>, usize) {
    let mut counts: IndexMap<i32, u32> = IndexMap::new();
    for frame in frames {
        let mut o = 0;
        while o < frame.width as usize * frame.height as usize * 4 {
            if px(&frame.rgba, o + 3) < 16.0 {
                o += 4;
                continue;
            }
            let [r, g, b] = rgb12(&frame.rgba, o);
            let key = (r << 8) | (g << 4) | b;
            *counts.entry(key).or_insert(0) += 1;
            o += 4;
        }
    }
    let mut ordered: Vec<(i32, u32)> = counts.into_iter().collect();
    // `Array.prototype.sort` is stable; the comparator is `b[1] - a[1] || a[0] - b[0]`.
    ordered.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let distinct = ordered.len();
    (
        ordered
            .iter()
            .take(PALETTE_COLORS)
            .map(|(key, _)| *key)
            .collect(),
        distinct,
    )
}

pub(crate) fn nearest(colors: &[i32], r: i32, g: i32, b: i32) -> i32 {
    let mut best = 0;
    let mut best_d = f64::INFINITY;
    for (i, key) in colors.iter().enumerate() {
        let dr = ((key >> 8) & 15) - r;
        let dg = ((key >> 4) & 15) - g;
        let db = (key & 15) - b;
        let d = f64::from(dr * dr + dg * dg + db * db);
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best as i32 + 1
}

pub(crate) fn pack_frame(frame: &Frame, colors: &[i32], width: usize, height: usize) -> Vec<u8> {
    let index: IndexMap<i32, i32> = colors
        .iter()
        .enumerate()
        .map(|(i, key)| (*key, i as i32 + 1))
        .collect();
    let mut out = Vec::new();
    for y in 0..height {
        let mut x = 0;
        while x < width {
            let mut pair = [0i32, 0i32];
            for (k, slot) in pair.iter_mut().enumerate() {
                let p = x + k;
                if p >= frame.width as usize || y >= frame.height as usize {
                    continue;
                }
                let o = (y * frame.width as usize + p) * 4;
                if px(&frame.rgba, o + 3) < 16.0 {
                    continue;
                }
                let [r, g, b] = rgb12(&frame.rgba, o);
                *slot = index
                    .get(&((r << 8) | (g << 4) | b))
                    .copied()
                    .unwrap_or_else(|| nearest(colors, r, g, b));
            }
            out.push(((pair[0] << 4) | pair[1]) as u8);
            x += 2;
        }
    }
    out
}
