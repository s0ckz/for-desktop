const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const test = require("node:test");
function load(file, deps = {}, globals = {}) {
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
  new Function("require", "module", "exports", ...Object.keys(globals), code)(
    (name) => {
      if (name in deps) return deps[name];
      if (name === "./screenCapturePatch") return load("screenCapturePatch.ts");
      throw Error("Unexpected import: " + name);
    },
    module,
    module.exports,
    ...Object.values(globals),
  );
  return module.exports;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
class Track extends EventTarget {
  constructor() {
    super();
    this.readyState = "live";
  }
  stop() {
    this.readyState = "ended";
  }
  getSettings() {
    return {};
  }
}
function renderer({
  canvas = false,
  cap = null,
  constructionFails = false,
  drawFails = false,
  write,
  configure,
} = {}) {
  const frames = new Set(),
    states = new Set(),
    timers = new Map(),
    intervals = new Map();
  const logs = [],
    requests = [],
    stops = [],
    counters = [];
  let clockId = 0,
    generated,
    requested = 0,
    closedFrames = 0;
  let state = {
    active: true,
    sessionId: 1,
    width: 1280,
    height: 720,
    sourceWidth: 1920,
    sourceHeight: 1080,
    targetWidth: 1920,
    targetHeight: 1080,
    fps: 30,
    configurationVersion: 1,
  };
  class Generator extends Track {
    constructor() {
      super();
      generated = this;
      this.writable = {
        getWriter: () => ({
          desiredSize: 1,
          write: write || (() => Promise.resolve()),
          abort: () => Promise.resolve(),
        }),
      };
    }
  }
  class Frame {
    constructor() {
      if (constructionFails) throw Error("Injected constructor failure");
    }
    close() {
      closedFrames++;
    }
  }
  const canvasTrack = new Track();
  canvasTrack.requestFrame = () => {
    requested++;
  };
  const document = {
    createElement: () => ({
      getContext: () => ({
        drawImage: () => {
          if (drawFails) throw Error("Injected draw failure");
        },
      }),
      captureStream: (fps) => {
        assert.equal(fps, 0);
        return { getVideoTracks: () => [canvasTrack] };
      },
    }),
  };
  const bridge = {
    onFrame: (fn) => {
      frames.add(fn);
      return () => frames.delete(fn);
    },
    onState: (fn) => {
      states.add(fn);
      return () => states.delete(fn);
    },
    getState: async () => ({ ...state }),
    stop: (id) => stops.push(id),
    reportStats: (id, value) => counters.push({ id, ...value }),
    configure: async (request) => {
      requests.push(request);
      if (configure) return configure(request);
      state = {
        ...state,
        targetWidth: request.width,
        targetHeight: request.height,
        fps: request.fps,
        configurationVersion: state.configurationVersion + 1,
      };
      return {
        accepted: true,
        requestId: request.requestId,
        state: { ...state },
      };
    },
  };
  const { NATIVE_VIDEO_PATCH } = load("screenCapturePatch.ts");
  const api = new Function(
    "screenCaptureBridge",
    "fpsCap",
    "MediaStreamTrackGenerator",
    "VideoFrame",
    "document",
    "logPage",
    "reportDrop",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "let currentGeneration = 1;\n" +
      NATIVE_VIDEO_PATCH +
      "\nreturn { buildVideoTrack, generation: value => { currentGeneration = value; } };",
  )(
    bridge,
    cap,
    canvas ? undefined : Generator,
    Frame,
    document,
    (message) => logs.push(message),
    () => {},
    (fn) => {
      const id = ++clockId;
      timers.set(id, fn);
      return id;
    },
    (id) => timers.delete(id),
    (fn) => {
      const id = ++clockId;
      intervals.set(id, fn);
      return id;
    },
    (id) => intervals.delete(id),
  );
  return {
    build: () => api.buildVideoTrack({ ...state }, 30, 1),
    bridge,
    requests,
    stops,
    counters,
    timers,
    intervals,
    frames,
    states,
    logs,
    generation: api.generation,
    emit: () => {
      for (const fn of [...frames])
        fn(new Uint8Array(6), {
          width: 1280,
          height: 720,
          timestampUs: 100,
          sessionId: 1,
        });
    },
    dead: () => {
      state = { ...state, active: false };
      for (const fn of [...states]) fn({ ...state });
    },
    expire: () => {
      for (const fn of [...timers.values()]) fn();
    },
    state: () => ({ ...state }),
    generated: () => generated,
    requested: () => requested,
    closedFrames: () => closedFrames,
  };
}
test("first successful generator write gates readiness, including a single static image", async () => {
  const write = deferred(),
    h = renderer({ write: () => write.promise }),
    built = await h.build();
  let settled = false;
  const ready = built.confirmSessionLive().then((value) => {
    settled = true;
    return value;
  });
  h.emit();
  await tick();
  assert.equal(settled, false);
  write.resolve();
  assert.equal(await ready, true);
  assert.equal(h.closedFrames(), 1);
  built.cleanup();
  built.cleanup();
  assert.deepEqual(h.stops, [1]);
  assert.equal(
    h.frames.size + h.states.size + h.timers.size + h.intervals.size,
    0,
  );
});
test("repeated constructor errors and an unusable static first image retire the renderer", async () => {
  for (const repeated of [false, true]) {
    const h = renderer({ constructionFails: true }),
      built = await h.build();
    const ready = built.confirmSessionLive();
    for (let i = 0; i < (repeated ? 8 : 1); i++) h.emit();
    if (!repeated) h.expire();
    assert.equal(await ready, false);
    assert.equal(built.track.readyState, "ended");
    assert.equal(
      h.frames.size + h.states.size + h.timers.size + h.intervals.size,
      0,
    );
    built.cleanup();
  }
});
test("first write rejection and synchronous writer failure cannot pass readiness", async () => {
  for (const write of [
    () => Promise.reject(Error("Injected rejection")),
    () => {
      throw Error("Injected synchronous error");
    },
  ]) {
    const h = renderer({ write }),
      built = await h.build(),
      ready = built.confirmSessionLive();
    h.emit();
    assert.equal(await ready, false);
    await tick();
    assert.equal(h.closedFrames(), 1);
    built.cleanup();
  }
});
test("canvas readiness requires a successful draw/request; repeated draw failure retires it", async () => {
  for (const drawFails of [false, true]) {
    const h = renderer({ canvas: true, drawFails }),
      built = await h.build(),
      ready = built.confirmSessionLive();
    for (let i = 0; i < (drawFails ? 8 : 1); i++) h.emit();
    assert.equal(await ready, !drawFails);
    assert.equal(h.requested(), drawFails ? 0 : 1);
    built.cleanup();
    assert.equal(
      h.frames.size + h.states.size + h.timers.size + h.intervals.size,
      0,
    );
  }
});
test("settings await acknowledgement and rejected presets retain the accepted rate", async () => {
  const ack = deferred(),
    h = renderer({ configure: () => ack.promise }),
    built = await h.build();
  const change = built.track.applyConstraints({ frameRate: 60 });
  await tick();
  assert.equal(built.track.getSettings().frameRate, 30);
  ack.resolve({
    accepted: true,
    state: { ...h.state(), fps: 60, configurationVersion: 2 },
  });
  await change;
  assert.equal(built.track.getSettings().frameRate, 60);
  h.bridge.configure = async () => ({
    accepted: false,
    reason: "Injected refusal",
    state: { ...h.state(), fps: 60, configurationVersion: 2 },
  });
  await assert.rejects(built.track.applyConstraints({ frameRate: 30 }), {
    name: "OperationError",
  });
  assert.equal(built.track.getSettings().frameRate, 60);
  assert.equal(built.track.getSettings().width, 1280);
  built.cleanup();
});
test("rapid presets serialize, snapshot input, and use monotonic request IDs", async () => {
  const a = deferred(),
    b = deferred();
  const h = renderer({
      configure: (request) => (request.requestId === 1 ? a.promise : b.promise),
    }),
    built = await h.build();
  const c = { frameRate: { ideal: 60 } };
  const first = built.track.applyConstraints(c),
    second = built.track.applyConstraints({ frameRate: 30 });
  c.frameRate.ideal = 45;
  await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].fps, 60);
  a.resolve({
    accepted: true,
    state: { ...h.state(), fps: 60, configurationVersion: 2 },
  });
  await first;
  await tick();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(
    h.requests.map((r) => r.requestId),
    [1, 2],
  );
  b.resolve({
    accepted: true,
    state: { ...h.state(), fps: 30, configurationVersion: 3 },
  });
  await second;
  assert.equal(built.track.getSettings().frameRate, 30);
  built.cleanup();
});
test("late acknowledgement cannot update a dead or superseded track", async () => {
  for (const superseded of [false, true]) {
    const ack = deferred(),
      h = renderer({ configure: () => ack.promise }),
      built = await h.build();
    const change = built.track.applyConstraints({ frameRate: 60 });
    await tick();
    if (superseded) h.generation(2);
    else h.dead();
    ack.resolve({
      accepted: true,
      state: { ...h.state(), fps: 60, configurationVersion: 2 },
    });
    await assert.rejects(change, { name: "AbortError" });
    assert.equal(built.track.getSettings().frameRate, 30);
    built.cleanup();
    if (superseded) assert.deepEqual(h.stops, []);
  }
});
test("max/exact/min constraints respect caps, source aspect ratio and NV12 even dimensions", async () => {
  const h = renderer({ cap: 30 }),
    built = await h.build();
  await assert.rejects(
    built.track.applyConstraints({ frameRate: { exact: 60 } }),
    { name: "OverconstrainedError", constraint: "frameRate" },
  );
  await assert.rejects(
    built.track.applyConstraints({ frameRate: { min: 40, max: 30 } }),
    { name: "OverconstrainedError" },
  );
  await assert.rejects(
    built.track.applyConstraints({
      width: { exact: 1281 },
      height: { exact: 720 },
    }),
    { name: "OverconstrainedError", constraint: "width" },
  );
  await assert.rejects(
    built.track.applyConstraints({ width: { exact: 3840 } }),
    { name: "OverconstrainedError" },
  );
  await assert.rejects(
    built.track.applyConstraints({ frameRate: { max: NaN } }),
    { name: "TypeError" },
  );
  assert.equal(h.requests.length, 0);
  await built.track.applyConstraints({
    frameRate: { ideal: 60, max: 30 },
    width: { max: 1280 },
    height: { ideal: 720 },
  });
  assert.equal(h.requests[0].fps, 30);
  assert.equal(h.requests[0].width, 1280);
  assert.equal(h.requests[0].height, 720);
  built.cleanup();
});
function mainHarness({
  pixels = true,
  malformed = false,
  nativeConfigure = true,
  legacy = false,
  cap = "",
} = {}) {
  const handlers = {},
    callbacks = [],
    calls = [],
    posted = [],
    logs = [];
  let now = 100,
    stops = 0;
  const native = {
    isSupported: () => true,
    lastError: () => "",
    diagnostics: () => ({
      ready: true,
      running: true,
      sourceWidth: 1920,
      sourceHeight: 1080,
    }),
    start: (...args) => {
      callbacks.push(args[4]);
      if (pixels)
        queueMicrotask(() =>
          args[4](Buffer.alloc(malformed ? 1 : 6), {
            width: 2,
            height: 2,
            timestampUs: 1,
            refused: 0,
            poolResizes: 0,
            stillDrawing: 0,
            timestampFallbacks: 0,
            timestampDiscontinuities: 0,
            bltMs: 0,
            grabMs: 0,
          }),
        );
      return true;
    },
    stop: () => {
      stops++;
      return Promise.resolve();
    },
    configure: (width, height, fps) => {
      calls.push([width, height, fps]);
      return nativeConfigure;
    },
    setTarget: () => true,
    setFps: () => !legacy,
  };
  if (legacy) delete native.configure;
  const { FrameDelivery } = load("frameDelivery.ts");
  const api = load(
    "screenCapture.ts",
    {
      electron: {
        app: {
          getVersion: () => "test",
          commandLine: { getSwitchValue: () => cap },
        },
        BrowserWindow: { getAllWindows: () => [] },
        ipcMain: {
          handle: (key, fn) => {
            handlers[key] = fn;
          },
          on: (key, fn) => {
            handlers[key] = fn;
          },
        },
        screen: {
          getAllDisplays: () => [
            { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
          ],
          dipToScreenPoint: (point) => point,
        },
      },
      "./frameDelivery": { FrameDelivery },
      "win-capture": native,
      "./appAudio": {
        log: (...args) => logs.push(args.join(" ")),
        createLogRateLimiter: () => () => true,
        windowHandleFromSourceId: () => null,
        windowStateForSourceId: () => null,
      },
    },
    {
      performance: { now: () => now },
      setTimeout: (fn, delay) =>
        setTimeout(() => {
          now += delay;
          fn();
        }, 0),
    },
  );
  api.initScreenCapture();
  let portMessage;
  api.setFramePort({
    postMessage: (message) => posted.push(message),
    start() {},
    on: (_event, handler) => {
      portMessage = handler;
    },
    close() {},
  });
  return {
    api,
    handlers,
    callbacks,
    calls,
    posted,
    ready: () => portMessage({ data: { kind: "ready", sessionId: 1 } }),
    native,
    logs,
    stops: () => stops,
    state: () => handlers["screenCapture:getState"](),
    configure: (requestId, extra = {}) =>
      handlers["screenCapture:configure"](
        {},
        {
          sessionId: 1,
          requestId,
          width: 1280,
          height: 720,
          fps: 60,
          ...extra,
        },
      ),
  };
}
test("setup without usable pixels times out; a retained single static payload proves readiness", async () => {
  for (const options of [{ pixels: false }, { malformed: true }, {}]) {
    const h = mainHarness(options);
    try {
      assert.equal(
        await h.api.startForSource("screen:1:0", 30, 1, "1"),
        !options.malformed && options.pixels !== false,
      );
      if (options.malformed || options.pixels === false)
        assert.match(h.state().reason, /first frame timed out/);
      else {
        assert.equal(h.state().pixelsReady, true);
        assert.equal(h.posted.length, 0);
        h.ready();
        assert.equal(h.posted.length, 1);
        assert.equal(h.posted[0].frame.length, 6);
        // The preload grants credit only after its listener attaches.
        // Lifecycle readiness has not consumed/discarded the static payload.
        assert(h.logs.some((line) => line.includes("session start")));
      }
    } finally {
      await h.api.stop();
    }
  }
});
test("main acknowledges accepted limits, caps FPS, and refuses stale/invalid requests", async () => {
  const h = mainHarness({ cap: "30" });
  try {
    assert(await h.api.startForSource("screen:1:0", 30, 1, "1"));
    const accepted = h.configure(2);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.state.fps, 30);
    assert.equal(accepted.state.targetWidth, 1280);
    assert.equal(accepted.state.width, 2);
    assert.equal(h.configure(1).accepted, false);
    assert.equal(h.configure(3, { width: -1 }).accepted, false);
    assert.equal(h.configure(3, { sessionId: 2 }).accepted, false);
    assert.equal(h.configure(3, { fps: Infinity }).accepted, false);
    assert.deepEqual(h.calls, [[1280, 720, 30]]);
    assert.equal(h.state().configurationVersion, 2);
  } finally {
    await h.api.stop();
  }
});
test("native preset refusal and legacy partial acceptance report actual state", async () => {
  for (const legacy of [false, true]) {
    const h = mainHarness({ nativeConfigure: false, legacy });
    try {
      assert(await h.api.startForSource("screen:1:0", 30, 1, "1"));
      const result = h.configure(1);
      assert.equal(result.accepted, false);
      assert.equal(result.state.fps, 30);
      assert.equal(result.state.targetWidth, legacy ? 1280 : 1920);
    } finally {
      await h.api.stop();
    }
  }
});

