const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "appAudio.ts"), "utf8");
const prefix = source.slice(0, source.indexOf("/**\n * Caps how often"));
const code = ts.transpileModule(prefix, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const sync = [],
  async = [];
const dependencies = {
  "node:fs": {
    mkdirSync: () => {},
    appendFileSync: (_, data) => sync.push(data),
  },
  "node:fs/promises": {
    appendFile: (_, data) => {
      async.push(data);
      return Promise.resolve();
    },
  },
  "node:os": require("node:os"),
  "node:path": path,
  electron: { app: { getPath: () => "test-user-data" } },
  "./diagnosticLog": { rotateDiagnosticLog: () => {} },
};
const moduleUnderTest = { exports: {} };
new Function("require", "module", "exports", "console", code)(
  (name) => {
    assert(name in dependencies, name);
    return dependencies[name];
  },
  moduleUnderTest,
  moduleUnderTest.exports,
  { log: () => {} },
);
const logger = moduleUnderTest.exports;
(async () => {
  for (const marker of ["batch-one", "batch-two", "batch-three"])
    logger.log(marker + " " + "x".repeat(65536));
  logger.log("tail-at-quit");
  logger.flushAppAudioLogSync(); // no async callback has run yet
  assert.equal(sync.length, 4);
  for (const [index, marker] of [
    "batch-one",
    "batch-two",
    "batch-three",
    "tail-at-quit",
  ].entries())
    assert(sync[index].includes(marker));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    async.length,
    0,
    "queued appends must skip batches already flushed at quit",
  );
  logger.log("normal-async-batch " + "x".repeat(65536));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(async.length, 1);
  logger.flushAppAudioLogSync();
  assert.equal(sync.length, 4, "settled batches must not be replayed");
  console.log("LOG QUIT TAIL PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
