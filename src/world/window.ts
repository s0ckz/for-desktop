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

  // Wait for a screen share that Chromium ended -- a window that toggled
  // fullscreen or was minimised -- to become shareable again. Resolves true
  // once the main process has the window lined up, at which point re-requesting
  // getDisplayMedia is answered with it and no picker appears.
  reacquireScreenShare: (): Promise<boolean> =>
    ipcRenderer.invoke("screenShare:reacquire"),

  // Per-application screen share audio (Windows). The injected main-world
  // patch uses this to turn captured PCM back into a MediaStreamTrack.
  appAudio: {
    getState: () => ipcRenderer.invoke("appAudio:getState"),
    getLogPath: () => ipcRenderer.invoke("appAudio:getLogPath"),
    openLogs: () => ipcRenderer.send("appAudio:openLogs"),
    stop: () => ipcRenderer.send("appAudio:stop"),
    onChunk: (handler: (chunk: Uint8Array) => void) => {
      const listener = (_: unknown, chunk: Uint8Array) => handler(chunk);
      ipcRenderer.on("appAudio:chunk", listener);
      return () => ipcRenderer.removeListener("appAudio:chunk", listener);
    },
  },

  // Native GPU-downscaled window capture (Windows). The injected main-world
  // patch uses this to turn captured NV12 frames back into a
  // MediaStreamTrack, in place of Chromium's own (slower) capture.
  screenCapture: {
    getState: () => ipcRenderer.invoke("screenCapture:getState"),
    stop: () => ipcRenderer.send("screenCapture:stop"),
    // One-shot announcement of the framerate the page just asked
    // getDisplayMedia for, sent immediately before the call that triggers
    // the actual display-media request -- see takeNextRequestedFps's doc
    // comment in native/screenCapture.ts for why this exists and its
    // read-and-clear contract.
    setNextFps: (fps: number) =>
      ipcRenderer.send("screenCapture:setNextFps", fps),
    // The page's console is filtered below error level (see window.ts's
    // console-message listener), so the injected patch reports which video
    // path a share took -- and, on fallback, why -- through here instead,
    // straight into app-audio.log where the rest of this diagnosis lives.
    log: (message: string) =>
      ipcRenderer.send("screenCapture:pageLog", message),
    onFrame: (
      handler: (
        frame: Uint8Array,
        meta: { width: number; height: number },
      ) => void,
    ) => {
      const listener = (
        _: unknown,
        frame: Uint8Array,
        meta: { width: number; height: number },
      ) => handler(frame, meta);
      ipcRenderer.on("screenCapture:frame", listener);
      return () => ipcRenderer.removeListener("screenCapture:frame", listener);
    },
    // Pushed whenever capture starts, stops, or the main process detects the
    // captured window went away -- see the long comment on the watchdogs in
    // screenCapture.ts for why this has to be a poll-driven push rather than
    // something the native module itself reports.
    onState: (
      handler: (state: {
        active: boolean;
        sourceId: string | null;
        width: number;
        height: number;
        fps: number;
        supported: boolean;
      }) => void,
    ) => {
      const listener = (
        _: unknown,
        state: {
          active: boolean;
          sourceId: string | null;
          width: number;
          height: number;
          fps: number;
          supported: boolean;
        },
      ) => handler(state);
      ipcRenderer.on("screenCapture:state", listener);
      return () => ipcRenderer.removeListener("screenCapture:state", listener);
    },
  },
});
