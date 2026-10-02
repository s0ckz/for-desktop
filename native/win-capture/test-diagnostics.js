const assert = require("node:assert/strict");
const { app, screen } = require("electron");
const capture = require("win-capture");
app
  .whenReady()
  .then(async () => {
    for (const backend of process.argv[2]
      ? [process.argv[2]]
      : ["wgc", "duplication"]) {
      for (const display of screen.getAllDisplays()) {
        const point = screen.dipToScreenPoint({
          x: Math.round(display.bounds.x + display.bounds.width / 2),
          y: Math.round(display.bounds.y + display.bounds.height / 2),
        });
        let frames = 0,
          lastMeta;
        capture.start(
          "0",
          1280,
          720,
          30,
          (frame, meta) => {
            if (frame) {
              assert.equal(frame.length, meta.width * meta.height * 1.5);
              assert.equal(meta.width % 2, 0);
              frames++;
              lastMeta = meta;
            }
          },
          point,
          backend,
        );
        assert.equal(capture.diagnostics().processFailures, 0);
        await new Promise((r) => setTimeout(r, 2000));
        const first = capture.diagnostics();
        assert(first.incomingFrames > 0);
        assert(first.processAttempts > 0, JSON.stringify(first));
        // A single initial frame from a static monitor must drain without
        // waiting for additional source frames to prime a ring.
        assert(
          frames > 0,
          "static monitor must deliver its initial image: " +
            JSON.stringify(first),
        );
        assert.equal(first.processFailures, 0);
        assert.equal(first.surfaceFailures, 0);
        assert(first.identity.adapter.length > 0);
        assert.equal(first.identity.requestedBackend, backend);
        assert(first.timings.readbackWait.count > 0);
        assert(first.timings.frameAge.count > 0);
        if (backend === "duplication") {
          assert.equal(
            first.identity.backend,
            "duplication",
            "test monitors must support prototype",
          );
          assert.equal(first.identity.adapterMatchesMonitor, true);
        }
        assert(capture.setTarget(640, 360));
        assert(capture.setFps(60));
        await new Promise((r) => setTimeout(r, 1000));
        const later = capture.diagnostics();
        assert(later.incomingFrames >= first.incomingFrames);
        if (frames > first.emittedFrames) {
          assert(lastMeta.width <= 640 && lastMeta.height <= 360);
        }
        console.log(
          JSON.stringify({
            backend,
            displayId: display.id,
            frames,
            diagnostics: later,
          }),
        );
        await capture.stop();
        assert.equal(capture.diagnostics().running, false);
      }
    }
    assert.throws(() =>
      capture.start("0", 1280, 720, 30, () => {}, { x: 999999, y: 999999 }),
    );
    console.log("DIAGNOSTICS SMOKE PASS");
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
