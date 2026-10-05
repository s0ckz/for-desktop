"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { options } = require("./options.cjs");

let config;
try {
  config = options(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (config.help) {
  console.log(
    "pnpm diagnostic:screen-share --fps=30|60 --mode=generator|canvas --seconds=12 --warmup=3 --output=<report.json> [--trace] [--software]",
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
  path.join(os.tmpdir(), `stoat-encode-report-${process.pid}.json`);
const environment = { ...process.env, STOAT_SHARE_DIAGNOSTIC_PROFILE: profile };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electronBinary,
  [
    path.join(__dirname, "main.cjs"),
    ...process.argv.slice(2),
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
