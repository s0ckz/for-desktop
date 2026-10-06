"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  options,
  gpuSummary,
  traceSummary,
  encoderLogSummary,
} = require("./options.cjs");
const {
  interval,
  aggregate,
  profile,
  sameProfile,
  h265Main,
  sameH265Profile,
} = require("./metrics.js");
const {
  nativeOptions,
  distribution,
  decodeMarker,
  markerTracker,
  counterDelta,
  compositorTraceSummary,
} = require("./native-metrics.cjs");

test("profile validation permits negotiated levels but rejects profile and packetization substitution", () => {
  const requested = profile("profile-level-id=640020;packetization-mode=1");
  assert.equal(
    sameProfile(
      requested,
      profile("profile-level-id=64001f;packetization-mode=1"),
    ),
    true,
  );
  for (const fmtp of [
    "profile-level-id=42e01f;packetization-mode=1",
    "profile-level-id=640c1f;packetization-mode=1",
    "profile-level-id=64001f;packetization-mode=0",
    "profile-level-id=64001f",
    "profile-level-id=6400;packetization-mode=1",
  ])
    assert.equal(sameProfile(requested, profile(fmtp)), false);
});

test("diagnostic options bound work and reject arbitrary source/codec arguments", () => {
  assert.equal(options([]).mode, "generator");
  assert.equal(options(["--fps=30", "--mode=canvas", "--trace"]).fps, 30);
  assert.equal(options(["--profile=baseline"]).profile, "baseline");
  assert.equal(options(["--codec=h265"]).profile, "main");
  assert.equal(
    options(["--codec=h265", "--bitrate=8000000"]).bitrate,
    8_000_000,
  );
  for (const arg of [
    "--fps=0",
    "--fps=120",
    "--seconds=Infinity",
    "--seconds=4",
    "--warmup=30",
    "--mode=screen",
    "--profile=arbitrary",
    "--codec=vp9",
    "--codec=h265 --profile=high",
    "--bitrate=9000000",
    "--server=https://example.com",
  ])
    assert.throws(() => options([arg]));
  assert.throws(() => options(["--codec=h265", "--profile=high"]));
});

test("HEVC Main validation uses SDP defaults and rejects profile/tier substitution or malformed parameters", () => {
  assert.equal(h265Main(profile("")), true);
  assert.equal(
    sameH265Profile(
      profile("profile-id=1;tier-flag=0;level-id=153"),
      profile("profile-id=1;level-id=93"),
    ),
    true,
  );
  for (const fmtp of [
    "profile-id=2",
    "tier-flag=1",
    "profile-space=1",
    "profile-id=@",
    "profile-id=NaN",
  ])
    assert.equal(h265Main(profile(fmtp)), false);
  assert.equal(
    sameH265Profile(
      profile("profile-id=1;interop-constraints=000000000000"),
      profile("profile-id=1;interop-constraints=100000000000"),
    ),
    false,
  );
});

test("HEVC renderer fails explicitly without a Main capability and closes both peers", async () => {
  let closed = 0;
  const video = {};
  const context = vm.createContext({
    window: { ScreenShareDiagnosticMetrics: require("./metrics.js") },
    document: { getElementById: () => video },
    RTCPeerConnection: class {
      close() {
        closed++;
      }
    },
    RTCRtpSender: {
      getCapabilities: () => ({
        codecs: [
          {
            mimeType: "video/H264",
            sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1",
          },
          { mimeType: "video/H265", sdpFmtpLine: "profile-id=2;tier-flag=0" },
        ],
      }),
    },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "renderer.js"), "utf8"),
    context,
  );
  await assert.rejects(
    context.window.runScreenShareDiagnostic({ codec: "h265", profile: "main" }),
    /H265 profile RTP capability is unavailable/,
  );
  assert.equal(closed, 2);
  assert.equal(video.srcObject, null);
});

test("native diagnostic only accepts bounded own-source WGC measurements", () => {
  assert.equal(nativeOptions(["--fps=30"]).sourceFps, 60);
  assert.equal(nativeOptions([]).backend, "wgc");
  for (const arg of [
    "--hwnd=42",
    "--mode=monitor",
    "--backend=duplication",
    "--codec=h265",
    "--fps=120",
    "--seconds=61",
  ])
    assert.throws(() => nativeOptions([arg]));
  assert.equal(
    counterDelta(
      { incomingFrames: 0 },
      { incomingFrames: 0 },
      "incomingFrames",
    ),
    0,
  );
  assert.equal(
    counterDelta(
      { incomingFrames: 5 },
      { incomingFrames: 10 },
      "incomingFrames",
    ),
    null,
  );
  assert.equal(distribution([]).p95Ms, null);
  assert.equal(distribution([1, 2, NaN, -1, 10]).p95Ms, 10);
});

