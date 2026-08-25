import {
  IUpdateInfo,
  UpdateSourceType,
  updateElectronApp,
} from "update-electron-app";

import { BrowserWindow, Notification, app, shell } from "electron";
import started from "electron-squirrel-startup";

import { initAppAudio } from "./native/appAudio";
import { config } from "./native/config";
import { initDiscordRpc } from "./native/discordRpc";
import { initTray } from "./native/tray";
import { initVirtualMic } from "./native/virtualMic";
import { createMainWindow, getBuildUrl, mainWindow } from "./native/window";

// Squirrel-specific logic
// create/remove shortcuts on Windows when installing / uninstalling
// we just need to close out of the app immediately
if (started) {
  app.quit();
}

// disable hw-accel if so requested
if (!config.hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// Every Windows.Graphics.Capture session is brokered by the CaptureService
// service (`svchost -k LocalService -s CaptureService`). Measured on Windows 10
// 22H2 during a share: that service sat at 85-100% of a core for the entire
// duration, its threadpool threads parked in EventPairLow -- drowning in RPC
// rather than computing -- while alt-tab and the Start menu stopped responding.
// Discord captures through DXGI desktop duplication, never loads
// GraphicsCapture.dll, and does not do this on the same machine.
//
// Dropping WGC for screens selects ScreenCapturerWinDirectx (DXGI), falling
// back to ScreenCapturerWinGdi; both are compiled into Electron already.
//
// `AllowWgcScreenCapturer` is the only switch that exists. `CreateWindowCapturer`
// is hard-coded to WgcCapturerWin with no feature flag or field trial behind it,
// so a *window* share cannot be moved off WGC from here at all -- see
// `--window-shares-as-screen` in native/window.ts for the one workaround we do
// have.
//
// `--keep-wgc-screen` restores stock behaviour so the two can be compared
// without a rebuild; `--no-wgc-zero-hz` additionally drops WGC's
// deliver-nothing-when-idle path, which is a plausible source of retry churn.
if (process.platform === "win32") {
  const disabled: string[] = [];
  if (!app.commandLine.hasSwitch("keep-wgc-screen")) {
    disabled.push("AllowWgcScreenCapturer");
  }
  if (app.commandLine.hasSwitch("no-wgc-zero-hz")) {
    disabled.push("AllowWgcScreenZeroHz");
  }
  // appendSwitch replaces rather than appends when the switch already exists,
  // so the whole list has to go in one call.
  if (disabled.length) {
    app.commandLine.appendSwitch("disable-features", disabled.join(","));
  }
}

// ensure only one copy of the application can run
const acquiredLock = app.requestSingleInstanceLock();

const onNotifyUser = (_info: IUpdateInfo) => {
  const notification = new Notification({
    title: "Update Available",
    body: "Restart the app to install the update.",
    silent: true,
  });

  notification.show();
};

/** Guards against this module being evaluated more than once. */
let didInitialise = false;

if (acquiredLock) {
  // start auto update logic
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: "s0ckz/for-desktop",
    },
    onNotifyUser,
  });

  // create and configure the app when electron is ready
  app.on("ready", () => {
    // app-audio.log shows every startup line twice -- two "session start"
    // blocks, two "page loaded", two patch injections -- which means this
    // module gets evaluated twice and registers two `ready` listeners. The
    // second run built a second BrowserWindow and re-ran initAppAudio(), whose
    // ipcMain.handle calls then threw for being registered twice. Only the
    // first run may proceed.
    if (didInitialise) {
      console.warn("[main] ready fired twice; ignoring the second run");
      return;
    }
    didInitialise = true;

    // create window and application contexts
    createMainWindow();

    // save first launch state
    if (config.firstLaunch) {
      // Doesn't do anything right now. Used to enable auto start, but that behaviour was removed.
      // Left in case it gets used in the future.
      config.firstLaunch = false;
    }

    initTray();
    initDiscordRpc();
    initVirtualMic();
    initAppAudio();

    // Windows specific fix for notifications
    if (process.platform === "win32") {
      app.setAppUserModelId("chat.stoat.notifications");
    }
  });

  // focus the window if we try to launch again
  app.on("second-instance", () => {
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  });

  // macOS specific behaviour to keep app active in dock:
  // (irrespective of the minimise-to-tray option)

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ensure URLs launch in external context
  app.on("web-contents-created", (_, contents) => {
    // prevent navigation out of build URL origin
    contents.on("will-navigate", (event, navigationUrl) => {
      if (new URL(navigationUrl).origin !== getBuildUrl().origin) {
        event.preventDefault();
      }
    });

    // handle links externally
    contents.setWindowOpenHandler(({ url }) => {
      if (
        url.startsWith("http:") ||
        url.startsWith("https:") ||
        url.startsWith("mailto:")
      ) {
        setImmediate(() => {
          shell.openExternal(url);
        });
      }

      return { action: "deny" };
    });
  });
} else {
  app.quit();
}
