/** Runs in the page's main world, with the bridges/helpers in APP_AUDIO_PATCH. */
export const NATIVE_VIDEO_PATCH = String.raw`
  const boundedCaptureCall = (operation, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException('Native capture did not respond', 'TimeoutError')), timeoutMs);
    Promise.resolve(operation).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  const constraintError = (key, message) => {
    const error = new DOMException(message, 'OverconstrainedError');
    Object.defineProperty(error, 'constraint', { value: key });
    return error;
  };
  const captureLimit = (constraints, key, current, floor, ceiling, integral = false) => {
    const input = constraints && constraints[key];
    if (input === undefined) return { value: current };
    const limit = typeof input === 'number' ? { ideal: input } : input;
    if (!limit || typeof limit !== 'object' || Array.isArray(limit)) throw new TypeError('Invalid ' + key + ' constraint');
    for (const name of ['ideal', 'exact', 'min', 'max']) {
      if (limit[name] !== undefined && (typeof limit[name] !== 'number' || !Number.isFinite(limit[name]) || limit[name] <= 0)) throw new TypeError('Invalid ' + key + '.' + name);
    }
    const min = Math.max(floor, limit.min === undefined ? floor : limit.min);
    const max = Math.min(ceiling, limit.max === undefined ? ceiling : limit.max);
    if (min > max || (limit.exact !== undefined && (limit.exact < min || limit.exact > max || (integral && !Number.isInteger(limit.exact))))) throw constraintError(key, 'Native capture cannot satisfy ' + key);
    const desired = limit.exact === undefined ? (limit.ideal === undefined ? current : limit.ideal) : limit.exact;
    let value = Math.max(min, Math.min(max, desired));
    if (integral) value = Math.max(Math.ceil(min), Math.min(Math.floor(max), Math.round(value)));
    if (value < min || value > max) throw constraintError(key, 'Native capture cannot satisfy ' + key);
    return { value, min: limit.min, max: limit.max, exact: limit.exact };
  };
  const checkCaptureSize = (width, height, sourceWidth, sourceHeight, widthLimit, heightLimit) => {
    if (!(sourceWidth > 0 && sourceHeight > 0)) return;
    const scale = Math.min(1, width / sourceWidth, height / sourceHeight);
    const actual = { width: Math.max(2, Math.floor(sourceWidth * scale / 2) * 2), height: Math.max(2, Math.floor(sourceHeight * scale / 2) * 2) };
    for (const [key, limit] of [['width', widthLimit], ['height', heightLimit]]) {
      if ((limit.exact !== undefined && actual[key] !== limit.exact) || (limit.min !== undefined && actual[key] < limit.min) || (limit.max !== undefined && actual[key] > limit.max)) throw constraintError(key, 'Source aspect ratio or size cannot satisfy ' + key);
    }
  };

  const buildVideoTrack = (state, fps, generation) => {
    const owner = generation;
    const builtForSessionId = state.sessionId;
    let lastWidth = state.width, lastHeight = state.height;
    let effectiveFps = state.fps || fps || 30;
    let targetWidth = state.targetWidth || lastWidth, targetHeight = state.targetHeight || lastHeight;
    let sourceWidth = state.sourceWidth || lastWidth, sourceHeight = state.sourceHeight || lastHeight;
    let configurationVersion = state.configurationVersion || 0, requestId = 0;
    let lastTimestampUs = null, closed = false, cleaned = false, pending = 0;
    let constructionFailures = 0, drawFailures = 0, loggedFailure = false;
    let track = null, writer = null, canvas = null, ctx2d = null, kind = null;
    const subscriptions = [];
    const counters = { received: 0, constructed: 0, accepted: 0, written: 0, backpressure: 0, writeFailures: 0, canvasDrawn: 0, drawFailures: 0 };
    const flushCounters = () => { try { screenCaptureBridge.reportStats(builtForSessionId, counters); } catch (e) { /* older bridge */ } };
    // Timing costs are paid only while a local diagnostic reader is polling.
    // The lease expires if the reader stops, even when its page-side cleanup fails.
    let tracing = false, traceLease = null, traceArrivalAt = null, traceTimestampUs = null;
    const traceTimings = {};
    const observeTrace = (name, ms) => {
      if (!Number.isFinite(ms) || ms < 0) return;
      const value = traceTimings[name] || (traceTimings[name] = { count: 0, totalMs: 0, maxMs: 0 });
      value.count++; value.totalMs += ms; value.maxMs = Math.max(value.maxMs, ms);
    };
    if (typeof MediaStreamTrackGenerator === 'function') {
      try { track = new MediaStreamTrackGenerator({ kind: 'video' }); writer = track.writable.getWriter(); kind = 'MediaStreamTrackGenerator'; }
      catch (e) { try { if (track) track.stop(); } catch (e2) {} track = writer = null; }
    }
    if (!track && typeof document !== 'undefined' && typeof VideoFrame === 'function') {
      try {
        canvas = document.createElement('canvas'); canvas.width = lastWidth; canvas.height = lastHeight;
        ctx2d = canvas.getContext('2d');
        if (ctx2d && canvas.captureStream) track = canvas.captureStream(0).getVideoTracks()[0];
        if (!track || typeof track.requestFrame !== 'function') { if (track) track.stop(); track = null; }
        else kind = 'canvas.captureStream';
      } catch (e) { try { if (track) track.stop(); } catch (e2) {} track = null; }
    }
    if (!track) return null;
    let settleFirst, firstSettled = false;
    const firstFrame = new Promise(resolve => { settleFirst = resolve; });
    const finishFirst = value => { if (!firstSettled) { firstSettled = true; clearTimeout(startupTimer); settleFirst(value); } };
    const startupTimer = setTimeout(() => fail('first renderer frame timed out'), 3000);
    const statsTimer = setInterval(flushCounters, 10000);
    const retire = () => {
      if (closed) return false;
      closed = true; finishFirst(false); clearInterval(statsTimer); flushCounters();
      tracing = false; clearTimeout(traceLease);
      for (const unsubscribe of subscriptions.splice(0)) { try { unsubscribe(); } catch (e) {} }
      try { if (writer) Promise.resolve(writer.abort ? writer.abort() : writer.close()).catch(() => {}); } catch (e) {}
      return true;
    };
    const fail = reason => {
      if (!retire()) return;
      logPage('video: native renderer failed: ' + reason);
      if (owner === currentGeneration && screenCaptureBridge.reportFailure) { try { screenCaptureBridge.reportFailure(builtForSessionId, reason); } catch (e) {} }
      try { track.stop(); track.dispatchEvent(new Event('ended')); } catch (e) {}
    };
    const subscribe = unsubscribe => { if (closed) { try { unsubscribe(); } catch (e) {} } else subscriptions.push(unsubscribe); };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      retire();
      try { track.stop(); } catch (e) {}
      if (owner === currentGeneration) { try { screenCaptureBridge.stop(builtForSessionId); } catch (e) {} }
    };
    const originalGetSettings = track.getSettings.bind(track);
    track.getSettings = () => Object.assign({}, originalGetSettings(), { width: lastWidth, height: lastHeight, frameRate: effectiveFps });
    // Track-owned diagnostic hook. Old/non-native tracks simply do not have it.
    track.getCaptureDiagnostics = async () => {
      if (closed || owner !== currentGeneration || track.readyState === 'ended') return null;
      let live;
      try { live = await boundedCaptureCall(screenCaptureBridge.getState()); } catch (e) { return null; }
      if (closed || owner !== currentGeneration || !live || !live.active || live.sessionId !== builtForSessionId) return null;
      tracing = true; clearTimeout(traceLease);
      traceLease = setTimeout(() => { tracing = false; traceArrivalAt = traceTimestampUs = null; }, 2500);
      return {
        sessionId: builtForSessionId, configurationVersion: live.configurationVersion || 0,
        path: kind, sampledAtMs: performance.timeOrigin + performance.now(),
        renderer: Object.assign({}, counters), native: live.flow || null,
        timings: Object.fromEntries(Object.entries(traceTimings).map(([name, value]) => [name, Object.assign({}, value)])),
      };
    };
    let configurationQueue = Promise.resolve();
    const applyConfiguration = async constraints => {
      if (closed || owner !== currentGeneration || track.readyState === 'ended') throw new DOMException('Capture session ended', 'AbortError');
      if (constraints !== undefined && (!constraints || typeof constraints !== 'object' || Array.isArray(constraints))) throw new TypeError('Invalid capture constraints');
      const c = constraints || {};
      const cap = Number.isFinite(fpsCap) && fpsCap > 0 ? Math.min(120, fpsCap) : 120;
      const rate = captureLimit(c, 'frameRate', effectiveFps, 1, cap);
      const width = captureLimit(c, 'width', targetWidth, 2, 8192, true);
      const height = captureLimit(c, 'height', targetHeight, 2, 8192, true);
      checkCaptureSize(width.value, height.value, sourceWidth, sourceHeight, width, height);
      let result, configurationRequest = 0;
      if (typeof screenCaptureBridge.configure === 'function') {
        configurationRequest = ++requestId;
        result = await boundedCaptureCall(screenCaptureBridge.configure({ sessionId: builtForSessionId, requestId: configurationRequest, width: width.value, height: height.value, fps: rate.value }));
      } else {
        // Older bridges are one-way: read back accepted state, rather than
        // optimistically changing settings to what we just requested.
        if (c.frameRate !== undefined) screenCaptureBridge.setFps(rate.value, builtForSessionId);
        if ((c.width !== undefined || c.height !== undefined) && screenCaptureBridge.setTarget) screenCaptureBridge.setTarget(width.value, height.value, builtForSessionId);
        result = { accepted: true, state: await boundedCaptureCall(screenCaptureBridge.getState()) };
      }
      const accepted = result && result.state;
      if (closed || owner !== currentGeneration || !accepted || !accepted.active || accepted.sessionId !== builtForSessionId || (result.requestId !== undefined && result.requestId !== configurationRequest) || (accepted.configurationVersion !== undefined && accepted.configurationVersion < configurationVersion)) throw new DOMException('Capture configuration became stale', 'AbortError');
      if (Number.isFinite(accepted.fps)) effectiveFps = accepted.fps;
      targetWidth = accepted.targetWidth || targetWidth; targetHeight = accepted.targetHeight || targetHeight;
      sourceWidth = accepted.sourceWidth || sourceWidth; sourceHeight = accepted.sourceHeight || sourceHeight;
      configurationVersion = accepted.configurationVersion || configurationVersion;
      if (!result.accepted) throw new DOMException(result.reason || 'Native configuration refused', 'OperationError');
      if ((rate.exact !== undefined && effectiveFps !== rate.exact) || (rate.min !== undefined && effectiveFps < rate.min) || (rate.max !== undefined && effectiveFps > rate.max)) throw constraintError('frameRate', 'Accepted capture rate cannot satisfy the constraint');
    };
    track.applyConstraints = constraints => {
      const snapshot = constraints && typeof constraints === 'object' && !Array.isArray(constraints) ? Object.assign({}, constraints) : constraints;
      if (snapshot && typeof snapshot === 'object') for (const key of ['width', 'height', 'frameRate']) if (snapshot[key] && typeof snapshot[key] === 'object') snapshot[key] = Object.assign({}, snapshot[key]);
      const task = configurationQueue.then(() => applyConfiguration(snapshot));
      configurationQueue = task.catch(() => {});
      return task;
    };
    try {
      subscribe(screenCaptureBridge.onState(s => { if (s.sessionId === builtForSessionId && !s.active) fail('native session stopped'); }));
      subscribe(screenCaptureBridge.onFrame((buf, meta) => {
        if (closed || owner !== currentGeneration || (meta.sessionId !== undefined && meta.sessionId !== builtForSessionId)) return;
        counters.received++;
        const traceAt = tracing ? performance.now() : null;
        if (traceAt !== null) {
          if (traceArrivalAt !== null) observeTrace('arrivalGap', traceAt - traceArrivalAt);
          if (traceTimestampUs !== null) observeTrace('captureTimestampGap', (meta.timestampUs - traceTimestampUs) / 1000);
          traceArrivalAt = traceAt; traceTimestampUs = meta.timestampUs;
        }
        if (writer && writer.desiredSize === null) { fail('writer closed'); return; }
        if (writer && (writer.desiredSize <= 0 || pending > 0)) { counters.backpressure++; return; }
        const init = { format: 'NV12', codedWidth: meta.width, codedHeight: meta.height, timestamp: meta.timestampUs };
        if (lastTimestampUs !== null) init.duration = Math.max(0, meta.timestampUs - lastTimestampUs);
        let vf;
        try { vf = new VideoFrame(buf, init); }
        catch (e) {
          reportDrop('videoFrameFailure'); constructionFailures++;
          if (!loggedFailure) { loggedFailure = true; logPage('new VideoFrame() construction failed (' + kind + '): ' + e); }
          if (constructionFailures >= 8) fail('repeated VideoFrame construction failure');
          return;
        }
        constructionFailures = 0; counters.constructed++;
        if (traceAt !== null) observeTrace('construction', performance.now() - traceAt);
        lastWidth = meta.width; lastHeight = meta.height; lastTimestampUs = meta.timestampUs;
        if (writer) {
          pending++; counters.accepted++;
          let write;
          const writeAt = tracing ? performance.now() : null;
          try { write = writer.write(vf); }
          catch (e) { pending--; counters.writeFailures++; try { vf.close(); } catch (e2) {} fail('writer threw'); return; }
          Promise.resolve(write).then(() => { counters.written++; if (!closed) { if (tracing && writeAt !== null) observeTrace('write', performance.now() - writeAt); finishFirst(true); } }, () => { counters.writeFailures++; fail('writer rejected frame'); }).finally(() => { pending--; try { vf.close(); } catch (e) {} });
        } else {
          try {
            if (canvas.width !== meta.width || canvas.height !== meta.height) { canvas.width = meta.width; canvas.height = meta.height; }
            ctx2d.drawImage(vf, 0, 0, canvas.width, canvas.height); track.requestFrame();
            drawFailures = 0; counters.accepted++; counters.canvasDrawn++; finishFirst(true);
          } catch (e) { counters.drawFailures++; drawFailures++; if (drawFailures >= 8) fail('repeated canvas draw failure'); }
          finally { try { vf.close(); } catch (e) {} }
        }
      }, builtForSessionId));
    } catch (e) { fail('bridge subscription failed'); return null; }
    return {
      kind, track, cleanup,
      confirmSessionLive: async () => {
        if (!await firstFrame || closed || owner !== currentGeneration) return false;
        let live;
        try { live = await boundedCaptureCall(screenCaptureBridge.getState()); } catch (e) { fail('state confirmation failed'); return false; }
        if (closed || owner !== currentGeneration || track.readyState === 'ended' || !live || !live.active || live.sessionId !== builtForSessionId) { fail('native session changed before replacement'); return false; }
        return true;
      },
    };
  };
`;
