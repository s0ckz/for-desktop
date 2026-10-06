"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { app, BrowserWindow, contentTracing } = require("electron");
const {
  options,
  gpuSummary,
  traceSummary,
  encoderLogSummary,
} = require("./options.cjs");

let config;
try {
  config = options(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  app.exit(1);
}
if (config?.help) {
  console.log(
    "pnpm diagnostic:screen-share --codec=h264|h265 --bitrate=6000000|8000000 --mode=generator|canvas --profile=cbp|baseline|main|high --fps=30|60 --seconds=12 --warmup=3 --output=<report.json> [--trace] [--software]",
  );
  app.exit(0);
}
// This helper never imports the Stoat main/preload/config or its signed-in profile.
const profile = process.env.STOAT_SHARE_DIAGNOSTIC_PROFILE;
if (
  !profile ||
  path.dirname(path.resolve(profile)) !== path.resolve(os.tmpdir()) ||
  !path.basename(profile).startsWith("stoat-encode-diagnostic-") ||
  !fs.statSync(profile).isDirectory()
) {
  console.error(
    "Launch this diagnostic through run.cjs so its temporary profile is managed.",
  );
  app.exit(1);
}
const output =
  config.output ??
  path.join(os.tmpdir(), `stoat-encode-report-${process.pid}.json`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const traceFile = output.replace(/(?:\.json)?$/, ".trace.json");
const chromiumLog = output.replace(/(?:\.json)?$/, ".chromium.log");
app.setPath("userData", profile);
app.setPath("sessionData", profile);
if (config.software) app.disableHardwareAcceleration();
if (process.platform === "win32")
  app.commandLine.appendSwitch("enable-features", "PlatformH264CbpEncoding");
if (config.trace) {
  app.commandLine.appendSwitch("enable-logging", "file");
  app.commandLine.appendSwitch("log-file", chromiumLog);
  app.commandLine.appendSwitch(
    "vmodule",
    "rtc_video_encoder=2,media_foundation_video_encode_accelerator_win=2,video_encode_accelerator_adapter=2",
  );
}
let window,
  timer,
  recording = false,
  finishing = false;
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
        ["main.cjs", "renderer.js", "metrics.js", "options.cjs"]
          .map((file) => fs.readFileSync(path.join(__dirname, file)))
          .reduce((all, bytes) => Buffer.concat([all, bytes]), Buffer.alloc(0)),
      )
      .digest("hex"),
  },
  note: "Synthetic local loopback, hidden renderer, no SFU/internet/game load; not a production or viewer-performance benchmark.",
};
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  if (error)
    report.error = {
      name: error.name ?? "Error",
      message: String(error.message ?? error).slice(0, 300),
    };
  try {
    if (recording) {
      recording = false;
      await Promise.race([
        contentTracing.stopRecording(traceFile),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Trace stop timed out")), 5000),
        ),
      ]);
      report.trace = {
        file: traceFile,
        encoderEvents: traceSummary(
          JSON.parse(fs.readFileSync(traceFile, "utf8")),
        ),
      };
    }
  } catch (traceError) {
    report.trace = { error: String(traceError.message).slice(0, 200) };
  }
  report.encoderLog =
    config.trace && fs.existsSync(chromiumLog)
      ? encoderLogSummary(fs.readFileSync(chromiumLog, "utf8"))
      : null;
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
      summary: report.measurement?.summary ?? null,
      gpu: report.gpu?.videoEncodeAvailability ?? null,
      traceEvents: report.trace?.encoderEvents?.slice(0, 6) ?? [],
      encoderLog: report.encoderLog,
    }),
  );
  process.exitCode = report.error ? 1 : 0;
  if (report.error) app.exit(1);
  else app.quit();
}
app
  .whenReady()
  .then(async () => {
    timer = setTimeout(
      () => void finish(new Error("Diagnostic exceeded bounded runtime")),
      (config.seconds + config.warmup + 25) * 1000,
    );
    let gpuTimer;
    try {
      const gpuInfo = await Promise.race([
        app.getGPUInfo("complete"),
        new Promise((_, reject) => {
          gpuTimer = setTimeout(
            () => reject(new Error("GPU information timed out")),
            5000,
          );
        }),
      ]);
      report.gpu = gpuSummary(gpuInfo, app.getGPUFeatureStatus());
    } catch (error) {
      report.gpu = gpuSummary(undefined, undefined);
      report.gpu.queryError = String(error.message).slice(0, 120);
    } finally {
      clearTimeout(gpuTimer);
    }
    if (config.trace) {
      await contentTracing.startRecording({
        included_categories: ["media", "disabled-by-default-media", "gpu"],
      });
      recording = true;
    }
    window = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
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
      () => void finish(new Error("Diagnostic renderer stopped")),
    );
    await window.loadFile(path.join(__dirname, "index.html"));
    report.measurement = await window.webContents.executeJavaScript(
      `window.runScreenShareDiagnostic(${JSON.stringify(config)})`,
    );
    if (finishing) return;
    if (!report.measurement.validCodec)
      throw new Error(
        "Negotiated codec/profile did not match the requested diagnostic codec/profile",
      );
    if (
      !(report.measurement.summary.sentFps > 0) ||
      !(report.measurement.summary.decodedFps > 0)
    )
      throw new Error(
        "No encoded and decoded video flowed during the measurement",
      );
    await finish();
  })
  .catch((error) => void finish(error));
