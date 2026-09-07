import { join } from "node:path";

import {
  BrowserWindow,
  Menu,
  MenuItem,
  app,
  desktopCapturer,
  ipcMain,
  nativeImage,
  session,
} from "electron";

import windowIconAsset from "../../assets/desktop/icon.png?asset";
import { DEFAULT_SERVER } from "../constants";

import {
  createLogRateLimiter,
  flushAppAudioLogSync,
  log as appAudioLog,
  pidForSourceId,
  startForSource,
  stop as stopAppAudio,
  windowStateForSourceId,
} from "./appAudio";
import { APP_AUDIO_PATCH } from "./appAudioPatch";
import { config, getPersistedServer } from "./config";
import {
  resetNativeFailures,
  setLiveFps as setScreenCaptureFps,
  startForSource as startScreenCapture,
  stop as stopScreenCapture,
  takeNextRequestedFps,
} from "./screenCapture";
import { updateTrayMenu } from "./tray";

// global reference to main window
export let mainWindow: BrowserWindow;

// currently in-use build, resolved lazily and memoised.
//
// NOTE: this is intentionally NOT resolved at module load time. `config.ts`
// imports `mainWindow` from this module, and this module imports `config`
// from `config.ts`, so the two modules are circularly dependent. When this
// module is first `require`d (nested inside config.ts's own load), the
// `config` binding here is not yet populated. Resolving the build URL lazily
// on first call to `getBuildUrl()` (from `createMainWindow`, invoked from
// `app.on("ready")`, long after both modules have finished loading)
// sidesteps that hazard.
let buildUrl: URL | undefined;

export function getBuildUrl(): URL {
  return (buildUrl ??= resolveBuildUrl());
}

function resolveBuildUrl(): URL {
  // Precedence: --force-server > getPersistedServer() > DEFAULT_SERVER.
  // Any candidate can be malformed (a bad --force-server flag, or a
  // hand-edited/corrupted config.json), so each is tried in turn and a bad
  // value is logged and skipped rather than left to throw out of
  // `createMainWindow()` — which runs during `app.on("ready")`, before any
  // window exists, so an uncaught throw there would kill the app with no
  // recovery short of deleting config.json.
  const candidates = [
    app.commandLine.hasSwitch("force-server")
      ? app.commandLine.getSwitchValue("force-server")
      : undefined,
    getPersistedServer(),
    DEFAULT_SERVER,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return new URL(candidate);
    } catch {
      console.error("Ignoring invalid server URL:", candidate);
    }
  }

  return new URL(DEFAULT_SERVER);
}

// internal window state
let shouldQuit = false;

// load the window icon
const windowIcon = nativeImage.createFromDataURL(windowIconAsset);

// windowIcon.setTemplateImage(true);

type DisplayMediaCallback = (streams: Electron.Streams) => void;

/** The share the user last agreed to, so a dead one can be picked up again. */
let lastShare: {
  sourceId: string;
  pid: number;
  name: string;
  audio: boolean;
  /**
   * The Display API's own stable id for a *screen* share (empty string for a
   * window share, or if Electron could not report one) -- plan PR A5 item 3.
   * `sourceId`'s `screen:ZZ:0` form encodes ZZ as a sequential enumeration
   * index, not a persistent identifier, so unplugging/replugging a monitor
   * (or it simply waking up in a different enumeration order) can renumber
   * it out from under a straight sourceId comparison. See
   * `findRememberedScreen` below, the counterpart to `findRememberedWindow`'s
   * pid/name matching for windows.
   */
  displayId: string;
} | null = null;

/**
 * A window found by `screenShare:reacquire`, waiting for the renderer to ask
 * for it. The next display media request is answered with it directly instead
 * of showing the picker again.
 */
let armedShare: {
  source: Electron.DesktopCapturerSource;
  audio: boolean;
  at: number;
} | null = null;

/** Bumped to abandon an in-flight re-acquire; only the newest one counts. */
let reacquireGeneration = 0;

const REACQUIRE_POLL_MS = 1000;
/**
 * Enumerating every window is cheap now that we ask for no thumbnails, but a
 * window left minimised for minutes should not be polled at the same rate as
 * one that is about to come straight back.
 */
const REACQUIRE_POLL_MAX_MS = 5000;
// Five minutes of polling outlived every share it was meant to rescue: nothing
// cancelled it when the user simply stopped sharing or left the call, so it
// ground on regardless. Ninety seconds covers an app recreating its window
// without leaving a poll running long after anyone cares.
const REACQUIRE_TIMEOUT_MS = 90 * 1000;
/**
 * How long a found window stays armed before the picker comes back.
 *
 * Nothing cancels an in-flight re-acquire when the user simply gives up -- they
 * leave the call, or stop sharing -- so the poll keeps running and can still
 * arm a window afterwards. The next `getDisplayMedia` inside this window is
 * then answered with the remembered source and no picker, which means a user
 * who retries straight away gets the *old* window shared without being asked.
 *
 * The legitimate path consumes the arm within milliseconds: for-web awaits
 * `reacquireScreenShare()` and calls `getDisplayMedia` the moment it resolves
 * true. Ten seconds bought nothing and left that door wide open; three is
 * generous for the real path and narrows the wrong-window window considerably.
 *
 * A renderer-driven cancel IPC would close it outright rather than narrow it,
 * but it only works once both for-web and for-desktop are current, and desktop
 * updates need a manual reinstall -- so it would sit half-deployed for as long
 * as anyone puts that off. This works on every client version.
 */
