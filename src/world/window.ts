import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

import { version } from "../../package.json";

// Dedicated frame-delivery port (plan PR A4 item 2), replacing a plain
// `ipcRenderer.on("screenCapture:frame", ...)` listener bound to a channel
// every other IPC message in the app also uses. `native/window.ts` posts a
// fresh `MessageChannelMain` port down `FRAME_PORT_CHANNEL` on every
// `did-finish-load` -- including a reload, so this is a mutable slot, not a
// value claimed once at preload startup. Handlers registered through
// `onFrame` below must survive a port swap without resubscribing (the page
// that called `onFrame` has no idea a reload happened, and appAudioPatch.ts
// is not touched by this item), so frames fan out to a small local listener
// set instead of binding the caller's handler straight to the port.
const FRAME_PORT_CHANNEL = "screenCapture:framePort";
type FrameMeta = { width: number; height: number; timestampUs: number };
type FrameHandler = (frame: Uint8Array, meta: FrameMeta) => void;
let framePort: MessagePort | null = null;
const frameHandlers = new Set<FrameHandler>();

ipcRenderer.on(FRAME_PORT_CHANNEL, (event: IpcRendererEvent) => {
  // Old port first: a reload means the previous port's other end (the main
  // process's `framePort` in screenCapture.ts) was already closed and
  // replaced there (see `setFramePort`'s doc comment) -- closing this end
  // too is just tidiness, not a leak fix (this whole renderer context is
  // about to be torn down along with it either way), but doing it
  // explicitly means nothing is left relying on GC to notice.
  if (framePort) {
    try {
      framePort.close();
    } catch {
      /* already closed */
    }
  }
  framePort = event.ports[0] ?? null;
  if (!framePort) return;
  framePort.onmessage = (e: MessageEvent) => {
    const { frame, meta } = e.data as { frame: Uint8Array; meta: FrameMeta };
    for (const handler of frameHandlers) handler(frame, meta);
  };
  // Only needed for the *receiving* end of a MessagePort -- this port is
  // otherwise idle (native capture pushes; nothing here replies), but
  // messages queue until start() is called regardless, per the MessagePort
  // spec.
  framePort.start();
});

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
    // Direct observable for the duplicate-subscription mechanism behind the
    // session-overlap bug: the injected patch logs this alongside every
    // session it builds. This is read *after* the new session's onChunk has
    // subscribed and *before* the old session's unsubscribes, so
    // "chunk listeners=2" is the normal reading on every source change, not a
    // regression -- do not triage on it. A regression is 2 observed
    // steady-state (well after a share has settled) or >=3 at build time.
    listenerCount: () => ipcRenderer.listenerCount("appAudio:chunk"),
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
    /** Change the rate of a share already running (a mid-share quality change). */
    setFps: (fps: number) => ipcRenderer.send("screenCapture:setFps", fps),
    /** Change the target bounding box of a share already running (a
     *  mid-share quality change) -- see setLiveTarget's doc comment in
     *  native/screenCapture.ts. */
    setTarget: (width: number, height: number) =>
      ipcRenderer.send("screenCapture:setTarget", width, height),
    // The page's console is filtered below error level (see window.ts's
    // console-message listener), so the injected patch reports which video
    // path a share took -- and, on fallback, why -- through here instead,
    // straight into app-audio.log where the rest of this diagnosis lives.
    log: (message: string) =>
      ipcRenderer.send("screenCapture:pageLog", message),
    // Delivered over the dedicated port wired above, not a plain
    // `ipcRenderer` channel -- see `FRAME_PORT_CHANNEL`'s doc comment. The
    // shape of this call is unchanged (register a handler, get an
    // unsubscribe function back) so appAudioPatch.ts, which calls this, did
    // not need to change for the port swap.
    onFrame: (handler: FrameHandler) => {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
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
