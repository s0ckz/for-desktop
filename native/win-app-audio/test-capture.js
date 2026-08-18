// Manual smoke test: play a sound from a throwaway process, capture only that
// process, and report whether real (non-silent) audio came back.
//
//   node test-capture.js
const { spawn } = require("node:child_process");
const audio = require("./index.js");

console.log("platform        :", process.platform);
console.log("isSupported()   :", audio.isSupported());
if (!audio.isSupported()) {
  console.log("lastError()     :", audio.lastError());
  process.exit(1);
}

// A PowerShell process that plays a system sound on a loop for ~8 seconds.
const script =
  "$p = New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav';" +
  "1..8 | ForEach-Object { $p.PlaySync() }";
const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
  stdio: "ignore",
});
console.log("sound source pid:", child.pid);

let chunks = 0;
let bytes = 0;
let nonSilentSamples = 0;
let peak = 0;

setTimeout(() => {
  try {
    audio.start(child.pid, true, (chunk) => {
      chunks++;
      bytes += chunk.length;
      for (let i = 0; i + 1 < chunk.length; i += 2) {
        const v = chunk.readInt16LE(i);
        if (v !== 0) nonSilentSamples++;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
    });
    console.log("capture started, listening for 6s...");
  } catch (err) {
    console.error("start() threw:", err.message);
    console.error("lastError()  :", audio.lastError());
    child.kill();
    process.exit(1);
  }
}, 700);

setTimeout(() => {
  audio.stop();
  try {
    child.kill();
  } catch {
    /* already gone */
  }

  console.log("");
  console.log("chunks received :", chunks);
  console.log("bytes received  :", bytes);
  console.log("non-silent samps:", nonSilentSamples);
  console.log("peak amplitude  :", peak, "/ 32767");
  console.log("lastError()     :", audio.lastError() || "(none)");
  console.log("");

  if (bytes === 0) {
    console.log("RESULT: FAIL - no audio delivered at all");
    process.exit(2);
  } else if (nonSilentSamples === 0) {
    console.log("RESULT: PARTIAL - stream works but only silence was captured");
    process.exit(3);
  } else {
    console.log("RESULT: PASS - per-process audio captured");
    process.exit(0);
  }
}, 7000);
