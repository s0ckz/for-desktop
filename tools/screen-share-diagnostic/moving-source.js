"use strict";

window.startMovingSource = function (fps) {
  if (fps !== 60) throw new Error("Moving source requires 60 FPS");
  const canvas = document.getElementById("source");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Moving source canvas is unavailable");
  const start = performance.now();
  let callback,
    stopped = false,
    lastDue = -1,
    drawn = 0,
    skipped = 0,
    lastDrawAt = null,
    maxDrawGapMs = 0;
  function draw(now) {
    if (stopped) return;
    const due = Math.floor(((now - start) * fps) / 1000);
    if (due > lastDue) {
      skipped += Math.max(0, due - lastDue - 1);
      lastDue = due;
      if (lastDrawAt !== null)
        maxDrawGapMs = Math.max(maxDrawGapMs, now - lastDrawAt);
      lastDrawAt = now;
      context.fillStyle = "#203044";
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (let x = (drawn * 7) % 96; x < canvas.width; x += 96) {
        context.fillStyle = `rgb(${120 + (drawn % 80)}, 190, 220)`;
        context.fillRect(x, canvas.height / 24, 32, canvas.height);
      }
      // Frame marker advances on actual draws, independently of skipped deadlines.
      for (let cell = 0; cell < 20; cell++) {
        const bit = cell < 4 ? cell % 2 : (drawn >> (cell - 4)) & 1;
        context.fillStyle = bit ? "rgb(235,235,235)" : "rgb(16,16,16)";
        context.fillRect(
          (cell * canvas.width) / 20,
          0,
          canvas.width / 20,
          canvas.height / 24,
        );
      }
      context.fillStyle = "#ffffff";
      context.font = "24px sans-serif";
      context.fillText(
        "Local native capture diagnostic — closes automatically",
        30,
        100,
      );
      drawn++;
    }
    callback = requestAnimationFrame(draw);
  }
  callback = requestAnimationFrame(draw);
  window.readMovingSource = () => ({
    atMs: performance.now(),
    drawn,
    skipped,
    maxDrawGapMs,
    hidden: document.hidden,
    width: canvas.width,
    height: canvas.height,
    devicePixelRatio,
  });
  window.stopMovingSource = () => {
    stopped = true;
    cancelAnimationFrame(callback);
    return window.readMovingSource();
  };
};
