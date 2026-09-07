import fs from "node:fs";
import path from "node:path";

import { BrowserWindow, app, shell } from "electron";
import started from "electron-squirrel-startup";

import { initAppAudio } from "./native/appAudio";
import { config } from "./native/config";
import { initDiscordRpc } from "./native/discordRpc";
import { initScreenCapture } from "./native/screenCapture";
import { initTray } from "./native/tray";
import { initUpdater } from "./native/update";
import { initVirtualMic } from "./native/virtualMic";
import { createMainWindow, getBuildUrl, mainWindow } from "./native/window";

// Squirrel-specific logic
// create/remove shortcuts on Windows when installing / uninstalling
// we just need to close out of the app immediately
if (started) {
  app.quit();
}

// Windows resolves a taskbar button's icon and grouping through the
// AppUserModelID, by finding a Start Menu shortcut stamped with the same ID
// and borrowing its icon and name. Squirrel writes that shortcut as
// `com.squirrel.<name>.<execName>` -- "Stoat" and "stoat-desktop" from the
// STRINGS block in forge.config.ts, which is build-time only and not
// importable here, so the literal below has to be kept in sync by hand.
//
// A portable exe or a dev run has no shortcut at all. Setting an explicit
// AUMID there resolves to nothing *and* suppresses the fallback where
// Windows derives identity from the executable path -- which is what would
// otherwise pick up the icon rcedit stamped into stoat-desktop.exe. That
// suppressed fallback is the blank taskbar icon, so outside a Squirrel
// install we deliberately set nothing. Notifications lose nothing by it: an
// AUMID matching no shortcut never gave them a name or icon either.
//
// This has to run before any window exists -- it previously sat inside the
// `ready` handler below, after createMainWindow() had already registered the
// taskbar button under the old identity.
if (process.platform === "win32") {
  const isSquirrelInstall = fs.existsSync(
    path.join(process.execPath, "..", "..", "Update.exe"),
  );
  if (isSquirrelInstall) {
    app.setAppUserModelId("com.squirrel.Stoat.stoat-desktop");
  }
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

// The web client's codec probe only trusts hardware H.264 Constrained
// Baseline (CBP); anything else is treated as "no hardware H.264" and the
// probe falls back to vp9 libvpx software encoding with forced L1T3, which
// cannot sustain 1080p60. On Windows, Chromium only advertises a hardware
// CBP encoder once `PlatformH264CbpEncoding` is enabled -- without it the
// platform encoder is still there, just never offered as CBP, so the probe
// never sees it and every affected machine silently downgrades to software.
//
// Confirmed present in this project's pinned Electron: the literal string
// "PlatformH264CbpEncoding" is compiled into electron.exe for
// electron@43.4.0 (Chrome/150.0.7871.224), found alongside the same blink
// media-constraints strings that also list "H265" -- i.e. it is a real
// base::Feature name in this build, not something we're guessing at.
//
// Same appendSwitch caveat as `disable-features` above applies here too:
// build the whole list and pass it in one call, since a second
// enable-features call would replace this one instead of adding to it. As of
// this change nothing else in src/ calls enable-features (grepped before
// adding this), but if that ever changes, merge into this array rather than
// adding a second appendSwitch("enable-features", ...) call elsewhere.
//
// Risk: an unknown or misspelled feature name passed to enable-features is
// silently ignored by Chromium -- there is no error, no warning, nothing --
// so a typo here would be invisible at runtime and just quietly keep
// everyone on the software fallback. To confirm this actually took effect on
// a given machine, log RTCRtpSender.getStats()'s `encoderImplementation` (or
// check the ScreenShareStats overlay's "Encoder" row) during a share and
// look for `MediaFoundationVideoEncodeAccelerator`; seeing `libvpx` there
// instead means either this flag didn't take or the machine genuinely lacks
// a hardware CBP encoder.
if (process.platform === "win32") {
  const enabled: string[] = ["PlatformH264CbpEncoding"];
  app.commandLine.appendSwitch("enable-features", enabled.join(","));
}

// ensure only one copy of the application can run
const acquiredLock = app.requestSingleInstanceLock();

/** Guards against this module being evaluated more than once. */
let didInitialise = false;

if (acquiredLock) {
  // start auto update logic -- see native/update.ts for the toast, the tray
  // fallback, and the diagnostic logging around both.
  //
  // Deliberately outside the `app.on("ready", ...)` callback below, and so
  // NOT covered by `didInitialise` -- an update can in principle land before
  // `ready` even fires, and this starts the check as early as possible
  // rather than wait on it (see `onNotifyUser`'s own comment in update.ts).
  // If this module is ever evaluated twice (see the `didInitialise` comment
  // for the confirmed case of that), initUpdater() no longer needs a second
  // guard here: it has its own once-flag now (plan PR A5 item 5) precisely
  // because it sits outside `didInitialise`'s reach.
  initUpdater();

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
    initScreenCapture();
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
