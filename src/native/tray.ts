import { Menu, Tray, nativeImage } from "electron";

import trayIconAsset from "../../assets/desktop/icon.png?asset";
import macOsTrayIconAsset from "../../assets/desktop/iconTemplate.png?asset";
import { version } from "../../package.json";

import { applyStagedUpdate, isUpdateStaged } from "./update";
import { mainWindow, quitApp } from "./window";

// internal tray state
let tray: Tray = null;

// Create and resize tray icon for macOS
function createTrayIcon() {
  if (process.platform === "darwin") {
    const image = nativeImage.createFromDataURL(macOsTrayIconAsset);
    const resized = image.resize({ width: 20, height: 20 });
    resized.setTemplateImage(true);
    return resized;
  } else {
    return nativeImage.createFromDataURL(trayIconAsset);
  }
}

export function initTray() {
  const trayIcon = createTrayIcon();
  tray = new Tray(trayIcon);
  updateTrayMenu();
  tray.setToolTip("Stoat for Desktop");
  tray.setImage(trayIcon);
  tray.on("click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

export function updateTrayMenu() {
  // update.ts's onNotifyUser can call this before createMainWindow() +
  // initTray() have run (an update landing before app.on("ready") fires),
  // unlike every other caller here, which only runs once both `tray` and
  // `mainWindow` are alive. Bail rather than dereference a null tray.
  if (!tray) return;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Stoat for Desktop", type: "normal", enabled: false },
      {
        label: "Version",
        type: "submenu",
        submenu: Menu.buildFromTemplate([
          {
            label: version,
            type: "normal",
            enabled: false,
          },
        ]),
      },
      { type: "separator" },
      {
        label: mainWindow.isVisible() ? "Hide App" : "Show App",
        type: "normal",
        click() {
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
          }
        },
      },
      // Only appears once update.ts has actually staged a new version on
      // disk. This exists so a toast the user missed, dismissed, or (per the
      // bug it was added for) that never delivered its click at all is not
      // the only way to apply an update that is already sitting there ready
      // to go.
      ...(isUpdateStaged()
        ? [
            {
              label: "Restart to update",
              type: "normal" as const,
              click: () => applyStagedUpdate("tray menu"),
            },
          ]
        : []),
      {
        label: "Quit App",
        type: "normal",
        click: quitApp,
      },
    ]),
  );
}
