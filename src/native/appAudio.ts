/* eslint-disable @typescript-eslint/no-explicit-any */
// Windows per-application audio for screen sharing.
//
// Electron's `audio: "loopback"` can only ever give us the entire system mix,
// so sharing a single window still leaks every other app's sound. Windows can
// produce a private submix for one process tree, so when the user picks a
// window we capture only that window's process and hand the PCM to the
// renderer, which turns it back into a MediaStreamTrack.
//
// Whole-screen shares get the mirror-image treatment: there is no single
// process to include, so we enumerate every process currently rendering
// audio and start one include-mode client per process that is neither
// blocklisted (see VOICE_APP_BLOCKLIST below) nor part of our own process
// tree, then mix them in native code into the same PCM chunk stream. This is
// the fix for the bug this file used to encode: capturing "system audio minus
// our own tree" put Discord -- and every other voice app -- straight into
// the mix, so the far end of a screen share heard the call it was already on,
// including its own voice coming back delayed.
//
// Everything here degrades quietly: if the native module is missing, the OS
// is too old, or activation fails, we report failure and the caller decides
// what to do. For *either* mode that means sharing video with no audio at
// all -- it must never widen to Chromium's `"loopback"`, which is the whole
// system mix including the voice call. See window.ts's respondToDisplayMedia
// and the `--allow-system-audio-mix` escape hatch that fallback now lives
// behind.
import { appendFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";

import { BrowserWindow, app, ipcMain, shell } from "electron";

export const APP_AUDIO_CHUNK = "appAudio:chunk";
export const APP_AUDIO_STATE = "appAudio:state";

/**
 * Voice/chat apps whose audio must never enter a whole-screen share's system
 * mix.
 *
 * The machine sharing its screen is, in the overwhelming common case, also
 * on the call being blocked here: missing one of these rebroadcasts a
 * private conversation back to the people on it, including their own voice
 * returning delayed. That failure mode -- leaking, silently -- is strictly
 * worse than the app simply being silent in the mix (a viewer says "I can't
 * hear it" and the log says why). That asymmetry is why this is a fixed
 * default with no UI: a setting nobody finds is a setting that is off when
 * it matters, and getting this list wrong is a privacy incident, not an
 * inconvenience.
 *
 * Matched case-insensitively against the lowercase exe basename, never a
 * PID: the offending process (someone starting a Discord call mid-share, say)
 * may not exist yet when the share begins, so there is no PID to exclude at
 * that point -- only a name to watch for on every rescan.
 *
 * Deliberately does NOT include Voicemeeter or any other virtual-audio-cable
 * software; that was an explicit decision, not an oversight, and is not
 * revisited here.
 */
export const VOICE_APP_BLOCKLIST = [
  "discord.exe",
  "discordptb.exe",
  "discordcanary.exe",
  "discorddevelopment.exe",
  "vesktop.exe",
  "armcord.exe",
  "slack.exe",
  "teams.exe",
  "ms-teams.exe",
  "zoom.exe",
  "cpthost.exe",
];

// A packaged Electron app on Windows has no console attached, so anything we
// print is lost. Diagnostics go to a file the user can actually find.
let logPath: string | null = null;

export function appAudioLogPath() {
  if (logPath) return logPath;
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, "app-audio.log");
  } catch {
    logPath = null;
  }
  return logPath;
}

export function log(...parts: unknown[]) {
  const line =
    new Date().toISOString() +
    " " +
    parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  console.log("[appAudio]", line);
  const file = appAudioLogPath();
  if (!file) return;
  try {
    // Keep it small; this is a diagnostic aid, not an audit trail.
    try {
      if (statSync(file).size > 512 * 1024) unlinkSync(file);
    } catch {
      /* first run */
    }
    appendFileSync(file, line + "\n", "utf8");
  } catch {
    /* logging must never break screen sharing */
  }
}

type NativeModule = typeof import("win-app-audio");
// Derived from NativeModule rather than imported directly: the module is
// declared with `export =`, and going through the same type alias already
// used for `native` below sidesteps any doubt about named type exports
// alongside `export =` resolving the way we expect.
type AudioProcess = ReturnType<NativeModule["listAudioProcesses"]>[number];
type MixReport = ReturnType<NativeModule["startSystemExcluding"]>;
type MixState = ReturnType<NativeModule["mixState"]>;

let native: NativeModule | null = null;
let nativeLoadError: string | null = null;

