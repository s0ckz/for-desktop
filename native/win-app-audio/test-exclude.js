// Manual harness: prove that a blocklisted application's audio does NOT
// reach the mixed capture, deterministically, without needing Discord
// installed - the blocklist is an argument to startSystemExcluding(), so
// this test blocks an arbitrary executable (pwsh.exe) and uses a second,
// differently-named PowerShell host (powershell.exe) as the "allowed"
// control source.
//
// A quirk that matters: the addon excludes OUR OWN process tree from the
// mix by design (that's how it keeps Stoat's own voice-call audio out of a
// share). If we spawned the sound sources directly with
// child_process.spawn(), both would be our children and BOTH would be
// excluded as "self-tree" regardless of the blocklist - phase 3 would look
// silent for the wrong reason (never attached at all, not blocked). So
// both sources are launched via WMI (Win32_Process.Create), whose actual
// parent is WmiPrvSE.exe, unrelated to this process. See
// spawnDetachedSoundSource() below.
//
// IMPORTANT - how to run this file:
//
//   Run it from node_modules/win-app-audio/, NEVER from
//   native/win-app-audio/. The copy under native/ has its own stale
//   build/Release/win_app_audio.node, and index.js there requires the
//   addon by relative path - running from there silently tests the wrong
//   binary.
//
//   The addon is rebuilt at Electron's ABI (148), not host Node's (137),
//   so plain `node` cannot load it. Run it as:
//
//     ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd ./node_modules/win-app-audio/test-exclude.js
//
//   Close Spotify, browser tabs, and anything else that makes sound
//   before running. This machine typically has several apps holding live
//   audio sessions at once, so the "baseline" phase is NOT silent here -
//   see the phase 2/3/4 assertions below, which are deliberately relative
//   to each other rather than to that noisy baseline.
//
//   Writes phase1.wav .. phase4.wav to the current working directory.
//   Listen to phase3.wav: it should be silent even though the alarm was
//   audibly playing out of the speakers for the entire clip - that
//   silence is the actual proof the blocklist works, more convincing
//   than any number printed below.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const audio = require("./index.js");

console.log("platform        :", process.platform);
console.log("isSupported()   :", audio.isSupported());
if (!audio.isSupported()) {
  console.log("lastError()     :", audio.lastError());
  process.exit(1);
}

// Two real, distinctly-named binaries. Full paths on purpose: spawning bare
// "powershell"/"pwsh" would let PATH resolution surprise us, and the native
// enumerator needs the two image names to be unambiguous.
const ALLOWED_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const BLOCKED_EXE = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const ALARM_WAV = "C:\\Windows\\Media\\Alarm01.wav";

// A source that never plays would make phase 3 pass for the wrong reason
// (silence because it isn't running, not because it's blocked) - fail
// loudly here instead of silently "passing" later.
for (const exe of [ALLOWED_EXE, BLOCKED_EXE]) {
  if (!fs.existsSync(exe)) {
    console.error(`FATAL: expected binary not found: ${exe}`);
    process.exit(1);
  }
}

// Launch a PlaySync loop (same idea as test-capture.js:16-18) as a process
// whose PARENT is WmiPrvSE.exe, NOT this Node/Electron process - see the
// file header for why that matters. Returns the new process's PID, parsed
// from Invoke-CimMethod's printed ProcessId.
//
// The CommandLine value is single-quoted PowerShell text, so the embedded
// double quotes around the nested -Command argument need no escaping, and
// a literal single quote (around the wav path) is written doubled ('')
// per PowerShell's single-quoted-string escaping rule.
function spawnDetachedSoundSource(exePath) {
  const innerCommand =
    `"${exePath}" -NoProfile -Command "$p = New-Object Media.SoundPlayer ''${ALARM_WAV}''; 1..30 | ForEach-Object { $p.PlaySync() }"`;
  const launcherScript = `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${innerCommand}'}).ProcessId`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", launcherScript], {
    encoding: "utf8",
  });
  const pid = parseInt(output.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`failed to launch detached sound source for ${exePath}: got PID output "${output.trim()}"`);
  }
  return pid;
}

// --- single cleanup path --------------------------------------------------
// An orphaned looping alarm is genuinely obnoxious, so every exit - normal,
// early failure, or an uncaught error - funnels through here exactly once.
// The sources are WMI-launched, not our children, so child.kill() would do
// nothing; taskkill /T reaches the process (and anything it spawned) by PID.
let allowedPid = null;
let blockedPid = null;
let statusTimer = null;
let cleanedUp = false;