const ARMED_TTL_MS = 3_000;

/**
 * Identifies one display-media request, assigned at the very top of the
 * handler below, before any `await`. Threaded through to
 * `stopScreenCapture`/`stopAppAudio` and into `startForSource` in both
 * native modules so a request that gets delayed by an await (e.g.
 * `--window-shares-as-screen`'s screen lookup) and resumes after a later,
 * faster request has already started can never stop or clobber that newer
 * session -- both modules' `stop()` refuse a stale id instead. See A3 item 4.
 */
let nextRequestId = 0;

/**
 * Wrap Electron's display-media callback so it can be answered at most once,
 * from whichever of several paths gets there first (a direct answer, a
 * picker response, a supersede, a leak-guard timeout, or an error fallback)
 * without each of them having to coordinate with the others. Electron throws
 * if the callback runs after the request is already gone (e.g. the renderer
 * reloaded mid-picker); every path here gets that for free instead of
 * needing its own try/catch. See A3 item 1.
 */
function answerOnce(callback: DisplayMediaCallback) {
  let answered = false;
  const guard = (respond: () => void) => {
    if (answered) return;
    answered = true;
    try {
      respond();
    } catch (err) {
      appAudioLog(
        "display media: callback threw answering request (request likely already gone):",
        String(err),
      );
    }
  };
  return {
    answer: (streams: Electron.Streams) => guard(() => callback(streams)),
    // Electron's typings insist on an argument, but the documented way to
    // cancel is calling back with none: that is what turns into a clean
    // NotAllowedError in the renderer instead of an unexpected rejection.
    cancel: () => guard(() => (callback as unknown as () => void)()),
  };
}

