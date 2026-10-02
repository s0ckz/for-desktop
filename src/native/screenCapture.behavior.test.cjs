const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
function load(file, dependencies = {}) {
  const code = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, file), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    },
  ).outputText;
  const m = { exports: {} };
  new Function("require", "module", "exports", code)(
    (name) => {
      if (name in dependencies) return dependencies[name];
      throw Error("unexpected dependency " + name);
    },
    m,
    m.exports,
  );
  return m.exports;
}
const { FrameDelivery } = load("frameDelivery.ts");
const frame = (sessionId, timestampUs) => ({
  frame: Buffer.alloc(6),
  meta: { sessionId, timestampUs, width: 2, height: 2 },
});
function transportTests() {
  const delivery = new FrameDelivery();
  const posted = [];
  delivery.setPort({ postMessage: (x) => posted.push(x) });
  delivery.start(1);
  delivery.offer(frame(1, 1));
  assert.equal(posted.length, 0); // retain a static image until listener ready
  delivery.receive({ kind: "ready", sessionId: 1 });
  assert.equal(posted.length, 1);
  for (let i = 2; i <= 500; ++i) delivery.offer(frame(1, i));
  assert.equal(posted.length, 1); // renderer is deliberately unresponsive
  assert.equal(delivery.snapshot().coalesced, 498);
  delivery.receive({
    kind: "ack",
    sessionId: 0,
    frameId: posted[0].meta.frameId,
  });
  assert.equal(posted.length, 1);
  delivery.receive({
    kind: "ack",
    sessionId: 1,
    frameId: posted[0].meta.frameId,
  });
  assert.equal(posted[1].meta.timestampUs, 500); // no stale pixel FIFO
  delivery.start(2);
  delivery.offer(frame(1, 999));
  delivery.receive({ kind: "ready", sessionId: 1 });
  assert.equal(posted.length, 2);
  delivery.offer(frame(2, 1000));
  delivery.receive({ kind: "ready", sessionId: 2 });
  assert.equal(posted[2].meta.sessionId, 2);
  delivery.setPort({
    postMessage: () => {
      throw Error("closed port");
    },
  });
  delivery.receive({ kind: "ready", sessionId: 2 });
  assert.equal(delivery.snapshot().failures, 1);
  assert.equal(delivery.snapshot().ready, false);
}
async function lifecycleTests() {
  const callbacks = [],
    startArgs = [],
    handlers = {},
    logs = [];
  const native = {
    isSupported: () => true,
    start: (...args) => {
      startArgs.push(args);
      callbacks.push(args[4]);
      return true;
    },
    stop: () => Promise.resolve(),
    lastError: () => "",
  };
  let requestedBackend = "";
  const electron = {
    app: {
      commandLine: { getSwitchValue: () => requestedBackend },
      getVersion: () => "test",
    },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: {
      on: (key, fn) => {
        handlers[key] = fn;
      },
      handle: (key, fn) => {
        handlers[key] = fn;
      },
    },
    screen: {
      getAllDisplays: () => [
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ],
      dipToScreenPoint: (x) => x,
    },
  };
  const api = load("screenCapture.ts", {
    electron,
    "./frameDelivery": { FrameDelivery },
    "win-capture": native,
    "./appAudio": {
      log: (...x) => logs.push(x.join(" ")),
      createLogRateLimiter: () => () => true,
      windowHandleFromSourceId: (id) =>
        id.startsWith("window:") ? "123" : null,
      windowStateForSourceId: () => null,
    },
  });
  api.initScreenCapture();
  try {
    await api.startForSource("screen:1:0", 30, 1, "1");
    assert.equal(startArgs[0][6], "wgc");
    requestedBackend = "duplication";
    await api.startForSource("screen:1:0", 30, 2, "1");
    assert.equal(startArgs[1][6], "duplication");
    assert(logs.some((line) => line.includes("screen capture: session start")));
    const oldMeta = {
      width: 640,
      height: 480,
      refused: 0,
      poolResizes: 0,
      stillDrawing: 0,
      timestampFallbacks: 0,
      timestampDiscontinuities: 0,
      bltMs: 0,
      grabMs: 0,
      timestampUs: 1,
      gpuThreadPriority: "OLD",
      schedulingPriority: "OLD",
    };
    callbacks[0](Buffer.alloc(6), oldMeta);
    callbacks[0](null, { ...oldMeta, reason: "old death" });
    assert.equal(handlers["screenCapture:getState"]().sessionId, 2);
    assert.equal(handlers["screenCapture:getState"]().width, 1920);
    assert(!logs.some((x) => x.includes("OLD") || x.includes("old death")));
    handlers["screenCapture:stop"]({}, 1);
    assert.equal(api.isScreenCaptureActive(), true);
    callbacks[1](null, { ...oldMeta, reason: "new death" });
    const state = handlers["screenCapture:getState"]();
    assert.equal(state.active, false);
    assert.equal(state.sessionId, 2);
    assert(state.reason.includes("new death"));
    assert(logs.some((line) => line.includes("screen capture: session final")));
    await api.stop();
    api.resetNativeFailures();
    native.diagnostics = () => ({
      running: false,
      ready: false,
      lastError: "setup failed",
    });
    assert.equal(await api.startForSource("screen:1:0", 30, 3, "1"), false);
    assert(
      handlers["screenCapture:getState"]().reason.includes("setup failed"),
    );
    delete native.diagnostics;
    api.resetNativeFailures();
    const results = await Promise.all([
      api.startForSource("screen:1:0", 30, 4, "1"),
      api.startForSource("screen:1:0", 60, 5, "1"),
    ]);
    assert.deepEqual(results, [false, true]);
    assert.equal(handlers["screenCapture:getState"]().sessionId, 5);
    assert.equal(handlers["screenCapture:getState"]().fps, 60);
    await api.startForSource("window:123:0", 30, 6);
    assert.equal(startArgs.at(-1)[6], "wgc", "window shares always use WGC");
  } finally {
    await api.stop();
  }
}
class Track extends EventTarget {
  constructor() {
    super();
    this.readyState = "live";
  }
  getSettings() {
    return {};
  }
  applyConstraints() {
    return Promise.resolve();
  }
  stop() {
    this.readyState = "ended";
  }
}
async function patchTests({
  dies = false,
  canvas = false,
  rejects = false,
} = {}) {
  const { APP_AUDIO_PATCH } = load("appAudioPatch.ts");
  let constructed = 0,
    requested = 0,
    frameHandler,
    reads = 0,
    release;
  const constraints = [],
    stats = [];
  class Frame {
    constructor() {
      constructed++;
    }
    close() {}
  }
  const original = new Track();
  let tracks = [original];
  const stream = {
    getVideoTracks: () => tracks,
    getAudioTracks: () => [],
    addTrack: (t) => tracks.push(t),
    removeTrack: (t) => {
      tracks = tracks.filter((x) => x !== t);
    },
  };
  class Generator extends Track {
    constructor() {
      super();
      this.writable = {
        getWriter: () => ({
          desiredSize: 1,
          write: () =>
            rejects
              ? Promise.reject(Error("writer failed"))
              : new Promise((r) => {
                  release = r;
                }),
          close: () => Promise.resolve(),
        }),
      };
    }
  }
  const canvasTrack = new Track();
  canvasTrack.requestFrame = () => {
    requested++;
  };
  const document = {
    createElement: () => ({
      getContext: () => ({ drawImage: () => undefined }),
      captureStream: (fps) => {
        assert.equal(fps, 0);
        return { getVideoTracks: () => [canvasTrack] };
      },
    }),
  };
  const bridge = {
    setNextFps: () => undefined,
    setFps: (...x) => constraints.push(x),
    setTarget: () => undefined,
    stop: () => undefined,
    reportStats: (...x) => stats.push(x),
    reportDrop: () => undefined,
    log: () => undefined,
    getState: async () => {
      reads++;
      return {
        active: !(dies && reads > 1),
        sessionId: 1,
        width: 1280,
        height: 720,
        fps: 30,
      };
    },
    onFrame: (fn, sessionId) => {
      assert.equal(sessionId, 1);
      frameHandler = fn;
      return () => undefined;
    },
    onState: () => () => undefined,
  };
  const window = {
    native: {
      screenCapture: bridge,
      appAudio: { getState: async () => ({ active: false }) },
    },
  };
  const navigator = { mediaDevices: { getDisplayMedia: async () => stream } };
  new Function(
    "window",
    "navigator",
    "MediaStreamTrackGenerator",
    "VideoFrame",
    "Event",
    "document",
    APP_AUDIO_PATCH,
  )(window, navigator, canvas ? undefined : Generator, Frame, Event, document);
  const result = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
  });
  const track = result.getVideoTracks()[0];
  try {
    if (dies) {
      assert.equal(track, original);
      assert.equal(original.readyState, "live");
      return;
    }
    assert.equal(original.readyState, "ended");
    await track.applyConstraints({ frameRate: 60 });
    assert.equal(track.getSettings().frameRate, 60);
    assert.deepEqual(constraints[0], [60, 1]);
    for (let i = 0; i < 100; ++i)
      frameHandler(new Uint8Array(6), {
        width: 2,
        height: 2,
        timestampUs: i * 16667,
        sessionId: 1,
      });
    if (canvas) {
      assert.equal(requested, 100);
      assert.equal(constructed, 100);
    } else {
      assert.equal(constructed, 1);
      release?.();
      await new Promise((r) => setImmediate(r));
      if (rejects) assert.equal(track.readyState, "ended");
    }
  } finally {
    track.stop();
  }
  assert(stats.length > 0 || rejects);
}
(async () => {
  transportTests();
  await lifecycleTests();
  await patchTests({ dies: true });
  await patchTests();
  await patchTests({ canvas: true });
  await patchTests({ rejects: true });
  console.log(
    "CAPTURE BEHAVIOR PASS: bounded transport, stale callbacks, startup failure, transactional replacement, generator pressure, canvas presets, writer errors",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
