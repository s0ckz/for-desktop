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
  createLogRateLimiter,
  windowHandleFromSourceId,
  windowStateForSourceId,
} from "./appAudio";

export const SCREEN_CAPTURE_STATE = "screenCapture:state";
/** One-time handoff channel: carries the {@link MessageChannelMain} port the
 *  preload should use for frame delivery from here on -- see
 *  {@link setFramePort}'s doc comment. */
export const SCREEN_CAPTURE_FRAME_PORT = "screenCapture:framePort";

// `for-web` no longer requests a capture resolution at getDisplayMedia time
// (PR #6 removed it on purpose -- asking WGC for a smaller surface does not
// make it grab fewer pixels, it just rescales what it grabbed). So this is
// only the INITIAL target, used until the first mid-share preset change (see
// setLiveTarget/mod.setTarget below, PR C3 item 1): the share picker resolves
// after capture has already started, and the chosen preset's resolution
// arrives the same way its framerate already does, as a mid-share
// applyConstraints() forwarded through screenCaptureBridge.setTarget() in the
// page patch. Before that lands, native scales to fit inside this box; after,
// it re-keys the GPU video processor to fit inside the picked box instead --
// see EnsurePipeline in addon.cc -- so scaleResolutionDownBy (computed by
// for-web from the generated track's `getSettings()` override in
// appAudioPatch.ts, which reports the true delivered size) settles to 1
// instead of doing a per-frame libyuv CPU downscale on the encoder queue.
export const CAPTURE_TARGET_WIDTH = 1920;
export const CAPTURE_TARGET_HEIGHT = 1080;

/** Sane bounds for {@link setLiveTarget}; mirrors MIN/MAX_REQUESTABLE_FPS
 *  below. Mostly a defence against a clearly-wrong value crossing IPC from a
 *  remote page -- the real ceiling is EnsurePipeline's own fit-inside clamp
 *  in addon.cc, which never upscales regardless of what is requested here. */
const MIN_TARGET_DIMENSION = 2;
const MAX_TARGET_DIMENSION = 8192;

/**
 * How often we check that the captured window still exists.
 *
 * The capture thread notices a gone window internally (`IsWindow(hwnd)`
 * inside the poll loop in src/addon.cc) and exits, and {@link onFrame}'s
 * null-frame branch now hears about that exit directly (A3 item 5). But
 * Chromium's own capturer -- what for-web's `screenShare:reacquire` actually
 * reacts to -- has no idea any of this happened, since it never owned these
 * pixels to begin with. So this module still polls, reusing win-app-audio's
 * `windowState` (win-capture exposes no equivalent) to detect the same
 * condition on a signal Chromium's side can act on.
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
 * How often {@link onFrame} writes a rolling health summary to app-audio.log
 * for a session that is alive but degraded (plan PR C4 item 2). Before this,
 * app-audio.log only ever heard from a session when it died -- the death
 * branch in {@link onFrame} -- so a share that was merely slow (heavy
 * refusal, a GPU-contended bltMs) left no trace at all short of a crash
 * report. 10s is short enough to catch a share that degrades mid-call and
 * long enough that the per-frame bookkeeping this adds (a few float adds,
 * see {@link onFrame}) stays well under noise at up to 60fps.
 */