function killPid(pid) {
  if (!pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone, or never actually started */
  }
}

function cleanup(exitCode) {
  if (cleanedUp) return;
  cleanedUp = true;
  if (statusTimer) clearInterval(statusTimer);
  killPid(allowedPid);
  killPid(blockedPid);
  try {
    audio.stop();
  } catch {
    /* already stopped */
  }
  process.exit(exitCode);
}

process.on("uncaughtException", (err) => {
  console.error("uncaught exception:", err);
  cleanup(2);
});
process.on("SIGINT", () => cleanup(2));

// --- start the mixer once, for the whole test -----------------------------
let mixReport;
try {
  mixReport = audio.startSystemExcluding(["pwsh.exe"], onChunk);
} catch (err) {
  console.error("startSystemExcluding() threw:", err.message);
  console.error("lastError()              :", audio.lastError());
  process.exit(1);
}

console.log("");
console.log("mix report at start:");
console.log("  enumerated:", fmtList(mixReport.enumerated));
console.log("  blocked   :", fmtBlocked(mixReport.blocked));
console.log("  started   :", fmtList(mixReport.started));
if (mixReport.failed.length > 0) {
  console.log("  failed    :", mixReport.failed.map((p) => `${p.name || "?"}(${p.pid}): ${p.error}`).join(", "));
}
console.log("");

function fmtList(list) {
  return (list || []).map((p) => `${p.name || "?"}(${p.pid})`).join(", ") || "(none)";
}
function fmtBlocked(list) {
  return (list || []).map((p) => `${p.name || "?"}(${p.pid}) [${p.reason}]`).join(", ") || "(none)";
}

function snapshotClients() {
  try {
    return audio.mixState().clients || [];
  } catch {
    return [];
  }
}

// --- per-phase stats accumulation ------------------------------------------
// `stats` is null outside a measurement window, so chunks arriving during
// settle time (while the mixer's 2s rescan is attaching/reaping clients)
// are deliberately not counted toward any phase's numbers.
let stats = null;

function resetStats() {
  stats = { chunks: 0, bytes: 0, sumSquares: 0, sampleCount: 0, peak: 0, buffers: [] };
}

function onChunk(chunk) {
  if (!stats) return;
  stats.chunks++;
  stats.bytes += chunk.length;
  stats.buffers.push(chunk);
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const v = chunk.readInt16LE(i);
    stats.sumSquares += v * v;
    stats.sampleCount++;
    const a = Math.abs(v);
    if (a > stats.peak) stats.peak = a;
  }
}

// RMS in dBFS relative to full-scale int16. Clamp true silence to a noise
// floor instead of -Infinity so arithmetic comparisons below stay sane.
function dbfs(rms) {
  return rms <= 0 ? -96 : 20 * Math.log10(rms / 32768);
}

