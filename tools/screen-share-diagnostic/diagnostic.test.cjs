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
const { interval, aggregate, profile, sameProfile } = require("./metrics.js");

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
  for (const arg of [
    "--fps=0",
    "--fps=120",
    "--seconds=Infinity",
    "--seconds=4",
    "--warmup=30",
    "--mode=screen",
    "--profile=arbitrary",
    "--server=https://example.com",
  ])
    assert.throws(() => options([arg]));
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