type PendingPicker = {
  id: number;
  sources: Electron.DesktopCapturerSource[];
  /** idx < 0 (or out of range) cancels; otherwise answers with sources[idx]. */
  answer: (idx: number, audio: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * The picker currently awaiting the renderer's `screenPickerCallback`, if
 * any. Backs a single `ipcMain.on` handler registered once in
 * `createMainWindow`, replacing the old `ipcMain.once` registered fresh per
 * request -- which stacked across overlapping requests and could answer the
 * wrong one. See A3 item 3.
 */
let pendingPicker: PendingPicker | null = null;
let nextPickerId = 0;

/**
 * Backstop for a picker that never gets a renderer response at all (a crash,
 * or a reload that drops the IPC round-trip entirely) -- `did-finish-load`,
 * `render-process-gone` and window `closed` already cover the ordinary ways
 * that happens, so this is only for whatever those don't catch.
 */
const PICKER_LEAK_GUARD_MS = 10 * 60 * 1000;

/**
 * Supersede whatever picker is currently pending, answering it with a cancel
 * so the renderer gets a clean NotAllowedError instead of a request that
 * never resolves. Safe to call when nothing is pending.
 */
function cancelPendingPicker(reason: string) {
  // Captured into a local first, not narrowed-and-reused: `pendingPicker` is
  // reassigned inside closures elsewhere in this module, so TS cannot narrow
  // it across the appAudioLog() call below and neither can we rely on it.
  const picker = pendingPicker;
  if (!picker) return;
  appAudioLog("screen picker: cancelling pending request:", reason);
  picker.answer(-1, false);
}

/**
 * Arm the picker for one request: supersedes into `pendingPicker`, wires the
 * leak-guard timer, and dispatches the renderer's eventual response (or a
 * supersede/timeout) through `respondToDisplayMedia`.
 */
function registerPendingPicker(
  sources: Electron.DesktopCapturerSource[],
  respond: (streams: Electron.Streams) => void,
  cancelRequest: () => void,
  requestId: number,
) {
  const id = ++nextPickerId;
  const timer = setTimeout(() => {
    const picker = pendingPicker;
    if (!picker || picker.id !== id) return;
    appAudioLog(
      "screen picker: leak guard fired after",
      PICKER_LEAK_GUARD_MS,
      "ms with no response; cancelling",
    );
    picker.answer(-1, false);
  }, PICKER_LEAK_GUARD_MS);

  pendingPicker = {
    id,
    sources,
    answer: (idx, audio) => {
      clearTimeout(timer);
      pendingPicker = null;
      if (idx < 0 || idx >= sources.length) {
        // Electron's typings insist on an argument, but the documented way
        // to cancel is calling back with none -- that is what turns into a
        // clean NotAllowedError in the renderer instead of an unexpected
        // rejection.
        lastShare = null;
        cancelRequest();
        return;
      }
      void respondToDisplayMedia(sources[idx], audio, respond, requestId).catch(
        (err) => {
          appAudioLog(
            "respondToDisplayMedia failed, answering with video-only fallback:",
            String(err),
          );
          respond({ video: sources[idx] });
        },
      );
    },
    timer,
  };
}

/**
 * `--capture-fps=N` caps the frame rate the page may ask for. WGC brokers each
 * frame through CaptureService, so the rate is a direct lever on how hard that
 * service is driven -- and this fork raised the requested rate when it removed
 * an old 5fps clamp.
 *
 * Module-scoped (rather than local to `createMainWindow`) so
 * `respondToDisplayMedia` can read it too: it is the value native video
 * capture is started with, composing the same cap that used to be enforced by
 * capping Chromium's video track constraints -- see `withFpsCap` in
 * appAudioPatch.ts, which now only applies when native capture did not start.
 */
function captureFpsCap(): number | null {
  if (!app.commandLine.hasSwitch("capture-fps")) return null;
  const raw = Number(app.commandLine.getSwitchValue("capture-fps"));
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
}

/**
 * Answer a display media request, preferring audio from just the shared
 * application.
 *
 * A *window* share that cannot get per-app audio is answered with video only:
 * Chromium's `"loopback"` is the entire system mix, including the voice call
 * itself, which is exactly the leak this whole module exists to avoid.
 *
 * A *screen* share used to fall back to `"loopback"` on the same failure --
 * that was the actual bug this module was built to fix (see appAudio.ts's
 * header). On Windows, appAudio's own system-mix capture (every audible
 * process except the blocklist and our own tree) is what a screen share gets
 * instead; if even that fails, we share video only and log why, rather than
 * silently reintroducing the leak. `--allow-system-audio-mix` is the
 * deliberate escape hatch back to Chromium's raw loopback, and it is now the
 * *only* route to it. Non-Windows platforms have no appAudio system-mix path
 * to fall back from, so their behaviour (straight to loopback) is unchanged.
 */
async function respondToDisplayMedia(
  source: Electron.DesktopCapturerSource,
  audio: boolean,
  answer: (streams: Electron.Streams) => void,
  sessionId: number,
) {
  const isWindow = source.id.startsWith("window:");
  lastShare = {
    sourceId: source.id,
    pid: pidForSourceId(source.id),
    name: source.name,
    audio,
    // Only meaningful for a screen source -- see lastShare's own doc comment
    // on this field. `display_id` is "" rather than absent for a window
    // source, per Electron's own typing, so this needs no isWindow branch.
    displayId: source.display_id,
  };

  // Window capture is hard-wired to WGC and WGC is brokered by CaptureService,
  // which is what pins a core and takes the shell down with it. Capturing the
  // whole screen instead goes through DXGI desktop duplication -- the stack
  // Discord uses -- while per-app audio still follows the window's process, so
  // the sound stays correct even though the framing does not. Everything on the
  // screen becomes visible: strictly a trade, hence opt-in.
  let videoSource = source;
  if (isWindow && app.commandLine.hasSwitch("window-shares-as-screen")) {
    const screen = await primaryScreenSource();
    if (screen) {
      appAudioLog(
        "window-shares-as-screen: sending",
        screen.id,
        "in place of",
        source.id,
      );
      videoSource = screen;
    } else {
      appAudioLog("window-shares-as-screen: no screen source; keeping window");
    }
  }

  // Native GPU-downscaled capture: Windows + window sources only (the agreed
  // scope boundary -- screen sources and every other platform keep today's
  // Chromium path untouched). `videoSource` may have been swapped to a screen
  // above by --window-shares-as-screen, which must NOT go through here: that
  // flag exists specifically to route a window off WGC, and this module's
  // whole point is capturing a *window* through WGC, just more cheaply.
  if (
    process.platform === "win32" &&
    isWindow &&
    videoSource.id === source.id
  ) {
    // The page announced what it asked getDisplayMedia for (see
    // appAudioPatch.ts and takeNextRequestedFps's doc comment); 30 is what we
    // fell back to before that handoff existed, so it stays the default when
    // nothing was announced. --capture-fps is a cap, not a request, so it
    // still wins over a higher ask -- a 60fps request under --capture-fps=30
    // must still capture at 30.
    const requestedFps = takeNextRequestedFps() ?? 30;
    const fpsCap = captureFpsCap();
    const fps = fpsCap !== null ? Math.min(requestedFps, fpsCap) : requestedFps;
    // Awaited (item 4): startScreenCapture is now async (it awaits its own
    // pre-start stop() before touching mod.start()) -- respondToDisplayMedia
    // is already async, so this just needed the keyword added; without it,
    // `if` would test a Promise object, which is always truthy, and this
    // branch would report "native GPU capture" even when start ultimately
    // failed or fell back.
    if (await startScreenCapture(source.id, fps, sessionId)) {
      appAudioLog(
        "video path: native GPU capture (WGC + VideoProcessorBlt) for",
        source.id,
        `at up to ${fps}fps`,
      );
    } else {
      appAudioLog(
        "video path: Chromium capture (native GPU path unavailable, see reason above) for",
        source.id,
      );
    }
  } else {
    appAudioLog(
      "video path: Chromium capture for",
      videoSource.id,
      isWindow ? "(window, but out of native scope)" : "(screen source)",
    );
  }

  if (!audio || app.commandLine.hasSwitch("no-per-app-audio")) {
    appAudioLog("sharing", videoSource.id, "without audio");
    answer({ video: videoSource });
    return;
  }
  // For a screen source this calls into startSystemExcluding(), which blocks
  // the calling thread -- here, the Electron main thread -- until its first
  // enumerate-and-activate pass finishes, so the report it returns names the
  // processes actually captured rather than an empty guess. Measured on a
  // desktop with 8 audible applications: 18ms median, 23ms worst over five
  // runs, i.e. imperceptible at share start. The native side caps that wait
  // at 5s, but the cap is a backstop for an activation that hangs, not a
  // figure this approaches -- a freeze here would be user-visible, so
  // re-measure before assuming it is still cheap.
  // Awaited (item 4): appAudio's startForSource is now async for the same
  // reason as startScreenCapture above -- same correctness note applies.
  if (await startForSource(source.id, sessionId)) {
    // Audio arrives out-of-band and is stitched in by the renderer; asking
    // Chromium for loopback too would double up the sound.
    appAudioLog("sharing", videoSource.id, "with per-app audio");
    answer({ video: videoSource });
    return;
  }
  if (isWindow) {
    appAudioLog(
      "no per-app audio for window",
      source.id,
      "- sharing video only rather than the whole system mix",
    );
    answer({ video: videoSource });
    return;
  }
  // Screen share, and appAudio's system-mix capture didn't come up (native
  // module missing, unsupported OS, or activation failed -- appAudio already
  // logged which). Falling back to Chromium's raw loopback here is exactly
  // the bug this module exists to fix: it is the entire system mix,
  // including whatever voice call the sharer is on. So on Windows we share
  // video only by default, unless the user has opted into the raw mix with
  // --allow-system-audio-mix. Non-Windows platforms never had a system-mix
  // path to fall back from, so they go straight to loopback as before.
  if (
    process.platform === "win32" &&
    !app.commandLine.hasSwitch("allow-system-audio-mix")
  ) {
    appAudioLog(
      "screen share: no system-mix audio and Chromium loopback is disabled by default on Windows",
      "(it would rebroadcast any voice call the sharer is on) - sharing video only;",
      "pass --allow-system-audio-mix to opt into the raw system mix instead",
    );
    answer({ video: videoSource });
    return;
  }
  appAudioLog(
    "screen share falling back to Chromium loopback (whole system mix)",
  );
  answer({ video: videoSource, audio: "loopback" });
}

/**
 * Look for the remembered window among the sources on offer: same id first,
 * then any window of the same process, preferring an identical title. WGC
 * refuses minimised windows, so an iconic match does not count as found.
 */
async function findRememberedWindow(target: {
  sourceId: string;
  pid: number;
  name: string;
}): Promise<Electron.DesktopCapturerSource | null> {
  // `thumbnailSize` defaults to 150x150, which makes Electron capture a live
  // frame of *every* window on the system. Chromium 150 does that through the
  // Windows Graphics Capture window capturer, so each call builds and tears
  // down a WGC item plus a D3D11 frame pool per window -- once a second, for
  // as long as this poll runs. That is enough to wedge dwm.exe and take the
  // shell (alt-tab, Start menu) down with it. We only read ids, names and
  // pids, so ask for no thumbnails at all.
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 0, height: 0 },
  });

  const capturable = (source: Electron.DesktopCapturerSource) => {
    const state = windowStateForSourceId(source.id);
    // No native module means no way to tell; take the source at face value.
    if (!state) return true;
    return state.exists && state.visible && !state.iconic;
  };

  const sameId = sources.find((source) => source.id === target.sourceId);
  if (sameId && capturable(sameId)) return sameId;

  // Toggling fullscreen usually destroys and recreates the window, so the
  // handle in the id changes while the process stays put.
  if (!target.pid) return null;
  const samePid = sources.filter(
    (source) => pidForSourceId(source.id) === target.pid && capturable(source),
  );
  return (
    samePid.find((source) => source.name === target.name) ?? samePid[0] ?? null
  );
}

