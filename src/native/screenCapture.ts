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
/**
 * Consecutive abnormal capture deaths before we stop attempting the native
 * path at all and leave the share on Chromium capture.
 *
 * Without this, a GPU or driver that starts capture successfully and then
 * fails part-way through is worse than one that never starts: each death ends
 * the track, for-web's reacquire restarts the share, native starts and dies
 * again, and after three rounds `MAX_RECOVERIES` (rtc/state.tsx) gives up and
 * the share is dead for good. Degrading to Chromium capture -- the behaviour
 * before this module existed -- is always the better outcome.
 *
 * Once tripped this stays off until the app restarts -- deliberately, since a
 * disabled path can never deliver the healthy session that would reset it. A
 * hardware incompatibility is not going to resolve itself mid-session, and the
 * cost of being wrong is one share running at the old frame rate.
 *
 * This is the one failure mode we cannot test for here, since it would come
 * from hardware we do not have.
 */
const MAX_NATIVE_FAILURES = 2;
/**
 * A session that has been delivering frames this long is working, whatever
 * happened before it, so it clears the failure count. Keeps one transient
 * hiccup from disabling the native path for the rest of the session.
 */
const HEALTHY_SESSION_MS = 10_000;

/** Consecutive abnormal deaths; see {@link MAX_NATIVE_FAILURES}. */
let consecutiveFailures = 0;

/** Sane bounds for {@link takeNextRequestedFps}; see its doc comment. */
const MIN_REQUESTABLE_FPS = 1;
const MAX_REQUESTABLE_FPS = 120;

/**
 * One-shot handoff of the framerate the page asked `getDisplayMedia` for.
 *
 * `setDisplayMediaRequestHandler` (registered in window.ts) is never handed
 * the page's `getDisplayMedia` constraints -- Electron does not pass them
 * through -- so the main process has no way to see what for-web actually
 * requested, only `--capture-fps`, which is a cap, not a request. The page
 * *does* know: the wrapper in appAudioPatch.ts reads
 * `constraints.video.frameRate.ideal` and sends it here immediately before
 * calling through to the real `getDisplayMedia`, which is what triggers the
 * request that reaches this process at all.
 *
 * Mirrors the read-and-clear discipline in for-web's
 * rtc/screenShareCapture.ts, which solves the identical problem one layer
 * up (a value that cannot cross an API boundary we do not own as a plain
 * argument): set immediately before the call that needs it, read-and-clear
 * the instant capture actually starts, so a stale value can never leak into
 * a share it wasn't meant for.
 */
let nextRequestedFps: number | null = null;

/**
 * Read and clear the pending fps in one step. Returns null if nothing was
 * announced -- the page's patch didn't run, is stale, or asked for
 * something invalid -- in which case the caller falls back to today's
 * default.
 */
