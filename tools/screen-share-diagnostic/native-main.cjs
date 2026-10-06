"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { app, BrowserWindow, screen, contentTracing } = require("electron");
const {
  nativeOptions,
  distribution,
  decodeMarker,
  markerTracker,
  counterDelta,
  compositorTraceSummary,
} = require("./native-metrics.cjs");

const config = nativeOptions(process.argv.slice(2));
const profile = process.env.STOAT_SHARE_DIAGNOSTIC_PROFILE;
if (
  !profile ||
  path.dirname(path.resolve(profile)) !== path.resolve(os.tmpdir()) ||
  !path.basename(profile).startsWith("stoat-encode-diagnostic-") ||
  !fs.statSync(profile).isDirectory()
) {
  console.error(
    "Launch through diagnostic:native-capture so its temporary profile is managed.",
  );
  app.exit(1);
}
app.setPath("userData", profile);
app.setPath("sessionData", profile);
const output = config.output;
fs.mkdirSync(path.dirname(output), { recursive: true });
const report = {
  schema: 1,
  startedUtc: new Date().toISOString(),
  configuration: config,
  runtime: {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    platform: process.platform,
    helperSha256: createHash("sha256")
      .update(
        [
          "native-main.cjs",
          "native-metrics.cjs",
          "moving-source.js",
          "moving-source.html",
        ]
          .map((file) => fs.readFileSync(path.join(__dirname, file)))
          .reduce((all, bytes) => Buffer.concat([all, bytes]), Buffer.alloc(0)),
      )
      .digest("hex"),
  },
  note: "Own visible moving window only, native WGC-to-NV12 delivery to Electron main; excludes app IPC/track ingestion/encoder/SFU/internet. Does not launch/control a game; ambient device load must be measured separately. Canvas draws are not physical presentation counts.",
};
let capture,
  window,
  timer,
  finishing = false,
  measuring = false,
  recording = false,
  death = null;
let frames = 0,
  invalidPayloads = 0,
  previousCallback = null,
  previousSourceTime = null;
const callbackGaps = [],
  timestampGaps = [],
  submissionCpu = [],
  mapPackCpu = [];