test("native markers distinguish repeated pixels, missed source draws and modulo wrap", () => {
  const width = 1280,
    height = 720;
  const bytes = Buffer.alloc(width * height * 1.5, 128);
  function encode(value) {
    const y = Math.floor(height / 48);
    for (let cell = 0; cell < 20; cell++)
      bytes[y * width + Math.floor(((cell + 0.5) * width) / 20)] = (
        cell < 4 ? cell % 2 : (value >> (cell - 4)) & 1
      )
        ? 218
        : 30;
    return decodeMarker(bytes, width, height);
  }
  for (const value of [0, 1, 17, 65535]) assert.equal(encode(value), value);
  const tracker = markerTracker();
  for (const value of [65534, 65535, 0, 0, 3, null]) tracker.add(value);
  assert.equal(tracker.result.distinctFrames, 4);
  assert.equal(tracker.result.repeatedFrames, 1);
  assert.equal(tracker.result.skippedSourceMarkers, 2);
  assert.equal(tracker.result.invalidFrames, 1);
  assert.equal(tracker.result.discontinuities, 0);
  tracker.add(2);
  assert.equal(tracker.result.discontinuities, 1);
  bytes[15 * width + 32] = 128;
  assert.equal(decodeMarker(bytes, width, height), null);
  assert.equal(decodeMarker(Buffer.alloc(10), width, height), null);
});

test("aggregate distinguishes sampled resolution fraction from duration counters", () => {
  const result = aggregate([
    {
      intervalSeconds: 1,
      resolution: [1280, 720],
      limitedSeconds: { bandwidth: 1, cpu: 0 },
    },
    {
      intervalSeconds: 3,
      resolution: [640, 360],
      limitedSeconds: { bandwidth: 2, cpu: 0 },
    },
    {
      intervalSeconds: null,
      resolution: null,
      limitedSeconds: { bandwidth: 100 },
    },
  ]);
  assert.equal(result.fullResolutionSampleFraction, 0.5);
  assert.equal(result.limitationDurationSeconds.bandwidth, 3);
  assert.equal(result.limitationDurationSeconds.none, null);
});

test("moving source skips late deadlines without bursts and stops its callback", () => {
  let next,
    cancelled = 0,
    time = 0;
  const context = vm.createContext({
    window: {},
    performance: { now: () => time },
    devicePixelRatio: 1,
    document: {
      hidden: false,
      getElementById: () => ({
        width: 1280,
        height: 720,
        getContext: () => ({ fillRect() {}, fillText() {} }),
      }),
    },
    requestAnimationFrame: (callback) => {
      next = callback;
      return 1;
    },
    cancelAnimationFrame: () => cancelled++,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "moving-source.js"), "utf8"),
    context,
  );
  assert.throws(() => context.window.startMovingSource(30), /requires 60 FPS/);
  context.window.startMovingSource(60);
  for (time of [0, 16.67, 33.34, 100]) next(time);
  assert.equal(context.window.readMovingSource().drawn, 4);
  assert.equal(context.window.readMovingSource().skipped, 3);
  context.window.stopMovingSource();
  next(200);
  assert.equal(context.window.readMovingSource().drawn, 4);
  assert.equal(cancelled, 1);
});

