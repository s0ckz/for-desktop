"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { options } = require("./options.cjs");
const { nativeOptions } = require("./native-metrics.cjs");
const nativeCapture = process.argv[2] === "--native";
const args = process.argv.slice(nativeCapture ? 3 : 2);

let config;
try {
  config = (nativeCapture ? nativeOptions : options)(args);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (config.help) {
  console.log(
    nativeCapture
      ? "pnpm diagnostic:native-capture --stage=production|reference|full|acquire --fps=30|60 --seconds=12 --warmup=3 --output=<report.json> [--trace] [--min-interval=default|zero (private stages only)]"
      : "pnpm diagnostic:screen-share --codec=h264|h265 --bitrate=6000000|8000000 --fps=30|60 --mode=generator|canvas --seconds=12 --warmup=3 --output=<report.json> [--trace] [--software]",
  );
  process.exit(0);
}
// The Node parent owns cleanup after Electron and its profile locks have exited.
const electronBinary = require("electron");
const profile = fs.mkdtempSync(
  path.join(os.tmpdir(), "stoat-encode-diagnostic-"),
);
const output =
  config.output ??
  path.join(
    os.tmpdir(),
    `stoat-${nativeCapture ? "native" : "encode"}-report-${process.pid}.json`,
  );
const environment = { ...process.env, STOAT_SHARE_DIAGNOSTIC_PROFILE: profile };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electronBinary,
  [
    path.join(__dirname, nativeCapture ? "native-main.cjs" : "main.cjs"),
    ...args,
    `--output=${output}`,
  ],
  {
    stdio: "inherit",
    env: environment,
    windowsHide: true,
  },
);
let cleanupDone = false;
function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  clearTimeout(watchdog);
  const absolute = path.resolve(profile);
  const temporaryRoot = path.resolve(os.tmpdir());
  if (
    path.dirname(absolute) !== temporaryRoot ||
    !path.basename(absolute).startsWith("stoat-encode-diagnostic-")
  )
    return;
  try {
    fs.rmSync(absolute, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    });
  } catch {
    console.error(
      "Could not completely remove temporary diagnostic profile: " + absolute,
    );
    process.exitCode = 1;
  }
}
const watchdog = setTimeout(
  () => {
    console.error("Diagnostic process timed out");
    child.kill();
  },
  (config.seconds + config.warmup + 40) * 1000,
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
  cleanup();
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
  cleanup();
});
