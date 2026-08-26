// Loading the addon must never be fatal: a missing or unbuildable binary just
// means we fall back to Chromium's system-wide loopback.
let native = null;
let loadError = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  native = require("./build/Release/win_app_audio.node");
} catch (err) {
  loadError = err;
}

const missingWindow = { exists: false, visible: false, iconic: false };

const unavailable = {
  isSupported: () => false,
  pidFromWindowHandle: () => 0,
  windowState: () => missingWindow,
  start: () => {
    throw new Error("win-app-audio native module is not available");
  },
  stop: () => {},
  lastError: () => (loadError ? String(loadError.message || loadError) : "not loaded"),
  sampleRate: 48000,
  channels: 2,
};

const api = native || unavailable;

module.exports = {
  /** True when the running OS can do per-process loopback capture. */
  isSupported: () => {
    try {
      return process.platform === "win32" && api.isSupported();
    } catch {
      return false;
    }
  },
  /** Resolve the owning process of a window handle (as given by desktopCapturer ids). */
  pidFromWindowHandle: (handle) => {
    try {
      return api.pidFromWindowHandle(handle);
    } catch {
      return 0;
    }
  },
  /** Whether a window handle still names a window we could capture right now. */
  windowState: (handle) => {
    try {
      return api.windowState(handle) || missingWindow;
    } catch {
      return missingWindow;
    }
  },
  /** Begin capture. onChunk receives 48kHz stereo signed 16-bit LE PCM buffers. */
  start: (pid, includeTree, onChunk) => api.start(pid, includeTree, onChunk),
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
  sampleRate: api.sampleRate || 48000,
  channels: api.channels || 2,
};
