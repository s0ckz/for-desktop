// Throughput/latency harness: capture a real window for ~30s and report
// whether native GPU-downscaled capture can actually hit 30fps, and whether
// the per-frame Napi::Buffer copy pattern keeps up with NV12 video-rate
// throughput (the reason this file exists at all -- see the plan).
//
//   node test-capture.js [windowTitleSubstring]
//
// With no argument, launches Notepad as a throwaway capture target and closes
// it when done. Pass a substring (case-insensitive) to match an existing
// window's title instead -- e.g. `node test-capture.js "Escape from Tarkov"`.
"use strict";

const { spawn, execFileSync } = require("node:child_process");
const capture = require("./index.js");

const DURATION_MS = 30_000;
const TARGET_W = 1920;
const TARGET_H = 1080;
const TARGET_FPS = 30;

console.log("platform      :", process.platform);
console.log("isSupported() :", capture.isSupported());
if (!capture.isSupported()) {
  console.log("lastError()   :", capture.lastError());
  process.exit(1);
}

function findWindowHandle(titleSubstring) {
  // Get-Process' MainWindowHandle is exactly an HWND for any process with a
  // visible top-level window -- good enough to find a real window without
  // pulling in Electron's desktopCapturer, which this harness deliberately
  // avoids so it can run standalone.
  const script = titleSubstring
    ? `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match [regex]::Escape('${titleSubstring}') } | Select-Object -First 1 -ExpandProperty MainWindowHandle`
    : `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | Select-Object -First 1 -ExpandProperty MainWindowHandle`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).trim();
  return out ? out : null;
}

let spawnedNotepad = null;
let hwnd = null;
const titleArg = process.argv[2];

if (titleArg) {
  hwnd = findWindowHandle(titleArg);
  if (!hwnd) {
    console.error(`no window found matching "${titleArg}"`);
    process.exit(1);
  }
  console.log("window        : matched existing window, hwnd =", hwnd);
} else {
  console.log("no window title given -- launching Notepad as the capture target");
  spawnedNotepad = spawn("notepad.exe", [], { stdio: "ignore" });
  // Give it a moment to create its top-level window.
  const start = Date.now();
  while (!hwnd && Date.now() - start < 5000) {
    try {
      hwnd = findWindowHandle("Notepad");
    } catch {
      /* not up yet */
    }
  }
  if (!hwnd) {
    console.error("could not find Notepad's window handle after 5s");
    process.exit(1);
  }
  console.log("window        : Notepad, hwnd =", hwnd);
}

// --- stats ---
let frames = 0;
let bytes = 0;
let droppedFallingBehind = 0; // frames whose JS callback fired late relative to expected cadence
let lastFrameAt = null;
let intervalsSum = 0;
let bltMsSum = 0;
let grabMsSum = 0;
let bltMsMax = 0;
let grabMsMax = 0;
let firstWidth = null;
let firstHeight = null;

const testStart = Date.now();

try {
  capture.start(hwnd, TARGET_W, TARGET_H, TARGET_FPS, (buf, meta) => {
    const now = Date.now();
    frames++;
    bytes += buf.length;
    if (firstWidth === null) {
      firstWidth = meta.width;
      firstHeight = meta.height;
    }
    if (lastFrameAt !== null) {
      const gap = now - lastFrameAt;
      intervalsSum += gap;
      if (gap > (1000 / TARGET_FPS) * 1.5) droppedFallingBehind++;
    }
    lastFrameAt = now;
    bltMsSum += meta.bltMs;
    grabMsSum += meta.grabMs;
    if (meta.bltMs > bltMsMax) bltMsMax = meta.bltMs;
    if (meta.grabMs > grabMsMax) grabMsMax = meta.grabMs;
  });
} catch (err) {
  console.error("start() threw:", err.message);
  console.error("lastError()  :", capture.lastError());
  if (spawnedNotepad) spawnedNotepad.kill();
  process.exit(1);
}

console.log(`capture started, running for ${DURATION_MS / 1000}s ...`);

setTimeout(() => {
  capture.stop();
  const elapsedS = (Date.now() - testStart) / 1000;

  if (spawnedNotepad) {
    try {
      spawnedNotepad.kill();
    } catch {
      /* already gone */
    }
  }

  const deliveredFps = frames / elapsedS;
  const avgIntervalMs = frames > 1 ? intervalsSum / (frames - 1) : 0;
  const throughputMBps = bytes / 1024 / 1024 / elapsedS;
  const avgBltMs = frames ? bltMsSum / frames : 0;
  const avgGrabMs = frames ? grabMsSum / frames : 0;

  console.log("");
  console.log("=== RESULTS ===");
  console.log("elapsed (s)          :", elapsedS.toFixed(2));
  console.log("frames delivered     :", frames);
  console.log("delivered fps        :", deliveredFps.toFixed(2), "(target", TARGET_FPS + ")");
  console.log("avg inter-frame (ms) :", avgIntervalMs.toFixed(2));
  console.log("frame size           :", firstWidth + "x" + firstHeight, "(NV12)");
  console.log("bytes total          :", bytes);
  console.log("throughput (MB/s)    :", throughputMBps.toFixed(2));
  console.log("avg VideoProcessorBlt (ms) :", avgBltMs.toFixed(3), " max:", bltMsMax.toFixed(3));
  console.log("avg CopyResource+Map (ms)  :", avgGrabMs.toFixed(3), " max:", grabMsMax.toFixed(3));
  console.log("frames arriving >1.5x late (JS side, N-API falling behind):", droppedFallingBehind);
  console.log("lastError()          :", capture.lastError() || "(none)");
  console.log("");

  if (frames === 0) {
    console.log("RESULT: FAIL - no frames delivered at all");
    process.exit(2);
  }
  if (avgGrabMs > 16.6) {
    console.log("RESULT: FAIL - CopyResource+Map alone exceeds the 16.6ms/frame budget for 30fps");
    process.exit(3);
  }
  if (deliveredFps < TARGET_FPS * 0.9) {
    console.log("RESULT: PARTIAL - grab is fast enough but delivered fps is short of target");
    process.exit(4);
  }
  console.log("RESULT: PASS - native capture sustains target fps with grab time inside budget");
  process.exit(0);
}, DURATION_MS);
