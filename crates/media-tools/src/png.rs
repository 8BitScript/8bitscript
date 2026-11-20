//! `graphics-tools/src/index.mjs:1-151, 184-256, 260-294`.

use miniz_oxide::inflate::{TINFLStatus, decompress_to_vec_zlib};
use std::collections::HashMap;

const SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// Result of `decodePng`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Result of `quantize`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Quantized {
    /// One index per pixel; 255 is transparent.
    pub indices: Vec<u8>,
    pub palette: Vec<[u8; 3]>,
    pub colors: usize,
}

fn paeth(a: i32, b: i32, c: i32) -> i32 {
    let p = a + b - c;
    let pa = (p - a).abs();
    let pb = (p - b).abs();
    let pc = (p - c).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

/// A zeroed buffer allocated lazily (like Node's `calloc`), failing without
/// aborting. `Vec::resize` would touch every page.
fn alloc_zeroed_vec(n: usize) -> Result<Vec<u8>, String> {
    use std::alloc::{Layout, alloc_zeroed};
    const FAILED: &str = "Array buffer allocation failed";
    if n == 0 {
        return Ok(Vec::new());
    }
    let layout = Layout::array::<u8>(n).map_err(|_| FAILED.to_string())?;
    // SAFETY: `layout` has non-zero size; a null result is handled; the
    // pointer, length and capacity describe one `u8` allocation that came
    // from the global allocator with this layout.
    unsafe {
        let ptr = alloc_zeroed(layout);
        if ptr.is_null() {
            return Err(FAILED.to_string());
        }
        Ok(Vec::from_raw_parts(ptr, n, n))
    }
}

/// `new Uint8Array(len)` for a JS number length: V8 rejects 2^53 and up
/// with the length in the message, and anything it cannot allocate with
/// "Array buffer allocation failed".
fn typed_array(len: f64) -> Result<Vec<u8>, String> {
    let len = len.trunc();
    if len >= 9_007_199_254_740_992.0 {
        return Err(format!("Invalid typed array length: {len}"));
    }
    match usize::try_from(len as u64) {
        Ok(n) => alloc_zeroed_vec(n),
        Err(_) => Err("Array buffer allocation failed".to_string()),
    }
}

fn unfilter(data: &[u8], width: u32, bpp: usize) -> Result<Vec<u8>, String> {
    let stride_f = width as f64 * bpp as f64;
    // `new Uint8Array(stride * (data.length / (stride + 1)))` truncates.
    let mut out = typed_array(stride_f * (data.len() as f64 / (stride_f + 1.0)))?;
    let mut prev = typed_array(stride_f)?;
    // an allocation of `stride` bytes succeeded, so it fits usize
    let stride = prev.len();
    let mut src = 0usize;
    let mut dst = 0usize;
    while src < data.len() {
        let ty = data[src];
        src += 1;
        let end = src.saturating_add(stride).min(data.len());
        let row = &data[src.min(data.len())..end];
        src = src.saturating_add(stride);
        let mut recon = typed_array(stride_f)?;
        for i in 0..stride {
            let a = if i >= bpp { recon[i - bpp] as i32 } else { 0 };
            let b = prev[i] as i32;
            let c = if i >= bpp { prev[i - bpp] as i32 } else { 0 };
            if ty > 4 {
                return Err(format!("unsupported PNG filter {ty}"));
            }
            // A missing byte is `undefined` in JS: every filter stores 0.
            recon[i] = match row.get(i) {
                None => 0,
                Some(&x) => {
                    let x = x as i32;
                    (match ty {
                        1 => x + a,
                        2 => x + b,
                        3 => x + ((a + b) >> 1),
                        4 => x + paeth(a, b, c),
                        _ => x,
                    } & 255) as u8
                }
            };
        }
        if dst.saturating_add(stride) > out.len() {
            return Err("offset is out of bounds".to_string());
        }
        out[dst..dst + stride].copy_from_slice(&recon);
        dst += stride;
        prev = recon;
    }
    Ok(out)
}

struct Chunk<'a> {
    ty: [u8; 4],
    data: &'a [u8],
}

