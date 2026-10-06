"use strict";
// Load through the installed Electron ABI, without a window/profile/account.
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
if (process.argv[2] !== "--child") {
  const result = spawnSync(require("electron"), [__filename, "--child"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true,
    timeout: 15000,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
assert.equal(process.platform, "win32");
assert.ok(process.versions.electron);
const root = path.join(__dirname, "wgc-probe/build/Release");
const reference = require(path.join(root, "wgc_production_reference.node"));
const probe = require(path.join(root, "wgc_acquisition_probe.node"));
assert.equal(reference.setDiagnosticStage, undefined);
assert.equal(reference.setDiagnosticMinInterval, undefined);
assert.equal(reference.diagnostics().diagnosticStage, undefined);
assert.deepEqual(
  Object.keys(probe)
    .filter(
      (key) =>
        !["setDiagnosticStage", "setDiagnosticMinInterval"].includes(key),
    )
    .sort(),
  Object.keys(reference).sort(),
);
for (const stage of [null, undefined, 1, {}, "unknown", "production"])
  assert.equal(probe.setDiagnosticStage(stage), false);
for (const stage of ["acquire", "full"]) {
  assert.equal(probe.setDiagnosticStage(stage), true);
  assert.equal(probe.diagnostics().diagnosticStage, stage);
}
for (const interval of [null, undefined, 1, {}, "unknown"])
  assert.equal(probe.setDiagnosticMinInterval(interval), false);
for (const interval of ["default", "zero"])
  assert.equal(probe.setDiagnosticMinInterval(interval), true);
console.log("Private/default native exports and diagnostic stage guards pass.");