/**
 * The screen counterpart to {@link findRememberedWindow} (plan PR A5 item
 * 3): a screen share used to be unre-acquirable at all -- the reacquire
 * handler below refused anything whose sourceId did not start with
 * `window:` -- so a monitor that WGC or the OS transiently dropped the
 * share for had no recovery path a window share already had.
 *
 * Matched on `display_id`, the Display API's own stable id, not on
 * `sourceId`: see `lastShare`'s doc comment on `displayId` for why the raw
 * `screen:ZZ:0` id is not safe to compare directly.
 */
async function findRememberedScreen(target: {
  displayId: string;
}): Promise<Electron.DesktopCapturerSource | null> {
  if (!target.displayId) return null;
  const screens = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 0, height: 0 },
  });
  return (
    screens.find((source) => source.display_id === target.displayId) ?? null
  );
}

/**
 * The first whole-screen source, used to keep a window share off WGC.
 */
async function primaryScreenSource(): Promise<Electron.DesktopCapturerSource | null> {
  try {
    const screens = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    return screens[0] ?? null;
  } catch (err) {
    appAudioLog("could not list screens:", String(err));
    return null;
  }
}

/**
 * Wait for the last shared window to come back.
 *
 * Chromium ends the capture track when the shared window is destroyed (an app
 * toggling fullscreen recreates its window) or minimised, and the web client
 * tears the share down. It calls this, and on `true` re-requests
 * getDisplayMedia -- which we then answer with the window we found.
 *
 * Resolves false on timeout, if there is nothing to re-acquire, or if another
 * call supersedes this one.
 */
