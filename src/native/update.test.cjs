const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function load(file, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, file), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
  new Function("require", "module", "exports", code)(
    (name) => {
      assert(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}

function updater() {
  const handlers = new Map();
  const messages = [];
  const autoUpdater = new EventEmitter();
  let installs = 0;
  autoUpdater.quitAndInstall = () => installs++;
  class Notification extends EventEmitter {
    static isSupported() {
      return true;
    }
    show() {}
    close() {}
  }
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: {},
      send: (channel, state) => messages.push({ channel, state }),
    },
  };
  const options = [];
  const api = load("update.ts", {
    electron: {
      Notification,
      app: new EventEmitter(),
      autoUpdater,
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    },
    "update-electron-app": {
      UpdateSourceType: { ElectronPublicUpdateService: 0 },
      updateElectronApp: (value) => options.push(value),
    },
    "./appAudio": { log() {} },
    "./tray": { updateTrayMenu() {} },
    "./window": { mainWindow: window },
  });
  api.initUpdater();
  return {
    api,
    autoUpdater,
    handlers,
    messages,
    options,
    window,
    installs: () => installs,
    event: () => ({
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    }),
    ready: () => options[0].onNotifyUser({ releaseName: "1.9.0" }),
  };
}

test("one existing updater checks every five minutes and restores status through IPC", () => {
  const h = updater();
  h.api.initUpdater();
  assert.equal(h.options.length, 1);
  assert.equal(h.options[0].updateInterval, "5 minutes");
  assert.equal(h.options[0].updateSource.repo, "s0ckz/for-desktop");
  assert.deepEqual(h.handlers.get("updater:getState")(), {
    status: "idle",
    version: null,
  });
  h.autoUpdater.emit("update-available");
  assert.equal(h.messages.at(-1).state.status, "downloading");
  h.ready();
  assert.deepEqual(h.handlers.get("updater:getState")(), {
    status: "ready",
    version: "1.9.0",
  });
  h.autoUpdater.emit("update-available");
  assert.equal(h.api.getUpdateState().status, "ready");
  const snapshot = h.api.getUpdateState();
  snapshot.status = "idle";
  assert.equal(h.api.getUpdateState().status, "ready");
});

test("restart requires a staged update and the app's main frame; duplicate clicks are ignored", () => {
  const h = updater(),
    install = h.handlers.get("updater:install");
  assert.equal(install(h.event()), false);
  h.ready();
  assert.equal(install({ ...h.event(), sender: {} }), false);
  assert.equal(install({ ...h.event(), senderFrame: {} }), false);
  assert.equal(h.installs(), 0);
  assert.equal(install(h.event()), true);
  assert.equal(h.api.getUpdateState().status, "installing");
  assert.equal(install(h.event()), false);
  assert.equal(h.api.applyStagedUpdate("tray"), false);
  assert.equal(h.installs(), 1);
});

test("failed downloads clear the indicator; failed installation retains the staged update for retry", () => {
  const h = updater();
  h.autoUpdater.emit("update-available");
  h.autoUpdater.emit("error", new Error("offline"));
  assert.deepEqual(h.api.getUpdateState(), { status: "idle", version: null });
  h.ready();
  h.autoUpdater.quitAndInstall = () => {
    throw new Error("restart failed");
  };
  assert.equal(h.api.applyStagedUpdate("button"), false);
  assert.equal(h.api.getUpdateState().status, "ready");
  h.autoUpdater.quitAndInstall = () => {};
  assert.equal(h.api.applyStagedUpdate("button"), true);
  h.autoUpdater.emit("error", new Error("async restart failure"));
  assert.equal(h.api.getUpdateState().status, "ready");
  assert.equal(h.api.isUpdateStaged(), true);
});

test("a renderer reload can read a staged update without a live window to notify", () => {
  const h = updater();
  h.window.isDestroyed = () => true;
  h.ready();
  assert.equal(h.messages.length, 0);
  assert.equal(h.handlers.get("updater:getState")().status, "ready");
  assert.equal(h.handlers.get("updater:install")(h.event()), false);
});

test("preload exposes a scoped update subscription with working cleanup", async () => {
  const ipc = new EventEmitter();
  const calls = [];
  ipc.invoke = (channel) => {
    calls.push(channel);
    return Promise.resolve(
      channel === "updater:install"
        ? true
        : { status: "ready", version: "1.9.0" },
    );
  };
  let native;
  load("../world/window.ts", {
    electron: {
      ipcRenderer: ipc,
      contextBridge: { exposeInMainWorld: (_name, value) => (native = value) },
    },
    "../../package.json": { version: "1.8.1" },
  });
  const states = [];
  const stop = native.updater.onState((state) => states.push(state));
  ipc.emit("updater:state", {}, { status: "ready", version: "1.9.0" });
  assert.equal(states.length, 1);
  assert.equal(stop(), undefined);
  ipc.emit("updater:state", {}, { status: "idle", version: null });
  assert.equal(states.length, 1);
  assert.equal(ipc.listenerCount("updater:state"), 0);
  assert.equal((await native.updater.getState()).status, "ready");
  assert.equal(await native.updater.install(), true);
  assert.deepEqual(calls, ["updater:getState", "updater:install"]);
});