fn read_chunks(bytes: &[u8]) -> Result<Vec<Chunk<'_>>, String> {
    if bytes.len() < 8 || bytes[..8] != SIGNATURE {
        return Err("not a PNG".to_string());
    }
    let mut chunks = Vec::new();
    let mut i = 8usize;
    while i + 12 <= bytes.len() {
        let length =
            u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        // toString('ascii') drops the high bit.
        let ty = [
            bytes[i + 4] & 0x7f,
            bytes[i + 5] & 0x7f,
            bytes[i + 6] & 0x7f,
            bytes[i + 7] & 0x7f,
        ];
        let start = i + 8;
        let data = &bytes[start..start.saturating_add(length).min(bytes.len())];
        chunks.push(Chunk { ty, data });
        i = i.saturating_add(12).saturating_add(length);
        if &ty == b"IEND" {
            break;
        }
    }
    Ok(chunks)
}

fn to_rgba(
    raw: &[u8],
    width: u32,
    height: u32,
    color_type: u8,
    palette: Option<&[u8]>,
    transparency: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let mut rgba = typed_array(width as f64 * height as f64 * 4.0)?;
    let pixels = rgba.len() / 4;
    let r = |i: usize| raw.get(i).copied().unwrap_or(0);
    match color_type {
        6 => {
            let n = raw.len().min(rgba.len());
            rgba[..n].copy_from_slice(&raw[..n]);
        }
        2 => {
            for i in 0..pixels {
                let p = i * 3;
                rgba[i * 4] = r(p);
                rgba[i * 4 + 1] = r(p + 1);
                rgba[i * 4 + 2] = r(p + 2);
                rgba[i * 4 + 3] = 255;
            }
        }
        0 => {
            for i in 0..pixels {
                let g = r(i);
                rgba[i * 4..i * 4 + 3].fill(g);
                rgba[i * 4 + 3] = 255;
            }
        }
        3 => {
            for i in 0..pixels {
                let idx = raw.get(i).copied();
                let Some(pal) = palette else {
                    // `palette[idx * 3]` on undefined
                    let key = idx.map_or("NaN".to_string(), |v| (v as u32 * 3).to_string());
                    return Err(format!(
                        "Cannot read properties of undefined (reading '{key}')"
                    ));
                };
                let at = |o: usize| pal.get(o).copied().unwrap_or(0);
                match idx {
                    Some(v) => {
                        let v = v as usize;
                        rgba[i * 4] = at(v * 3);
                        rgba[i * 4 + 1] = at(v * 3 + 1);
                        rgba[i * 4 + 2] = at(v * 3 + 2);
                        rgba[i * 4 + 3] =
                            transparency.and_then(|t| t.get(v)).copied().unwrap_or(255);
                    }
                    None => rgba[i * 4 + 3] = 255,
                }
            }
        }
        4 => {
            for i in 0..pixels {
                let p = i * 2;
                let g = r(p);
                rgba[i * 4..i * 4 + 3].fill(g);
                rgba[i * 4 + 3] = r(p + 1);
            }
        }
        _ => return Err(format!("unsupported PNG color type {color_type}")),
    }
    Ok(rgba)
}

/// Node's `inflateSync` message text for the zlib failure.
fn inflate(idat: &[u8]) -> Result<Vec<u8>, String> {
    if idat.len() < 2 {
        return Err("unexpected end of file".to_string());
    }
    let (cmf, flg) = (idat[0] as u32, idat[1] as u32);
    if ((cmf << 8) | flg) % 31 != 0 {
        return Err("incorrect header check".to_string());
    }
    if cmf & 0x0f != 8 {
        return Err("unknown compression method".to_string());
    }
    if (cmf >> 4) > 7 {
        return Err("invalid window size".to_string());
    }
    if flg & 0x20 != 0 {
        // zlib needs the 4-byte dictionary id before it asks for a dictionary
        return Err(if idat.len() < 6 {
            "unexpected end of file"
        } else {
            "Missing dictionary"
        }
        .to_string());
    }
    decompress_to_vec_zlib(idat).map_err(|e| {
        match e.status {
            TINFLStatus::Adler32Mismatch => "incorrect data check",
            TINFLStatus::NeedsMoreInput | TINFLStatus::FailedCannotMakeProgress => {
                "unexpected end of file"
            }
            // Approximate: the deflate body error is not told apart.
            _ => "invalid block type",
        }
        .to_string()
    })
}

