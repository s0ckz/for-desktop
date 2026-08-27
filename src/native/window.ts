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
  log as appAudioLog,
  pidForSourceId,
  startForSource,
  stop as stopAppAudio,
  windowStateForSourceId,
} from "./appAudio";
import { APP_AUDIO_PATCH } from "./appAudioPatch";
import { config, getPersistedServer } from "./config";
import {
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
/** How long a found window stays armed before the picker comes back. */
const ARMED_TTL_MS = 10_000;

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
 * itself, which is exactly the leak this whole module exists to avoid. Only
 * whole-screen shares -- where the system mix is what the user asked for
 * anyway -- fall back to it.
 */
async function respondToDisplayMedia(
  source: Electron.DesktopCapturerSource,
  audio: boolean,
  callback: DisplayMediaCallback,
) {
  const isWindow = source.id.startsWith("window:");
  lastShare = {
    sourceId: source.id,
    pid: pidForSourceId(source.id),
    name: source.name,
    audio,
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
    if (startScreenCapture(source.id, fps)) {
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
    callback({ video: videoSource });
    return;
  }
  if (startForSource(source.id)) {
    // Audio arrives out-of-band and is stitched in by the renderer; asking
    // Chromium for loopback too would double up the sound.
    appAudioLog("sharing", videoSource.id, "with per-app audio");
    callback({ video: videoSource });
    return;
  }
  if (isWindow) {
    appAudioLog(
      "no per-app audio for window",
      source.id,
      "- sharing video only rather than the whole system mix",
    );
    callback({ video: videoSource });
    return;
  }
  appAudioLog(
    "screen share falling back to Chromium loopback (whole system mix)",
  );
  callback({ video: videoSource, audio: "loopback" });
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
 * Abandon any in-flight re-acquire. The renderer calls this when the user stops
 * sharing or leaves the call, so a poll cannot outlive the share it was started
 * for.
 */
ipcMain.on("screenShare:cancelReacquire", () => {
  if (lastShare) appAudioLog("reacquire: cancelled by renderer");
  reacquireGeneration++;
  lastShare = null;
  armedShare = null;
  // The renderer sends this once it considers the share fully over, so any
  // native video capture still running at this point is a leak, not a race
  // we need to be gentle with.
  stopScreenCapture();
});

ipcMain.handle("screenShare:reacquire", async () => {
  const target = lastShare;
  if (!target) {
    appAudioLog("reacquire: no remembered share");
    return false;
  }
  if (!target.sourceId.startsWith("window:")) {
    appAudioLog("reacquire: last share was a screen, not re-acquiring");
    return false;
  }

  const generation = ++reacquireGeneration;
  const deadline = Date.now() + REACQUIRE_TIMEOUT_MS;
  let pollMs = REACQUIRE_POLL_MS;
  appAudioLog(
    "reacquire: waiting for window",
    target.name,
    `(${target.sourceId}, pid ${target.pid})`,
  );

  while (Date.now() < deadline) {
    if (generation !== reacquireGeneration || lastShare !== target) {
      appAudioLog("reacquire: superseded, giving up");
      return false;
    }

    let match: Electron.DesktopCapturerSource | null = null;
    try {
      match = await findRememberedWindow(target);
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
  });

  mainWindow.webContents.on("unresponsive", () =>
    appAudioLog("renderer became unresponsive"),
  );

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) =>
    appAudioLog("preload failed:", preloadPath, String(error)),
  );

  // Errors the page itself reports. This is what would have caught the missing
  // VITE_HOST, and any future client-side breakage.
  mainWindow.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      if (level < 3) return; // 3 = error
      appAudioLog(`page error: ${message} (${sourceId}:${line})`);
    },
  );

  // The web app is remote, so the getDisplayMedia override has to be injected
  // into its main world on every load (contextIsolation keeps the preload out).
  mainWindow.webContents.on("did-finish-load", () => {
    appAudioLog("page loaded:", mainWindow.webContents.getURL());
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
  purgeCachedClient()
    .then(() => mainWindow.loadURL(getBuildUrl().toString()))
    .then(() => mainWindow.webContents.reload());

  // minimise window to tray
  mainWindow.on("close", (event) => {
    if (!shouldQuit && config.minimiseToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

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

  // Log renderer crashes to terminal
  mainWindow.webContents.on("render-process-gone", (_, details) => {
    console.error("RENDERER CRASHED:", details.reason, details.exitCode);
  });

  // Log unresponsive events
  mainWindow.on("unresponsive", () => {
    console.error("WINDOW UNRESPONSIVE");
  });

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

      // A re-acquire that already found the window answers straight away, so
      // the recovered share does not make the user pick it again.
      const armed = armedShare;
      armedShare = null;
      if (armed && Date.now() - armed.at < ARMED_TTL_MS) {
        appAudioLog("answering with re-acquired source", armed.source.id);
        stopAppAudio();
        stopScreenCapture();
        void respondToDisplayMedia(
          armed.source,
          armed.audio && request.audioRequested,
          callback,
        );
        return;
      }
      if (armed) {
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
        .then((sources) => {
          // Any previous share is over by the time a new one is requested.
          stopAppAudio();
          stopScreenCapture();
          appAudioLog("sources offered:", String(sources.length));

          // Shortcut for linux wayland.
          if (sources.length == 1) {
            void respondToDisplayMedia(
              sources[0],
              request.audioRequested,
              callback,
            );
            return;
          }
          ipcMain.once(
            "screenPickerCallback",
            (_, idx: number, audio: boolean) => {
              appAudioLog(
                "picker chose index",
                String(idx),
                "audio =",
                String(audio),
                idx >= 0 && idx < sources.length
                  ? sources[idx].id
                  : "(out of range)",
              );
              if (idx < 0 || idx >= sources.length) {
                // Electron's typings insist on an argument, but the documented
                // way to cancel is calling back with none: that is what turns
                // into a clean NotAllowedError in the renderer instead of an
                // unexpected rejection.
                lastShare = null;
                (callback as unknown as () => void)();
              } else {
                void respondToDisplayMedia(sources[idx], audio, callback);
              }
            },
          );
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
        });
    },
    { useSystemPicker: true },
  );

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
});
