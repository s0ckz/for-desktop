/* eslint-disable @typescript-eslint/no-explicit-any */
// Windows native GPU-downscaled window capture for screen sharing.
//
// getDisplayMedia is contractually bound to hand JavaScript a full-resolution
// frame, so Chromium's WGC capturer reads back every pixel of the shared
// window and only then throws most of them away in the encoder, all while its
// 50% CPU governor halves the achievable frame rate under load. This module
// captures the same window through the same WGC API, but downscales and
// converts to NV12 on the GPU (VideoProcessorBlt) before the CPU ever touches
// a pixel, and is not routed through DesktopCaptureDevice's governor at all.
// See native/win-capture and the plan this implements.
//
// Same defensive posture as appAudio.ts: a missing native module, an
// unsupported OS/GPU, or a capture failure is never fatal -- the caller (the
// page patch in appAudioPatch.ts) falls back to Chromium's own, slower
// capture path and keeps sharing.
import { BrowserWindow, ipcMain } from "electron";

import {
  log as appAudioLog,
  windowHandleFromSourceId,
  windowStateForSourceId,
} from "./appAudio";

export const SCREEN_CAPTURE_FRAME = "screenCapture:frame";
export const SCREEN_CAPTURE_STATE = "screenCapture:state";

// `for-web` no longer requests a capture resolution (PR #6 removed it on
// purpose -- asking WGC for a smaller surface does not make it grab fewer
// pixels, it just rescales what it grabbed). So this target is fixed rather
// than negotiated: capture fit-inside 1920x1080 always, and let the 720p/1080p
// presets downscale further on the encoder side via scaleResolutionDownBy,
// which reads the real delivered size back off the generated track's
// `getSettings()` override in appAudioPatch.ts.
export const CAPTURE_TARGET_WIDTH = 1920;
export const CAPTURE_TARGET_HEIGHT = 1080;

/**
 * How often we check that the captured window still exists.
 *
 * The native module has no way to push "the window is gone" to JS: its
 * capture thread notices internally (`IsWindow(hwnd)` inside the poll loop in
 * src/addon.cc), records `lastError()`, and simply stops calling back --
 * nothing crosses the ThreadSafeFunction to say why. Today, with Chromium
 * owning the pixels, Chromium's own track ends itself when its capturer sees
 * the same thing, and that is what `screenShare:reacquire` in window.ts reacts
 * to. Once we own the pixels instead, that signal is gone unless we
 * synthesize it -- so this module polls, reusing win-app-audio's `windowState`
 * (win-capture exposes no equivalent) since that costs nothing new to wire up.
 *
 * This is a real gap in win-capture, not a design choice: ideally the addon
 * would surface thread-exit (window gone or any other capture failure)
 * through the same onFrame callback or a dedicated one, instead of going
 * silent. Flagging it here rather than leaving the recovery path silently
 * dead until someone notices reacquire stopped working.
 */
const WINDOW_POLL_MS = 1000;
/**
 * Safety net for capture deaths the window-existence poll cannot see (the
 * window is still open but VideoProcessorBlt/Map started failing, say). If no
 * frame has arrived in this long while we still believe capture is active,
 * treat it as dead. Generous relative to any fps we ask for.
 */
const FRAME_WATCHDOG_MS = 4000;

type NativeModule = typeof import("win-capture");

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
    native = require("win-capture") as NativeModule;
  } catch (err) {
    nativeLoadError = String((err as Error)?.message ?? err);
    appAudioLog("screen capture: native module unavailable:", nativeLoadError);
  }
  return native;
}

/** Capture state for the session currently being shared, if any. */
let active: {
  sourceId: string;
  hwnd: string;
  fps: number;
  width: number;
  height: number;
  lastFrameAt: number;
} | null = null;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

export function isScreenCaptureSupported(): boolean {
  const mod = loadNative();
  if (!mod) return false;
  try {
    return process.platform === "win32" && mod.isSupported();
  } catch {
    return false;
  }
}

export function isScreenCaptureActive() {
  return active !== null;
}

/**
 * Begin native capture of a desktopCapturer window source, fit inside
 * 1920x1080 (aspect preserved, see native/win-capture/index.d.ts). `fps`
 * bounds how often frames are delivered -- the caller composes this with
 * whatever --capture-fps cap is in effect before calling here, so this module
 * does not need to know about that flag.
 *
 * Returns true only once the native session actually started. Mirrors
 * appAudio.startForSource's degrade-quietly contract: on false, the caller
 * keeps Chromium's own capture running untouched, video (and audio) still
 * share normally, just at the old, slower path.
 */
