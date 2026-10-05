"use strict";
const path = require("node:path");
function options(args) {
  const result = {
    mode: "generator",
    profile: "cbp",
    fps: 60,
    seconds: 12,
    warmup: 3,
    width: 1280,
    height: 720,
    bitrate: 6_000_000,
    software: false,
    trace: false,
  };
  for (const arg of args) {
    if (arg === "--software" || arg === "--trace" || arg === "--help") {
      result[arg.slice(2)] = true;
      continue;
    }
    const match = /^--(mode|profile|fps|seconds|warmup|output)=(.+)$/.exec(arg);
    if (!match) throw new Error("Unknown diagnostic option: " + arg);
    const [, key, value] = match;
    result[key] = ["fps", "seconds", "warmup"].includes(key)
      ? Number(value)
      : value;
  }
  if (!["generator", "canvas"].includes(result.mode))
    throw new Error("mode must be generator or canvas");
  if (!["cbp", "baseline", "main", "high"].includes(result.profile))
    throw new Error("profile must be cbp, baseline, main or high");
  if (![30, 60].includes(result.fps)) throw new Error("fps must be 30 or 60");
  if (
    !Number.isInteger(result.seconds) ||
    result.seconds < 5 ||
    result.seconds > 60
  )
    throw new Error("seconds must be 5..60");
  if (
    !Number.isInteger(result.warmup) ||
    result.warmup < 2 ||
    result.warmup > 10
  )
    throw new Error("warmup must be 2..10");
  if (result.output) result.output = path.resolve(result.output);
  return result;
}
function gpuSummary(info, features) {
  const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
  return {
    videoEncodeAvailability: features?.video_encode ?? null,
    videoDecodeAvailability: features?.video_decode ?? null,
    compositingAvailability: features?.gpu_compositing ?? null,
    devices: devices.slice(0, 8).map((value) => ({
      vendorId: Number.isFinite(value.vendorId) ? value.vendorId : null,
      deviceId: Number.isFinite(value.deviceId) ? value.deviceId : null,
      active: typeof value.active === "boolean" ? value.active : null,
      name:
        typeof value.deviceString === "string"
          ? value.deviceString.slice(0, 120)
          : null,
      driverVersion:
        typeof value.driverVersion === "string"
          ? value.driverVersion.slice(0, 80)
          : null,
    })),
    note: "Availability is not evidence that a particular stream used a hardware encoder.",
  };
}
function traceSummary(trace) {
  const counts = new Map();
  for (const event of trace?.traceEvents ?? []) {
    if (
      typeof event.name !== "string" ||
      !/VideoEncodeAccelerator|RTCVideoEncoder|VideoEncoder|EncodeOneFrame|EncoderImpl/.test(
        event.name,
      )
    )
      continue;
    const name = event.name.slice(0, 160);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, events]) => ({ name, events }))
    .sort((a, b) => b.events - a.events)
    .slice(0, 40);
}
function encoderLogSummary(text) {
  const rows = text
    .split(/\r?\n/)
    .filter((line) =>
      /media_foundation_video_encode_accelerator_win\.cc|rtc_video_encoder\.cc|video_encoder_software_fallback_wrapper\.cc/.test(
        line,
      ),
    );
  const hardwareFailures = rows.filter((line) =>
    /Hardware encoder initialization failed/.test(line),
  );
  const fallbacks = rows.filter((line) => /InitFallbackEncoder\(/.test(line));
  const outputFailures = rows.filter((line) =>
    /Couldn't set output media type/.test(line),
  );
  return {
    hardwareInitializationFailures: hardwareFailures.length,
    softwareFallbackInitializations: fallbacks.length,
    softwareFallbackObserved: fallbacks.length > 0,
    outputMediaTypeFailures: outputFailures.length,
    outputMediaTypeErrorCodes: [
      ...new Set(
        outputFailures.flatMap((line) => line.match(/0x[0-9A-Fa-f]{8}/g) ?? []),
      ),
    ],
    note: "Explicit fallback log markers describe this helper run; they do not identify a live Stoat publication's encoder.",
  };
}
module.exports = { options, gpuSummary, traceSummary, encoderLogSummary };