fn be32(d: &[u8], o: usize) -> Result<u32, String> {
    if d.len() < o + 4 {
        return Err(if d.len() < 4 {
            "Attempt to access memory outside buffer bounds".to_string()
        } else {
            format!(
                "The value of \"offset\" is out of range. It must be >= 0 and <= {}. Received {o}",
                d.len() - 4
            )
        });
    }
    Ok(u32::from_be_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]]))
}

/// `decodePng`.
pub fn decode_png(bytes: &[u8]) -> Result<Decoded, String> {
    let chunks = read_chunks(bytes)?;
    let find = |t: &[u8; 4]| chunks.iter().find(|c| &c.ty == t);
    let ihdr = find(b"IHDR").ok_or_else(|| "PNG has no IHDR".to_string())?;
    let width = be32(ihdr.data, 0)?;
    let height = be32(ihdr.data, 4)?;
    let bit_depth = ihdr.data.get(8).copied();
    let color_type = ihdr.data.get(9).copied();
    let interlace = ihdr.data.get(12).copied();
    if bit_depth != Some(8) {
        return Err(match bit_depth {
            Some(d) => format!("PNG bit depth {d} is not 8"),
            None => "PNG bit depth undefined is not 8".to_string(),
        });
    }
    if interlace != Some(0) {
        return Err("interlaced PNG is not supported".to_string());
    }
    let plte = find(b"PLTE");
    let trns = find(b"tRNS");
    let idat: Vec<u8> = chunks
        .iter()
        .filter(|c| &c.ty == b"IDAT")
        .flat_map(|c| c.data.iter().copied())
        .collect();
    let inflated = inflate(&idat)?;
    // color type undefined (short IHDR) falls to the default arms in JS
    let ct = color_type.unwrap_or(255);
    let bpp = match ct {
        2 => 3,
        6 => 4,
        4 => 2,
        _ => 1,
    };
    let raw = unfilter(&inflated, width, bpp)?;
    let rgba = to_rgba(
        &raw,
        width,
        height,
        ct,
        plte.map(|c| c.data),
        trns.map(|c| c.data),
    )
    .map_err(|e| {
        if color_type.is_none() {
            "unsupported PNG color type undefined".to_string()
        } else {
            e
        }
    })?;
    Ok(Decoded {
        width,
        height,
        rgba,
    })
}

/// `sliceFrames`: frames left to right, then down. A zero frame size loops
/// forever in JS; here it gives no frames.
pub fn slice_frames(
    rgba: &[u8],
    width: usize,
    height: usize,
    frame_w: usize,
    frame_h: usize,
) -> Vec<Vec<u8>> {
    if frame_w == 0 || frame_h == 0 {
        return Vec::new();
    }
    let cols = width / frame_w;
    let rows = height / frame_h;
    let mut frames = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let mut frame = vec![0u8; frame_w * frame_h * 4];
            for y in 0..frame_h {
                let src = ((r * frame_h + y) * width + c * frame_w) * 4;
                let end = (src + frame_w * 4).min(rgba.len());
                if src < end {
                    frame[y * frame_w * 4..y * frame_w * 4 + (end - src)]
                        .copy_from_slice(&rgba[src..end]);
                }
            }
            frames.push(frame);
        }
    }
    frames
}

