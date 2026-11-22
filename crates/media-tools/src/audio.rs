//! `audio-tools/src/index.mjs:1-121, 144-184`.

use std::ffi::OsStr;
use std::fmt;
use std::path::PathBuf;

/// Result of `decodeWav` / `decodeFlac`: mono float samples.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decoded {
    pub sample_rate: u32,
    pub samples: Vec<f32>,
}

/// A thrown `Error`: its message and its `code` property, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioError {
    pub message: String,
    pub code: Option<String>,
}

impl fmt::Display for AudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl AudioError {
    fn plain(message: String) -> Self {
        AudioError {
            message,
            code: None,
        }
    }
}

/// Result of `encodeDpcm`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Dpcm {
    pub bytes: Vec<u8>,
    pub rate: u8,
    pub length: usize,
}

/// `resolveFfmpeg`: the first `ffmpeg` that exists in a PATH directory.
fn resolve_ffmpeg(search: Option<&OsStr>) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    for dir in std::env::split_paths(search?) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

// An out-of-range read is `undefined`, which the `|` and `<<` make 0.
fn byte(buf: &[u8], o: u64) -> u32 {
    usize::try_from(o)
        .ok()
        .and_then(|o| buf.get(o))
        .map_or(0, |&b| b as u32)
}
fn read_u16(buf: &[u8], o: u64) -> u32 {
    byte(buf, o) | (byte(buf, o + 1) << 8)
}
fn read_u32(buf: &[u8], o: u64) -> u32 {
    byte(buf, o) | (byte(buf, o + 1) << 8) | (byte(buf, o + 2) << 16) | (byte(buf, o + 3) << 24)
}

fn find_chunk<'a>(bytes: &'a [u8], id: &[u8; 4]) -> Option<&'a [u8]> {
    let len = bytes.len() as u64;
    let mut i = 12u64;
    while i + 8 <= len {
        let size = read_u32(bytes, i + 4) as u64;
        if &bytes[i as usize..i as usize + 4] == id {
            let start = (i + 8) as usize;
            let end = (i + 8 + size).min(len) as usize;
            return Some(&bytes[start..end]);
        }
        i += 8 + size + (size & 1);
    }
    None
}

fn samples_from_pcm(
    data: &[u8],
    bits: u32,
    channels: u32,
    format: u32,
) -> Result<Vec<f32>, String> {
    let ch = channels as usize;
    let div = channels as f64;
    let mut out = Vec::new();
    let supported = (format == 3 && bits == 32) || bits == 8 || bits == 16;
    if channels == 0 && supported {
        // A WAV with zero channels reads no samples; the JS throws the same message.
        return Err("WAV has zero channels".to_string());
    }
    if format == 3 && bits == 32 {
        let mut i = 0;
        while i + 4 * ch <= data.len() {
            let mut s = 0f64;
            for c in 0..ch {
                let o = i + c * 4;
                s += f32::from_le_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]]) as f64;
            }
            out.push((s / div) as f32);
            i += 4 * ch;
        }
        return Ok(out);
    }
    if bits == 8 {
        let mut i = 0;
        while i + ch <= data.len() {
            let mut s = 0f64;
            for c in 0..ch {
                s += (data[i + c] as f64 - 128.0) / 128.0;
            }
            out.push((s / div) as f32);
            i += ch;
        }
        return Ok(out);
    }
    if bits == 16 {
        let mut i = 0;
        while i + 2 * ch <= data.len() {
            let mut s = 0f64;
            for c in 0..ch {
                let o = i + c * 2;
                s += i16::from_le_bytes([data[o], data[o + 1]]) as f64 / 32768.0;
            }
            out.push((s / div) as f32);
            i += 2 * ch;
        }
        return Ok(out);
    }
    Err(format!(
        "WAV PCM {bits}-bit format {format} is not supported"
    ))
}

/// `decodeWav`.
pub fn decode_wav(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a WAV".to_string());
    }
    let fmt = find_chunk(bytes, b"fmt ");
    let data = find_chunk(bytes, b"data");
    let (Some(fmt), Some(data)) = (fmt, data) else {
        return Err("WAV is missing fmt or data".to_string());
    };
    let format = read_u16(fmt, 0);
    let channels = read_u16(fmt, 2);
    let sample_rate = read_u32(fmt, 4);
    let bits = read_u16(fmt, 14);
    let samples = samples_from_pcm(data, bits, channels, format)?;
    Ok(Decoded {
        sample_rate,
        samples,
    })
}

/// `ffmpegAvailable`; always false on `wasm32`.
pub fn ffmpeg_available() -> bool {
    ffmpeg_available_in(std::env::var_os("PATH").as_deref())
}

/// `ffmpeg_available` against an explicit `PATH` value.
pub fn ffmpeg_available_in(search: Option<&OsStr>) -> bool {
    #[cfg(target_arch = "wasm32")]
    {
        false
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        match resolve_ffmpeg(search) {
            None => false,
            Some(bin) => std::process::Command::new(bin)
                .arg("-version")
                .stdin(std::process::Stdio::null())
                .output()
                .is_ok_and(|o| o.status.success()),
        }
    }
}