/**
 * A quality change on a share that is already running.
 *
 * for-web resolves its picker *after* `setScreenShareEnabled`, so the chosen
 * quality arrives as `applyConstraints({ frameRate })` on the live track --
 * long after capture started at whatever the saved default was. The page patch
 * forwards that here rather than swallowing it, which is what makes picking
 * "1080p 60FPS" in the picker actually reach capture.
 *
 * Lives here rather than in screenCapture.ts so `--capture-fps` still wins,
 * exactly as it does for the initial rate in respondToDisplayMedia.
 */
ipcMain.on("screenCapture:setFps", (_event, fps: unknown) => {
  if (typeof fps !== "number" || !Number.isFinite(fps)) {
    appAudioLog("screen capture: ignoring invalid setFps value:", fps);
    return;
  }
  const cap = captureFpsCap();
  setScreenCaptureFps(cap !== null ? Math.min(fps, cap) : fps);
});

ipcMain.handle("screenShare:reacquire", async () => {
  const target = lastShare;
  if (!target) {
    appAudioLog("reacquire: no remembered share");
    return false;
  }
  // Screens can re-arm too now (plan PR A5 item 3) -- see findRememberedScreen's
  // doc comment for why this used to be window-only. A screen share with no
  // displayId (Electron could not report one) still has no recovery path.
  const isWindow = target.sourceId.startsWith("window:");
  if (!isWindow && !target.displayId) {
    appAudioLog(
      "reacquire: last share was a screen with no display id, not re-acquiring",
    );
    return false;
  }

  const generation = ++reacquireGeneration;
  const deadline = Date.now() + REACQUIRE_TIMEOUT_MS;
  let pollMs = REACQUIRE_POLL_MS;
  appAudioLog(
    "reacquire: waiting for",
    isWindow ? "window" : "screen",
    target.name,
    `(${target.sourceId}, pid ${target.pid})`,
  );

  while (Date.now() < deadline) {
    // The window this poll is chasing is gone the moment the app quits --
    // bail rather than keep polling desktopCapturer against a torn-down
    // window/session (plan PR A5 item 3). before-quit also bumps
    // reacquireGeneration (see that handler) for the same reason; this check
    // catches it sooner than waiting for the next generation comparison
    // below to notice, since a poll can be mid-`await` when quit fires.
    if (mainWindow.isDestroyed()) {
      appAudioLog("reacquire: main window destroyed, giving up");
      return false;
    }
    if (generation !== reacquireGeneration || lastShare !== target) {
      appAudioLog("reacquire: superseded, giving up");
      return false;
    }

    let match: Electron.DesktopCapturerSource | null = null;
    try {
      match = isWindow
        ? await findRememberedWindow(target)
        : await findRememberedScreen(target);
    } catch (err) {
      appAudioLog("reacquire: could not list sources:", String(err));
    }

    if (match) {
      appAudioLog("reacquire: found", match.id, match.name);
      armedShare = { source: match, audio: target.audio, at: Date.now() };
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
    pollMs = Math.min(Math.round(pollMs * 1.5), REACQUIRE_POLL_MAX_MS);
  }

  appAudioLog("reacquire: window never came back");
  return false;
});

/**
 * The remote page's raw `console-message` event, capped independently of
 * screenCapture.ts's own `screenCapture:pageLog` limiter -- see
 * createLogRateLimiter's doc comment for why a page-controlled log source
 * needs one at all (plan PR A5 item 2). Module-scoped, not local to
 * `createMainWindow`, so a reload/reload loop cannot reset the budget by
 * re-running the function that would otherwise redeclare it.
 */
const consoleMessageRateLimit = createLogRateLimiter("console-message", 50);

/**
 * Create the main application window
 */
export function createMainWindow() {
  // (CLI arg --hidden or config)
  const startHidden =
    app.commandLine.hasSwitch("hidden") || config.startMinimisedToTray;
  const isMacOS = process.platform === "darwin";

  // create the window
  mainWindow = new BrowserWindow({
    minWidth: 300,
    minHeight: 300,
    width: 1280,
    height: 720,
    backgroundColor: "#191919",
    frame: isMacOS ? true : !config.customFrame,
    titleBarStyle: isMacOS ? "hidden" : "default",
    trafficLightPosition: isMacOS ? { x: 8, y: 8 } : undefined,
    icon: windowIcon,
    show: !startHidden,
    webPreferences: {
      // relative to `.vite/build`
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      // A fullscreen game covering Stoat would otherwise have Chromium throttle
      // our timers, which stalls the per-app audio pump and the share recovery
      // polling exactly when they are needed.
      backgroundThrottling: app.commandLine.hasSwitch("background-throttling"),
    },
  });

  // hide the options
  mainWindow.setMenu(null);

  // So the log says exactly which knobs this run was started with.
  if (process.platform === "win32") {
    appAudioLog(
      "wgc screen capturer:",
      app.commandLine.hasSwitch("keep-wgc-screen")
        ? "enabled (stock)"
        : "disabled -> DXGI, falling back to GDI",
    );
    const flags = [
      "no-wgc-zero-hz",
      "window-shares-as-screen",
      "no-per-app-audio",
      "background-throttling",
      "allow-system-audio-mix",
    ].filter((flag) => app.commandLine.hasSwitch(flag));
    appAudioLog("capture flags:", flags.length ? flags.join(", ") : "(none)");
    appAudioLog("capture fps cap:", String(captureFpsCap() ?? "none"));
  }

  // restore last position if it was moved previously
  if (config.windowState.x > 0 || config.windowState.y > 0) {
    mainWindow.setPosition(
      config.windowState.x ?? 0,
      config.windowState.y ?? 0,
    );
  }

  // restore last size if it was resized previously
  if (config.windowState.width > 0 && config.windowState.height > 0) {
    mainWindow.setSize(
      config.windowState.width ?? 1280,
      config.windowState.height ?? 720,
    );
  }

  // maximise the window if it was maximised before
  if (config.windowState.isMaximised && !startHidden) {
    mainWindow.maximize();
  }

  // Whatever goes wrong loading the remote client should end up in the log file
  // rather than a console nobody can see. A blank or grey window is almost
  // always one of these.
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      appAudioLog(
        `page failed to load (${isMainFrame ? "main frame" : "subframe"}):`,
        `${errorCode} ${errorDescription}`,
        validatedURL,
      );
    },
  );

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    appAudioLog(
      "renderer process gone:",
      details.reason,
      `exitCode=${details.exitCode}`,
    );
    console.error("RENDERER CRASHED:", details.reason, details.exitCode);
    cancelPendingPicker("renderer process gone");
  });

  mainWindow.webContents.on("unresponsive", () => {
    appAudioLog("renderer became unresponsive");
    console.error("WINDOW UNRESPONSIVE");
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) =>
    appAudioLog("preload failed:", preloadPath, String(error)),
  );

  // Errors the page itself reports. This is what would have caught the missing
  // VITE_HOST, and any future client-side breakage.
  mainWindow.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      if (level < 3) return; // 3 = error
      if (consoleMessageRateLimit()) {
        appAudioLog(`page error: ${message} (${sourceId}:${line})`);
      }
    },
  );

  // The web app is remote, so the getDisplayMedia override has to be injected
  // into its main world on every load (contextIsolation keeps the preload out).
  mainWindow.webContents.on("did-finish-load", () => {
    appAudioLog("page loaded:", mainWindow.webContents.getURL());
    // The picker lived in the page that just went away; whatever answer it
    // would have sent can never arrive now.
    cancelPendingPicker("page reloaded");
    const prelude =
      "window.__stoatCaptureFps = " + JSON.stringify(captureFpsCap()) + ";\n";
    mainWindow.webContents
      .executeJavaScript(prelude + APP_AUDIO_PATCH)
      .then(() => appAudioLog("screen share patch injected"))
      .catch((err) => appAudioLog("could not inject patch:", String(err)));
  });

  // The web client registers a service worker that serves the whole app from
  // cache, offline-first. That is useful in a browser and actively harmful
  // here: after the server deploys a new client, the cached one keeps running
  // against the new backend and the window comes up grey.
  //
  // Purging only when the server *origin* changed was not enough, because the
  // usual case is the same origin serving a newer build. A desktop app has no
  // use for offline caching, so drop it on every launch: the cost is
  // re-fetching a few MB of assets, and it removes the failure mode entirely.
  const purgeCachedClient = async () => {
    try {
      await session.defaultSession.clearStorageData({
        storages: ["serviceworkers", "cachestorage"],
      });
      console.log("[window] cleared cached web client");
    } catch (err) {
      console.warn("[window] could not clear cached client:", err);
    }
    config.lastServer = getBuildUrl().origin;
  };

  // load the entrypoint
  //
  // Used to load, then immediately reload() again (plan PR A5 item 6): that
  // predates purgeCachedClient() above and was itself a speculative "reload
  // on every startup" attempt at the same grey-window bug the comment above
  // explains -- see PR #269's own commit message, literally "what if we just
  // reloaded every startup, would that kill cache?", with no evidence it
  // actually did. purgeCachedClient() is the real fix: it clears the
  // service worker and cache storage *before* this load even starts, which
  // is what the comment above documents, and it does not depend on a second
  // load to work. The leftover reload() only doubled did-finish-load (so
  // the page patch above injects twice) and briefly re-flashed the window
  // on every launch, with nothing behind it once the real fix landed.
  purgeCachedClient().then(() => mainWindow.loadURL(getBuildUrl().toString()));

  // minimise window to tray
  mainWindow.on("close", (event) => {
    if (!shouldQuit && config.minimiseToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Unlike "close" above, this fires only once the window is actually gone
  // (never on a minimise-to-tray hide), so a picker waiting on it truly has
  // no answer coming.
  mainWindow.on("closed", () => cancelPendingPicker("window closed"));

  // update tray menu when window is shown/hidden
  mainWindow.on("show", updateTrayMenu);
  mainWindow.on("hide", updateTrayMenu);

  // keep track of window state
  function generateState() {
    config.windowState = {
      x: mainWindow.getPosition()[0],
      y: mainWindow.getPosition()[1],
      width: mainWindow.getSize()[0],
      height: mainWindow.getSize()[1],
      isMaximised: mainWindow.isMaximized(),
    };
  }

  mainWindow.on("maximize", generateState);
  mainWindow.on("unmaximize", generateState);
  mainWindow.on("moved", generateState);
  mainWindow.on("resized", generateState);

  // rebind zoom controls to be more sensible
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.control && (input.key === "=" || input.key === "+")) {
      // zoom in (+)
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(
        mainWindow.webContents.getZoomLevel() + 1,
      );
    } else if (input.control && input.key === "-") {
      // zoom out (-)
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(
        mainWindow.webContents.getZoomLevel() - 1,
      );
    } else if (input.control && input.key === "0") {
      // reset zoom to default.
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(0);
    } else if (
      input.key === "F5" ||
      ((input.control || input.meta) && input.key.toLowerCase() === "r")
    ) {
      event.preventDefault();
      mainWindow.webContents.reload();
    }
  });

  // send the config
  mainWindow.webContents.on("did-finish-load", () => config.sync());

  // configure spellchecker context menu
  mainWindow.webContents.on("context-menu", (_, params) => {
    const menu = new Menu();

    // add all suggestions
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(
        new MenuItem({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        }),
      );
    }

    // allow users to add the misspelled word to the dictionary
    if (params.misspelledWord) {
      menu.append(
        new MenuItem({
          label: "Add to dictionary",
          click: () =>
            mainWindow.webContents.session.addWordToSpellCheckerDictionary(
              params.misspelledWord,
            ),
        }),
      );
    }

    // add an option to toggle spellchecker
    menu.append(
      new MenuItem({
        label: "Toggle spellcheck",
        click() {
          config.spellchecker = !config.spellchecker;
        },
      }),
    );

    // show menu if we've generated enough entries
    if (menu.items.length > 0) {
      menu.popup();
    }
  });

  // Create display media request handler
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // If this never appears in the log, the OS picker handled the request and
      // we never got the chance to pick per-app audio.
      appAudioLog(
        "display media request received; audioRequested =",
        String(request.audioRequested),
      );

      const requestId = ++nextRequestId;
      const { answer, cancel } = answerOnce(callback);

      // Anything the user starts by hand ends whatever else was already
      // waiting on an answer -- a picker still showing from an earlier
      // request gets a clean NotAllowedError instead of being left to
      // answer whichever request happens to still be listening. See item 3.
      cancelPendingPicker("superseded by a new display media request");

      // A re-acquire that already found the window answers straight away, so
      // the recovered share does not make the user pick it again.
      const armed = armedShare;
      armedShare = null;
      if (armed && Date.now() - armed.at < ARMED_TTL_MS) {
        appAudioLog("answering with re-acquired source", armed.source.id);
        // Item 4: both stop()s now return a promise that only settles once
        // the native reap has actually finished (or timed out) rather than
        // blocking the main thread the old synchronous stop() did, so the
        // video/audio start below (inside respondToDisplayMedia) must wait
        // for both before it runs -- otherwise it can race a native
        // start() against a still-in-flight teardown of the session it's
        // replacing. This display-media handler is not itself async (it's
        // Electron's plain callback signature), hence the IIFE.
        void (async () => {
          // "superseded", not the "stopped" default: this ends the previous
          // native session because a new one (the re-acquired source) is
          // about to replace it, not because the user asked to stop sharing.
          // The companion for-web PR keys its recovery-budget accounting off
          // this field, and a supersede must not look like a user stop --
          // see StopReason's doc comment in screenCapture.ts. requestId
          // scopes it to sessions older than this one -- see item 4.
          await Promise.all([
            stopAppAudio(requestId),
            stopScreenCapture("superseded", requestId),
          ]);
          await respondToDisplayMedia(
            armed.source,
            armed.audio && request.audioRequested,
            answer,
            requestId,
          );
        })().catch((err) => {
          appAudioLog(
            "respondToDisplayMedia failed, answering with video-only fallback:",
            String(err),
          );
          answer({ video: armed.source });
        });
        return;
      }
      if (armed) {
        // The picker below still runs, and the user still chooses a window
        // through it -- from resetNativeFailures's point of view that makes
        // this a new share like any other picker answer, not a continuation
        // of the stale one, so falling through to the same reset just below
        // is deliberate, not an accident of where this line happens to sit.
        appAudioLog("re-acquired source went stale; showing the picker");
      }

      // Anything the user starts by hand ends whatever we were waiting for.
      reacquireGeneration++;

      desktopCapturer
        .getSources({
          types: ["screen", "window"],
          fetchWindowIcons: true,
          // The picker shows app icons, never window thumbnails; capturing one
          // per window is pure cost -- and a visible stall while the picker
          // opens. See the note in `findRememberedWindow`.
          thumbnailSize: { width: 0, height: 0 },
        })
        .then(async (sources) => {
          // Any previous share is over by the time a new one is requested.
          // "superseded", not "stopped" for the screen-capture side -- see
          // the comment on the other stopScreenCapture() call above. Item 4:
          // both stop()s now only resolve once their native reap has
          // actually finished (or timed out), instead of blocking the main
          // thread the way the old synchronous stop() did, so this awaits
          // both rather than firing them and moving on -- the video/audio
          // start further down must not race a native start() against a
          // still-in-flight teardown of the session it's replacing. Making
          // this `.then` callback async (rather than a nested IIFE, as the
          // armed-fast-path branch above needs) is enough here since its
          // caller is already a promise chain with its own `.catch` below.
          await Promise.all([
            stopAppAudio(requestId),
            stopScreenCapture("superseded", requestId),
          ]);
          // Everything past this point is a *new* share, not a recovery of
          // the one the armed fast path above would have answered -- the
          // Wayland single-source shortcut and a fresh picker answer both
          // land here. Reset the native failure budget so a window that
          // previously tripped it does not disable native capture for a
          // share that has nothing to do with the one that failed. See
          // resetNativeFailures's doc comment for why the armed path above
          // must never do this.
          //
          // Placed here, right after the awaited Promise.all above rather
          // than synchronously before this getSources() call: getSources({
          // fetchWindowIcons: true }) is a visible stall (see the comment on
          // it above), and the previous session's watchdog timers do not
          // actually stop until that Promise.all resolves. A reset issued
          // before that await would race the old session's own watchdog: if
          // it was already stalled, it could still fire and increment
          // consecutiveFailures in that gap, and the new share would inherit
          // a failure count this reset was meant to have already cleared.
          resetNativeFailures();
          appAudioLog("sources offered:", String(sources.length));

          // Shortcut for linux wayland.
          if (sources.length == 1) {
            void respondToDisplayMedia(
              sources[0],
              request.audioRequested,
              answer,
              requestId,
            ).catch((err) => {
              appAudioLog(
                "respondToDisplayMedia failed, answering with video-only fallback:",
                String(err),
              );
              answer({ video: sources[0] });
            });
            return;
          }
          registerPendingPicker(sources, answer, cancel, requestId);
          mainWindow.webContents.send(
            "screenPicker",
            sources.map((source, idx) => {
              const image = source.appIcon;
              if (image) {
                if (image.getAspectRatio() > 1) {
                  image.resize({ width: 256 });
                } else {
                  image.resize({ height: 256 });
                }
              }
              return {
                idx: idx,
                name: source.name,
                isFullScreen: source.id.startsWith("screen"),
                image: image?.toDataURL(),
              };
            }),
          );
        })
        .catch((err) => {
          // No sources means no picker to show and no source to answer
          // with -- cancel rather than leave the request hanging. See item 2.
          appAudioLog(
            "could not list sources for display media request:",
            String(err),
          );
          cancel();
        });
    },
    { useSystemPicker: true },
  );

  // A single handler for the whole app's life, dispatching to whichever
  // picker is currently pending -- see `pendingPicker`'s doc comment (item 3).
  ipcMain.on("screenPickerCallback", (_event, idx: number, audio: boolean) => {
    const picker = pendingPicker;
    if (!picker) {
      appAudioLog("screen picker: response with no pending request; ignoring");
      return;
    }
    appAudioLog(
      "picker chose index",
      String(idx),
      "audio =",
      String(audio),
      idx >= 0 && idx < picker.sources.length
        ? picker.sources[idx].id
        : "(out of range)",
    );
    picker.answer(idx, audio);
  });

  // push world events to the window
  ipcMain.on("minimise", () => mainWindow.minimize());
  ipcMain.on("maximise", () =>
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(),
  );
  ipcMain.on("close", () => mainWindow.close());
}

