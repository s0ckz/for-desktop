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

// The full set of methods index.d.ts declares -- single source of truth for
// the `unavailable` fallback below, so a name added to `unavailable` (or
// left out of it) can never drift from the real list by hand. check-exports.js
// asserts this array matches index.d.ts, and separately asserts
// module.exports forwards every name in it, so a method missing from either
// half of this file fails that check instead of shipping silently -- see its
// own comment for why that check exists at all.
const METHODS = [
  "isSupported",
  "start",
  "stop",
  "setFps",
  "setTarget",
  "lastError",
];

const unavailable = {};
for (const name of METHODS) unavailable[name] = () => false;
unavailable.start = () => {
  throw new Error("win-capture native module is not available");
};
// Must match the real addon's shape (a resolved Promise, not undefined) --
// see module.exports.stop's comment below for why.
unavailable.stop = () => Promise.resolve();
unavailable.lastError = () =>
  loadError ? String(loadError.message || loadError) : "not loaded";

const api = native || unavailable;

// This object must mirror index.d.ts exactly: every method declared there
// needs a matching entry here, forwarding to `api`. test-capture.js (the dev
// harness) also goes through this file -- it requires "./index.js", not the
// addon directly -- but it only calls isSupported/start/stop/lastError, so a
// method missing here (setTarget, previously) is invisible to it too. Don't
// assume the harness exercises a method just because it goes through this
// wrapper; check test-capture.js's own call list, or check-exports.js.
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
  /**
   * Resolves once the capture thread has actually joined (see index.d.ts).
   * screenCapture.ts's stopNative() awaits this specifically to know when
   * it is safe to call start() again -- returning early (e.g. `undefined`,
   * which resolves in one microtask) makes stopNative()'s own promise settle
   * before the native join is done, so a caller racing to restart hits the
   * addon's "previous capture still shutting down" throw instead of waiting
   * it out. Must return the addon's actual promise, not just invoke it.
   */
  stop: () => {
    try {
      return Promise.resolve(api.stop());
    } catch {
      return Promise.resolve();
    }
  },
  /** Change the delivery rate of a running capture. False if nothing is capturing. */
  setFps: (fps) => {
    try {
      return api.setFps(fps);
    } catch {
      return false;
    }
  },
  /** Change the target bounding box of a running capture. False if nothing is capturing. */
  setTarget: (width, height) => {
    try {
      return api.setTarget(width, height);
    } catch {
      return false;
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

// Exposed purely for check-exports.js -- lets it verify METHODS itself
// (the list `unavailable` is built from) hasn't drifted from index.d.ts,
// on top of verifying module.exports forwards everything in METHODS.
module.exports.METHODS = METHODS;
