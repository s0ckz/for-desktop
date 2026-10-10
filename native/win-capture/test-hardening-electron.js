// Local integration fixture: real native pixels/port/VideoFrame/generator and
// canvas, without a remote page, account, publication or visible test window.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const {
  app,
  BrowserWindow,
  MessageChannelMain,
  screen,
  ipcMain,
} = require("electron");
const root = path.resolve(__dirname, "../..");
const logs = [];
const server = require("node:http").createServer((_request, response) => {
  response.end("<html><body>Local capture integration fixture</body></html>");
});
function load(file, dependencies = {}) {
  const source = fs.readFileSync(path.join(root, "src/native", file), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    (name) => {
      if (name in dependencies) return dependencies[name];
      if (name === "./screenCapturePatch") return load("screenCapturePatch.ts");
      return require(name);
    },
    module,
    module.exports,
  );
  return module.exports;
}
const { APP_AUDIO_PATCH } = load("appAudioPatch.ts");
const capture = load("screenCapture.ts", {
  "./frameDelivery": load("frameDelivery.ts"),
  "./appAudio": {
    log: (...args) => logs.push(args.join(" ")),
    createLogRateLimiter: () => () => true,
    windowHandleFromSourceId: () => null,
    windowStateForSourceId: () => null,
  },
});
app
  .whenReady()
  .then(async () => {
    capture.initScreenCapture();
    // Test-only readback: observe the worker's applied policy after each real
    // track/IPC preset acknowledgement, including compatibility fallback.
    ipcMain.handle("capture-test:interval", async (_event, fps) => {
      for (let attempt = 0; attempt < 120; ++attempt) {
        const diagnostics = require("win-capture").diagnostics();
        const interval = diagnostics.wgcInterval;
        assert.equal(diagnostics.running, true);
        if (
          interval?.disabled ||
          (interval?.status ===
            (fps > 30 ? "unthrottled" : "session_default") &&
            interval.observedMs === (fps > 30 ? 0 : interval.defaultMs))
        )
          return interval;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        "Worker did not apply the interval policy after preset acknowledgement",
      );
    });
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await win.loadURL("http://127.0.0.1:" + server.address().port);
    await win.webContents.executeJavaScript(`
    const { ipcRenderer } = require('electron');
    let framePort = null, receivingSession = 0;
    const frames = new Set();
    ipcRenderer.on('capture-test:port', event => {
      framePort = event.ports[0];
      framePort.onmessage = event => {
        const { frame, meta } = event.data;
        try { for (const fn of [...frames]) fn(frame, meta); }
        finally { framePort.postMessage({ kind: 'ack', sessionId: meta.sessionId, frameId: meta.frameId }); }
      };
      framePort.start();
      if (receivingSession) framePort.postMessage({ kind: 'ready', sessionId: receivingSession });
    });
    window.native = { appAudio: { getState: async () => ({ active: false }) }, screenCapture: {
      getState: () => ipcRenderer.invoke('screenCapture:getState'),
      configure: request => ipcRenderer.invoke('screenCapture:configure', request),
      onFrame: (fn, sessionId) => {
        frames.add(fn); receivingSession = sessionId;
        if (framePort) framePort.postMessage({ kind: 'ready', sessionId });
        return () => { frames.delete(fn); receivingSession = 0; if (framePort) framePort.postMessage({ kind: 'pause', sessionId }); };
      },
      onState: fn => { const listener = (_, state) => fn(state); ipcRenderer.on('screenCapture:state', listener); return () => ipcRenderer.removeListener('screenCapture:state', listener); },
      stop: sessionId => ipcRenderer.send('screenCapture:stop', sessionId),
      reportStats: (sessionId, stats) => ipcRenderer.send('screenCapture:rendererStats', sessionId, stats),
      reportDrop: stage => ipcRenderer.send('screenCapture:pageDrop', stage),
      log: message => ipcRenderer.send('screenCapture:pageLog', message),
    } };
    const originalGenerator = window.MediaStreamTrackGenerator;
    const fallbackCanvas = document.createElement('canvas'); fallbackCanvas.width = 2; fallbackCanvas.height = 2;
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, writable: true, value: async () => {
      const fallback = fallbackCanvas.captureStream(0).getVideoTracks()[0];
      window.lastFallback = fallback;
      return new MediaStream([fallback]);
    } });
  `);
    const { port1, port2 } = new MessageChannelMain();
    capture.setFramePort(port1);
    win.webContents.postMessage("capture-test:port", null, [port2]);
    await win.webContents.executeJavaScript(APP_AUDIO_PATCH);
    const display = screen.getAllDisplays()[0];
    let sessionId = 0;
    for (const canvas of [false, true]) {
      for (let run = 0; run < 3; ++run) {
        sessionId++;
        assert(
          await capture.startForSource(
            "screen:test:0",
            30,
            sessionId,
            String(display.id),
          ),
        );
        const result = await win.webContents.executeJavaScript(`(async () => {
        window.MediaStreamTrackGenerator = ${canvas ? "undefined" : "originalGenerator"};
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 } });
        const track = stream.getVideoTracks()[0];
        const fallbackEnded = window.lastFallback.readyState === 'ended';
        const before = track.getSettings();
        await track.applyConstraints({ width: 1280, height: 720, frameRate: 60 });
        const state = await window.native.screenCapture.getState();
        const after = track.getSettings();
        const policy60 = await ipcRenderer.invoke('capture-test:interval', 60);
        const peer = new RTCPeerConnection();
        const sender = peer.addTrack(track, stream);
        if (sender.track !== track) throw Error('Sender must retain the native diagnostic hook');
        const flowBefore = await sender.track.getCaptureDiagnostics();
        await new Promise(resolve => setTimeout(resolve, 250));
        const flowAfter = await sender.track.getCaptureDiagnostics();
        peer.close();
        await track.applyConstraints({ width: 1280, height: 720, frameRate: 30 });
        const restored = track.getSettings();
        const policy30 = await ipcRenderer.invoke('capture-test:interval', 30);
        track.stop();
        const flowEnded = await track.getCaptureDiagnostics();
        return { fallbackEnded, before, after, state, restored, policy60, policy30, flowBefore, flowAfter, flowEnded };
      })()`);
        assert.equal(
          result.fallbackEnded,
          true,
          "Replacement must succeed before stopping the fallback",
        );
        assert.equal(result.before.frameRate, 30);
        assert.equal(result.after.frameRate, 60);
        assert.equal(result.restored.frameRate, 30);
        assert.equal(result.flowEnded, null);
        assert.equal(result.flowAfter.sessionId, sessionId);
        assert.equal(
          result.flowAfter.path,
          canvas ? "canvas.captureStream" : "MediaStreamTrackGenerator",
        );
        assert(
          result.flowAfter.native.native.emittedFrames >
            result.flowBefore.native.native.emittedFrames,
        );
        assert(
          result.flowAfter.native.native.jsDeliveredFrames >
            result.flowBefore.native.native.jsDeliveredFrames,
        );
        assert(
          result.flowAfter.renderer.received >
            result.flowBefore.renderer.received,
        );
        assert(result.flowAfter.timings.arrivalGap.count > 0);
        if (!canvas) assert(result.flowAfter.timings.write.count > 0);
        if (!result.policy60.disabled) {
          assert.equal(result.policy60.observedMs, 0);
          assert.equal(result.policy30.observedMs, result.policy60.defaultMs);
          assert(
            result.policy30.setterAttempts >= result.policy60.setterAttempts,
          );
        }
        assert.equal(result.state.targetWidth, 1280);
        assert.equal(result.state.targetHeight, 720);
        assert.equal(result.state.pixelsReady, true);
        assert(result.state.configurationVersion >= 2);
        await capture.stop();
        const diagnostics = require("win-capture").diagnostics();
        assert.equal(diagnostics.running, false);
        assert.equal(
          diagnostics.processFailures +
            diagnostics.surfaceFailures +
            diagnostics.tsfnRejectedFrames,
          0,
        );
        console.log(
          JSON.stringify({
            path: canvas ? "canvas" : "generator",
            run,
            sessionId,
            firstPixels: true,
            acceptedTarget: [
              result.state.targetWidth,
              result.state.targetHeight,
              result.after.frameRate,
            ],
            nativeBuild: diagnostics.nativeBuild,
            interval60: result.policy60,
            interval30: result.policy30,
            flow: result.flowAfter,
          }),
        );
      }
    }
    const rendererRows = logs
      .filter((line) => line.startsWith("screen capture: renderer "))
      .map((line) =>
        JSON.parse(line.slice("screen capture: renderer ".length)),
      );
    assert(
      rendererRows.some((row) => row.written > 0),
      "Real generator must write its first frame without publication/consumer setup",
    );
    assert(
      rendererRows.some((row) => row.canvasDrawn > 0),
      "Real canvas must draw/request its first native frame",
    );
    assert(
      rendererRows.every(
        (row) => row.writeFailures + row.drawFailures + row.backpressure === 0,
      ),
    );
    win.destroy();
    server.close();
    console.log(
      "ELECTRON HARDENING PASS: six native/port/renderer starts, static first pixels and acknowledged presets",
    );
    app.exit(0);
  })
  .catch(async (error) => {
    console.error(error.stack || error);
    console.error(
      logs
        .filter((line) =>
          /page|renderer|first frame|native replacement/.test(line),
        )
        .slice(-12)
        .join("\n"),
    );
    server.close();
    try {
      await capture.stop();
    } finally {
      app.exit(1);
    }
  });