const SUMMARY_INTERVAL_MS = 10000;
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
  /**
   * The bounding box last REQUESTED of native (via startForSource's initial
   * mod.start() call, or a later {@link setLiveTarget} mid-share change) --
   * as opposed to {@link width}/{@link height} just above, which report the
   * real delivered size once a frame has arrived (see buildState()'s own
   * comment). Needed as a separate pair specifically so setLiveTarget can
   * tell "no-op, already at this box" apart from "really changed": comparing
   * against width/height instead would almost never match, since those hold
   * the aspect-preserved *delivered* size (e.g. 1280x720) rather than the
   * *requested* one (e.g. 1280x720 was itself derived by fitting inside some
   * other box for-web actually asked for).
   */
  targetWidth: number;
  targetHeight: number;
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
  /** Cumulative DXGI_ERROR_WAS_STILL_DRAWING skips -- see {@link LiveFrameMeta}. */
  stillDrawing: number;
  /** Cumulative timestamp-pacing fallbacks -- see {@link LiveFrameMeta}.
   *  Kept here (not only in `summary`) so {@link onFrame} can edge-detect
   *  0 -> nonzero against the *previous* frame's value, independent of
   *  whether a 10s window happens to be closing on this exact frame. */
  timestampFallbacks: number;
  /** Cumulative pacing-clock re-baselines -- see {@link LiveFrameMeta}. Kept
   *  here (not only in `summary`) for the same edge-detect reason as
   *  `timestampFallbacks` just above: a distinct event from it (see
   *  addon.cc's g_timestampDiscontinuities doc comment for why these two
   *  are not folded into one counter), so it needs its own previous-value
   *  slot rather than sharing `timestampFallbacks`'s. */
  timestampDiscontinuities: number;
  /**
   * Identifies which request started this session. Assigned by window.ts at
   * the top of each display-media request, before any `await` -- so two
   * requests racing through the async chain in `respondToDisplayMedia` still
   * get IDs in true arrival order, letting {@link stop} and {@link onFrame}
   * refuse to act on a session that has since been superseded. See item 4 of
   * the A3 plan.
   */
  sessionId: number;
  /**
   * Rolling-summary accumulators for {@link onFrame}'s live branch (plan PR
   * C4 item 2) -- grouped here, not module-level, specifically so a fresh
   * `active` object at the top of {@link startForSource} resets them for
   * free, the same way every other per-session field above does. A
   * module-level accumulator would otherwise let a share's tail numbers
   * bleed into the next share's opening window.
   */
  summary: {
    /** {@link Date.now} at the start of the window currently accumulating. */
    windowStartMs: number;
    /** Frames native actually produced and handed to {@link onFrame} this
     *  window -- the first stage in the pipeline plan PR "no frames" item 6
     *  wants visible on its own, distinct from `posted` below. */
    frames: number;
    bltMsSum: number;
    grabMsSum: number;
    /** `refused` as of the last emitted summary (or session start), so the
     *  next one can log the delta rather than the running total. */
    refusedAtWindowStart: number;
    /** `stillDrawing` as of the last emitted summary -- same delta pattern
     *  as `refusedAtWindowStart`. */
    stillDrawingAtWindowStart: number;
    /** `timestampDiscontinuities` as of the last emitted summary -- same
     *  delta pattern as `refusedAtWindowStart`. Normally the delta is 0 for
     *  the whole session; nonzero in a window is what gives a session that
     *  actually hit the clock-discontinuity guard in addon.cc's
     *  CaptureThread a trace beyond the one-shot edge-detect log in
     *  {@link onFrame}. */
    discontinuitiesAtWindowStart: number;
    /** Frames actually handed to `framePort.postMessage` this window (a
     *  frame native produced but that arrived for a session already
     *  superseded, or with no port registered, does not count) -- reset
     *  every window, not cumulative, so this is a plain count rather than a
     *  delta-off-cumulative like `refused`/`stillDrawing` above. Comparing
     *  this against `frames` in the same log line is what tells "native
     *  isn't producing anything" (both near 0) apart from "native is fine,
     *  delivery to the renderer is the broken stage" (`frames` healthy,
     *  `posted` not). */
    posted: number;
    /** `VideoFrame` construction failures the injected page patch reported
     *  this window (plan PR "no frames" item 6) -- see the
     *  screenCapture:pageDrop handler in {@link initScreenCapture} and
     *  {@link APP_AUDIO_PATCH}'s two `new VideoFrame(...)` call sites. Reset
     *  every window, same reasoning as `posted`. Renderer-side, so a
     *  `frames`/`posted` pair that both look healthy alongside this
     *  climbing is what points at the *renderer's* frame construction as
     *  the dropped stage, rather than anything in this file or addon.cc. */
    videoFrameFailures: number;
  };
} | null = null;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The main-process end of the dedicated frame-delivery channel (plan PR A4
 * item 2), set by {@link setFramePort}. Frames used to go out via
 * `BrowserWindow.getAllWindows()[0].webContents.send` -- a guess at which
 * window wanted them (wrong the moment a second window exists) that also put
 * every 3MB-ish frame on the same generic `ipcMain`/`ipcRenderer` channel as
 * everything else the app sends. A `MessageChannelMain` port is a direct pipe
 * to the one renderer that actually asked for it, established fresh by
 * `native/window.ts` on every `did-finish-load`.
 */
let framePort: Electron.MessagePortMain | null = null;

/**
 * Wire (or rewire) the frame-delivery port. `native/window.ts` calls this
 * once per `did-finish-load` -- including a reload, which is exactly why the
 * previous port is explicitly {@link MessagePortMain.close}d here rather than
 * dropped on the floor: `MessagePortMain` has no finalizer that closes it for
 * you, so leaving the old one for GC would leak one native port handle per
 * reload for the life of the process.
 */
