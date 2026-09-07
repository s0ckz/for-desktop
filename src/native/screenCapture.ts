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
 * Safety net for capture deaths the window-existence/visibility poll cannot
 * see on its own -- the window is still there and, as far as the poll can
 * tell, not hidden, but frames have simply stopped, e.g.
 * VideoProcessorBlt/Map started failing every frame. If no frame has arrived
 * in this long while we still expect them, treat the session as suspect and
 * pause it (see {@link startWatchdogs}) -- but, since this PR, NOT dead: a
 * window can legitimately go quiet for reasons the poll does not catch
 * (occluded but not iconic, moved to another virtual desktop, a fullscreen
 * exclusive app briefly taking the whole output, ...), and ending the native
 * session over that used to cost the share one of for-web's three
 * recoveries per 60s (MAX_RECOVERIES in rtc/state.tsx) for no better reason
 * than a frame gap that would have cleared itself. On the state-readable
 * path this threshold only pauses -- there is deliberately no time-based
 * teardown on this path at all; see the REJECTED note above
 * {@link startWatchdogs} for why. The session is torn down only by the
 * separate fatal no-window-state path at FRAME_WATCHDOG_NO_STATE_MS.
 */
const FRAME_WATCHDOG_MS = 4000;
/**
 * Same idea as FRAME_WATCHDOG_MS, but for the one case where the frame
 * watchdog is genuinely all we have: `windowStateForSourceId`
 * (win-app-audio) returned null, meaning that module never loaded, so the
 * poll in {@link startWatchdogs} cannot tell "window hidden" from "window
 * gone" from "capture thread died" -- it just returns without touching
 * anything. With no visibility signal at all, a stalled frame stream is the
 * only evidence of death this module can see, so on this path alone the
 * watchdog stays fatal, the way the single unconditional FRAME_WATCHDOG_MS
 * did for every session before this PR. The threshold is longer than that
 * old value (15s vs 4s) because it is now this path's ONLY safety net rather
 * than one signal among several, and a share is worth a few extra seconds of
 * frozen frame to avoid ending it over a window that may simply be minimised
 * with no way here to prove otherwise.
 */
const FRAME_WATCHDOG_NO_STATE_MS = 15000;
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

/**
 * Why native capture is not currently engaged, for the *page-visible* log
 * only (app-audio.log already gets the specific reason from the appAudioLog
 * call next to each assignment below). Cleared by {@link stop} so a reason
 * from an earlier share never bleeds into a later one that never even
 * attempts the native path -- e.g. a screen source, or
 * --window-shares-as-screen, both of which skip {@link startForSource}
 * entirely. Null while a session is active.
 */
let lastFallbackReason: string | null = null;

/**
 * Why the native capture session that was last running ended. Exposed on
 * {@link buildState}'s separate `stopReason` field -- deliberately NOT the
 * same field as `reason` (`lastFallbackReason` above), which answers "why
 * did native capture never engage for this share" and is already consumed
 * by the injected page patch at appAudioPatch.ts:518-519. Overloading one
 * field to answer both questions would make e.g. `reason: "window-gone"`
 * ambiguous between "capture never started because the source wasn't a
 * window" (not actually a real value today, but the shape of the ambiguity)
 * and "capture started, then the window went away" -- two different
 * situations for the page's own logging, and for for-web's recovery-budget
 * accounting, to tell apart.
 *
 * - "stopped": the ordinary case -- the `screenCapture:stop` IPC handler,
 *   i.e. a user- or page-driven end of the share.
 * - "window-gone": the window-existence poll in {@link startWatchdogs} found
 *   `state.exists === false`.
 * - "capture-error": the fatal FRAME_WATCHDOG_NO_STATE_MS watchdog path
 *   fired (no window-state signal available at all). See the REJECTED
 *   comment above {@link startWatchdogs} for why `lastError()` itself is not
 *   what decides this, and the note there for why the state-readable path
 *   has no time-based equivalent -- A3 item 5 will add the real signal for
 *   that path.
 * - "superseded": {@link startForSource}'s own pre-start `stop()` call, or
 *   one of window.ts's two pre-start calls (the armed-reacquire fast path
 *   and the fresh-picker-answer path) -- the session is not ending on its
 *   own, it is being replaced by the one about to start. for-web's
 *   recovery-budget accounting keys off this to avoid counting a supersede
 *   as a failure.
 *
 * Null while a session is active, and cleared the moment a new one starts
 * successfully -- same lifecycle as `lastFallbackReason`, just answering a
 * different question. See {@link stop} and {@link startForSource} for where
 * it is set and cleared.
 */