function loadNative(): NativeModule | null {
  if (native || nativeLoadError) return native;
  if (process.platform !== "win32") {
    nativeLoadError = "not windows";
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    native = require("win-app-audio") as NativeModule;
  } catch (err) {
    nativeLoadError = String((err as Error)?.message ?? err);
    log("native module unavailable:", nativeLoadError);
  }
  return native;
}

/** One process's audio, formatted for a log line. */
function describeProcess(p: AudioProcess): string {
  return p.name ? `${p.name}(${p.pid})` : `pid:${p.pid}`;
}

/** Capture state for the session currently being shared, if any. */
let active: {
  sourceId: string;
  mode: "include" | "system";
  /** 0 in system mode: there is no single owning process. */
  pid: number;
  /**
   * When *this attempt* began. Reset on every watchdog restart -- used only
   * for the system path's healthy-session failure-count reset, mirroring
   * screenCapture.ts's HEALTHY_SESSION_MS.
   */
  attemptStartedAt: number;
} | null = null;

/**
 * System-mix bookkeeping that spans the whole share, i.e. survives the
 * watchdog's in-place restarts -- unlike `active`, which is replaced on every
 * (re)start. Created when a system capture first begins, cleared by stop().
 */
let systemSession: {
  startedAt: number;
  bytes: number;
  restarts: number;
} | null = null;

/** Last known count of processes actually contributing to the mix. */
let systemSources = 0;
/** Names blocked by the blocklist so far this session (deduped), for buildState(). */
let systemBlockedNames: string[] = [];
/** Live-client pids as of the last watchdog tick, for attached/dropped diffing. */
let knownClientPids: Set<number> = new Set();
/** Pids we've already logged a "refused" line for, until they stop trying. */
let refusedPidsLogged: Set<number> = new Set();

/**
 * The mixer emits a chunk on a fixed ~10ms cadence, even with zero live
 * clients (a silence heartbeat, verified on this machine) -- so no chunks at
 * all, for anything meaningfully longer than that cadence, is an unambiguous
 * death signal, never a legitimately silent machine. Generous relative to
 * 10ms to absorb scheduler jitter under load.
 */
const SYSTEM_STALL_MS = 1500;
/**
 * How often the watchdog checks for a stall and diffs mixer membership.
 * Matches the native mixer's own rescan cadence, so a membership check never
 * fires between two rescans for no reason.
 */
const SYSTEM_WATCHDOG_POLL_MS = 2000;
/**
 * A session that has been delivering chunks this long is working, whatever
 * happened before it, so it clears the failure count. Mirrors
 * screenCapture.ts's HEALTHY_SESSION_MS.
 */
const SYSTEM_HEALTHY_MS = 10_000;
/**
 * Consecutive stall-and-restart cycles before we give up on mixed capture for
 * the rest of this share. One higher than screenCapture.ts's
 * MAX_NATIVE_FAILURES (2): there, giving up falls back to a *slower* capture
 * path and the share survives untouched. Here, giving up means the share goes
 * back to silence -- never to Chromium's raw loopback, see the file header --
 * so we should be slower to accept that outcome. Scoped to the system path
 * only: a broken mixer says nothing about single-process (include) capture.
 */
const MAX_SYSTEM_FAILURES = 3;

let consecutiveSystemFailures = 0;
let lastSystemChunkAt = 0;
let systemWatchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * desktopCapturer window ids look like `window:<hwnd>:<n>`, where the middle
 * field is the native window handle. Screens use `screen:<id>:<n>` and have no
 * owning process, so they always fall back to the system mix.
 */
export function windowHandleFromSourceId(sourceId: string): string | null {
  const parts = sourceId.split(":");
  if (parts[0] !== "window" || parts.length < 2) return null;
  return parts[1] || null;
}

/**
 * The process owning a desktopCapturer window source, or 0 when it has none
 * (a screen source) or the native module is unavailable.
 */
export function pidForSourceId(sourceId: string): number {
  const mod = loadNative();
  const handle = windowHandleFromSourceId(sourceId);
  if (!mod || !handle) return 0;
  try {
    return mod.pidFromWindowHandle(handle);
  } catch {
    return 0;
  }
}

/**
 * Whether a window source still names a window we could capture. Windows
 * Graphics Capture refuses minimised windows, so re-acquiring a share has to
 * wait for the user to restore the application. Null means "cannot tell".
 */
