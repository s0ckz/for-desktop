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

  // The web app is remote, so the getDisplayMedia override has to be injected
  // into its main world on every load (contextIsolation keeps the preload out).
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents
      .executeJavaScript(APP_AUDIO_PATCH)
      .catch((err) => console.warn("[appAudio] could not inject patch:", err));
  });

  // The web client registers a service worker that serves the whole app from
  // cache. Pointing the desktop at a different server (or upgrading a
  // self-hosted one) can therefore leave a stale client running against a new
  // backend, which shows up as a grey window. Drop those caches whenever the
  // origin changes.
  const purgeIfServerChanged = async () => {
    if (config.lastServer === BUILD_URL.origin) return;
    try {
      await session.defaultSession.clearStorageData({
        storages: ["serviceworkers", "cachestorage"],
      });
      console.log(
        `[window] server changed to ${BUILD_URL.origin}, cleared cached client`,
      );
    } catch (err) {
      console.warn("[window] could not clear cached client:", err);
    }
    config.lastServer = BUILD_URL.origin;
  };

  // load the entrypoint
  purgeIfServerChanged()
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
           * application. Falls back to the system mix whenever per-app capture
           * is unavailable, so behaviour never gets worse than before.
           */
          const respond = (source: Electron.DesktopCapturerSource, audio: boolean) => {
            if (!audio) {
              callback({ video: source });
              return;
            }
            if (startForSource(source.id)) {
              // Audio arrives out-of-band and is stitched in by the renderer;
              // asking Chromium for loopback too would double up the sound.
              callback({ video: source });
              return;
            }
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
              if (idx < 0 || idx > sources.length) {
                callback({});
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