function finishPhase(name) {
  const rms = stats.sampleCount > 0 ? Math.sqrt(stats.sumSquares / stats.sampleCount) : 0;
  const result = {
    name,
    chunks: stats.chunks,
    bytes: stats.bytes,
    peak: stats.peak,
    rmsDbfs: dbfs(rms),
    buffer: Buffer.concat(stats.buffers),
  };
  stats = null;
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Once per second, print what Windows reports vs. what the mixer actually
// attached - lets a human see a blocked PID show up in `processes` but
// never in `mixer clients`.
function startStatusPrinter() {
  statusTimer = setInterval(() => {
    let procs = [];
    let clients = [];
    try {
      procs = audio.listAudioProcesses();
    } catch {
      /* index.js already swallows; belt and suspenders */
    }
    try {
      clients = audio.mixState().clients;
    } catch {
      /* ditto */
    }
    console.log(`  [status] processes: ${fmtList(procs)} | mixer clients: ${fmtList(clients)}`);
  }, 1000);
}

// 44-byte RIFF/WAVE header + PCM data, 16-bit signed.
function wavFile(pcmData, sampleRate, channels, bitsPerSample = 16) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

// Settle time lets the native control thread's 2s rescan attach a newly
// spawned source (or reap a killed one) before we start counting; measure
// time is the actual ~5s window the plan's phase table describes.
const SETTLE_MS = 2500;
const MEASURE_MS = 5000;

// PASS/FAIL printer. Returns `pass` so callers can fold it straight into an
// exit-code decision without re-deriving the condition.
function check(label, pass, failDetail) {
  console.log(`[${pass ? "PASS" : "FAIL"}] ${label}`);
  if (!pass && failDetail) console.log(`       ${failDetail}`);
  return pass;
}

(async () => {
  startStatusPrinter();
  const results = {};

  // Phase 1 - baseline: nothing WE started playing. NOT a silence
  // reference - this machine routinely has several apps holding live audio
  // sessions (Spotify, browser, chat apps, etc.), so this number varies by
  // tens of dB run to run and is printed as context only. Every real
  // assertion below compares phases to each other instead.
  console.log("=== phase 1: baseline (nothing playing) ===");
  await sleep(SETTLE_MS);
  resetStats();
  await sleep(MEASURE_MS);
  results.baseline = finishPhase("baseline");

  // Phase 2 - allowed only. Proves mixing works at all.
  console.log("=== phase 2: allowed only (powershell.exe) ===");
  allowedPid = spawnDetachedSoundSource(ALLOWED_EXE);
  const allowedPidPhase2 = allowedPid;
  console.log("  allowed pid:", allowedPid);
  await sleep(SETTLE_MS);
  resetStats();
  await sleep(MEASURE_MS);
  results.allowedOnly = finishPhase("allowed-only");
  const allowedAttachedPhase2 = snapshotClients().some((c) => c.pid === allowedPidPhase2);

  // Phase 3 - blocked only. Swap sources: kill the allowed one, start the
  // blocked one. This is the assertion that matters.
  console.log("=== phase 3: blocked only (pwsh.exe) ===");
  killPid(allowedPid);
  allowedPid = null;
  blockedPid = spawnDetachedSoundSource(BLOCKED_EXE);
  console.log("  blocked pid:", blockedPid);
  await sleep(SETTLE_MS);
  resetStats();
  await sleep(MEASURE_MS);
  results.blockedOnly = finishPhase("blocked-only");
  const blockedAttachedPhase3 = snapshotClients().some((c) => c.pid === blockedPid);

  // Phase 4 - both. Proves the blocklist doesn't collaterally drop the
  // permitted source just because a blocked one is also playing.
  console.log("=== phase 4: both (powershell.exe + pwsh.exe) ===");
  allowedPid = spawnDetachedSoundSource(ALLOWED_EXE);
  console.log("  allowed pid:", allowedPid, " blocked pid:", blockedPid);
  await sleep(SETTLE_MS);
  resetStats();
  await sleep(MEASURE_MS);
  results.both = finishPhase("both");
  const clientsPhase4 = snapshotClients();
  const allowedAttachedPhase4 = clientsPhase4.some((c) => c.pid === allowedPid);
  const blockedAttachedPhase4 = clientsPhase4.some((c) => c.pid === blockedPid);

  // --- write phase<N>.wav --------------------------------------------------
  const order = ["baseline", "allowedOnly", "blockedOnly", "both"];
  const sampleRate = audio.sampleRate || 48000;
  const channels = audio.channels || 2;
  const wavPaths = order.map((key, idx) => {
    const r = results[key];
    const wavPath = path.join(process.cwd(), `phase${idx + 1}.wav`);
    fs.writeFileSync(wavPath, wavFile(r.buffer, sampleRate, channels));
    return wavPath;
  });

  // --- summary table --------------------------------------------------------
  console.log("");
  console.log("phase              chunks   bytes      peak     rms(dBFS)");
  order.forEach((key, idx) => {
    const r = results[key];
    const label = `${idx + 1} ${r.name}`;
    console.log(
      label.padEnd(19),
      String(r.chunks).padEnd(9),
      String(r.bytes).padEnd(11),
      String(r.peak).padEnd(9),
      r.rmsDbfs.toFixed(1)
    );
  });
  console.log("");
  console.log(
    "phase-1 baseline (context only, NOT a threshold):",
    results.baseline.rmsDbfs.toFixed(1),
    "dBFS / peak",
    results.baseline.peak
  );
  console.log("");

  // --- assertions -------------------------------------------------------
  // Thresholds are relative to each other, not to the phase-1 baseline:
  // this machine's background noise floor varies by tens of dB between
  // runs (measured -47.4 and -58.3 dBFS in back-to-back runs, with 8 apps
  // holding live sessions), so a baseline captured ~20s earlier is not a
  // stable reference point.
  const chunksOk = check(
    "chunks > 0 in every phase (incl. 1 and 3 - zero-client heartbeat)",
    results.baseline.chunks > 0 &&
      results.allowedOnly.chunks > 0 &&
      results.blockedOnly.chunks > 0 &&
      results.both.chunks > 0
  );

  // The assertion that would have caught "spawned as our own descendant"
  // immediately: loudness alone doesn't prove the mixer captured this PID,
  // presence in mixState().clients does.
  const attachedPhase2Ok = check(
    `phase 2: allowed pid ${allowedPidPhase2} attached to mixer`,
    allowedAttachedPhase2,
    "allowed source was never attached - is it a descendant of this process?"
  );

  const audibleOk = check(
    `phase 2 audible: rms ${results.allowedOnly.rmsDbfs.toFixed(1)} dBFS > phase3 + 15 (${(
      results.blockedOnly.rmsDbfs + 15
    ).toFixed(1)}), peak ${results.allowedOnly.peak} > 4000`,
    results.allowedOnly.rmsDbfs > results.blockedOnly.rmsDbfs + 15 && results.allowedOnly.peak > 4000
  );

  const silentOk = check(
    `phase 3 silent: rms ${results.blockedOnly.rmsDbfs.toFixed(1)} dBFS < phase2 - 15 (${(
      results.allowedOnly.rmsDbfs - 15
    ).toFixed(1)})`,
    results.blockedOnly.rmsDbfs < results.allowedOnly.rmsDbfs - 15
  );

  const blockedNotAttachedPhase3Ok = check("phase 3: blocked pid NOT in mixer clients", !blockedAttachedPhase3);

  const attachedPhase4Ok = check(
    "phase 4: allowed pid attached AND blocked pid absent from mixer clients",
    allowedAttachedPhase4 && !blockedAttachedPhase4,
    !allowedAttachedPhase4
      ? "allowed source was never (re)attached in phase 4"
      : "blocked source is present in phase 4's mixer clients"
  );

  const phase4AudibleOk = check(
    `phase 4 audible again: rms ${results.both.rmsDbfs.toFixed(1)} dBFS > phase3 + 15 (${(
      results.blockedOnly.rmsDbfs + 15
    ).toFixed(1)})`,
    results.both.rmsDbfs > results.blockedOnly.rmsDbfs + 15
  );

  const noDuckOk = check(
    `phase 4 within +-6dB of phase 2: ${results.both.rmsDbfs.toFixed(1)} vs ${results.allowedOnly.rmsDbfs.toFixed(1)}`,
    Math.abs(results.both.rmsDbfs - results.allowedOnly.rmsDbfs) <= 6
  );

  console.log("");
  console.log("wav files written:");
  wavPaths.forEach((p) => console.log("  ", p));
  console.log("");
  console.log("Listen to phase3.wav: it should be silent even though the alarm");
  console.log("was audibly playing out of the speakers for the whole clip. That");
  console.log("silence - not this printout - is the real proof.");
  console.log("");

  // --- exit code, in test-capture.js's style --------------------------------
  // Grouped by failure class: "the permitted source never got captured at
  // all" (3) vs. "the blocked source leaked, or blocklist handling ducked
  // the permitted source" (4) - the latter is the failure that matters.
  const mixerNeverAttached = !attachedPhase2Ok || !audibleOk || !attachedPhase4Ok || !phase4AudibleOk;
  const blockedLeaked = !silentOk || !blockedNotAttachedPhase3Ok || !noDuckOk;

  if (!chunksOk) {
    console.log("RESULT: FAIL - no audio delivered at all (heartbeat missing in some phase)");
    cleanup(2);
  } else if (mixerNeverAttached) {
    console.log("RESULT: FAIL - mixer never attached a client (allowed source stayed uncaptured)");
    cleanup(3);
  } else if (blockedLeaked) {
    console.log("RESULT: FAIL - blocked source leaked into the mix");
    cleanup(4);
  } else {
    console.log("RESULT: PASS - blocklist holds across all four phases");
    cleanup(0);
  }
})().catch((err) => {
  console.error("test-exclude.js crashed:", err);
  cleanup(2);
});
