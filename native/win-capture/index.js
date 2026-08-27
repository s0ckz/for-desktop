// Loading the addon must never be fatal: a missing or unbuildable binary just
// means the caller falls back to Chromium's own (slower) desktop capture path.
let native = null;
let loadError = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  native = require("./build/Release/win_capture.node");
} catch (err) {
  loadError = err;
}

const unavailable = {
  isSupported: () => false,
  start: () => {
    throw new Error("win-capture native module is not available");
  },
  stop: () => {},
  lastError: () => (loadError ? String(loadError.message || loadError) : "not loaded"),
};

const api = native || unavailable;

module.exports = {
  /** True when the running OS/GPU can do Windows Graphics Capture with a video processor. */
  isSupported: () => {
    try {
      return process.platform === "win32" && api.isSupported();
    } catch {
      return false;
    }
  },
  /**
   * Begin capture of a top-level window. Frames are delivered fit-inside
   * targetWidth x targetHeight (aspect preserved, never stretched -- see
   * index.d.ts), at up to `fps` times per second. Frames produced faster than
   * that are dropped on the native side, never queued.
   */
  start: (hwnd, targetWidth, targetHeight, fps, onFrame) =>
    api.start(hwnd, targetWidth, targetHeight, fps, onFrame),
  stop: () => {
    try {
      api.stop();
    } catch {
      /* already stopped */
    }
  },
  lastError: () => {
    try {
      return api.lastError();
    } catch {
      return "unknown";
    }
  },
};
