const assert = require("node:assert/strict");
const { app, screen } = require("electron");
const capture = require("win-capture");
app
  .whenReady()
  .then(async () => {
    for (const display of screen.getAllDisplays()) {
      const point = screen.dipToScreenPoint({
        x: Math.round(display.bounds.x + display.bounds.width / 2),
        y: Math.round(display.bounds.y + display.bounds.height / 2),
      });
      let frames = 0;
      capture.start(
        "0",
        1280,
        720,
        30,
        (frame) => {
          if (frame) frames++;
        },
        point,
      );
      assert.equal(capture.diagnostics().processFailures, 0);
      await new Promise((r) => setTimeout(r, 2000));
      const first = capture.diagnostics();
      assert(first.incomingFrames > 0);
      assert(first.processAttempts > 0);
      // A static monitor may not fill the staging ring. Diagnostics must still
      // remain readable when no pixel callback has been delivered.
      assert.equal(first.processFailures, 0);
      assert.equal(first.surfaceFailures, 0);
      await new Promise((r) => setTimeout(r, 1000));
      const later = capture.diagnostics();
      assert(later.incomingFrames >= first.incomingFrames);
      console.log(
        JSON.stringify({ displayId: display.id, frames, diagnostics: later }),
      );
      await capture.stop();
      assert.equal(capture.diagnostics().running, false);
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