const resolutions = new Set();
const markers = markerTracker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function finish(error) {
  if (finishing) return;
  finishing = true;
  measuring = false;
  clearTimeout(timer);
  if (error)
    report.error = { message: String(error.message ?? error).slice(0, 300) };
  try {
    if (capture) {
      await capture.stop();
      report.finalDiagnostics = capture.diagnostics();
    }
    if (window && !window.isDestroyed())
      await window.webContents.executeJavaScript("window.stopMovingSource?.()");
  } catch (cleanupError) {
    report.cleanupError = String(cleanupError.message).slice(0, 200);
  }
  if (recording) {
    recording = false;
    const file = output.replace(/(?:\.json)?$/, ".trace.json");
    let traceTimer;
    try {
      await Promise.race([
        contentTracing.stopRecording(file),
        new Promise((_, reject) => {
          traceTimer = setTimeout(
            () => reject(new Error("Native trace stop timed out")),
            5000,
          );
        }),
      ]);
      report.trace = {
        file,
        compositorEventsIncludingWarmup: compositorTraceSummary(
          JSON.parse(fs.readFileSync(file, "utf8")),
        ),
        note: "Event counts are not physical display presentation FPS. Trace overhead can affect timing; correlate source renderer and marked measurement interval in the local trace.",
      };
    } catch (traceError) {
      report.trace = { error: String(traceError.message).slice(0, 200) };
    } finally {
      clearTimeout(traceTimer);
    }
  }
  if (window && !window.isDestroyed()) window.destroy();
  report.completedUtc = new Date().toISOString();
  try {
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  } catch (writeError) {
    console.error(writeError.message);
    app.exit(1);
    return;
  }
  console.log(
    JSON.stringify({
      output,
      error: report.error ?? null,
      summary: report.measurement ?? null,
    }),
  );
  if (report.error || report.cleanupError) app.exit(1);
  else app.quit();
}
app
  .whenReady()
  .then(async () => {
    timer = setTimeout(
      () =>
        void finish(new Error("Native diagnostic exceeded bounded runtime")),
      (config.seconds + config.warmup + 25) * 1000,
    );
    if (process.platform !== "win32")
      throw new Error("Native WGC diagnostic requires Windows");
    capture = require("win-capture");
    if (!capture.isSupported())
      throw new Error("Native capture unavailable: " + capture.lastError());
    const binary = path.join(
      path.dirname(require.resolve("win-capture")),
      "build/Release/win_capture.node",
    );
    report.runtime.nativeBinarySha256 = createHash("sha256")
      .update(fs.readFileSync(binary))
      .digest("hex");
    const display = screen.getPrimaryDisplay();
    report.display = {
      refreshHz: display.displayFrequency,
      scaleFactor: display.scaleFactor,
    };
    if (config.trace) {
      await contentTracing.startRecording({
        included_categories: [
          "cc",
          "viz",
          "gpu",
          "benchmark",
          "blink.user_timing",
        ],
      });
      recording = true;
    }
    window = new BrowserWindow({
      show: false,
      frame: false,
      thickFrame: false,
      useContentSize: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      width: config.width,
      height: config.height,
      x: Math.round(
        display.workArea.x + (display.workArea.width - config.width) / 2,
      ),
      y: Math.round(
        display.workArea.y + (display.workArea.height - config.height) / 2,
      ),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_details, callback) => callback({ cancel: true }),
    );
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on(
      "render-process-gone",
      () => void finish(new Error("Moving source renderer stopped")),
    );
    window.on("closed", () => {
      if (!finishing)
        void finish(new Error("Moving source closed before completion"));
    });
    await window.loadFile(path.join(__dirname, "moving-source.html"));
    report.runtime.sourceRendererPid = window.webContents.getOSProcessId();
    window.showInactive();
    await window.webContents.executeJavaScript(
      `window.startMovingSource(${config.sourceFps})`,
    );
    const handle = window.getNativeWindowHandle();
    const hwnd = (
      handle.length >= 8
        ? handle.readBigUInt64LE(0)
        : BigInt(handle.readUInt32LE(0))
    ).toString();
    if (
      !capture.start(
        hwnd,
        config.width,
        config.height,
        config.fps,
        (frame, meta) => {
          if (!frame) {
            if (!finishing)
              death = meta.reason || "Native capture worker stopped";
            return;
          }
          if (!measuring) return;
          const now = performance.now();
          frames++;
          if (frame.length !== meta.width * meta.height * 1.5)
            invalidPayloads++;
          if (previousCallback !== null)
            callbackGaps.push(now - previousCallback);
          if (
            previousSourceTime !== null &&
            meta.timestampUs > previousSourceTime
          )
            timestampGaps.push((meta.timestampUs - previousSourceTime) / 1000);
          previousCallback = now;
          previousSourceTime = meta.timestampUs;
          submissionCpu.push(meta.bltMs);
          mapPackCpu.push(meta.grabMs);
          resolutions.add(`${meta.width}x${meta.height}`);
          markers.add(decodeMarker(frame, meta.width, meta.height));
        },
        undefined,
        "wgc",
      )
    )
      throw new Error("Native capture rejected the owned source");
    await sleep(config.warmup * 1000);
    if (finishing) return;
    if (death || !capture.diagnostics()?.ready)
      throw new Error(death || "Native capture did not become ready");
    const sourceStart = await window.webContents.executeJavaScript(
      "performance.mark('stoat-native-measurement-start'); window.readMovingSource()",
    );
    const nativeStart = capture.diagnostics();
    const started = performance.now();
    measuring = true;
    await sleep(config.seconds * 1000);
    measuring = false;
    const elapsedSeconds = (performance.now() - started) / 1000;
    const nativeEnd = capture.diagnostics();
    const sourceEnd = await window.webContents.executeJavaScript(
      "performance.mark('stoat-native-measurement-end'); window.readMovingSource()",
    );
    if (finishing) return;
    const sourceSeconds = (sourceEnd.atMs - sourceStart.atMs) / 1000;
    const counters = Object.fromEntries(
      [
        "arrivalEvents",
        "incomingFrames",
        "drainedFrames",
        "pacingSkips",
        "processAttempts",
        "processFailures",
        "poolReadFailures",
        "surfaceFailures",
        "submittedFrames",
        "emittedFrames",
        "tsfnQueuedFrames",
        "tsfnRejectedFrames",
        "payloadPoolPressurePolls",
        "readbackCoalesced",
        "ringFull",
        "expiredReadbacks",
      ].map((key) => [key, counterDelta(nativeEnd, nativeStart, key)]),
    );
    report.measurement = {
      elapsedSeconds,
      sourceDrawFps: (sourceEnd.drawn - sourceStart.drawn) / sourceSeconds,
      sourceSkippedDeadlines: sourceEnd.skipped - sourceStart.skipped,
      sourceMaxDrawGapMsIncludingWarmup: sourceEnd.maxDrawGapMs,
      sourceHidden: sourceStart.hidden || sourceEnd.hidden,
      incomingFps:
        counters.incomingFrames === null
          ? null
          : counters.incomingFrames / elapsedSeconds,
      submittedFps:
        counters.submittedFrames === null
          ? null
          : counters.submittedFrames / elapsedSeconds,
      deliveredFps: frames / elapsedSeconds,
      distinctMarkerFps: markers.result.discontinuities
        ? null
        : markers.result.distinctFrames / elapsedSeconds,
      resolutions: [...resolutions],
      invalidPayloads,
      markers: markers.result,
      counters,
      callbackGap: distribution(callbackGaps),
      sourceTimestampGap: distribution(timestampGaps),
      submissionCpu: distribution(submissionCpu),
      nonblockingMapPackCpu: distribution(mapPackCpu),
      note: "Rates use independent native/main/source sample clocks. Marker skips can be expected at a 30 FPS capture cap. Native timings below are cumulative including warm-up; readback residence is overlapped, not a serial GPU execution time.",
    };
    report.source = { start: sourceStart, end: sourceEnd };
    report.nativeDiagnostics = { start: nativeStart, end: nativeEnd };
    if (death) throw new Error(death);
    if (!frames || invalidPayloads || !markers.result.validFrames)
      throw new Error("No valid moving native NV12 source was measured");
    await finish();
  })
  .catch((error) => void finish(error));
