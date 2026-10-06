const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const asar = require("@electron/asar");
const root = path.resolve(__dirname, "../..");
const packaged = path.resolve(
  process.argv[2] ||
    path.join(root, "out-capture-hardening", "Stoat-win32-x64"),
);
const resources = path.join(packaged, "resources");
const archive = path.join(resources, "app.asar");
const main = asar.extractFile(archive, ".vite\\build\\main.js").toString();
const preload = asar
  .extractFile(archive, ".vite\\build\\preload.js")
  .toString();
for (const marker of [
  "expiredReadbacks",
  "screen capture: renderer",
  "confirmSessionLive",
  "counters.written",
  "native-monitor-backend",
  "screen capture: session start",
  "screen capture: session final",
  "timings",
  "native liveness failure",
  "sourceTimestampOffsets",
  "tsfnQueuedFrames",
  "first renderer frame timed out",
  "screenCapture:configure",
  "wgcInterval",
  "configuration accepted",
  "app-audio.log",
]) {
  assert(main.includes(marker), "Packaged main missing: " + marker);
}
for (const marker of [
  "screenCapture:configure",
  "frameId",
  "sessionId",
  '"ack"',
]) {
  assert(preload.includes(marker), "Packaged preload missing: " + marker);
}
const relative = "node_modules/win-capture/build/Release/win_capture.node";
const nativeBinary = fs.readFileSync(
  path.join(resources, "app.asar.unpacked", relative),
);
for (const marker of [
  "capture-hardening-v1",
  "interval-policy-v1",
  "verification_failed",
  "consecutive surface failures=",
  "sourceTimestampOffsets",
  "payloadPoolPressurePolls",
  "readbackWait",
  "sourceConversion",
  "DuplicateOutput",
])
  assert(
    nativeBinary.includes(Buffer.from(marker)),
    "Packaged native missing: " + marker,
  );
const hash = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(
  hash(path.join(resources, "app.asar.unpacked", relative)),
  hash(path.join(root, relative)),
);
console.log(
  "CAPTURE PACKAGE PASS: main/preload changes and exact native binary verified",
);
