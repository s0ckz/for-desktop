import { type JSONSchema } from "json-schema-typed";

import { ipcMain } from "electron";
import Store from "electron-store";

import { DEFAULT_SERVER } from "../constants";

import { destroyDiscordRpc, initDiscordRpc } from "./discordRpc";
import { mainWindow } from "./window";

const schema = {
  firstLaunch: {
    type: "boolean",
  } as JSONSchema.Boolean,
  customFrame: {
    type: "boolean",
  } as JSONSchema.Boolean,
  minimiseToTray: {
    type: "boolean",
  } as JSONSchema.Boolean,
  startMinimisedToTray: {
    type: "boolean",
  } as JSONSchema.Boolean,
  spellchecker: {
    type: "boolean",
  } as JSONSchema.Boolean,
  hardwareAcceleration: {
    type: "boolean",
  } as JSONSchema.Boolean,
  discordRpc: {
    type: "boolean",
  } as JSONSchema.Boolean,
  lastServer: {
    type: "string",
  } as JSONSchema.String,
  server: {
    type: "string",
  } as JSONSchema.String,
  windowState: {
    type: "object",
    properties: {
      x: {
        type: "number",
      } as JSONSchema.Number,
      y: {
        type: "number",
      } as JSONSchema.Number,
      width: {
        type: "number",
      } as JSONSchema.Number,
      height: {
        type: "number",
      } as JSONSchema.Number,
      isMaximised: {
        type: "boolean",
      } as JSONSchema.Boolean,
    },
  } as JSONSchema.Object,
};

const store = new Store({
  schema,
  defaults: {
    firstLaunch: true,
    customFrame: true,
    minimiseToTray: true,
    startMinimisedToTray: false,
    spellchecker: true,
    hardwareAcceleration: true,
    discordRpc: true,
    lastServer: "",
    server: DEFAULT_SERVER,
    windowState: {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      isMaximised: false,
    },
  } as DesktopConfig & { server: string },
});

/**
 * Shim for `electron-store` because typings are broken
 */
class Config {
  /** Current configuration as a plain object */
  snapshot(): DesktopConfig {
    return {
      firstLaunch: this.firstLaunch,
      customFrame: this.customFrame,
      minimiseToTray: this.minimiseToTray,
      startMinimisedToTray: this.startMinimisedToTray,
      spellchecker: this.spellchecker,
      hardwareAcceleration: this.hardwareAcceleration,
      discordRpc: this.discordRpc,
      lastServer: this.lastServer,
      windowState: this.windowState,
    } as DesktopConfig;
  }

  sync() {
    mainWindow.webContents.send("config", {
      firstLaunch: this.firstLaunch,
      customFrame: this.customFrame,
      minimiseToTray: this.minimiseToTray,
      startMinimisedToTray: this.startMinimisedToTray,
      spellchecker: this.spellchecker,
      hardwareAcceleration: this.hardwareAcceleration,
      discordRpc: this.discordRpc,
      windowState: this.windowState,
    });
  }

  get firstLaunch() {
    return (store as never as { get(k: string): boolean }).get("firstLaunch");
  }

  set firstLaunch(value: boolean) {
    (store as never as { set(k: string, value: boolean): void }).set(
      "firstLaunch",
      value,
    );

    this.sync();
  }

  get lastServer() {
    return (store as never as { get(k: string): string }).get("lastServer");
  }

  set lastServer(value: string) {
    (store as never as { set(k: string, value: string): void }).set(
      "lastServer",
      value,
    );
  }

  get customFrame() {
    return (store as never as { get(k: string): boolean }).get("customFrame");
  }

  set customFrame(value: boolean) {
    (store as never as { set(k: string, value: boolean): void }).set(
      "customFrame",
      value,
    );

    this.sync();
  }

  get minimiseToTray() {
    return (store as never as { get(k: string): boolean }).get(
      "minimiseToTray",
    );
  }

  set minimiseToTray(value: boolean) {
    (store as never as { set(k: string, value: boolean): void }).set(
      "minimiseToTray",
      value,
    );

    this.sync();
  }

  get startMinimisedToTray() {
    return (store as never as { get(k: string): boolean }).get(
      "startMinimisedToTray",
    );
  }

  set startMinimisedToTray(value: boolean) {
    (store as never as { set(k: string, value: boolean): void }).set(
      "startMinimisedToTray",
      value,
    );

    this.sync();
  }

  get spellchecker() {
    return (store as never as { get(k: string): boolean }).get("spellchecker");
  }

  set spellchecker(value: boolean) {
    mainWindow.webContents.session.setSpellCheckerEnabled(value);

    (store as never as { set(k: string, value: boolean): void }).set(
      "spellchecker",
      value,
    );

    this.sync();
  }

  get hardwareAcceleration() {
    return (store as never as { get(k: string): boolean }).get(
      "hardwareAcceleration",
    );
  }

  set hardwareAcceleration(value: boolean) {
    (store as never as { set(k: string, value: boolean): void }).set(
      "hardwareAcceleration",
      value,
    );

    this.sync();
  }

  get discordRpc() {
    return (store as never as { get(k: string): boolean }).get("discordRpc");
  }

  set discordRpc(value: boolean) {
    if (value) {
      initDiscordRpc();
    } else {
      destroyDiscordRpc();
    }

    (store as never as { set(k: string, value: boolean): void }).set(
      "discordRpc",
      value,
    );

    this.sync();
  }

  get windowState() {
    return (
      store as never as { get(k: string): DesktopConfig["windowState"] }
    ).get("windowState");
  }

  set windowState(value: DesktopConfig["windowState"]) {
    (
      store as never as {
        set(k: string, value: DesktopConfig["windowState"]): void;
      }
    ).set("windowState", value);

    this.sync();
  }
}

export const config = new Config();

// The renderer needs configuration before its first paint. Pushing it on
// did-finish-load races the page's own scripts, and the client dereferences
// windowState without a guard -- losing that race throws during startup and
// leaves a blank window. Answer synchronously at preload time instead.
ipcMain.on("config:getSync", (event) => {
  event.returnValue = config.snapshot();
});

/**
 * Read the persisted server URL. Main-process-only: `server` is
 * intentionally not part of `DesktopConfig`/`Config`, so the renderer
 * (a remote page) can never read or write it over the `config` IPC
 * channel. See `getPersistedServer` usage in `window.ts`.
 */
export function getPersistedServer(): string {
  return (store as never as { get(k: string): string }).get("server");
}

// Keys the renderer is allowed to write via the `config` IPC channel.
// `server` is deliberately excluded: the renderer is a remote page, and
// if it could set `server` it could permanently repoint the app at an
// attacker-controlled origin (which also becomes the `will-navigate`
// trusted origin via getBuildUrl().origin in main.ts). `autostart` is handled
// separately by dedicated ipcMain.handle channels in native/autoLaunch.ts,
// not this channel.
const RENDERER_WRITABLE_KEYS: readonly string[] = [
  "firstLaunch",
  "customFrame",
  "minimiseToTray",
  "startMinimisedToTray",
  "spellchecker",
  "hardwareAcceleration",
  "discordRpc",
  "windowState",
];

ipcMain.on("config", (_, newConfig: Partial<DesktopConfig>) => {
  console.info("Received new configuration", newConfig);
  for (const [key, value] of Object.entries(newConfig)) {
    if (!RENDERER_WRITABLE_KEYS.includes(key)) {
      console.warn("Ignoring non-writable config key from renderer:", key);
      continue;
    }
    config[key as keyof DesktopConfig] = value as never;
  }
});