test("compositor summaries retain event phases without exposing arguments or inventing presentation FPS", () => {
  const result = compositorTraceSummary({
    traceEvents: [
      {
        name: "SubmitCompositorFrameToPresentationCompositorFrame",
        ph: "b",
        pid: 1,
        args: { secret: "private-data" },
      },
      {
        name: "SubmitCompositorFrameToPresentationCompositorFrame",
        ph: "e",
        pid: 1,
      },
      { name: "SkiaRenderer::SwapBuffers", ph: "X", pid: 2 },
      { name: "unrelated", ph: "X", pid: 2 },
    ],
  });
  assert.equal(result.length, 3);
  assert.equal(JSON.stringify(result).includes("private-data"), false);
  assert.equal(
    result.some((row) => "presentedFps" in row),
    false,
  );
});
test("metrics report real zero rates, observed dimension changes and no deltas across resets", () => {
  const before = {
    id: "rtp",
    timestamp: 1000,
    framesEncoded: 100,
    framesSent: 100,
    bytesSent: 1000,
    totalEncodeTime: 1,
    frameWidth: 1280,
    frameHeight: 720,
    codecId: "codec",
  };
  const now = { ...before, timestamp: 2000, frameWidth: 960, frameHeight: 540 };
  const idle = interval(now, before);
  assert.equal(idle.encodedFps, 0);
  assert.equal(idle.meanEncodeMs, null);
  assert.equal(idle.observedResolutionChanges, 1);
  for (const change of [
    { framesEncoded: 1 },
    { codecId: "replacement" },
    { timestamp: 1000 },
    { ssrc: 3 },
  ])
    assert.equal(interval({ ...now, ...change }, before).encodedFps, null);
  assert.equal(
    interval({ ...now, frameHeight: undefined }, before)
      .observedResolutionChanges,
    null,
  );
});
test("aggregate weights unequal intervals and preserves missing runtime evidence", () => {
  const result = aggregate([
    {
      intervalSeconds: 1,
      encodedFps: 60,
      sentFps: 60,
      encodedFrames: 60,
      encodeSeconds: 0.3,
      resolution: [1280, 720],
      observedResolutionChanges: 0,
    },
    {
      intervalSeconds: 3,
      encodedFps: 30,
      sentFps: 30,
      encodedFrames: 90,
      encodeSeconds: 0.9,
      resolution: [960, 540],
      observedResolutionChanges: 1,
    },
  ]);
  assert.equal(result.encodedFps, 37.5);
  assert.equal(result.meanEncodeMs, 8);
  assert.deepEqual(result.encoders, []);
  assert.deepEqual(result.browserPowerEfficientReports, []);
  assert.equal(aggregate([]).encodedFps, null);
});
test("GPU, profile and trace summaries exclude arbitrary data and capability does not imply runtime use", () => {
  const gpu = gpuSummary(
    {
      gpuDevice: [
        {
          vendorId: 4318,
          deviceId: 1,
          active: true,
          deviceString: "GPU",
          secret: "private-data",
        },
      ],
      secret: "private-data",
    },
    { video_encode: "enabled" },
  );
  assert.equal(gpu.videoEncodeAvailability, "enabled");
  assert.equal(JSON.stringify(gpu).includes("private-data"), false);
  assert.deepEqual(
    profile("profile-level-id=42e01f;packetization-mode=1;secret=private-data"),
    { "profile-level-id": "42e01f", "packetization-mode": "1" },
  );
  const trace = traceSummary({
    traceEvents: [
      {
        name: "MediaFoundationVideoEncodeAccelerator::ProcessOutput",
        args: { secret: "private-data" },
      },
      { name: "unrelated", args: { secret: "private-data" } },
    ],
  });
  assert.equal(trace.length, 1);
  assert.equal(JSON.stringify(trace).includes("private-data"), false);
});
test("only explicit encoder fallback markers establish fallback, with sanitized error codes", () => {
  const lines = [
    "video_encoder_software_fallback_wrapper.cc: Trying to access encoder in uninitialized fallback wrapper.",
    "video_encoder_software_fallback_wrapper.cc: Hardware encoder initialization failed with error code: WEBRTC_VIDEO_CODEC_FALLBACK_SOFTWARE",
    "video_encoder_software_fallback_wrapper.cc: InitFallbackEncoder(is_forced=false)",
    "media_foundation_video_encode_accelerator_win.cc: Couldn't set output media type, private-data (0xC00D6D76)",
  ];
  assert.equal(encoderLogSummary(lines[0]).softwareFallbackObserved, false);
  const result = encoderLogSummary(lines.join("\n"));
  assert.equal(result.softwareFallbackObserved, true);
  assert.equal(result.hardwareInitializationFailures, 1);
  assert.deepEqual(result.outputMediaTypeErrorCodes, ["0xC00D6D76"]);
  assert.equal(JSON.stringify(result).includes("private-data"), false);
});

test("the actual renderer closes both peers and presentation callbacks when setup fails", async () => {
  for (const available of [false, true]) {
    let closed = 0,
      cancelled = 0;
    const video = {
      requestVideoFrameCallback: () => 1,
      cancelVideoFrameCallback: () => cancelled++,
    };
    const context = vm.createContext({
      window: { ScreenShareDiagnosticMetrics: require("./metrics.js") },
      document: { getElementById: () => video },
      RTCPeerConnection: class {
        close() {
          closed++;
        }
      },
      RTCRtpSender: {
        getCapabilities: () => ({
          codecs: available
            ? [
                {
                  mimeType: "video/H264",
                  sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1",
                },
              ]
            : [],
        }),
      },
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "renderer.js"), "utf8"),
      context,
    );
    await assert.rejects(
      context.window.runScreenShareDiagnostic({
        profile: "cbp",
        mode: "generator",
        width: 1280,
        height: 720,
      }),
      available
        ? /MediaStreamTrackGenerator is unavailable/
        : /RTP capability is unavailable/,
    );
    assert.equal(closed, 2);
    assert.equal(cancelled, 1);
    assert.equal(video.srcObject, null);
  }
});

test("source setup failures stop a partially acquired track", () => {
  for (const mode of ["generator", "canvas"]) {
    let stopped = 0;
    const track = {
      stop() {
        stopped++;
      },
      writable: {
        getWriter() {
          throw new Error("Writer unavailable");
        },
      },
    };
    const context = vm.createContext({
      window: {},
      document: {
        createElement: () => ({
          getContext: () => null,
          captureStream: () => ({ getVideoTracks: () => [track] }),
        }),
      },
      MediaStreamTrackGenerator: class {
        constructor() {
          return track;
        }
      },
    });
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "renderer.js"), "utf8"),
      context,
    );
    assert.throws(
      () => context.makeSource({ mode, width: 1280, height: 720 }),
      mode === "generator"
        ? /Writer unavailable/
        : /Manual canvas capture is unavailable/,
    );
    assert.equal(stopped, 1);
  }
});
