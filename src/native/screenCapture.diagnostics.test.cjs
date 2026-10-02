// Verifies periodic diagnostics survive a complete pixel-frame drought.
// Uses the real capture lifecycle with a fake native module and no renderer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const logs = [];
const counters = {
  arrivalEvents: 0,
  incomingFrames: 0,
  drainedFrames: 0,
  pacingSkips: 0,
  processAttempts: 0,
  processFailures: 0,
  poolReadFailures: 0,
  surfaceFailures: 0,
  longLoopGaps: 0,
  stillDrawing: 0,
  refused: 0,
  maxLoopGapMs: 0,
  loopIdleMs: 0,
  running: true,
  lastError: "",
};
const native = {
  isSupported: () => true,
  start: () => true,
  stop: () => Promise.resolve(),
  lastError: () => "",
  diagnostics: () => ({ ...counters }),
};
const electron = {
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  screen: {
    getAllDisplays: () => [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ],
    dipToScreenPoint: (point) => point,
  },
};
const audio = {
  log: (...args) => logs.push(args.join(" ")),
  createLogRateLimiter: () => () => true,
  windowHandleFromSourceId: () => null,
  windowStateForSourceId: () => null,
};
const source = fs.readFileSync(
  path.join(__dirname, "screenCapture.ts"),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const captureModule = { exports: {} };
new Function("require", "module", "exports", code)(
  (name) => {
    if (name === "electron") return electron;
    if (name === "./appAudio") return audio;
    if (name === "win-capture") return native;
    throw Error("unexpected import " + name);
  },
  captureModule,
  captureModule.exports,
);
(async () => {
  const api = captureModule.exports;
  try {
    assert.equal(await api.startForSource("screen:1:0", 30, 1, "1"), true);
    await new Promise((resolve) => setTimeout(resolve, 10500));
    const stageLog = logs.find((line) =>
      line.startsWith("screen capture: stages "),
    );
    assert(
      stageLog,
      "stage report must be logged without any onFrame callbacks",
    );
    const report = JSON.parse(stageLog.slice("screen capture: stages ".length));
    assert.equal(report.incomingFps, 0);
    assert(report.frameDroughtMs >= 10000);
    await api.stop();
    const count = logs.length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      logs.length,
      count,
      "stop must clear diagnostic and watchdog timers",
    );
    console.log("CAPTURE DROUGHT REPORT PASS");
  } finally {
    await api.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
