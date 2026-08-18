/* eslint-disable @typescript-eslint/no-explicit-any */
// Windows per-application audio for screen sharing.
//
// Electron's `audio: "loopback"` can only ever give us the entire system mix,
// so sharing a single window still leaks every other app's sound. Windows can
// produce a private submix for one process tree, so when the user picks a
// window we capture only that window's process and hand the PCM to the
// renderer, which turns it back into a MediaStreamTrack.
//
// Everything here degrades quietly: if the native module is missing, the OS is
// too old, or activation fails, we report failure and the caller falls back to
// the previous `"loopback"` behaviour.
import { BrowserWindow, app, ipcMain, shell } from "electron";
import { appendFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";

export const APP_AUDIO_CHUNK = "appAudio:chunk";
export const APP_AUDIO_STATE = "appAudio:state";

// A packaged Electron app on Windows has no console attached, so anything we
// print is lost. Diagnostics go to a file the user can actually find.
let logPath: string | null = null;

export function appAudioLogPath() {
  if (logPath) return logPath;
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, "app-audio.log");
  } catch {
    logPath = null;
  }
  return logPath;
}

export function log(...parts: unknown[]) {
  const line =
    new Date().toISOString() +
    " " +
    parts
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      .join(" ");
  console.log("[appAudio]", line);
  const file = appAudioLogPath();
  if (!file) return;
  try {
    // Keep it small; this is a diagnostic aid, not an audit trail.
    try {
      if (statSync(file).size > 512 * 1024) unlinkSync(file);
    } catch {
      /* first run */
    }
    appendFileSync(file, line + "\n", "utf8");
  } catch {
    /* logging must never break screen sharing */
  }
}

type NativeModule = typeof import("win-app-audio");

let native: NativeModule | null = null;
let nativeLoadError: string | null = null;

function loadNative(): NativeModule | null {
  if (native || nativeLoadError) return native;
  if (process.platform !== "win32") {
    nativeLoadError = "not windows";
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    native = require("win-app-audio") as NativeModule;
  } catch (err) {
    nativeLoadError = String((err as Error)?.message ?? err);
    log("native module unavailable:", nativeLoadError);
  }
  return native;
}

/** Capture state for the session currently being shared, if any. */
let active: { pid: number; sourceId: string; mode: "include" | "exclude" } | null =
  null;

// A captured process tree can turn out to render no audio at all -- plenty of
// apps play through a helper process outside their own tree. Sending silence
// would be worse than the old behaviour, so watch for real samples and fall
// back if none arrive.
const SILENCE_GRACE_MS = 3000;
let sawAudio = false;
let watchdog: NodeJS.Timeout | null = null;

function noteSamples(chunk: Buffer) {
  if (sawAudio) return;
  // Sampling every 16th frame is plenty to spot non-silence and keeps this off
  // the hot path.
  for (let i = 0; i + 1 < chunk.length; i += 64) {
    if (Math.abs(chunk.readInt16LE(i)) > 64) {
      sawAudio = true;
      return;
    }
  }
}

