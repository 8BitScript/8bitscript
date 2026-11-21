//! Port of `elaborate.mjs:159-179` (`spriteBounds`); the rest of the file is
//! the elaborate unit.

use crate::machine::Frame;
use crate::machines::sprite_pack::px;

/// The box a sprite's hit check uses: the union over every frame of the pixels
/// with alpha >= 16, as `[left, top, right, bottom]` with right and bottom
/// exclusive. No opaque pixel, or no frames, is `[0, 0, 0, 0]`, which never hits.
#[must_use]
pub fn sprite_bounds(frames: &[Frame]) -> [u32; 4] {
    let mut left = u32::MAX;
    let mut top = u32::MAX;
    let mut right = 0;
    let mut bottom = 0;
    for frame in frames {
        let (width, height) = (frame.width, frame.height);
        for y in 0..height {
            for x in 0..width {
                // A short `rgba` reads `undefined < 16`: false, so opaque.
                let alpha = (y as usize * width as usize + x as usize) * 4 + 3;
                if px(&frame.rgba, alpha) < 16.0 {
                    continue;
                }
                left = left.min(x);
                top = top.min(y);
                right = right.max(x + 1);
                bottom = bottom.max(y + 1);
            }
        }
    }
    if right == 0 {
        [0, 0, 0, 0]
    } else {
        [left, top, right, bottom]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32, alpha: impl Fn(u32, u32) -> u8) -> Frame {
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for y in 0..height {
            for x in 0..width {
                rgba[((y * width + x) * 4 + 3) as usize] = alpha(x, y);
            }
        }
        Frame {
            width,
            height,
            rgba,
        }
    }

    #[test]
    fn no_frames_and_blank_frames_never_hit() {
        assert_eq!(sprite_bounds(&[]), [0, 0, 0, 0]);
        assert_eq!(sprite_bounds(&[frame(8, 8, |_, _| 15)]), [0, 0, 0, 0]);
    }

    #[test]
    fn frames_are_unioned() {
        let a = frame(8, 8, |x, y| if (x, y) == (1, 2) { 255 } else { 0 });
        let b = frame(8, 8, |x, y| if (x, y) == (5, 6) { 16 } else { 0 });
        assert_eq!(sprite_bounds(&[a, b]), [1, 2, 6, 7]);
    }

    #[test]
    fn a_short_buffer_counts_as_opaque() {
        let short = Frame {
            width: 2,
            height: 1,
            rgba: vec![0; 4],
        };
        assert_eq!(sprite_bounds(&[short]), [1, 0, 2, 1]);
    }
}
