import {
  IUpdateInfo,
  UpdateSourceType,
  updateElectronApp,
} from "update-electron-app";

import { Notification, app, autoUpdater } from "electron";

import { log as appAudioLog } from "./appAudio";
import { updateTrayMenu } from "./tray";

/**
 * Whether Squirrel has already staged a newer version on disk and is just
 * waiting for a relaunch to swap to it. Once `update-downloaded` fires this
 * stays true for the rest of the process's life -- there is no path back to
 * "not staged" short of actually restarting into the new version.
 *
 * Drives the tray's "Restart to update" item: a missed, dismissed, or (per
 * the bug this module was rewritten for) silently undelivered toast must not
 * be the only way to apply an update that is already sitting there ready to
 * go.
 */
let updateStaged = false;

export function isUpdateStaged(): boolean {
  return updateStaged;
}

/**
 * The live "Update Available" toast, if any.
 *
 * Held here so it isn't garbage collected while still on screen. A
 * `Notification` built and shown from inside a callback, with nothing else
 * keeping a reference once that callback returns, is a documented Electron
 * trap for a toast that silently stops delivering its `click` event -- the
 * user still sees it (Windows renders straight from the OS-side toast until
 * it's dismissed), but nothing in the main process is left listening.
 * (`Notification` is a main-process object; no renderer is involved here at
 * all.) That matches everything the Squirrel and app-audio logs showed for
 * the report this fixes: staged cleanly on disk, a toast the user says they clicked,
 * and then nothing -- no relaunch, and previously no log line either way.
 * It is not, however, a confirmed root cause; it's the strongest suspect we
 * could find and the logging below exists so a recurrence can be told apart
 * from it.
 */
let activeNotification: Notification | null = null;

/**
 * Relaunch into the version Squirrel already staged on disk.
 *
 * Called from both the toast's click handler and the tray's "Restart to
 * update" item, so both routes get identical logging and error handling.
 *
 * (This and the other Squirrel-specific claims in this file describe the
 * Squirrel packaging path, which is what we ship today -- `forge.config.ts`
 * also builds a `MakerAppX`, and Electron swaps in its MSIX auto-updater
 * implementation when `process.windowsStore` is true, where none of this
 * applies.)
 */
export function applyStagedUpdate(source: string) {
  appAudioLog(`update: quitAndInstall() called (from ${source})`);
  try {
    autoUpdater.quitAndInstall();
  } catch (err) {
    // Windows autoUpdater failures during quitAndInstall tend to surface as
    // an `error` event rather than a thrown exception (see the listener
    // below), so this mostly guards against something else throwing
    // synchronously in here -- but it's cheap insurance either way, and it's
    // now actually written down instead of going to a console nobody has
    // attached to a packaged GUI app.
    appAudioLog("update: quitAndInstall() threw:", String(err));
  }
}

/**
 * Tell the user an update is staged, and let one click apply it.
 *
 * Passing `onNotifyUser` at all replaces update-electron-app's own notifier,
 * which puts up a modal dialog with Restart Now / Later and calls
 * quitAndInstall() for you. A toast is the right call here -- this app is
 * usually behind a game or a call, and stealing focus to announce an update
 * is worse than the update waiting -- but the toast has to actually *do*
 * something, otherwise the only way to apply an update is to notice a
 * message that has already faded and then quit by hand.
 *
 * Not `silent`: a notification nobody hears, about a thing nobody is looking
 * for, is decoration.
 */