function clearWatchdog() {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

export function isAppAudioActive() {
  return active !== null;
}

/**
 * desktopCapturer window ids look like `window:<hwnd>:<n>`, where the middle
 * field is the native window handle. Screens use `screen:<id>:<n>` and have no
 * owning process, so they always fall back to the system mix.
 */
export function windowHandleFromSourceId(sourceId: string): string | null {
  const parts = sourceId.split(":");
  if (parts[0] !== "window" || parts.length < 2) return null;
  return parts[1] || null;
}

/**
 * Try to start per-application capture for a desktopCapturer source.
 * Returns true only when audio is actually flowing from that process.
 */
/**
 * Begin capture in one of two modes:
 *   include - only the shared application's process tree
 *   exclude - everything except our own tree, i.e. system audio minus the
 *             voice chat we are playing, which is how Discord avoids echoing
 *             other people's microphones back into a screen share
 */
function beginCapture(
  pid: number,
  mode: "include" | "exclude",
  sourceId: string,
): boolean {
  const mod = loadNative();
  if (!mod) return false;

  stop();
  sawAudio = false;

  try {
    mod.start(pid, mode === "include", (chunk: Buffer) => {
      noteSamples(chunk);
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return;
      win.webContents.send(APP_AUDIO_CHUNK, chunk);
    });
  } catch (err) {
    log(`capture failed to start (${mode} ${pid}):`, String(err), "lastError:", mod.lastError());
    return false;
  }

  active = { pid, sourceId, mode };
  log(`capturing ${mode} pid ${pid} for ${sourceId}`);
  broadcastState();
  return true;
}

/** Everything except us: keeps the shared machine's audio, drops our own call. */
function captureSystemMinusSelf(sourceId: string): boolean {
  return beginCapture(process.pid, "exclude", sourceId);
}

/**
 * Try to start per-application capture for a desktopCapturer source.
 * Returns true only when audio is actually flowing from that process.
 */
export function startForSource(sourceId: string): boolean {
  const mod = loadNative();
  if (!mod) {
    log("falling back to system audio: native module not loaded:", nativeLoadError);
    return false;
  }
  if (!mod.isSupported()) {
    log("falling back to system audio: OS reports process loopback unsupported");
    return false;
  }

  const handle = windowHandleFromSourceId(sourceId);

  // Whole-screen share: there is no single app to capture, but we can still
  // subtract our own audio so other people's microphones never leak back out.
  if (!handle) {
    log("whole-screen share: capturing system audio minus our own process tree");
    return captureSystemMinusSelf(sourceId);
  }

  const pid = mod.pidFromWindowHandle(handle);
  if (!pid) {
    log("could not resolve a process for window", handle, "- using system audio minus self");
    return captureSystemMinusSelf(sourceId);
  }

  // Include the process *tree*: browsers and Electron apps render audio from
  // a child process, so targeting the visible window's pid alone is silent.
  if (!beginCapture(pid, "include", sourceId)) {
    return captureSystemMinusSelf(sourceId);
  }

  // Some apps render through a helper outside their own tree, which would leave
  // viewers in silence. Give it a moment, then widen rather than send nothing.
  clearWatchdog();
  watchdog = setTimeout(() => {
    watchdog = null;
    if (sawAudio || !active || active.mode !== "include") return;
    log(
      `no audio from pid ${pid} after ${SILENCE_GRACE_MS}ms;` +
        " switching to system audio minus our own process tree",
    );
    captureSystemMinusSelf(sourceId);
  }, SILENCE_GRACE_MS);

  return true;
}

export function stop() {
  clearWatchdog();
  if (!active) return;
  const mod = loadNative();
  try {
    mod?.stop();
  } catch {
    /* nothing to do */
  }
  log(`stopped capturing ${active.mode} pid ${active.pid} (audio seen: ${sawAudio})`);
  active = null;
  broadcastState();
}

function broadcastState() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(APP_AUDIO_STATE, buildState());
    }
  }
}

function buildState() {
  const mod = loadNative();
  return {
    active: active !== null,
    pid: active?.pid ?? 0,
    supported: Boolean(mod?.isSupported()),
    sampleRate: mod?.sampleRate ?? 48000,
    channels: mod?.channels ?? 2,
  };
}

export function initAppAudio() {
  const mod = loadNative();
  log("--- session start ---");
  log("app version:", app.getVersion());
  log("platform:", process.platform, "os release:", release());
  log("native module loaded:", Boolean(mod), nativeLoadError ? `(${nativeLoadError})` : "");
  log("per-process capture supported:", Boolean(mod?.isSupported()));
  log("log file:", appAudioLogPath() ?? "(unavailable)");

  ipcMain.handle("appAudio:getLogPath", () => appAudioLogPath());
  ipcMain.on("appAudio:openLogs", () => {
    const file = appAudioLogPath();
    if (file) shell.showItemInFolder(file);
  });

  // The renderer asks for this right after getDisplayMedia resolves, so it can
  // decide whether to swap in our track. Answering from the main process avoids
  // any race with the IPC notification.
  ipcMain.handle("appAudio:getState", () => buildState());
  ipcMain.on("appAudio:stop", () => stop());
}
