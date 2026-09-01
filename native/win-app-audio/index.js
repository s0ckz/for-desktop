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
const deadMixState = { running: false, clients: [], scans: 0, lastError: "not loaded" };

const unavailable = {
  isSupported: () => false,
  pidFromWindowHandle: () => 0,
  windowState: () => missingWindow,
  start: () => {
    throw new Error("win-app-audio native module is not available");
  },
  stop: () => {},
  lastError: () => (loadError ? String(loadError.message || loadError) : "not loaded"),
  listAudioProcesses: () => [],
  startSystemExcluding: () => {
    throw new Error("win-app-audio native module is not available");
  },
  mixState: () => deadMixState,
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
  /** Enumerate every process currently rendering audio. Swallows on error. */
  listAudioProcesses: () => {
    try {
      return api.listAudioProcesses() || [];
    } catch {
      return [];
    }
  },
  /**
   * Begin mixed capture of every audible process except those named in
   * excludedNames (lowercase exe basenames). onChunk receives 48kHz stereo
   * signed 16-bit LE PCM buffers -- the same wire format as start(). Throws
   * when the native binary is not available, matching start()'s contract,
   * so beginCapture's existing try/catch handles both the same way.
   */
  startSystemExcluding: (excludedNames, onChunk) => api.startSystemExcluding(excludedNames, onChunk),
  /** Snapshot of the running mixer: live clients, scan count, last error. Swallows on error. */
  mixState: () => {
    try {
      return api.mixState() || deadMixState;
    } catch {
      return deadMixState;
    }
  },
  sampleRate: api.sampleRate || 48000,
  channels: api.channels || 2,
};