fn needs_ffmpeg() -> AudioError {
    AudioError {
        message: "FLAC needs ffmpeg on PATH".to_string(),
        code: Some("FLAC_NEEDS_FFMPEG".to_string()),
    }
}

/// `decodeFlac`: FLAC (or anything ffmpeg reads) to mono f32 at 48000 Hz.
/// Missing ffmpeg gives code `FLAC_NEEDS_FFMPEG`.
pub fn decode_flac(path: &str) -> Result<Decoded, AudioError> {
    decode_flac_in(path, std::env::var_os("PATH").as_deref())
}

/// `decode_flac` against an explicit `PATH` value (the JS reads `process.env.PATH`).
pub fn decode_flac_in(path: &str, search: Option<&OsStr>) -> Result<Decoded, AudioError> {
    if !std::path::Path::new(path).exists() {
        return Err(AudioError::plain(format!("cannot read '{path}'")));
    }
    if !ffmpeg_available_in(search) {
        return Err(needs_ffmpeg());
    }
    run_ffmpeg(path, search)
}

#[cfg(target_arch = "wasm32")]
fn run_ffmpeg(_path: &str, _search: Option<&OsStr>) -> Result<Decoded, AudioError> {
    Err(needs_ffmpeg())
}

/// `spawnSync`'s `maxBuffer` for ffmpeg's output.
#[cfg(not(target_arch = "wasm32"))]
const MAX_BUFFER: usize = 32 * 1024 * 1024;

/// Reads `r` up to `MAX_BUFFER` bytes; the flag says the limit was passed
/// (the bytes kept are the first `MAX_BUFFER`).
#[cfg(not(target_arch = "wasm32"))]
fn read_capped(mut r: impl std::io::Read) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => return (buf, false),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_BUFFER {
                    buf.truncate(MAX_BUFFER);
                    return (buf, true);
                }
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn run_ffmpeg(path: &str, search: Option<&OsStr>) -> Result<Decoded, AudioError> {
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    let fail = |stderr: &[u8]| {
        let text = String::from_utf8_lossy(stderr);
        let units: Vec<u16> = text.encode_utf16().collect();
        let tail = String::from_utf16_lossy(&units[units.len().saturating_sub(200)..]);
        AudioError::plain(format!("ffmpeg could not decode '{path}': {tail}"))
    };
    let Some(bin) = resolve_ffmpeg(search) else {
        return Err(needs_ffmpeg());
    };
    let spawned = Command::new(bin)
        .args([
            "-nostdin", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "48000",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = spawned else {
        return Err(fail(b""));
    };
    let (out_pipe, err_pipe) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (tx, rx) = mpsc::channel();
    let tx_err = tx.clone();
    let out_reader = std::thread::spawn(move || {
        let r = read_capped(out_pipe);
        let _ = tx.send(r.1);
        r.0
    });
    let err_reader = std::thread::spawn(move || {
        let r = read_capped(err_pipe);
        let _ = tx_err.send(r.1);
        r.0
    });
    let mut exceeded = false;
    for over in rx.iter().take(2) {
        if over && !exceeded {
            exceeded = true;
            // like spawnSync: past maxBuffer the child is killed
            let _ = child.kill();
        }
    }
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    let status = child.wait();
    if exceeded || !status.is_ok_and(|s| s.success()) {
        return Err(fail(&stderr));
    }
    let samples = stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    Ok(Decoded {
        sample_rate: 48000,
        samples,
    })
}

/// `encodeDpcm`: NES DPCM, 1-bit delta at about 33144 Hz, 16-byte aligned,
/// at most 4081 bytes; `None` when the clip does not fit.
pub fn encode_dpcm(samples: &[f32], sample_rate: f64) -> Option<Dpcm> {
    let target_rate = 33143.9;
    let ratio = sample_rate / target_rate;
    let needed = (samples.len() as f64 / ratio).ceil();
    let bytes = (needed / 8.0).ceil();
    if bytes < 1.0 || bytes > 4081.0 {
        return None;
    }
    let aligned = (bytes / 16.0).ceil() * 16.0;
    let mut out = vec![0u8; aligned as usize];
    let mut acc = 64i32;
    let mut bit = 0u32;
    let mut offset = 0usize;
    let mut packed = 0u8;
    let mut i = 0f64;
    while i < needed {
        let src = ((samples.len() - 1) as f64).min((i * ratio).floor()) as usize;
        let want = crate::js_round((samples[src] as f64 * 0.5 + 0.5) * 127.0);
        if want > acc as f64 && acc < 126 {
            packed |= 1 << bit;
            acc += 2;
        } else if acc > 1 {
            acc -= 2;
        }
        bit += 1;
        if bit == 8 {
            out[offset] = packed;
            offset += 1;
            packed = 0;
            bit = 0;
        }
        i += 1.0;
    }
    if bit != 0 {
        out[offset] = packed;
        offset += 1;
    }
    let length = ((offset as f64 / 16.0).ceil() as usize).max(1);
    Some(Dpcm {
        bytes: out,
        rate: 0x0f,
        length,
    })
}
