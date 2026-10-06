"use strict";
const { options } = require("./options.cjs");

function nativeOptions(args) {
  for (const arg of args)
    if (
      arg !== "--help" &&
      arg !== "--trace" &&
      !/^--(fps|seconds|warmup|output)=/.test(arg)
    )
      throw new Error("Unknown native diagnostic option: " + arg);
  const parsed = options(args);
  return {
    fps: parsed.fps,
    sourceFps: 60,
    width: parsed.width,
    height: parsed.height,
    seconds: parsed.seconds,
    warmup: parsed.warmup,
    output: parsed.output,
    help: parsed.help ?? false,
    backend: "wgc",
    trace: parsed.trace,
  };
}

function distribution(values) {
  const ordered = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const quantile = (fraction) =>
    ordered.length ? ordered[Math.ceil(ordered.length * fraction) - 1] : null;
  return {
    count: ordered.length,
    meanMs: ordered.length
      ? ordered.reduce((sum, value) => sum + value, 0) / ordered.length
      : null,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: ordered.at(-1) ?? null,
  };
}

// Read only 20 luma pixels from our own marker, never save captured media.
// Four fixed sentinel cells protect against a wrong surface/crop/color range.
function decodeMarker(bytes, width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 40 ||
    height < 48 ||
    bytes.length !== width * height * 1.5
  )
    return null;
  const y = Math.floor(height / 48);
  let marker = 0;
  for (let cell = 0; cell < 20; cell++) {
    const luma = bytes[y * width + Math.floor(((cell + 0.5) * width) / 20)];
    const bit = luma <= 80 ? 0 : luma >= 180 ? 1 : null;
    if (bit === null || (cell < 4 && bit !== cell % 2)) return null;
    if (cell >= 4) marker |= bit << (cell - 4);
  }
  return marker;
}

function markerTracker() {
  let previous = null;
  const result = {
    validFrames: 0,
    invalidFrames: 0,
    distinctFrames: 0,
    repeatedFrames: 0,
    skippedSourceMarkers: 0,
    discontinuities: 0,
  };
  return {
    result,
    add(marker) {
      if (marker === null) {
        result.invalidFrames++;
        return;
      }
      result.validFrames++;
      const step =
        previous === null ? null : (marker - previous + 65536) % 65536;
      if (step === 0) result.repeatedFrames++;
      else {
        result.distinctFrames++;
        if (step > 32768) result.discontinuities++;
        else if (step !== null) result.skippedSourceMarkers += step - 1;
      }
      previous = marker;
    },
  };
}

function counterDelta(end, start, key) {
  return Number.isFinite(end?.[key]) &&
    Number.isFinite(start?.[key]) &&
    end[key] >= start[key]
    ? end[key] - start[key]
    : null;
}

function compositorTraceSummary(trace) {
  const counts = new Map();
  for (const event of trace?.traceEvents ?? []) {
    if (
      event.ph === "E" ||
      typeof event.name !== "string" ||
      !/SubmitCompositorFrame|DrawAndSwap|SwapBuffers|DidPresent|stoat-native-measurement/.test(
        event.name,
      )
    )
      continue;
    const key = JSON.stringify([event.name.slice(0, 160), event.pid, event.ph]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, events]) => {
      const [name, pid, phase] = JSON.parse(key);
      return { name, pid, phase, events };
    })
    .sort((a, b) => b.events - a.events)
    .slice(0, 40);
}

module.exports = {
  nativeOptions,
  distribution,
  decodeMarker,
  markerTracker,
  counterDelta,
  compositorTraceSummary,
};
