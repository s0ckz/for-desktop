import { contextBridge, ipcRenderer } from "electron";

// Seeded synchronously so `get()` is usable from the very first render; the
// push below keeps it current afterwards.
let config: DesktopConfig = (() => {
  try {
    return ipcRenderer.sendSync("config:getSync") as DesktopConfig;
  } catch {
    return undefined as unknown as DesktopConfig;
  }
})();

ipcRenderer.on("config", (_, data) => (config = data));

contextBridge.exposeInMainWorld("desktopConfig", {
  get: () => config,
  set: (config: DesktopConfig) => ipcRenderer.send("config", config),
  getAutostart() {
    return ipcRenderer.invoke("getAutostart") as Promise<boolean>;
  },
  setAutostart(value: boolean) {
    return ipcRenderer.invoke("setAutostart", value) as Promise<boolean>;
  },
});