export function windowStateForSourceId(
  sourceId: string,
): { exists: boolean; visible: boolean; iconic: boolean } | null {
  const mod = loadNative();
  const handle = windowHandleFromSourceId(sourceId);
  if (!mod || !handle) return null;
  try {
    return mod.windowState(handle);
  } catch {
    return null;
  }
}

type CapturePlan = { mode: "include"; pid: number } | { mode: "system" };

/** Stops whatever native capture is running, without touching our own
 *  bookkeeping. Used both by the public stop() and by beginCapture itself
 *  before starting anew (a plain restart, or switching modes). */
function stopNative() {
  const mod = loadNative();
  try {
    mod?.stop();
  } catch {
    /* nothing to do */
  }
}

/**
 * Begin capture in one of two modes:
 *   include - only the shared application's process tree (window shares)
 *   system  - every audible process except VOICE_APP_BLOCKLIST and our own
 *             tree, mixed together (whole-screen shares)
 *
 * Generalised over both so the stop()/try-catch/active/broadcastState()
 * bookkeeping lives in exactly one place. The include path's behaviour and
 * log wording are unchanged from before this generalisation, so old logs
 * still grep.
 */
function beginCapture(plan: CapturePlan, sourceId: string): boolean {
  const mod = loadNative();
  if (!mod) return false;

  // Unconditionally, not `if (active)`. Native stop() is a no-op when nothing
  // is capturing, so this is free in the common case -- and `active` is not a
  // trustworthy proxy for "native is idle": stopNative() swallows a failing
  // mod.stop(), so a capture can survive an exported stop() that already
  // cleared `active`. Skipping the call there would leave the addon running,
  // every later start throwing "capture already running", and screen-share
  // audio dead for the rest of the session.
  stopNative();

  if (plan.mode === "include") {
    try {
      mod.start(plan.pid, true, (chunk: Buffer) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) return;
        win.webContents.send(APP_AUDIO_CHUNK, chunk);
      });
    } catch (err) {
      log(
        `capture failed to start (include ${plan.pid}):`,
        String(err),
        "lastError:",
        mod.lastError(),
      );
      return false;
    }

    active = {
      sourceId,
      mode: "include",
      pid: plan.pid,
      attemptStartedAt: Date.now(),
    };
    log(`capturing include pid ${plan.pid} for ${sourceId}`);
    broadcastState();
    return true;
  }

  // system mode
  let report: MixReport;
  try {
    report = mod.startSystemExcluding(VOICE_APP_BLOCKLIST, onSystemChunk);
  } catch (err) {
    log(
      "capture failed to start (system mix):",
      String(err),
      "lastError:",
      mod.lastError(),
    );
    return false;
  }

  active = { sourceId, mode: "system", pid: 0, attemptStartedAt: Date.now() };
  // Only a genuinely new share (systemSession still null, because stop()
  // cleared it) resets the failure budget and the running totals -- an
  // in-place watchdog restart must preserve both, or the receipt in stop()
  // would only ever describe the last attempt.
  if (!systemSession) {
    systemSession = { startedAt: Date.now(), bytes: 0, restarts: 0 };
    consecutiveSystemFailures = 0;
  }
  systemSources = report.started.length;
  for (const p of report.blocked) {
    if (p.reason !== "blocklist") continue;
    const label = p.name || `pid:${p.pid}`;
    if (!systemBlockedNames.includes(label)) systemBlockedNames.push(label);
  }
  knownClientPids = new Set(report.started.map((p) => p.pid));
  refusedPidsLogged.clear();
  logMixReport(report);
  startSystemWatchdog();
  broadcastState();
  return true;
}

function logMixReport(report: MixReport) {
  log("enumerated:", report.enumerated.map(describeProcess));
  log(
    "blocked:",
    report.blocked.map((p) => `${describeProcess(p)} [${p.reason}]`),
  );
  log("started:", report.started.map(describeProcess));
  log(`capturing ${report.started.length} of ${report.enumerated.length}`);
  if (report.failed.length > 0) {
    log(
      "failed:",
      report.failed.map((p) => `${describeProcess(p)}: ${p.error}`),
    );
  }
}

function onSystemChunk(chunk: Buffer) {
  if (!active || active.mode !== "system") return;
  lastSystemChunkAt = Date.now();
  if (systemSession) systemSession.bytes += chunk.length;

  // A session that has been healthy for a while clears whatever failed
  // before it, so one transient hiccup can't spend down the whole budget.
  if (
    consecutiveSystemFailures > 0 &&
    Date.now() - active.attemptStartedAt > SYSTEM_HEALTHY_MS
  ) {
    log("system mix: healthy again, clearing failure count");
    consecutiveSystemFailures = 0;
  }

  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  win.webContents.send(APP_AUDIO_CHUNK, chunk);
}

