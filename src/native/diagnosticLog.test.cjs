const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const code = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "diagnosticLog.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;
const m = { exports: {} };
new Function("require", "module", "exports", code)(require, m, m.exports);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stoat-log-rotation-"));
const file = path.join(temp, "capture.log");
try {
  for (let i = 0; i < 7; i++) {
    const data = `session-${i}\n`;
    m.exports.rotateDiagnosticLog(file, Buffer.byteLength(data), 12, 4);
    fs.appendFileSync(file, data);
  }
  assert.equal(fs.readFileSync(file, "utf8"), "session-6\n");
  for (let i = 1; i <= 4; i++)
    assert.equal(fs.readFileSync(`${file}.${i}`, "utf8"), `session-${6 - i}\n`);
  assert(!fs.existsSync(`${file}.5`));
  console.log("LOG ROTATION PASS: ordered complete archives, bounded history");
} finally {
  // Only remove files created by this test, inside its own verified temp dir.
  for (const name of fs.readdirSync(temp)) fs.unlinkSync(path.join(temp, name));
  fs.rmdirSync(temp);
}
