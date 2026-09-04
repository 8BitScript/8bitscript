// atari800 has no built-in "save a screenshot and exit" flag the way VICE
// (-exitscreenshot), Xemu (-screenshot), and FCEUX (a Lua script calling
// gui.savescreenshotas) do — its own screenshot feature only triggers off
// a host keypress (see docs/setup/verify.md's screenshot table). macOS
// (Screen Recording permission, not Accessibility) can capture that one
// window's real pixels directly, without sending it any synthetic
// keystrokes at all: this is the "set up the OS" half of a screenshot
// path, used only where no clean emulator API exists, not a general
// substitute for one.
//
// Finding *which* window belongs to a given process, asking macOS to
// capture only that one, and checking whether Screen Recording permission
// is even granted all need CoreGraphics APIs with no shell-command
// equivalent, so this compiles a tiny Swift helper the first time it's
// needed and caches the binary (screenshotCacheDir()) rather than
// recompiling on every screenshot. The cache key includes a hash of
// HELPER_SOURCE below, so editing this file invalidates the old binary
// instead of silently keeping using it forever.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { screenshotCacheDir } from './setup/paths.mjs';

const HELPER_SOURCE = `
import CoreGraphics
import Foundation

func findWindowId(_ ownerPid: Int32?, _ needle: String) -> Int? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: AnyObject]] else {
        return nil
    }
    var best: (id: Int, area: Int)? = nil
    for win in list {
        guard let owner = win[kCGWindowOwnerName as String] as? String else { continue }
        if let ownerPid = ownerPid {
            guard let pid = win[kCGWindowOwnerPID as String] as? Int32, pid == ownerPid else { continue }
        } else {
            guard owner.lowercased().contains(needle.lowercased()) else { continue }
        }
        guard let id = win[kCGWindowNumber as String] as? Int,
              let bounds = win[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let area = Int((bounds["Width"] ?? 0) * (bounds["Height"] ?? 0))
        if best == nil || area > best!.area { best = (id, area) }
    }
    return best?.id
}

let args = CommandLine.arguments
guard args.count > 1 else { exit(2) }

switch args[1] {
case "check-permission":
    // Preflight only — never prompts the user. CGRequestScreenCaptureAccess
    // would pop the system dialog, which a non-interactive \`8bs doctor\`
    // run has no business doing on its own.
    print(CGPreflightScreenCaptureAccess() ? "granted" : "denied")
case "find-window-by-pid":
    guard args.count > 2, let pid = Int32(args[2]) else { exit(2) }
    if let id = findWindowId(pid, "") { print(id) } else { exit(1) }
case "find-window-by-name":
    guard args.count > 2 else { exit(2) }
    if let id = findWindowId(nil, args[2]) { print(id) } else { exit(1) }
default:
    exit(2)
}
`;

function sourceHash() {
  return createHash('sha1').update(HELPER_SOURCE).digest('hex').slice(0, 12);
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function ensureHelperBinary() {
  const cacheDir = screenshotCacheDir();
  const binPath = join(cacheDir, `window-capture-${sourceHash()}`);
  if (existsSync(binPath)) return binPath;

  await mkdir(cacheDir, { recursive: true });
  const srcPath = join(tmpdir(), `8bs-window-capture-${process.pid}.swift`);
  await writeFile(srcPath, HELPER_SOURCE);
  const { code, stderr } = await run('swiftc', [srcPath, '-o', binPath]);
  if (code !== 0) {
    throw new Error(`8bs: could not compile the window-capture helper (is Xcode's command line tools installed?):\n${stderr}`);
  }
  return binPath;
}

/**
 * The macOS window ID of the largest on-screen window belonging to
 * `pid`, or `null` if none is on screen. PID-matched, not name-matched, so
 * two atari800 windows (an interactive `8bs run atari8` left open alongside
 * a `--screenshot` capture) can't be confused for each other.
 * @param {number} pid
 * @returns {Promise<number | null>}
 */
export async function findWindowIdForPid(pid) {
  const binPath = await ensureHelperBinary();
  const { code, stdout } = await run(binPath, ['find-window-by-pid', String(pid)]);
  if (code !== 0) return null;
  const id = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(id) ? id : null;
}

/**
 * Capture exactly one window's real pixels to a PNG — no synthetic
 * keyboard/mouse input, just macOS's own windowed screen capture. Requires
 * Screen Recording permission for whichever process runs `8bs` (System
 * Settings -> Privacy & Security -> Screen Recording) — see
 * hasScreenRecordingPermission() to check that ahead of time.
 * @param {number} windowId
 * @param {string} outFile
 */
export async function captureWindow(windowId, outFile) {
  const { code, stderr } = await run('screencapture', ['-x', '-o', '-l', String(windowId), outFile]);
  if (code !== 0) {
    throw new Error(`8bs: screencapture failed (${code}): ${stderr}`);
  }
}

/**
 * Whether this process already has Screen Recording permission — checked
 * with CGPreflightScreenCaptureAccess(), which never prompts. Used by
 * `8bs doctor` to report the gap (with a fix) rather than let a
 * `--screenshot atari8` fail confusingly later with an empty/black capture.
 * @returns {Promise<boolean>}
 */
export async function hasScreenRecordingPermission() {
  const binPath = await ensureHelperBinary();
  const { code, stdout } = await run(binPath, ['check-permission']);
  return code === 0 && stdout.trim() === 'granted';
}

/** The System Settings pane to send someone to grant it, and the shell
 * command that opens it directly. */
export const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
