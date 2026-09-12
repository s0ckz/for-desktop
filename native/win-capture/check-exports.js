#!/usr/bin/env node
// Catches exactly the bug that shipped 1.7.3/1.7.5's `i.setTarget is not a
// function` main-process crash: index.js hand-forwards each addon method by
// name, so a method declared in index.d.ts (or newly exported by the
// compiled addon) that nobody added to index.js's module.exports/`unavailable`
// is invisible to the app until a user's IPC call throws. test-capture.js
// (the dev harness) DOES go through index.js -- it requires "./index.js",
// not the addon directly -- but it only calls isSupported/start/stop/
// lastError/setTarget (added after this bug), so it still would not have
// caught a gap in a method it never happens to call. This is the only check
// that verifies the full set.
"use strict";

const fs = require("fs");
const path = require("path");

const dir = __dirname;
const wrapper = require(path.join(dir, "index.js"));

// Parse the module-level method names straight out of index.d.ts rather than
// maintaining a second hand-written list that could itself drift.
const dtsSource = fs.readFileSync(path.join(dir, "index.d.ts"), "utf8");
const declared = new Set();
for (const line of dtsSource.split("\n")) {
  const m = /^\s{2}(\w+)\(/.exec(line);
  if (m) declared.add(m[1]);
}

// A silent vacuous pass is worse than no check at all: if index.d.ts is ever
// re-indented, or a method declared property-style instead of method-style,
// this regex stops matching anything and the loop above leaves `declared`
// empty -- every check below trivially "passes" with nothing to check, and
// this script prints success while checking nothing.
if (declared.size === 0) {
  console.error(
    "check-exports: parsed no methods from index.d.ts -- regex no longer matches its layout",
  );
  process.exit(1);
}

const missingFromWrapper = [...declared].filter(
  (name) => typeof wrapper[name] !== "function",
);

// index.js builds its `unavailable` fallback from a METHODS array so that
// object can't drift from index.d.ts by hand (see index.js's own comment).
// That only holds if METHODS itself hasn't drifted -- assert it here too,
// against the same independently-parsed `declared` set.
const wrapperMethods = new Set(wrapper.METHODS || []);
const declaredNotInMethods = [...declared].filter(
  (name) => !wrapperMethods.has(name),
);
const methodsNotDeclared = [...wrapperMethods].filter(
  (name) => !declared.has(name),
);

let missingFromWrapperForBinary = [];
const binaryPath = path.join(dir, "build", "Release", "win_capture.node");
if (fs.existsSync(binaryPath)) {
  let binary;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    binary = require(binaryPath);
  } catch (err) {
    // Cannot fail today (no ABI pinning, this always runs on a freshly built
    // binary on the same Node/Electron ABI) -- but a raw ERR_DLOPEN_FAILED
    // stack here would kill the release run looking like this check found a
    // real export mismatch, when it actually found nothing. Degrade to the
    // half of this check that doesn't need the binary loaded instead.
    console.log(
      `check-exports: could not load ${binaryPath} under this Node (${err.message}) -- skipping the binary-vs-wrapper half`,
    );
  }
  if (binary) {
    const binaryMethods = Object.keys(binary).filter(
      (name) => typeof binary[name] === "function",
    );
    missingFromWrapperForBinary = binaryMethods.filter(
      (name) => typeof wrapper[name] !== "function",
    );
  }
} else {
  console.log(
    "check-exports: no compiled binary at " +
      binaryPath +
      ", skipping binary-vs-wrapper check",
  );
}

const missing = [
  ...new Set([...missingFromWrapper, ...missingFromWrapperForBinary]),
];

const errors = [];
if (missing.length > 0) {
  errors.push(
    "index.js does not forward: " +
      missing.join(", ") +
      " -- add each to module.exports (and the `unavailable` stub) in native/win-capture/index.js so it mirrors index.d.ts/the compiled addon exactly.",
  );
}
if (declaredNotInMethods.length > 0) {
  errors.push(
    "index.d.ts declares methods missing from index.js's METHODS array: " +
      declaredNotInMethods.join(", "),
  );
}
if (methodsNotDeclared.length > 0) {
  errors.push(
    "index.js's METHODS array names methods index.d.ts does not declare: " +
      methodsNotDeclared.join(", "),
  );
}

if (errors.length > 0) {
  for (const err of errors) console.error("check-exports: " + err);
  process.exit(1);
}

console.log(
  "check-exports: index.js forwards every method in index.d.ts, its METHODS list matches index.d.ts" +
    (fs.existsSync(binaryPath)
      ? ", and every function the compiled addon exports is forwarded."
      : "."),
);