export type StopReason =
  | "stopped"
  | "window-gone"
  | "capture-error"
  | "superseded";

/** See {@link StopReason}'s doc comment. */
let stopReason: StopReason | null = null;

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
   * Set by the frame watchdog in {@link startWatchdogs} the instant no frame
   * has arrived for FRAME_WATCHDOG_MS, cleared by {@link onFrame} the moment
   * a frame arrives again. This is the *only* thing that sets or clears this
   * field -- {@link hiddenByPoll} below exists as a separate field for
   * exactly this reason. Before this PR both concerns shared one `paused`
   * flag, and the window-existence/visibility poll (every 1s) and the frame
   * watchdog (also every 1s, on its own clock) fought over who got to set
   * and clear it -- a window that was hidden-but-not-iconic could get marked
   * paused by the frame watchdog and then immediately un-paused by the
   * poll's own resume branch even though it was still hidden, or the reverse.
   * Splitting them means each owns exactly the signal it can actually
   * observe: the poll knows window visibility, the watchdog knows frame
   * arrival, neither has to guess at the other's reason for the current
   * state, and the capture session survives either kind of pause -- see both
   * fields' call sites for why.
   */
  paused: boolean;
  /**
   * Set true by the {@link startWatchdogs} poll when `windowStateForSourceId`
   * reports the window minimised OR simply not visible (occluded, on
   * another virtual desktop, etc. -- anything short of "gone"), cleared when
   * it reports neither. Distinct from {@link paused} -- see that field's doc
   * comment for why they cannot be the same flag. This is purely descriptive
   * bookkeeping for the transition log lines below; the frame watchdog does
   * not read it, because a hidden window naturally stops producing frames on
   * its own and will hit the ordinary FRAME_WATCHDOG_MS pause a few seconds
   * later regardless of this flag.
   */
  hiddenByPoll: boolean;
  /**
   * Whether the most recent poll tick could read `windowStateForSourceId` at
   * all. False for the whole process life whenever win-app-audio failed to
   * load (see that function's null return) -- there is no retry, so in
   * practice this is either always true or always false for a given
   * process, but it is tracked per-session rather than re-derived from a
   * module-level flag so the frame watchdog only has to look in one place.
   * Selects which of FRAME_WATCHDOG_MS (state readable: non-fatal pause) or
   * FRAME_WATCHDOG_NO_STATE_MS (state unreadable: fatal) the watchdog
   * applies -- see both constants' doc comments.
   */
  stateReadable: boolean;
  /**
   * Latest counters off the frame metadata (see native/win-capture/index.d.ts),
   * kept here so the watchdog's death log can report them alongside
   * lastError() -- see {@link startWatchdogs}. `refused` is JS-side
   * backpressure; `poolResizes` is how many times the frame pool was
   * recreated for a content-size change this session. A death with
   * `poolResizes` climbing was mid-resize when it happened; a death at zero
   * is a genuine capture failure.
   */
  refused: number;
  poolResizes: number;
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
  // Belt and braces on top of stop()'s own clear: every return path below
  // already sets this to something specific (or to null on success), but
  // clearing it here too means a future early-return branch that forgets to
  // set it can never leak a previous, unrelated share's reason instead.
  lastFallbackReason = null;
  const mod = loadNative();
  if (!mod) {
    lastFallbackReason = `native module not loaded: ${nativeLoadError}`;
    appAudioLog(
      "screen capture: no native GPU path, falling back to Chromium capture: native module not loaded:",
      nativeLoadError,
    );
    return false;
  }
  if (!mod.isSupported()) {
    lastFallbackReason = "OS/GPU reports unsupported";
    appAudioLog(
      "screen capture: no native GPU path, falling back to Chromium capture: OS/GPU reports unsupported",
    );
    return false;
  }

  const hwnd = windowHandleFromSourceId(sourceId);
  if (!hwnd) {
    // Screen sources have no window handle; this module only ever handles
    // window shares, by design (see the plan's scope boundary).
    lastFallbackReason = "source is not a window";
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
    lastFallbackReason = `native path disabled after ${consecutiveFailures} consecutive failures`;
    appAudioLog(
      `screen capture: native path disabled after ${consecutiveFailures} consecutive failures, using Chromium capture; lastError:`,
      mod.lastError(),
    );
    return false;
  }

  // "superseded", not the "stopped" default: whatever was running before
  // this attempt is being replaced by it, not user/page-stopped. See
  // StopReason's doc comment. If the attempt below fails to actually start,
  // the `!started`/catch branches undo this -- see their comments.
  stop("superseded");

  try {
    const started = mod.start(
      hwnd,
      CAPTURE_TARGET_WIDTH,
      CAPTURE_TARGET_HEIGHT,
      fps,
      (frame: Buffer, meta) => onFrame(frame, meta),
    );
    if (!started) {
      lastFallbackReason = `native start() returned false: ${mod.lastError()}`;
      // This attempt never actually started, so the `stop("superseded")`
      // call above must not leave buildState() claiming the *previous*
      // session was superseded by something that never took over --
      // lastFallbackReason (the `reason` field) already carries the real
      // story for this failed attempt. See StopReason's doc comment.
      stopReason = null;
      appAudioLog(
        "screen capture: native start() returned false, falling back to Chromium capture:",
        mod.lastError(),
      );
      return false;
    }
  } catch (err) {
    lastFallbackReason = `native start() threw: ${String(err)}`;
    // See the comment on the `!started` branch above -- same reasoning.
    stopReason = null;
    appAudioLog(
      "screen capture: native start() threw, falling back to Chromium capture:",
      String(err),
      "lastError:",
      mod.lastError(),
    );
    return false;
  }

  lastFallbackReason = null;
  // A new session is starting cleanly, so whatever ended the last one is no
  // longer news -- see StopReason's doc comment.
  stopReason = null;
  active = {
    sourceId,
    hwnd,
    fps,
    width: CAPTURE_TARGET_WIDTH,
    height: CAPTURE_TARGET_HEIGHT,
    lastFrameAt: Date.now(),
    startedAt: Date.now(),
    paused: false,
    hiddenByPoll: false,
    stateReadable: true,
    refused: 0,
    poolResizes: 0,
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
  meta: {
    width: number;
    height: number;
    bltMs: number;
    grabMs: number;
    refused: number;
    poolResizes: number;
  },
) {
  if (!active) return;
  const now = Date.now();
  const wasPaused = active.paused;
  active.lastFrameAt = now;
  active.width = meta.width;
  active.height = meta.height;
  active.refused = meta.refused;
  active.poolResizes = meta.poolResizes;

  // One-shot, alongside the lastFrameAt update above: the frame watchdog in
  // {@link startWatchdogs} is the only thing that sets `paused`, this is the
  // only thing that clears it, and this is the transition, not every frame
  // while already unpaused.
  if (wasPaused) {
    active.paused = false;
    appAudioLog("screen capture: frames resuming for", active.sourceId);
  }

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

/**
 * REJECTED: stopping (or counting as a native-path failure) whenever
 * `mod.lastError()` reports something, on the theory that a real capture
 * error means the capture thread has exited. The original plan for this PR
 * said exactly that ("stop when lastError() reports a real capture error --
 * thread exited"), and it is wrong. Checked against
 * native/win-capture/src/addon.cc:
 *
 * - `g_lastError` is cleared ONLY inside `Start()` (addon.cc:887) -- it is
 *   sticky for the whole session. Once anything sets it, `lastError()` keeps
 *   returning that same message on every later call until the next
 *   `start()`, whether or not the capture thread is still running and
 *   perfectly healthy.
 * - It gets set on several transient, self-recovering per-frame paths where
 *   the capture thread carries on regardless: `get_Surface` (addon.cc:651),
 *   `QueryInterface(IDirect3DDxgiInterfaceAccess)` (addon.cc:660) and
 *   `GetInterface` (addon.cc:666) each just `continue;` the loop afterward;
 *   and `VideoProcessorBlt` (addon.cc:449) / `Map(staging texture)`
 *   (addon.cc:462) return `false` out of `ProcessFrame`, whose return value
 *   is discarded at its one call site (addon.cc:720) -- the loop does not
 *   even look at it before moving on to the next frame.
 * - The comment block at addon.cc:671-712 documents exactly this: a
 *   `VideoProcessorBlt` failure with `E_INVALIDARG` during a continuous
 *   window resize is an observed, self-recovering condition, not a thread
 *   death -- the fix that block describes exists specifically so that case
 *   stops dropping frames, let alone ending the session.
 * - `Init()` (addon.cc:951-957) exports only `isSupported` / `start` /
 *   `stop` / `setFps` / `lastError` -- there is no run-state export, so
 *   nothing in TypeScript today can distinguish "thread still running, had a
 *   transient hiccup a while ago" from "thread exited" by polling
 *   `lastError()`.
 *
 * Treating `lastError()` as fatal would have ended a share within about one
 * second of the first harmless VideoProcessorBlt hiccup (WINDOW_POLL_MS
 * polling against a value that a resize can set at any moment and that never
 * clears itself), and done it twice over: once by ending the session
 * outright, and again by counting toward MAX_NATIVE_FAILURES and eventually
 * disabling the native path for the rest of the process's life over
 * something that was never a failure to begin with.
 *
 * So `lastError()` is called ONLY as diagnostic context appended to the log
 * line of the one path that actually stops the session below
 * (FRAME_WATCHDOG_NO_STATE_MS) -- exactly how the pre-this-PR code used it.
 * The correct fatal signal does not exist yet: PR A3 item 5 has the addon
 * invoke the ThreadSafeFunction once on loop exit with a null frame and a
 * reason, and once that lands, `stop("capture-error")` on that path should
 * be driven by that callback instead of by this timeout guessing.
 */
/**
 * REJECTED: a second, longer timeout on the state-readable path (there used
 * to be one here, FRAME_WATCHDOG_HARD_LEAK_MS) ending the session after
 * minutes of silence even though the poll keeps confirming the window is
 * fine. `state.visible` is `IsWindowVisible`, reflecting only WS_VISIBLE --
 * it stays true for an occluded or alt-tabbed window, so the headline
 * scenario (share a fullscreen game, alt-tab away) leaves `hiddenByPoll`
 * false and the guard fires anyway. That is worse than the bug it guarded
 * against: `stop()` ends native capture but leaves the page's generated
 * track frozen instead of `ended`, so for-web never recovers -- permanently
 * frozen, no path back. No unbounded leak to guard against either: the poll
 * ends the session the instant the window closes (`state.exists === false`
 * above). The genuine "capture thread died" signal does not exist yet (A3
 * item 5 above); that, not a clock, should drive `stop("capture-error")`
 * here once it lands.
 */
function startWatchdogs() {
  stopWatchdogs();
  pollTimer = setInterval(() => {
    if (!active) return;
    const state = windowStateForSourceId(active.sourceId);
    active.stateReadable = state !== null;
    // No native audio module loaded means no way to tell this way; the frame
    // watchdog below (at FRAME_WATCHDOG_NO_STATE_MS) is what's left.
    if (!state) return;
    if (!state.exists) {
      appAudioLog(
        "screen capture: captured window is gone, ending native capture for",
        active.sourceId,
      );
      stop("window-gone");
      return;
    }

    // Minimised OR simply not visible (occluded by another window, moved to
    // another virtual desktop, ...) both mean WGC has nothing to hand us
    // right now, but neither means the window is gone, and the capture
    // session survives either just fine -- the addon's loop only bails on
    // !IsWindow(), which both states still satisfy. Before this PR only
    // `iconic` was checked here, so a window that was merely occluded (not
    // minimised) fell straight through to the frame watchdog's old,
    // unconditionally fatal path the moment frames stopped. Tearing the
    // share down over either case is unnecessary, and actively harmful:
    // every teardown used to spend one of for-web's three recoveries per 60s
    // (MAX_RECOVERIES in rtc/state.tsx), and minimising or losing focus a
    // few times in quick succession could exhaust that budget and kill the
    // share for good.
    //
    // Leave the session running instead. The viewer sees the last frame held
    // until the window comes back, which is a far better outcome than the
    // share ending. This sets `hiddenByPoll`, deliberately not `paused` --
    // see that field's doc comment for why the two must not be the same
    // flag.
    const hidden = state.iconic || !state.visible;
    if (hidden && !active.hiddenByPoll) {
      active.hiddenByPoll = true;
      appAudioLog(
        "screen capture: window hidden or minimised, holding the session open (no frames until restored) for",
        active.sourceId,
      );
    } else if (!hidden && active.hiddenByPoll) {
      active.hiddenByPoll = false;
      // Deliberately not "frames resuming" -- that wording belongs to
      // {@link onFrame}, which is the only place that can actually confirm a
      // frame arrived. All the poll can confirm is that the window is
      // visible again; whether WGC has delivered anything yet is a separate
      // question the frame watchdog below answers.
      appAudioLog(
        "screen capture: window restored, resuming normal capture for",
        active.sourceId,
      );
    }
  }, WINDOW_POLL_MS);
  watchdogTimer = setInterval(() => {
    if (!active) return;
    const now = Date.now();
    const droughtMs = now - active.lastFrameAt;

    if (!active.stateReadable) {
      // Fatal path -- see FRAME_WATCHDOG_NO_STATE_MS's doc comment for why
      // this one alone stays fatal instead of pausing like the
      // state-readable path below.
      if (droughtMs > FRAME_WATCHDOG_NO_STATE_MS) {
        const mod = loadNative();
        consecutiveFailures++;
        appAudioLog(
          "screen capture: no frames for",
          FRAME_WATCHDOG_NO_STATE_MS,
          `ms with no window-state signal available, ending native capture (failure ${consecutiveFailures}/${MAX_NATIVE_FAILURES}); lastError:`,
          mod?.lastError() ?? "(unknown)",
          `; refused=${active.refused} poolResizes=${active.poolResizes}`,
        );
        stop("capture-error");
      }
      return;
    }

    // Non-fatal: see FRAME_WATCHDOG_MS's doc comment. Logged once on the
    // transition into paused -- {@link onFrame} is the only thing that
    // clears `paused`, and does its own one-shot "resuming" log there.
    if (droughtMs > FRAME_WATCHDOG_MS && !active.paused) {
      active.paused = true;
      appAudioLog(
        "screen capture: no frames for",
        FRAME_WATCHDOG_MS,
        "ms, holding the session open (window state does not explain the gap) for",
        active.sourceId,
      );
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

/**
 * Reset the consecutive-failure counter kept by {@link MAX_NATIVE_FAILURES}.
 *
 * Call this when a *new* share begins -- the user answered the picker, or the
 * single-source Wayland shortcut fired -- never on the armed-reacquire fast
 * path in window.ts, which recovers the *same* share rather than starting a
 * fresh one. Recovery must keep the within-share budget intact, since that is
 * what stops one pathological window from retrying forever (each retry costs
 * ~4s of black plus a visible stop/start for viewers); a genuinely new share
 * deserves a clean slate instead of inheriting a previous window's failures.
 */
export function resetNativeFailures() {
  if (consecutiveFailures > 0) {
    appAudioLog(
      `screen capture: new share started, clearing native failure count (was ${consecutiveFailures})`,
    );
  }
  consecutiveFailures = 0;
}

/** Stops whatever native capture is running, without touching our own
 *  bookkeeping. Split out of stop() so it can run unconditionally there,
 *  ahead of the `!active` check -- see stop()'s comment for why. */
function stopNative() {
  const mod = loadNative();
  try {
    mod?.stop();
  } catch {
    /* already stopped */
  }
}

/**
 * Ends whatever native capture session is running, if any.
 * @param reason Why -- see {@link StopReason}'s doc comment. Defaults to the
 *   ordinary "stopped" (a user- or page-driven end); every call site that
 *   ends a session for a more specific reason passes one explicitly.
 */
export function stop(reason: StopReason = "stopped") {
  stopWatchdogs();
  // Unconditionally, not `if (active)`. Native stop() is a no-op when nothing
  // is capturing, so this is free in the common case -- and `active` is not a
  // trustworthy proxy for "native is idle" (same reasoning as appAudio.ts's
  // beginCapture): a native session that ever started without `active` being
  // set would otherwise survive an exported stop() that already cleared it,
  // leaving every later start() throw "capture already running" for the rest
  // of the process's life.
  stopNative();
  // Scope the fallback reason to the share that is about to start (or that
  // never even attempts native capture, e.g. a screen source) -- see
  // lastFallbackReason's doc comment for why this must happen here rather
  // than only inside startForSource.
  lastFallbackReason = null;
  // Also touched unconditionally, same scoping reason as lastFallbackReason
  // above -- but only *records* `reason` when a session was truly active.
  // startForSource's pre-start call and window.ts's two pre-start calls all
  // run `stop("superseded")` whether or not native was actually running (a
  // screen source, or a share that never reaches native start(), never had
  // a session to supersede), so buildState() must not report "superseded"
  // for a session that never existed; null it instead of leaving an
  // unrelated earlier session's reason lingering. startForSource's own
  // `!started`/catch branches still explicitly null this out afterward --
  // needed when `reason` above *was* recorded (a real session really was
  // superseded, then the replacement failed to start). See StopReason's doc
  // comment.
  stopReason = active ? reason : null;
  if (!active) return;
  appAudioLog(
    `screen capture: stopped native capture for ${active.sourceId} (${reason})`,
  );
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
    // Why native capture is not engaged for the share the page is asking
    // about right now, if it isn't -- see lastFallbackReason's doc comment.
    // The page's own log (appAudioPatch.ts) had no reason at all before this;
    // app-audio.log always did, from the appAudioLog call next to each
    // assignment.
    reason: active ? null : lastFallbackReason,
    // Why the most recently active session ended -- a different question
    // from `reason` just above (see StopReason's doc comment for the split).
    // Null while a session is active.
    stopReason: active ? null : stopReason,
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
  ipcMain.on("screenCapture:stop", () => stop("stopped"));
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
