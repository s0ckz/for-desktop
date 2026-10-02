const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const test = require("node:test");

function harness() {
  let now = 1000,
    wall = 100000,
    id = 0,
    stopCalls = 0;
  const timers = new Map(),
    handlers = {},
    logs = [];
  const health = {
    ready: true,
    running: true,
    lastError: "transient conversion error",
    maxLoopGapMs: 0,
    loopIdleMs: 0,
    incomingFrames: 0,
    emittedFrames: 0,
    tsfnQueuedFrames: 0,
    tsfnRejectedFrames: 0,
    payloadPoolPressurePolls: 0,
    sourceTimestampOffsets: {
      acquisition: {
        count: 1,
        meanMs: -20,
        minMs: -20,
        maxMs: -20,
        negativeSamples: 1,
      },
    },
  };
  const native = {
    isSupported: () => true,
    start: () => true,
    stop: () => {
      stopCalls++;
      return Promise.resolve();
    },
    lastError: () => health.lastError,
    diagnostics: () => ({ ...health }),
  };
  function load(file, deps = {}) {
    const code = ts.transpileModule(
      fs.readFileSync(path.join(__dirname, file), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      },
    ).outputText;
    const module = { exports: {} };
    new Function(
      "require",
      "module",
      "exports",
      "performance",
      "Date",
      "setInterval",
      "clearInterval",
      code,
    )(
      (name) => {
        if (name in deps) return deps[name];
        throw Error(name);
      },
      module,
      module.exports,
      { now: () => now },
      { now: () => wall },
      (callback, interval) => {
        const key = ++id;
        timers.set(key, { callback, interval });
        return key;
      },
      (key) => timers.delete(key),
    );
    return module.exports;
  }
  const api = load("screenCapture.ts", {
    electron: {
      app: {
        getVersion: () => "test",
        commandLine: { getSwitchValue: () => "" },
      },
      BrowserWindow: { getAllWindows: () => [] },
      ipcMain: {
        handle: (key, callback) => {
          handlers[key] = callback;
        },
        on: () => {},
      },
      screen: {
        getAllDisplays: () => [
          { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        ],
        dipToScreenPoint: (point) => point,
      },
    },
    "./frameDelivery": load("frameDelivery.ts"),
    "win-capture": native,
    "./appAudio": {
      log: (...args) => logs.push(args.join(" ")),
      createLogRateLimiter: () => () => true,
      windowHandleFromSourceId: () => null,
      windowStateForSourceId: () => null,
    },
  });
  api.initScreenCapture();
  return {
    api,
    health,
    native,
    timers,
    logs,
    stops: () => stopCalls,
    state: () => handlers["screenCapture:getState"](),
    advance(ms, wallJump = ms) {
      now += ms;
      wall += wallJump;
      for (const timer of [...timers.values()]) timer.callback();
    },
  };
}

test("lost death callback ends a stopped worker exactly once, including during monitor silence", async () => {
  const h = harness();
  try {
    assert(await h.api.startForSource("screen:1:0", 30, 1, "1"));
    h.advance(60000);
    assert.equal(h.api.isScreenCaptureActive(), true); // static image + transient error is legitimate
    const before = h.stops();
    h.health.running = false;
    h.health.lastError = "original device failure; death signal dropped";
    h.advance(1000);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(h.state().active, false);
    assert.equal(h.state().stopReason, "capture-error");
    assert(h.state().reason.includes("original device failure"));
    assert.equal(h.stops(), before + 1);
    h.advance(1000);
    assert.equal(h.stops(), before + 1);
    assert.equal(h.timers.size, 0);
  } finally {
    await h.api.stop();
  }
});

test("stale watchdogs cannot stop a replacement; unavailable/throwing health preserves capture", async () => {
  const h = harness();
  try {
    await h.api.startForSource("screen:1:0", 30, 1, "1");
    const stale = [...h.timers.values()].map((timer) => timer.callback);
    await h.api.startForSource("screen:1:0", 30, 2, "1");
    h.health.running = false;
    stale.forEach((callback) => callback());
    assert.equal(h.state().sessionId, 2);
    assert.equal(h.state().active, true);
    h.native.diagnostics = () => {
      throw Error("diagnostics unavailable");
    };
    h.advance(1000);
    assert.equal(h.state().active, true);
    delete h.native.diagnostics;
    h.advance(1000);
    assert.equal(h.state().active, true);
  } finally {
    await h.api.stop();
  }
});

test("wall-clock jumps do not change elapsed diagnostics; signed offsets remain visible", async () => {
  const h = harness();
  try {
    await h.api.startForSource("screen:1:0", 30, 1, "1");
    h.health.incomingFrames = 150;
    h.health.emittedFrames = 100;
    h.health.tsfnQueuedFrames = 99;
    h.health.tsfnRejectedFrames = 1;
    h.advance(10000, -3600000);
    const report = JSON.parse(
      h.logs
        .find((line) => line.startsWith("screen capture: stages "))
        .slice("screen capture: stages ".length),
    );
    assert.equal(report.intervalSeconds, 10);
    assert.equal(report.frameDroughtMs, 10000);
    assert.equal(report.incomingFps, 15);
    assert.equal(report.packedFrames, 100);
    assert.equal(report.tsfnQueuedFrames, 99);
    assert.equal(report.tsfnRejectedFrames, 1);
    assert.equal(report.jsDeliveredFrames, 0);
    assert.equal(report.sourceTimestampOffsets.acquisition.meanMs, -20);
  } finally {
    await h.api.stop();
  }
});