export function takeNextRequestedFps(): number | null {
  const fps = nextRequestedFps;
  nextRequestedFps = null;
  return fps;
}

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
  /** When this session began, for the HEALTHY_SESSION_MS failure-count reset. */
  startedAt: number;
  /**
   * The window is minimised, so WGC has nothing to hand us. The capture
   * session is deliberately still running -- see the poll in
   * {@link startWatchdogs} for why we do not tear down over this.
   */
  paused: boolean;
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

  // A GPU/driver that keeps dying part-way through a share is worse than one
  // that never starts, so stop trying after enough consecutive deaths and let
  // Chromium capture have it. See MAX_NATIVE_FAILURES.
  if (consecutiveFailures >= MAX_NATIVE_FAILURES) {
    appAudioLog(
      `screen capture: native path disabled after ${consecutiveFailures} consecutive failures, using Chromium capture; lastError:`,
      mod.lastError(),
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
    startedAt: Date.now(),
    paused: false,
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
  const now = Date.now();
  active.lastFrameAt = now;
  active.width = meta.width;
  active.height = meta.height;

  // Frames have been flowing long enough to call this session good, so
  // whatever failed before it no longer counts against the native path.
  if (consecutiveFailures > 0 && now - active.startedAt > HEALTHY_SESSION_MS) {
    appAudioLog(
      "screen capture: native capture healthy again, clearing failure count",
    );
    consecutiveFailures = 0;
  }

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
    if (!state.exists) {
      appAudioLog(
        "screen capture: captured window is gone, ending native capture for",
        active.sourceId,
      );
      stop();
      return;
    }

    // Minimised is not gone. WGC cannot produce frames for an iconic window,
    // but the capture session survives it -- the addon's loop only bails on
    // !IsWindow(), which a minimised window still satisfies. So tearing the
    // share down here is unnecessary, and actively harmful: every teardown
    // spends one of for-web's three recoveries per 60s (MAX_RECOVERIES in
    // rtc/state.tsx), and minimising a few times in quick succession used to
    // exhaust that budget and kill the share for good.
    //
    // Leave the session running instead. The viewer sees the last frame held
    // until the window comes back, which is a far better outcome than the
    // share ending.
    if (state.iconic) {
      if (!active.paused) {
        active.paused = true;
        appAudioLog(
          "screen capture: window minimised, holding the session open (no frames until restored) for",
          active.sourceId,
        );
      }
      return;
    }
    if (active.paused) {
      active.paused = false;
      // Not a resubscribe: WGC resumes delivering into the same session, so
      // there is nothing to restart here.
      active.lastFrameAt = Date.now();
      appAudioLog(
        "screen capture: window restored, frames resuming for",
        active.sourceId,
      );
    }
  }, WINDOW_POLL_MS);
  watchdogTimer = setInterval(() => {
    // While minimised there are legitimately no frames, so the watchdog must
    // not read that as a dead capture.
    if (!active || active.paused) return;
    if (Date.now() - active.lastFrameAt > FRAME_WATCHDOG_MS) {
      const mod = loadNative();
      // An abnormal death: the window is still there and not minimised, but
      // frames stopped. Count it -- enough of these and we stop using the
      // native path rather than letting it kill the share.
      consecutiveFailures++;
      appAudioLog(
        "screen capture: no frames for",
        FRAME_WATCHDOG_MS,
        `ms, ending native capture (failure ${consecutiveFailures}/${MAX_NATIVE_FAILURES}); lastError:`,
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

/**
 * Change the rate of the capture already running.
 *
 * for-web picks a screen-share quality *after* the share is live: the picker
 * resolves once capture has started, and the choice then arrives as
 * `applyConstraints({ frameRate })` on the track. Our generated track cannot
 * honour that natively -- the page patch neutralises it so a rejection cannot
 * break the share -- so without this the picked framerate never reached
 * capture, and a share started from a 30fps saved default stayed at 30 however
 * the user answered the picker.
 *
 * The caller is responsible for clamping to `--capture-fps`; this only guards
 * against values that make no sense at all, since the argument crosses IPC
 * from a remote page.
 * @param fps Requested delivery rate
 * @returns Whether the running capture accepted it
 */
export function setLiveFps(fps: number): boolean {
  if (!active) return false;
  if (!Number.isFinite(fps)) return false;
  const wanted = Math.min(
    MAX_REQUESTABLE_FPS,
    Math.max(MIN_REQUESTABLE_FPS, Math.round(fps)),
  );
  if (wanted === active.fps) return true;

  const mod = loadNative();
  if (!mod?.setFps(wanted)) {
    appAudioLog(
      `screen capture: native refused a rate change to ${wanted}fps; staying at ${active.fps}fps`,
    );
    return false;
  }
  appAudioLog(
    `screen capture: rate changed ${active.fps}fps -> ${wanted}fps for ${active.sourceId}`,
  );
  active.fps = wanted;
  broadcastState();
  return true;
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
  // Always log *why* when unsupported. The addon records a reason for every
  // false it returns, and an unexplained "supported: false" here previously
  // sent a debugging session looking in entirely the wrong layer.
  const supported = isScreenCaptureSupported();
  appAudioLog(
    "screen capture: GPU capture supported:",
    supported,
    supported ? "" : `(${mod?.lastError() ?? "native module not loaded"})`,
  );

  // The renderer asks for this right after getDisplayMedia resolves, so it can
  // decide whether to swap in the generated track -- same pattern as
  // appAudio:getState.
  ipcMain.handle("screenCapture:getState", () => buildState());
  ipcMain.on("screenCapture:stop", () => stop());
  // The value arrives from a remote page, so it is validated, not trusted:
  // reject anything that isn't a finite number (same distrust as
  // RENDERER_WRITABLE_KEYS in config.ts) and clamp the rest to a sane range
  // before it can ever reach mod.start()'s fps argument.
  ipcMain.on("screenCapture:setNextFps", (_event, fps: unknown) => {
    if (typeof fps !== "number" || !Number.isFinite(fps)) {
      appAudioLog("screen capture: ignoring invalid setNextFps value:", fps);
      return;
    }
    nextRequestedFps = Math.min(
      MAX_REQUESTABLE_FPS,
      Math.max(MIN_REQUESTABLE_FPS, Math.round(fps)),
    );
  });
  // The injected page patch's console is filtered below error level (see
  // window.ts), so it reports which video path a share actually took --
  // MediaStreamTrackGenerator, the canvas fallback, or leaving Chromium's
  // capture untouched, and why -- through here instead.
  ipcMain.on("screenCapture:pageLog", (_event, message: string) =>
    appAudioLog("page:", message),
  );
}
