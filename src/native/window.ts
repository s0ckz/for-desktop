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

import { log as appAudioLog, startForSource, stop as stopAppAudio } from "./appAudio";
import { APP_AUDIO_PATCH } from "./appAudioPatch";
import { config } from "./config";
import { updateTrayMenu } from "./tray";

// global reference to main window
export let mainWindow: BrowserWindow;

// currently in-use build
// Defaults to our self-hosted instance. Note there is no /app path here: the
// self-hosted web client is served at the root, unlike stoat.chat.
// Override at launch with --force-server=https://example.com
export const DEFAULT_SERVER = "https://stoat.lrl.com.br";

export const BUILD_URL = new URL(
  app.commandLine.hasSwitch("force-server")
    ? app.commandLine.getSwitchValue("force-server")
    : DEFAULT_SERVER,
);

// internal window state
let shouldQuit = false;

// load the window icon
const windowIcon = nativeImage.createFromDataURL(windowIconAsset);

// windowIcon.setTemplateImage(true);

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
    },
  });

  // hide the options
  mainWindow.setMenu(null);

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
    mainWindow.webContents
      .executeJavaScript(APP_AUDIO_PATCH)
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
    config.lastServer = BUILD_URL.origin;
  };

  // load the entrypoint
  purgeCachedClient()
    .then(() => mainWindow.loadURL(BUILD_URL.toString()))
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

      desktopCapturer
        .getSources({ types: ["screen", "window"], fetchWindowIcons: true })
        .then((sources) => {
          // Any previous share is over by the time a new one is requested.
          stopAppAudio();
          appAudioLog("sources offered:", String(sources.length));

          /**
           * Answer the request, preferring audio from just the shared
           * application.
           *
           * A *window* share that cannot get per-app audio is answered with
           * video only: Chromium's `"loopback"` is the entire system mix,
           * including the voice call itself, which is exactly the leak this
           * whole module exists to avoid. Only whole-screen shares -- where
           * the system mix is what the user asked for anyway -- fall back to
           * it.
           */
          const respond = (source: Electron.DesktopCapturerSource, audio: boolean) => {
            const isWindow = source.id.startsWith("window:");
            if (!audio) {
              appAudioLog("sharing", source.id, "without audio");
              callback({ video: source });
              return;
            }
            if (startForSource(source.id)) {
              // Audio arrives out-of-band and is stitched in by the renderer;
              // asking Chromium for loopback too would double up the sound.
              appAudioLog("sharing", source.id, "with per-app audio");
              callback({ video: source });
              return;
            }
            if (isWindow) {
              appAudioLog(
                "no per-app audio for window",
                source.id,
                "- sharing video only rather than the whole system mix",
              );
              callback({ video: source });
              return;
            }
            appAudioLog(
              "screen share falling back to Chromium loopback (whole system mix)",
            );
            callback({ video: source, audio: "loopback" });
          };

          // Shortcut for linux wayland.
          if (sources.length == 1) {
            respond(sources[0], request.audioRequested);
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
                idx >= 0 && idx < sources.length ? sources[idx].id : "(out of range)",
              );
              if (idx < 0 || idx >= sources.length) {
                // Electron's typings insist on an argument, but the documented
                // way to cancel is calling back with none: that is what turns
                // into a clean NotAllowedError in the renderer instead of an
                // unexpected rejection.
                (callback as unknown as () => void)();
              } else {
                respond(sources[idx], audio);
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

  // mainWindow.webContents.openDevTools();

  // let i = 0;
  // setInterval(() => setBadgeCount((++i % 30) + 1), 1000);
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