/**
 * Quit the entire app
 */
export function quitApp() {
  shouldQuit = true;
  mainWindow.close();
}

// Ensure global app quit works properly
app.on("before-quit", () => {
  shouldQuit = true;
  // Abandon any in-flight screenShare:reacquire poll (plan PR A5 item 3):
  // that loop already checks `mainWindow.isDestroyed()` on every iteration,
  // but it can be mid-`await` (the poll's own setTimeout, or a desktopCapturer
  // call) when quit fires, and bumping the generation here is what makes the
  // very next generation check it takes -- not the isDestroyed check, which
  // only runs at the top of the loop -- refuse to arm a share for a window
  // that no longer exists.
  reacquireGeneration++;
  // Item 5: the cooperative path that runs first, ahead of whatever the
  // native destructors do as a backstop once the process is actually
  // exiting -- gives the capture thread(s) a chance to join cleanly instead
  // of being torn down mid-flight. Fired and not awaited: before-quit has no
  // mechanism to wait on this, and both stop()s' returned promises can never
  // reject (see each file's stopNative() doc comment) or hang the process
  // (NATIVE_STOP_TIMEOUT_MS bounds how long either can appear "busy" for).
  appAudioLog("quit: native capture stop requested");
  void stopScreenCapture("stopped");
  void stopAppAudio();
  // Last, deliberately: plan PR A5 item 1's synchronous quit flush (see its
  // own doc comment in appAudio.ts) also catches whatever appAudioLog() call
  // this handler itself just made, since it runs after every log() call
  // above rather than racing them.
  flushAppAudioLogSync();
});