export function setFramePort(port: Electron.MessagePortMain | null) {
  if (framePort) {
    try {
      framePort.close();
    } catch {
      /* already closed */
    }
  }
  framePort = port;
}

/**
 * Cached answer from the native isSupported() probe (item 6). Each call does
 * a full RoInitialize plus a factory activation, and buildState() calls this
 * on every broadcastState() -- every frame-rate change, every watchdog
 * transition -- so an uncached call turns "just report state" into
 * "reprobe the OS/GPU" on a hot path. Hardware/OS capability cannot change
 * mid-process (a GPU driver does not appear or disappear while this process
 * is running), so the first answer is good for the process's life; null
 * means "not probed yet", not "unsupported" -- see below.
 */
let cachedSupported: boolean | null = null;

export function isScreenCaptureSupported(): boolean {
  if (cachedSupported !== null) return cachedSupported;
  const mod = loadNative();
  // Not cached: `!mod` is already a cheap check (loadNative() itself is a
  // one-shot try, so this stays true or false for the process's life without
  // help), and caching `false` here would be wrong if the module somehow
  // loaded later than this particular call.
  if (!mod) return false;
  try {
    cachedSupported = process.platform === "win32" && mod.isSupported();
  } catch {
    cachedSupported = false;
  }
  return cachedSupported;
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
 * @param sessionId Identity of the request starting this session -- see
 *   {@link active}'s doc comment. Threaded into the pre-start `stop()` call
 *   below and stamped onto `active` so a later stale caller can never affect
 *   this session once it exists.
 */
export async function startForSource(
  sourceId: string,
  fps: number,
  sessionId: number,
): Promise<boolean> {
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
  if (!isScreenCaptureSupported()) {
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

  // A stop() from an earlier attempt (this share's own supersede below, a
  // death signal from onFrame, a watchdog teardown, ...) may still be
  // joining the capture thread on the libuv threadpool -- see nativeBusy's
  // doc comment above stopNative(). mod.start() would just throw "previous
  // capture still shutting down" in that case; failing fast here skips the
  // pointless round trip through stop()/mod.start() and reaches the same
  // fallback outcome without spending another NATIVE_STOP_TIMEOUT_MS racing
  // a second timeout against a join we already know is running long.
  if (nativeBusy) {
    lastFallbackReason = "native stop still pending";
    appAudioLog(
      "screen capture: previous native stop still in flight, falling back to Chromium capture",
    );
    return false;
  }

  // "superseded", not the "stopped" default: whatever was running before
  // this attempt is being replaced by it, not user/page-stopped. See
  // StopReason's doc comment. Passing sessionId means this is a no-op
  // instead if a still-newer request already replaced whatever we think
  // we're superseding (item 4) -- the mod.start() below then fails with
  // "capture already running" and falls back to Chromium capture, same as
  // any other start failure. If the attempt below fails to actually start,
  // the `!started`/catch branches undo this -- see their comments.
  //
  // Awaited (item 4): stop()'s JS-visible bookkeeping (active, broadcastState)
  // already happened synchronously inside stop() itself by the time this
  // resolves -- what we're actually waiting on here is stopNative()'s race,
  // so mod.start() below never runs while the native side still considers
  // itself mid-teardown.
  await stop("superseded", sessionId);

  // The await above is also the call whose own stopNative() could be the one
  // that just timed out -- nativeBusy can only be known for certain once it
  // returns, so it's checked again rather than trusting the pre-check alone.
  if (nativeBusy) {
    lastFallbackReason = "native stop still pending";
    appAudioLog(
      "screen capture: native stop did not finish in time, falling back to Chromium capture",
    );
    return false;
  }

  try {
    const started = mod.start(
      hwnd,
      CAPTURE_TARGET_WIDTH,
      CAPTURE_TARGET_HEIGHT,
      fps,
      (frame, meta) => onFrame(frame, meta, sessionId),
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
    targetWidth: CAPTURE_TARGET_WIDTH,
    targetHeight: CAPTURE_TARGET_HEIGHT,
    lastFrameAt: Date.now(),
    startedAt: Date.now(),
    paused: false,
    hiddenByPoll: false,
    stateReadable: true,
    refused: 0,
    poolResizes: 0,
    stillDrawing: 0,
    timestampFallbacks: 0,
    timestampDiscontinuities: 0,
    sessionId,
    summary: {
      windowStartMs: Date.now(),
      frames: 0,
      bltMsSum: 0,
      grabMsSum: 0,
      refusedAtWindowStart: 0,
      stillDrawingAtWindowStart: 0,
      discontinuitiesAtWindowStart: 0,
      posted: 0,
      videoFrameFailures: 0,
    },
  };
  appAudioLog(
    `screen capture: native GPU path active for ${sourceId} (hwnd ${hwnd}), target ${CAPTURE_TARGET_WIDTH}x${CAPTURE_TARGET_HEIGHT}@${fps}fps`,
  );
  startWatchdogs();
  broadcastState();
  return true;
}

/** Meta for a live frame -- see native/win-capture/index.d.ts's `start()`. */
type LiveFrameMeta = {
  width: number;
  height: number;
  bltMs: number;
  grabMs: number;
  refused: number;
  poolResizes: number;
  /** Cumulative DXGI_ERROR_WAS_STILL_DRAWING skips this session -- see
   *  index.d.ts's doc comment. An ordinary pacing drop, not a failure, but
   *  one that fed into "0 fps" while it was silent (plan PR "no frames"
   *  item 1) -- now folded into the 10s summary below so a session stuck
   *  incrementing this on every frame is visible instead of looking exactly
   *  like a healthy session with nothing to deliver. */
  stillDrawing: number;
  /** Cumulative timestamp-pacing fallbacks this session (native's
   *  get_SystemRelativeTime() failed, or read a zero Duration, and fell
   *  back to a QPC wall clock) -- see index.d.ts's doc comment. Normally 0
   *  for the whole session; {@link onFrame} logs once on the 0 -> nonzero
   *  edge. */
  timestampFallbacks: number;
  /** Cumulative pacing-clock re-baselines this session (native's pacing
   *  `ts` -- from either clock -- read as landing BEFORE the previous
   *  delivered frame's, and reset instead of stalling delivery) -- see
   *  index.d.ts's doc comment. A separate counter from `timestampFallbacks`;
   *  normally 0 for the whole session; {@link onFrame} logs once on the
   *  0 -> nonzero edge, same as `timestampFallbacks`. */
  timestampDiscontinuities: number;
  /** This frame's own capture timestamp (microseconds) -- see index.d.ts's
   *  doc comment on the same field for what it's relative to and how the
   *  page patch uses it. */
  timestampUs: number;
};

/** Meta for the one death-signal call on capture-thread exit (`frame` null)
 *  -- no width/height/bltMs/grabMs, see index.d.ts. */
type DeathFrameMeta = {
  refused: number;
  poolResizes: number;
  stillDrawing: number;
  timestampFallbacks: number;
  timestampDiscontinuities: number;
  reason: string;
};

function onFrame(
  frame: Buffer | null,
  meta: LiveFrameMeta | DeathFrameMeta,
  sessionId: number,
) {
  if (!active) return;
  if (frame === null) {
    // The capture thread exited -- addon.cc invokes the TSFN once more on
    // loop exit with a null frame and lastError() as `reason`, so death no
    // longer has to be inferred from a frame drought (item 5). sessionId
    // scopes this to the session that actually died: stop() itself also
    // checks it, so a dead thread's signal, queued before a newer session
    // replaced this one, can never end the wrong session -- see item 4 and
    // StopReason's doc comment.
    //
    // Asserted, not narrowed: TS can't tie `meta`'s type to the `frame ===
    // null` check above on its own (they're separate parameters) -- but
    // index.d.ts's two call signatures guarantee this shape whenever `frame`
    // is null, so this is exactly the case the union type exists to catch if
    // it were ever violated at the one call site (startForSource, above).
    const death = meta as DeathFrameMeta;
    appAudioLog(
      "screen capture: native capture thread exited:",
      death.reason || "(no reason given)",
      `; refused=${death.refused} poolResizes=${death.poolResizes} stillDrawing=${death.stillDrawing} timestampFallbacks=${death.timestampFallbacks} timestampDiscontinuities=${death.timestampDiscontinuities}`,
    );
    // onFrame is a native callback, not an async context, so this cannot
    // await -- fire it and move on. Safe to leave unhandled: stop()'s
    // returned promise can never reject (see stopNative()'s doc comment),
    // and the JS-visible bookkeeping (active, broadcastState) it does
    // happens synchronously before this statement even returns, so nothing
    // here needs to wait on the native join to have already taken effect.
    void stop("capture-error", sessionId);
    return;
  }
  // Same reasoning as the death branch above, mirrored for the live case.
  const live = meta as LiveFrameMeta;
  const now = Date.now();
  const wasPaused = active.paused;
  active.lastFrameAt = now;
  active.width = live.width;
  active.height = live.height;
  active.refused = live.refused;
  active.poolResizes = live.poolResizes;
  active.stillDrawing = live.stillDrawing;
  // Edge-detected against the PREVIOUS frame's value (read before
  // overwriting it below), same one-shot reasoning as the `wasPaused` check
  // just below this block: a fallback that engaged once is worth a single
  // note in app-audio.log, not a line on every later frame for the rest of
  // the session it stays engaged.
  if (active.timestampFallbacks === 0 && live.timestampFallbacks > 0) {
    appAudioLog(
      "screen capture: native timestamp pacing fell back to a QPC wall clock at least once for",
      active.sourceId,
      "(get_SystemRelativeTime failed or read a zero Duration -- see addon.cc's QpcNow100ns)",
    );
  }
  active.timestampFallbacks = live.timestampFallbacks;
  // Same edge-detect pattern as `timestampFallbacks` just above, and
  // deliberately a separate check against a separate previous value rather
  // than folded into it -- see addon.cc's g_timestampDiscontinuities doc
  // comment for why a fallback engaging and a discontinuity firing are not
  // the same event, so one 0 -> nonzero edge does not imply the other.
  if (
    active.timestampDiscontinuities === 0 &&
    live.timestampDiscontinuities > 0
  ) {
    appAudioLog(
      "screen capture: native pacing clock jumped backwards at least once and was re-baselined for",
      active.sourceId,
      "(see addon.cc's discontinuity guard in CaptureThread)",
    );
  }
  active.timestampDiscontinuities = live.timestampDiscontinuities;

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

  // 10s rolling health summary (plan PR C4 item 2, extended by plan PR "no
  // frames" item 6) -- see SUMMARY_INTERVAL_MS for why this exists. Cheap
  // per frame on purpose: a handful of comparisons/adds, no allocation, no
  // string work until the window actually closes. bltMs/grabMs are summed
  // here and divided once below rather than kept as a running mean, since a
  // running mean needs the same divide (and more float error) on every
  // frame for no benefit -- nothing reads the mean until the window closes.
  //
  // `frames`/`posted`/`stillDrawing`/`videoFrameFailures` together name
  // which stage a dead share actually died at, instead of a share that
  // produces nothing being indistinguishable from one that was never asked
  // to produce anything (the failure mode item 6 exists to fix): `frames`
  // near 0 with `stillDrawing` climbing points at addon.cc's staging-ring
  // readback; `frames` healthy but `posted` near 0 points at this file's own
  // port-delivery gating (a stale sessionId, or no port registered);
  // `posted` healthy but `videoFrameFailures` climbing points at the
  // renderer's own `new VideoFrame(...)` calls in appAudioPatch.ts.
  const summary = active.summary;
  summary.frames++;
  summary.bltMsSum += live.bltMs;
  summary.grabMsSum += live.grabMs;
  // Narrowed (not just a boolean) so the postMessage call below gets
  // `framePort`'s non-null type back from TS without an assertion. Computed
  // once, here, rather than re-evaluated at that call site -- nothing async
  // runs between the two uses (this whole function is a synchronous native
  // callback), so re-checking there would just read the same answer twice,
  // not add a freshness guarantee.
  const port = sessionId === active.sessionId ? framePort : null;
  if (port) summary.posted++;
  const summaryElapsedMs = now - summary.windowStartMs;
  if (summaryElapsedMs >= SUMMARY_INTERVAL_MS) {
    const deliveredFps = (summary.frames / summaryElapsedMs) * 1000;
    const refusedDelta = live.refused - summary.refusedAtWindowStart;
    const stillDrawingDelta =
      live.stillDrawing - summary.stillDrawingAtWindowStart;
    // Delta, not the cumulative total -- same reasoning as `refusedDelta`/
    // `stillDrawingDelta` above: a window where this is nonzero is the one
    // that actually hit the clock discontinuity, which the one-shot
    // edge-detect log in this function's live branch would otherwise only
    // ever mention once for the whole session.
    const discontinuitiesDelta =
      live.timestampDiscontinuities - summary.discontinuitiesAtWindowStart;
    const meanBltMs = summary.bltMsSum / summary.frames;
    // grabMs is a Map(DO_NOT_WAIT) poll now, not a blocking GPU wait -- see
    // addon.cc's ProcessFrame -- so near-zero here means healthy, not idle.
    const meanGrabMs = summary.grabMsSum / summary.frames;
    appAudioLog(
      `screen capture: 10s summary for ${active.sourceId}: produced=${summary.frames} (${deliveredFps.toFixed(1)}fps) posted=${summary.posted} refused +${refusedDelta} stillDrawing +${stillDrawingDelta} timestampDiscontinuities +${discontinuitiesDelta} videoFrameFailures=${summary.videoFrameFailures} mean bltMs=${meanBltMs.toFixed(2)} grabMs=${meanGrabMs.toFixed(2)} (grabMs near zero is expected -- DO_NOT_WAIT readback, not a stall)`,
    );
    summary.windowStartMs = now;
    summary.frames = 0;
    summary.bltMsSum = 0;
    summary.grabMsSum = 0;
    summary.refusedAtWindowStart = live.refused;
    summary.stillDrawingAtWindowStart = live.stillDrawing;
    summary.discontinuitiesAtWindowStart = live.timestampDiscontinuities;
    summary.posted = 0;
    summary.videoFrameFailures = 0;
  }

  // Dedicated port delivery (A4 item 2), gated on `sessionId` matching the
  // live session, not just `framePort` existing. This is the "register the
  // port per capture session" half of that item: rather than tracking a
  // second, port-specific session id, it reuses the one `active.sessionId`
  // already carries (see that field's doc comment and `stop()`'s own
  // `sessionId` guard above) as the single source of truth for "who is
  // allowed to deliver right now". A frame from a session already superseded
  // -- in flight on the TSFN queue when a newer session's `active` replaced
  // this one -- is dropped here instead of being misdelivered through the
  // current session's port under the old session's stale width/height.
  if (!port) return;
  port.postMessage({
    frame,
    meta: {
      width: live.width,
      height: live.height,
      timestampUs: live.timestampUs,
    },
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
 * The real fatal signal now exists (A3 item 5): addon.cc invokes the
 * ThreadSafeFunction once more on loop exit with a null frame and lastError()
 * as `reason`, and {@link onFrame}'s null-frame branch drives
 * `stop("capture-error")` from that instead of from any timeout.
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
 * above). The genuine "capture thread died" signal now exists ({@link
 * onFrame}'s null-frame branch, A3 item 5) and drives `stop("capture-error")`
 * on this path instead of any clock.
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
      // Sync timer callback -- see the identical reasoning on onFrame's
      // death-branch stop() call above for why this is safe to leave
      // unawaited.
      void stop("window-gone");
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
        // Sync timer callback -- same reasoning as the other stop() call
        // sites in this file.
        void stop("capture-error");
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
 * Change the target bounding box of the capture already running (PR C3 item
 * 1's mid-share half -- see {@link CAPTURE_TARGET_WIDTH}'s doc comment for
 * the pre-start half).
 *
 * Mirrors {@link setLiveFps} exactly: for-web's share-quality picker resolves
 * after capture has already started, so the picked preset's resolution
 * arrives as a mid-share change forwarded from the page patch's
 * applyConstraints() override, the same way its framerate already does.
 * Without this the resolution stayed pinned at whatever {@link
 * CAPTURE_TARGET_WIDTH}x{@link CAPTURE_TARGET_HEIGHT} started the session,
 * and a 720p pick only ever reduced the delivered size via the encoder's own
 * (CPU) scaleResolutionDownBy -- see EnsurePipeline in addon.cc for the GPU
 * side of this fix.
 * @returns Whether the running capture accepted it.
 */
export function setLiveTarget(width: number, height: number): boolean {
  if (!active) return false;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  const w = Math.min(
    MAX_TARGET_DIMENSION,
    Math.max(MIN_TARGET_DIMENSION, Math.round(width)),
  );
  const h = Math.min(
    MAX_TARGET_DIMENSION,
    Math.max(MIN_TARGET_DIMENSION, Math.round(height)),
  );
  if (w === active.targetWidth && h === active.targetHeight) return true;

  const mod = loadNative();
  if (!mod?.setTarget(w, h)) {
    appAudioLog(
      `screen capture: native refused a target change to ${w}x${h}; staying at ${active.targetWidth}x${active.targetHeight}`,
    );
    return false;
  }
  appAudioLog(
    `screen capture: target changed ${active.targetWidth}x${active.targetHeight} -> ${w}x${h} for ${active.sourceId}`,
  );
  active.targetWidth = w;
  active.targetHeight = h;
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

/**
 * Whether an earlier stop()'s native join is still running past
 * {@link NATIVE_STOP_TIMEOUT_MS} -- see {@link stopNative}. While this is
 * true, native start() would throw "previous capture still shutting down",
 * so {@link startForSource} checks this itself instead of finding out the
 * hard way. Cleared the moment the join this flag was tracking actually
 * finishes, whenever that turns out to be -- so a slow join degrades the
 * native path only for as long as it is genuinely still shutting down, never
 * permanently. A stuck `true` here would disable native capture for the rest
 * of the process's life (item 4), so every path that sets it must have a
 * matching path that clears it -- see stopNative() below.
 */
let nativeBusy = false;

/** How long {@link stopNative} waits for the native join before reporting
 *  busy instead of leaving its caller to block indefinitely. */
const NATIVE_STOP_TIMEOUT_MS = 3000;

/**
 * Stops whatever native capture is running, without touching our own
 * bookkeeping. Split out of stop() so it can run unconditionally there,
 * ahead of the `!active` check -- see stop()'s comment for why.
 *
 * Returns a promise that resolves once it is safe to call mod.start() again
 * -- either because the native join actually finished, or because
 * NATIVE_STOP_TIMEOUT_MS elapsed first, in which case {@link nativeBusy} is
 * set. The real join keeps running on the libuv threadpool regardless of
 * which of the two wins: the timer here only decides what JS reports while
 * waiting. `settle`'s own `.then` (which clears nativeBusy) is chained off
 * the real join, not off the race, and is explicitly unhooked from the
 * timeout via `clearTimeout` when the join wins first -- without that, a
 * join that finishes in 10ms would still leave a stray timer that fires
 * NATIVE_STOP_TIMEOUT_MS later, wrongly flips nativeBusy back to true and
 * logs a bogus "still pending" line for a stop that was long over.
 *
 * Can never reject: whatever mod.stop() does, the failure is swallowed here
 * (mirroring the old synchronous stopNative()'s try/catch) rather than
 * surfaced, since a caller of stop() has nothing useful to do with a
 * rejected teardown -- and every sync call site of stop() in this file
 * fires it with `void` on exactly that guarantee.
 */
function stopNative(): Promise<void> {
  const mod = loadNative();
  if (!mod) return Promise.resolve();

  const settle = Promise.resolve(mod.stop())
    .catch(() => {
      /* already stopped, or the native side reported an error tearing down
         -- either way the thread has been reaped by the time this runs,
         which is all nativeBusy needs to know. */
    })
    .then(() => {
      nativeBusy = false;
    });

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      appAudioLog(
        `screen capture: native stop still pending after ${NATIVE_STOP_TIMEOUT_MS}ms`,
      );
      nativeBusy = true;
      resolve();
    }, NATIVE_STOP_TIMEOUT_MS);
    void settle.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Ends whatever native capture session is running, if any.
 * @param reason Why -- see {@link StopReason}'s doc comment. Defaults to the
 *   ordinary "stopped" (a user- or page-driven end); every call site that
 *   ends a session for a more specific reason passes one explicitly.
 * @param sessionId When given, this call only takes effect against the
 *   session it names (or an older one) -- see {@link active}'s doc comment.
 *   A caller whose own request has since been superseded by a newer one
 *   passes its own (now stale) id and is turned into a no-op here rather
 *   than tearing down a session it doesn't own (item 4). Omitted entirely by
 *   callers that mean "stop whatever is active right now, unconditionally"
 *   (the page's own `screenCapture:stop`, the window-gone poll, ...).
 * @returns A promise resolving once the native reap has settled (or
 *   NATIVE_STOP_TIMEOUT_MS has elapsed -- see {@link stopNative}). All the
 *   JS-visible bookkeeping below (`active`, `broadcastState()`) happens
 *   synchronously, before this function returns, deliberately -- the
 *   renderer must never be told a stale "still active" story just because a
 *   native join is taking a while in the background. Only the native reap
 *   itself is async, which is why every sync-context caller in this file
 *   (watchdog timers, the ipcMain handler, onFrame's death branch) can fire
 *   this with `void` and rely on the bookkeeping having already happened by
 *   the time control returns to them -- only startForSource, which actually
 *   needs to know when it is safe to call mod.start() again, awaits it.
 */
export function stop(
  reason: StopReason = "stopped",
  sessionId?: number,
): Promise<void> {
  if (sessionId !== undefined && active && sessionId < active.sessionId) {
    appAudioLog(`screen capture: stop ignored: stale session ${sessionId}`);
    return Promise.resolve();
  }
  stopWatchdogs();
  // Unconditionally, not `if (active)`. Native stop() is a no-op when nothing
  // is capturing, so this is free in the common case -- and `active` is not a
  // trustworthy proxy for "native is idle" (same reasoning as appAudio.ts's
  // beginCapture): a native session that ever started without `active` being
  // set would otherwise survive an exported stop() that already cleared it,
  // leaving every later start() throw "capture already running" for the rest
  // of the process's life. Kicked off here but not awaited inline -- see this
  // function's own @returns doc above for why the JS bookkeeping below stays
  // synchronous while only the returned promise tracks the native reap.
  const nativeStopPromise = stopNative();
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
  if (!active) return nativeStopPromise;
  appAudioLog(
    `screen capture: stopped native capture for ${active.sourceId} (${reason})`,
  );
  active = null;
  broadcastState();
  return nativeStopPromise;
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
    // Diagnostic only -- see active's doc comment (item 4).
    sessionId: active?.sessionId ?? 0,
  };
}

/**
 * screenCapture:pageLog is the injected page patch's own console, forwarded
 * from a page we do not control -- see createLogRateLimiter's doc comment
 * for why that needs a cap (plan PR A5 item 2). 50/s independently of
 * window.ts's console-message limiter: these are two different log sources
 * (this module's own diagnostic forwarding vs. Chromium's raw console-message
 * event), and a flood on one should not eat the other's budget.
 */
const pageLogRateLimit = createLogRateLimiter("screenCapture:pageLog", 50);
/**
 * screenCapture:pageDrop is the injected page patch's own frame-drop
 * counter (plan PR "no frames" item 6) -- a `new VideoFrame(...)` call
 * failing in appAudioPatch.ts's `buildVideoTrack`, at video-rate. It feeds
 * `active.summary.videoFrameFailures` (not `appAudioLog` directly -- that
 * already happens once per session via `logPage`/`screenCapture:pageLog`
 * above), so the 10s summary can report it as a per-window count alongside
 * the native-side stages instead of only a one-shot log line. Same distrust
 * and same cap as pageLogRateLimit above -- a remote page, at video-rate.
 */
const pageDropRateLimit = createLogRateLimiter("screenCapture:pageDrop", 50);

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
  // Sync ipcMain handler -- same "fire and let stop() settle its own
  // bookkeeping synchronously" reasoning as this file's other stop() call
  // sites.
  ipcMain.on("screenCapture:stop", () => void stop("stopped"));
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
  // A quality change on a share that is already running (PR C3 item 1) --
  // see {@link setLiveTarget}'s doc comment for why this exists and mirrors
  // screenCapture:setFps rather than screenCapture:setNextFps above. Values
  // are validated here (not trusted) for the same reason as setNextFps: they
  // cross IPC from a remote page.
  ipcMain.on(
    "screenCapture:setTarget",
    (_event, width: unknown, height: unknown) => {
      if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        !Number.isFinite(width) ||
        !Number.isFinite(height)
      ) {
        appAudioLog(
          "screen capture: ignoring invalid setTarget value:",
          width,
          height,
        );
        return;
      }
      setLiveTarget(width, height);
    },
  );
  // The injected page patch's console is filtered below error level (see
  // window.ts), so it reports which video path a share actually took --
  // MediaStreamTrackGenerator, the canvas fallback, or leaving Chromium's
  // capture untouched, and why -- through here instead.
  ipcMain.on("screenCapture:pageLog", (_event, message: string) => {
    if (pageLogRateLimit()) appAudioLog("page:", message);
  });
  // The injected page patch's per-frame drop counter (plan PR "no frames"
  // item 6) -- see pageDropRateLimit's doc comment. `stage` is validated,
  // not trusted: it crosses IPC from a remote page like every other value
  // here. Only one stage exists today ("videoFrameFailure", from
  // appAudioPatch.ts's two `new VideoFrame(...)` call sites); an unknown
  // value is dropped rather than silently bucketed somewhere wrong, so a
  // future stage added on the page side without a matching case here fails
  // loudly (via the else branch's log) instead of quietly undercounting.
  ipcMain.on("screenCapture:pageDrop", (_event, stage: unknown) => {
    if (typeof stage !== "string") return;
    if (!pageDropRateLimit()) return;
    if (!active) return;
    switch (stage) {
      case "videoFrameFailure":
        active.summary.videoFrameFailures++;
        break;
      default:
        appAudioLog("screen capture: ignoring unknown pageDrop stage:", stage);
    }
  });
}