function startSystemWatchdog() {
  stopSystemWatchdog();
  lastSystemChunkAt = Date.now();
  systemWatchdogTimer = setInterval(() => {
    try {
      tickSystemWatchdog();
    } catch (err) {
      // A watchdog is only useful if it cannot itself crash the process.
      log("system mix watchdog: unexpected error, ignoring:", String(err));
    }
  }, SYSTEM_WATCHDOG_POLL_MS);
}

function stopSystemWatchdog() {
  if (systemWatchdogTimer) clearInterval(systemWatchdogTimer);
  systemWatchdogTimer = null;
}

function tickSystemWatchdog() {
  if (!active || active.mode !== "system") return;

  if (Date.now() - lastSystemChunkAt > SYSTEM_STALL_MS) {
    handleSystemStall();
    return;
  }

  checkSystemMembership();
}

/**
 * A stall first gets one in-place stop() + startSystemExcluding() restart:
 * chunks are just IPC into a live AudioWorklet, so there is no track to
 * renegotiate and no share-recovery budget to spend. Only if the restart
 * also stalls -- or fails to start at all -- do we give up.
 */
function handleSystemStall() {
  if (!active || active.mode !== "system") return;
  const sourceId = active.sourceId;
  consecutiveSystemFailures++;
  log(
    `system mix stalled: no chunks for over ${SYSTEM_STALL_MS}ms (failure ${consecutiveSystemFailures}/${MAX_SYSTEM_FAILURES})`,
  );

  if (consecutiveSystemFailures > MAX_SYSTEM_FAILURES) {
    log(
      "system mix: giving up after repeated stalls - sharing continues with no audio rather than falling back to the raw system mix",
    );
    stop();
    return;
  }

  log("system mix: attempting an in-place restart");
  if (systemSession) systemSession.restarts++;
  const restarted = beginCapture({ mode: "system" }, sourceId);
  if (!restarted) {
    log("system mix: restart failed to start at all, giving up");
    stop();
  }
}

/**
 * Diff mixState().clients against what we saw last tick (attached/dropped),
 * and separately diff listAudioProcesses() against the blocklist to catch
 * apps that are audible right now but never made it into the mix (refused) --
 * mixState() only reports what IS mixed, not what was turned away.
 */
function checkSystemMembership() {
  if (!active || active.mode !== "system") return;
  const mod = loadNative();
  if (!mod) return;

  let state: MixState;
  try {
    state = mod.mixState();
  } catch (err) {
    log("system mix: mixState() failed, skipping this tick:", String(err));
    return;
  }

  const currentPids = new Set(state.clients.map((c) => c.pid));
  for (const client of state.clients) {
    if (!knownClientPids.has(client.pid)) {
      log(`attached ${describeProcess(client)}`);
    }
  }
  for (const pid of knownClientPids) {
    if (!currentPids.has(pid)) {
      log(`dropped pid:${pid}`);
    }
  }
  knownClientPids = currentPids;
  systemSources = state.clients.length;

  let audible: AudioProcess[];
  try {
    audible = mod.listAudioProcesses();
  } catch (err) {
    log(
      "system mix: listAudioProcesses() failed, skipping refusal check:",
      String(err),
    );
    return;
  }

  const stillAudible = new Set<number>();
  for (const proc of audible) {
    stillAudible.add(proc.pid);
    if (!VOICE_APP_BLOCKLIST.includes(proc.name.toLowerCase())) continue;
    if (currentPids.has(proc.pid)) continue;
    if (refusedPidsLogged.has(proc.pid)) continue;
    refusedPidsLogged.add(proc.pid);
    log(`refused ${describeProcess(proc)} [blocklist]`);
    const label = proc.name || `pid:${proc.pid}`;
    if (!systemBlockedNames.includes(label)) systemBlockedNames.push(label);
  }
  // A pid that's no longer even audible gets a fresh "refused" line if it
  // comes back later, instead of being rate-limited forever.
  for (const pid of refusedPidsLogged) {
    if (!stillAudible.has(pid)) refusedPidsLogged.delete(pid);
  }
}

/**
 * Try to start per-application capture for a desktopCapturer source.
 * Returns true only when audio is actually flowing from that process.
 */