async function audioSetupRace(sourceDies, timesOut = false, early = null) {
  const { APP_AUDIO_PATCH } = load("appAudioPatch.ts");
  const worklet = deferred(),
    entered = deferred(),
    initialState = deferred();
  let frameListener,
    stateListener,
    audioClosed = 0,
    audioStopped = 0,
    nativeStops = 0,
    audioDestinations = 0;
  const timers = new Map();
  let timerId = 0;
  const original = new Track(),
    audioTrack = new Track();
  let tracks = [original];
  const stream = {
    getVideoTracks: () => tracks.filter((t) => t !== audioTrack),
    getAudioTracks: () => tracks.filter((t) => t === audioTrack),
    getTracks: () => tracks,
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
          write: () => Promise.resolve(),
          abort: () => Promise.resolve(),
        }),
      };
    }
  }
  class Context {
    constructor() {
      this.state = "running";
      this.audioWorklet = {
        addModule: () => {
          entered.resolve();
          return worklet.promise;
        },
      };
    }
    createMediaStreamDestination() {
      audioDestinations++;
      return {
        stream: { getAudioTracks: () => [audioTrack] },
        disconnect() {},
      };
    }
    close() {
      audioClosed++;
      return Promise.resolve();
    }
  }
  class Worklet {
    constructor() {
      this.port = {};
    }
    connect() {}
    disconnect() {}
  }
  let nativeActive = true;
  const captureState = () => ({
    active: nativeActive,
    sessionId: 1,
    width: 2,
    height: 2,
    fps: 30,
  });
  let stateReads = 0;
  const screenBridge = {
    getState: async () => {
      if (early === "state" && ++stateReads === 1) {
        entered.resolve();
        return initialState.promise;
      }
      return captureState();
    },
    onFrame: (fn) => {
      frameListener = fn;
      if (early === "first-frame") entered.resolve();
      else {
        queueMicrotask(() =>
          fn(new Uint8Array(6), {
            width: 2,
            height: 2,
            timestampUs: 1,
            sessionId: 1,
          }),
        );
      }
      return () => {
        frameListener = null;
      };
    },
    onState: (fn) => {
      stateListener = fn;
      return () => {
        stateListener = null;
      };
    },
    reportStats() {},
    reportDrop() {},
    log() {},
    stop: () => {
      nativeStops++;
    },
  };
  const window = {
    native: {
      screenCapture: screenBridge,
      appAudio: {
        getState: async () => ({ active: true, sampleRate: 48000 }),
        onChunk: () => () => {},
        listenerCount: () => 1,
        stop: () => {
          audioStopped++;
        },
      },
    },
  };
  const navigator = { mediaDevices: { getDisplayMedia: async () => stream } };
  new Function(
    "window",
    "navigator",
    "MediaStreamTrackGenerator",
    "VideoFrame",
    "AudioContext",
    "AudioWorkletNode",
    "setTimeout",
    "clearTimeout",
    APP_AUDIO_PATCH,
  )(
    window,
    navigator,
    Generator,
    class {
      close() {}
    },
    Context,
    Worklet,
    (fn) => {
      const id = ++timerId;
      timers.set(id, fn);
      return id;
    },
    (id) => timers.delete(id),
  );
  const pending = navigator.mediaDevices.getDisplayMedia({ video: true });
  await entered.promise;
  assert.equal(
    original.readyState,
    "live",
    "Chromium stays available while the audio worklet loads",
  );
  if (early) {
    original.stop();
    original.dispatchEvent(new Event("ended"));
    assert.equal(
      audioStopped,
      1,
      "Native audio stops before audio setup begins",
    );
    initialState.resolve(captureState());
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(audioClosed, 0);
    assert.equal(audioDestinations, 0);
    assert.equal(nativeStops, 1, "Native video retires exactly once");
    assert.equal(frameListener ?? null, null);
    assert.equal(stateListener ?? null, null);
    return;
  }
  if (timesOut) {
    assert.equal(timers.size, 1, "Only the audio startup deadline remains");
    for (const fn of [...timers.values()]) fn();
  } else if (sourceDies) {
    original.stop();
    original.dispatchEvent(new Event("ended"));
    assert.equal(
      audioClosed,
      1,
      "Partial context closes before its pending worklet resolves",
    );
    assert.equal(audioStopped, 1);
  } else {
    nativeActive = false;
    stateListener({ active: false, sessionId: 1 });
  }
  worklet.resolve();
  if (sourceDies) {
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(
      audioDestinations,
      0,
      "Cancellation cannot build late audio resources",
    );
    assert.equal(audioClosed, 1);
  } else {
    const result = await pending;
    if (timesOut) {
      assert.equal(result.getAudioTracks().length, 0);
      assert.equal(audioDestinations, 0);
      assert.equal(
        original.readyState,
        "ended",
        "Usable native video can still replace Chromium after audio timeout",
      );
      result.getVideoTracks()[0].stop();
    } else {
      assert.equal(result.getVideoTracks()[0], original);
      assert.equal(original.readyState, "live");
      assert.equal(result.getAudioTracks()[0], audioTrack);
      original.stop();
      assert.equal(audioTrack.readyState, "ended");
    }
    assert.equal(audioClosed, 1);
  }
  assert.equal(frameListener, null);
  assert.equal(stateListener, null);
  assert.equal(nativeStops, 1);
  assert.equal(audioStopped, 1);
}
test("native death during audio worklet setup preserves Chromium and cleans native resources", () =>
  audioSetupRace(false));