/// `quantize`; `rgba.len()` is a multiple of 4.
pub fn quantize(rgba: &[u8], max_colors: usize) -> Quantized {
    let pixels = rgba.len() / 4;
    // Insertion-ordered counts: the sort below is stable.
    let mut order: Vec<((u8, u8, u8), usize)> = Vec::new();
    let mut slot: HashMap<(u8, u8, u8), usize> = HashMap::new();
    for px in rgba.chunks_exact(4) {
        if px[3] < 16 {
            continue;
        }
        let key = (px[0] >> 3, px[1] >> 3, px[2] >> 3);
        match slot.get(&key) {
            Some(&n) => order[n].1 += 1,
            None => {
                slot.insert(key, order.len());
                order.push((key, 1));
            }
        }
    }
    order.sort_by_key(|e| std::cmp::Reverse(e.1));
    let mut palette: Vec<[u8; 3]> = order
        .iter()
        .take(max_colors.max(1))
        .map(|((r, g, b), _)| [r * 8, g * 8, b * 8])
        .collect();
    if palette.is_empty() {
        palette.push([255, 255, 255]);
    }
    let mut indices = vec![0u8; pixels];
    let mut unique = std::collections::HashSet::new();
    for (i, px) in rgba.chunks_exact(4).enumerate() {
        if px[3] < 16 {
            indices[i] = 255;
            continue;
        }
        let mut best = 0usize;
        let mut best_d = i64::MAX;
        for (p, pal) in palette.iter().enumerate() {
            let dr = px[0] as i64 - pal[0] as i64;
            let dg = px[1] as i64 - pal[1] as i64;
            let db = px[2] as i64 - pal[2] as i64;
            let d = dr * dr + dg * dg + db * db;
            if d < best_d {
                best_d = d;
                best = p;
            }
        }
        // a Uint8Array store truncates mod 256
        indices[i] = best as u8;
        unique.insert(best);
    }
    Quantized {
        indices,
        palette,
        colors: unique.len(),
    }
}

/// `brightness`: mean of opaque pixels' channel mean, rounded as `Math.round`.
pub fn brightness(rgba: &[u8]) -> u32 {
    let mut sum = 0f64;
    let mut n = 0f64;
    for px in rgba.chunks_exact(4) {
        if px[3] < 16 {
            continue;
        }
        sum += (px[0] as f64 + px[1] as f64 + px[2] as f64) / 3.0;
        n += 1.0;
    }
    if n != 0.0 {
        crate::js_round(sum / n) as u32
    } else {
        0
    }
}

/// `bitmask`: rows are JS int32 values (`1 << n` wraps the shift count mod 32).
pub fn bitmask(indices: &[u8], src_w: usize, src_h: usize, dst_w: usize, dst_h: usize) -> Vec<i32> {
    let div = |a: usize, b: usize| ((a as f64) / (b as f64)).floor() as usize;
    let mut bits = Vec::new();
    for y in 0..dst_h {
        let mut row = 0i32;
        for x in 0..dst_w {
            let x0 = div(x * src_w, dst_w);
            let x1 = div((x + 1) * src_w, dst_w);
            let y0 = div(y * src_h, dst_h);
            let y1 = div((y + 1) * src_h, dst_h);
            let mut on = false;
            let mut sy = y0;
            while sy < (y0 + 1).max(y1) && sy < src_h {
                let mut sx = x0;
                while sx < (x0 + 1).max(x1) && sx < src_w {
                    if indices.get(sy * src_w + sx).is_none_or(|&v| v != 255) {
                        on = true;
                    }
                    sx += 1;
                }
                sy += 1;
            }
            if on {
                row |= 1i32 << (((dst_w - 1 - x) as u32) & 31);
            }
        }
        bits.push(row);
    }
    bits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocation_failure_is_an_error() {
        // larger than any address space the allocator can map
        assert_eq!(
            alloc_zeroed_vec(usize::MAX / 2).unwrap_err(),
            "Array buffer allocation failed"
        );
        assert_eq!(alloc_zeroed_vec(0).unwrap(), Vec::<u8>::new());
        assert_eq!(alloc_zeroed_vec(5).unwrap(), vec![0u8; 5]);
    }

    #[test]
    fn typed_array_lengths_match_v8() {
        assert_eq!(
            typed_array(4.0 * 4294967295.0 * 4294967295.0).unwrap_err(),
            "Invalid typed array length: 73786976260478470000"
        );
        assert_eq!(
            typed_array(9007199254740992.0).unwrap_err(),
            "Invalid typed array length: 9007199254740992"
        );
        assert_eq!(typed_array(2.9).unwrap(), vec![0, 0]);
        // below 2^53 but not allocatable
        assert_eq!(
            typed_array(1125899906842624.0 * 4.0).unwrap_err(),
            "Array buffer allocation failed"
        );
    }
}