export function startForSource(sourceId: string): boolean {
  const mod = loadNative();
  if (!mod) {
    log("no per-app capture: native module not loaded:", nativeLoadError);
    return false;
  }
  if (!mod.isSupported()) {
    log("no per-app capture: OS reports process loopback unsupported");
    return false;
  }

  const handle = windowHandleFromSourceId(sourceId);

  // Whole-screen share: there is no single app to capture, so mix every
  // audible process except the blocklist and our own tree instead of the
  // system-minus-self capture this used to be (see the file header).
  if (!handle) {
    log(
      "whole-screen share: mixing every audible process except the blocklist",
    );
    return beginCapture({ mode: "system" }, sourceId);
  }

  // A window share must never be widened to the system mix: that is how the
  // voice call, and every other app, ended up inside people's window shares.
  // If we cannot capture just this application, the caller shares video only.
  const pid = mod.pidFromWindowHandle(handle);
  if (!pid) {
    log(
      "window share: no process behind window",
      handle,
      "- no audio for this share",
    );
    return false;
  }

  // Include the process *tree*: browsers and Electron apps render audio from
  // a child process, so targeting the visible window's pid alone is silent.
  if (!beginCapture({ mode: "include", pid }, sourceId)) {
    log(
      `window share: include capture failed for pid ${pid} - no audio for this share`,
    );
    return false;
  }

  return true;
}

export function stop() {
  stopSystemWatchdog();
  if (!active) return;
  stopNative();

  if (active.mode === "system" && systemSession) {
    const durationS = ((Date.now() - systemSession.startedAt) / 1000).toFixed(
      1,
    );
    log(
      `system mix receipt for ${active.sourceId}: ${durationS}s, ${systemSession.bytes} bytes, ${systemSources} source(s), ${systemSession.restarts} restart(s)`,
    );
  }
  // The include wording is preserved verbatim from before this module grew a
  // second mode, so old logs and any habit of grepping for it still work.
  // System mode gets its own phrasing rather than reusing it: there is no one
  // pid behind a system mix, and "stopped capturing system pid 0" reads like
  // a bug report about pid 0 rather than a normal end-of-share line.
  if (active.mode === "system") {
    log(`stopped capturing the system mix for ${active.sourceId}`);
  } else {
    log(`stopped capturing ${active.mode} pid ${active.pid}`);
  }

  active = null;
  systemSession = null;
  systemSources = 0;
  systemBlockedNames = [];
  knownClientPids = new Set();
  refusedPidsLogged = new Set();
  broadcastState();
}

function broadcastState() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(APP_AUDIO_STATE, buildState());
    }
  }
}

function buildState() {
  const mod = loadNative();
  return {
    active: active !== null,
    pid: active?.pid ?? 0,
    // "include" = just the shared app, "system" = every audible process
    // except the blocklist and our own tree, mixed together.
    mode: active?.mode ?? null,
    supported: Boolean(mod?.isSupported()),
    sampleRate: mod?.sampleRate ?? 48000,
    channels: mod?.channels ?? 2,
    // Diagnostics only -- the injected page patch reads just `active` and
    // `sampleRate` (see appAudioPatch.ts), nothing here is load-bearing.
    sources: active?.mode === "system" ? systemSources : active ? 1 : 0,
    blocked: active?.mode === "system" ? systemBlockedNames.slice() : [],
  };
}

export function initAppAudio() {
  const mod = loadNative();
  log("--- session start ---");
  log("app version:", app.getVersion());
  log("platform:", process.platform, "os release:", release());
  log(
    "native module loaded:",
    Boolean(mod),
    nativeLoadError ? `(${nativeLoadError})` : "",
  );
  log("per-process capture supported:", Boolean(mod?.isSupported()));
  log("voice-app blocklist:", VOICE_APP_BLOCKLIST);
  if (mod) {
    try {
      log("audible processes at startup:", mod.listAudioProcesses());
    } catch (err) {
      log("could not enumerate audible processes at startup:", String(err));
    }
  }
  log("log file:", appAudioLogPath() ?? "(unavailable)");

  ipcMain.handle("appAudio:getLogPath", () => appAudioLogPath());
  ipcMain.on("appAudio:openLogs", () => {
    const file = appAudioLogPath();
    if (file) shell.showItemInFolder(file);
  });

  // The renderer asks for this right after getDisplayMedia resolves, so it can
  // decide whether to swap in our track. Answering from the main process avoids
  // any race with the IPC notification.
  ipcMain.handle("appAudio:getState", () => buildState());
  ipcMain.on("appAudio:stop", () => stop());
}