test("source death during audio worklet setup aborts and closes the late audio session", () =>
  audioSetupRace(true));
test("audio setup timeout closes partial resources and preserves usable video", () =>
  audioSetupRace(false, true));
test("source death before the first renderer frame promptly retires both producers", () =>
  audioSetupRace(true, false, "first-frame"));
test("source death before a delayed state reply retires its native session once", () =>
  audioSetupRace(true, false, "state"));
test("renderer failure ends only its owning main session once", async () => {
  const h = mainHarness();
  try {
    assert(await h.api.startForSource("screen:1:0", 30, 1, "1"));
    const report = h.handlers["screenCapture:rendererFailure"];
    const before = h.stops();
    report({}, 2, "stale renderer failure");
    assert.equal(h.state().active, true);
    report({}, 1, "repeated constructor failure");
    assert.equal(h.state().active, false);
    assert.equal(h.state().stopReason, "capture-error");
    assert.match(h.state().reason, /renderer: repeated constructor failure/);
    report({}, 1, "duplicate");
    report({}, undefined, "malformed");
    await tick();
    assert.equal(h.stops(), before + 1);
  } finally {
    await h.api.stop();
  }
});
test("wrong request identity or older configuration version cannot change settings", async () => {
  for (const bad of [
    { requestId: 99, configurationVersion: 2 },
    { requestId: 1, configurationVersion: 0 },
  ]) {
    const h = renderer({
      configure: async () => ({
        accepted: true,
        requestId: bad.requestId,
        state: {
          ...h.state(),
          fps: 60,
          configurationVersion: bad.configurationVersion,
        },
      }),
    });
    const built = await h.build();
    await assert.rejects(built.track.applyConstraints({ frameRate: 60 }), {
      name: "AbortError",
    });
    assert.equal(built.track.getSettings().frameRate, 30);
    built.cleanup();
  }
});