export function startForSource(sourceId: string, fps: number): boolean {
  const mod = loadNative();
  if (!mod) {
    appAudioLog(
      "screen capture: no native GPU path, falling back to Chromium capture: native module not loaded:",
      nativeLoadError,
    );
    return false;
  }
  if (!mod.isSupported()) {
    appAudioLog(
      "screen capture: no native GPU path, falling back to Chromium capture: OS/GPU reports unsupported",
    );
    return false;
  }

  const hwnd = windowHandleFromSourceId(sourceId);
  if (!hwnd) {
    // Screen sources have no window handle; this module only ever handles
    // window shares, by design (see the plan's scope boundary).
    appAudioLog(
      "screen capture: source is not a window, falling back to Chromium capture:",
      sourceId,
    );
    return false;
  }

  stop();

  try {
    const started = mod.start(
      hwnd,
      CAPTURE_TARGET_WIDTH,
      CAPTURE_TARGET_HEIGHT,
      fps,
      (frame: Buffer, meta) => onFrame(frame, meta),
    );
    if (!started) {
      appAudioLog(
        "screen capture: native start() returned false, falling back to Chromium capture:",
        mod.lastError(),
      );
      return false;
    }
  } catch (err) {
    appAudioLog(
      "screen capture: native start() threw, falling back to Chromium capture:",
      String(err),
      "lastError:",
      mod.lastError(),
    );
    return false;
  }

  active = {
    sourceId,
    hwnd,
    fps,
    width: CAPTURE_TARGET_WIDTH,
    height: CAPTURE_TARGET_HEIGHT,
    lastFrameAt: Date.now(),
  };
  appAudioLog(
    `screen capture: native GPU path active for ${sourceId} (hwnd ${hwnd}), target ${CAPTURE_TARGET_WIDTH}x${CAPTURE_TARGET_HEIGHT}@${fps}fps`,
  );
  startWatchdogs();
  broadcastState();
  return true;
}

function onFrame(
  frame: Buffer,
  meta: { width: number; height: number; bltMs: number; grabMs: number },
) {
  if (!active) return;
  active.lastFrameAt = Date.now();
  active.width = meta.width;
  active.height = meta.height;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  win.webContents.send(SCREEN_CAPTURE_FRAME, frame, {
    width: meta.width,
    height: meta.height,
  });
}

function startWatchdogs() {
  stopWatchdogs();
  pollTimer = setInterval(() => {
    if (!active) return;
    const state = windowStateForSourceId(active.sourceId);
    // No native audio module loaded means no way to tell this way; the frame
    // watchdog below is what's left.
    if (!state) return;
    if (!state.exists || state.iconic) {
      appAudioLog(
        "screen capture: captured window gone or minimised, ending native capture for",
        active.sourceId,
      );
      stop();
    }
  }, WINDOW_POLL_MS);
  watchdogTimer = setInterval(() => {
    if (!active) return;
    if (Date.now() - active.lastFrameAt > FRAME_WATCHDOG_MS) {
      const mod = loadNative();
      appAudioLog(
        "screen capture: no frames for",
        FRAME_WATCHDOG_MS,
        "ms, ending native capture; lastError:",
        mod?.lastError() ?? "(unknown)",
      );
      stop();
    }
  }, WINDOW_POLL_MS);
}

function stopWatchdogs() {
  if (pollTimer) clearInterval(pollTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  pollTimer = null;
  watchdogTimer = null;
}

export function stop() {
  stopWatchdogs();
  if (!active) return;
  const mod = loadNative();
  try {
    mod?.stop();
  } catch {
    /* already stopped */
  }
  appAudioLog(`screen capture: stopped native capture for ${active.sourceId}`);
  active = null;
  broadcastState();
}

function broadcastState() {
  const state = buildState();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(SCREEN_CAPTURE_STATE, state);
  }
}

function buildState() {
  return {
    active: active !== null,
    sourceId: active?.sourceId ?? null,
    // Real delivered size once at least one frame has arrived; the requested
    // target beforehand.
    width: active?.width ?? CAPTURE_TARGET_WIDTH,
    height: active?.height ?? CAPTURE_TARGET_HEIGHT,
    fps: active?.fps ?? 30,
    supported: isScreenCaptureSupported(),
  };
}

export function initScreenCapture() {
  const mod = loadNative();
  appAudioLog(
    "screen capture: native module loaded:",
    Boolean(mod),
    nativeLoadError ? `(${nativeLoadError})` : "",
  );
  appAudioLog(
    "screen capture: GPU capture supported:",
    isScreenCaptureSupported(),
  );

  // The renderer asks for this right after getDisplayMedia resolves, so it can
  // decide whether to swap in the generated track -- same pattern as
  // appAudio:getState.
  ipcMain.handle("screenCapture:getState", () => buildState());
  ipcMain.on("screenCapture:stop", () => stop());
  // The injected page patch's console is filtered below error level (see
  // window.ts), so it reports which video path a share actually took --
  // MediaStreamTrackGenerator, the canvas fallback, or leaving Chromium's
  // capture untouched, and why -- through here instead.
  ipcMain.on("screenCapture:pageLog", (_event, message: string) =>
    appAudioLog("page:", message),
  );
}
