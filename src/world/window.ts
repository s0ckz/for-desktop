import { contextBridge, ipcRenderer } from "electron";

import { version } from "../../package.json";

contextBridge.exposeInMainWorld("native", {
  versions: {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron,
    desktop: () => version,
  },

  minimise: () => ipcRenderer.send("minimise"),
  maximise: () => ipcRenderer.send("maximise"),
  close: () => ipcRenderer.send("close"),

  setBadgeCount: (count: number) => ipcRenderer.send("setBadgeCount", count),

  onceScreenPicker: (
    onScreenPick: (
      sources: {
        idx: number;
        name: string;
        isFullScreen: boolean;
        image?: string;
      }[],
    ) => void,
  ) => {
    const eventName = "screenPicker";
    ipcRenderer.removeAllListeners(eventName);
    ipcRenderer.once(eventName, (_, sources) => onScreenPick(sources));
  },
  screenPickerCallback: (idx: number, audio: boolean) =>
    ipcRenderer.send("screenPickerCallback", idx, audio),

  isWayland: () => ipcRenderer.invoke("getIsWayland"),

  // Per-application screen share audio (Windows). The injected main-world
  // patch uses this to turn captured PCM back into a MediaStreamTrack.
  appAudio: {
    getState: () => ipcRenderer.invoke("appAudio:getState"),
    stop: () => ipcRenderer.send("appAudio:stop"),
    onChunk: (handler: (chunk: Uint8Array) => void) => {
      const listener = (_: unknown, chunk: Uint8Array) => handler(chunk);
      ipcRenderer.on("appAudio:chunk", listener);
      return () => ipcRenderer.removeListener("appAudio:chunk", listener);
    },
  },
});