function showUpdateToast(info: IUpdateInfo) {
  // Replace, don't stack: only one update can ever be staged at a time (the
  // process restarts into it once applied), so an earlier toast is stale the
  // moment a newer one exists.
  activeNotification?.close();

  const notification = new Notification({
    title: "Update Available",
    body:
      // Squirrel stages the new version before this toast is ever shown, so
      // quitting and relaunching by *any* means already applies it -- saying
      // so gives the user a fallback the instant they read this, without
      // making the click itself any less the primary path. Not "restart the
      // app whenever": with `minimiseToTray` on (the default, see
      // config.ts), clicking the window's X hides it instead of quitting, so
      // that would send the user right back into the bug this file exists
      // to fix. Quitting from the tray icon is the one thing guaranteed to
      // actually exit the process.
      "Already downloaded. Click to restart now, or quit from the tray icon whenever -- either applies it.",
  });
  activeNotification = notification;

  notification.on("click", () => {
    appAudioLog("update: toast clicked");
    // Squirrel has already staged the new version by the time this fires
    // (showUpdateToast is only called from the update-downloaded handler),
    // so this swaps to it and relaunches. quitAndInstall() throws when the
    // app was not installed by Squirrel -- a portable/zip copy, or
    // `electron-forge start` -- and there is nothing useful to do about that
    // beyond not crashing the app over a notification click: those builds
    // have no update to apply in the first place, and never reach this
    // callback.
    applyStagedUpdate("toast click");
  });

  // Windows-only: fires when the OS fails to create or show the native
  // toast at all -- Focus Assist/Do Not Disturb, notifications disabled for
  // this app's AUMID, or a COM-activation failure are all plausible causes.
  // Without this, that failure mode is indistinguishable in the log from a
  // toast that showed fine and was simply never clicked, or from the GC
  // trap `activeNotification` exists to rule out: all three read as
  // "showing toast for version X" followed by nothing.
  notification.on("failed", (_event, error) => {
    appAudioLog("update: toast failed to show:", error);
  });

  appAudioLog(
    "update: showing toast for version",
    info.releaseName || "(unknown)",
  );
  notification.show();
}

/**
 * Start the updater. Only called when the single-instance lock was
 * acquired -- a second instance quits immediately (see main.ts) and has no
 * business polling for or applying updates.
 */
export function initUpdater() {
  // Logged once at startup rather than per-toast: if notifications are
  // unsupported on this machine at all, every "showing toast for version X"
  // line for the rest of the session is a known dead end rather than a
  // fresh mystery.
  appAudioLog(
    "update: Notification.isSupported():",
    Notification.isSupported(),
  );

  // update-electron-app registers its own `autoUpdater.on("error", ...)`
  // that logs to `console` (or whatever `logger` option is passed, which we
  // don't set). That's fine in a dev terminal, but a packaged Windows GUI app
  // has no console attached, so it's exactly the kind of async failure that
  // used to leave no trace at all. This is added alongside that listener,
  // not instead of it -- Node's EventEmitter runs every listener for an
  // event, so both fire.
  autoUpdater.on("error", (err) => {
    appAudioLog("update: autoUpdater error:", String(err));
  });

  autoUpdater.on("update-available", () => {
    appAudioLog("update: update available, downloading...");
  });

  // `quitAndInstall()` is `squirrelUpdate.processStart(); app.quit();` on
  // Windows (per Electron's own auto-updater-win source): it spawns
  // `Update.exe --processStartAndWait <exe>` detached and then asks the app
  // to quit. Logging just "quitAndInstall() called" cannot tell a clean
  // relaunch apart from a quit that got vetoed or wedged -- both look like
  // the log stopping there, since the good outcome also stops logging (the
  // process is gone). These two events mark whether the quit itself actually
  // got underway, so a recurrence points at Squirrel/`Update.exe` instead of
  // back at square one.
  app.on("will-quit", () => {
    appAudioLog("update: will-quit fired");
  });
  autoUpdater.on("before-quit-for-update", () => {
    appAudioLog("update: before-quit-for-update fired");
  });

  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: "s0ckz/for-desktop",
    },
    onNotifyUser: (info) => {
      updateStaged = true;
      appAudioLog(
        "update: update downloaded, version",
        info.releaseName || "(unknown)",
      );
      // Show the toast before touching the tray: updateTrayMenu() reaches
      // into module-level state on two other modules (tray.ts's `tray`,
      // window.ts's `mainWindow`) that are only guaranteed alive once
      // createMainWindow() + initTray() have run in app.on("ready"). Every
      // other caller of updateTrayMenu() runs after that point; this one
      // doesn't have that guarantee, an update can in principle land before
      // `ready` fires. If updateTrayMenu() throws, doing it after the toast
      // means the user still gets the toast -- the one thing this whole file
      // exists to make reliable -- instead of an uncaught main-process
      // exception eating the notification entirely.
      showUpdateToast(info);
      updateTrayMenu();
    },
  });
}
