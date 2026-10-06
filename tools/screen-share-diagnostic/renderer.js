"use strict";

window.runScreenShareDiagnostic = async function (config) {
  const metrics = window.ScreenShareDiagnosticMetrics;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const bounded = (promise, ms, message) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const video = document.getElementById("receiver");
  let send, receive, source, presentationCallback;
  let presentedFrames = null;
  const onPresentation = (_now, metadata) => {
    presentedFrames = metadata.presentedFrames;
    presentationCallback = video.requestVideoFrameCallback(onPresentation);
  };
  try {
    send = new RTCPeerConnection({ iceServers: [] });
    receive = new RTCPeerConnection({ iceServers: [] });
    if (video.requestVideoFrameCallback)
      presentationCallback = video.requestVideoFrameCallback(onPresentation);
    const profiles = {
      cbp: ["42e0"],
      baseline: ["4200"],
      main: ["4d00"],
      high: ["6400", "640c"],
    };
    const capabilities = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
    const requestedCodec = config.codec ?? "h264";
    const codec = capabilities.find((value) => {
      const parameters = metrics.profile(value.sdpFmtpLine);
      if (requestedCodec === "h265")
        return (
          value.mimeType.toLowerCase() === "video/h265" &&
          metrics.h265Main(parameters)
        );
      return (
        value.mimeType.toLowerCase() === "video/h264" &&
        profiles[config.profile].some((prefix) =>
          parameters["profile-level-id"]?.toLowerCase().startsWith(prefix),
        ) &&
        parameters["packetization-mode"] === "1"
      );
    });
    if (!codec)
      throw new Error(
        `Requested ${requestedCodec.toUpperCase()} profile RTP capability is unavailable: ` +
          config.profile,
      );
    source = makeSource(config);
    source.track.contentHint = "motion";
    const transceiver = send.addTransceiver(source.track, {
      direction: "sendonly",
    });
    transceiver.setCodecPreferences([codec]);
    receive.ontrack = (event) => {
      video.srcObject = new MediaStream([event.track]);
      void video.play().catch(() => {});
    };
    const gather = async (pc) => {
      if (pc.iceGatheringState === "complete") return;
      let listener;
      try {
        await bounded(
          new Promise((resolve) => {
            listener = () => {
              if (pc.iceGatheringState === "complete") resolve();
            };
            pc.addEventListener("icegatheringstatechange", listener);
            listener();
          }),
          8000,
          "Local ICE gathering timed out",
        );
      } finally {
        pc.removeEventListener("icegatheringstatechange", listener);
      }
    };
    source.start();
    await send.setLocalDescription(await send.createOffer());
    await gather(send);
    await receive.setRemoteDescription(send.localDescription);
    await receive.setLocalDescription(await receive.createAnswer());
    await gather(receive);
    await send.setRemoteDescription(receive.localDescription);
    const connected = performance.now();
    while (send.connectionState !== "connected") {
      if (
        send.connectionState === "failed" ||
        performance.now() - connected > 8000
      )
        throw new Error("Local peer connection did not connect");
      await sleep(50);
    }
    const parameters = transceiver.sender.getParameters();
    if (!parameters.encodings?.length)
      throw new Error("Connected sender has no encoding parameters");
    Object.assign(parameters.encodings[0], {
      maxBitrate: config.bitrate,
      maxFramerate: config.fps,
      scaleResolutionDownBy: 1,
    });
    parameters.degradationPreference = "maintain-framerate";
    await transceiver.sender.setParameters(parameters);
    const read = async () => {
      const [outbound, inbound] = await Promise.all([
        send.getStats(),
        receive.getStats(),
      ]);
      const select = (report, type) => {
        const row = [...report.values()].find(
          (value) =>
            value.type === type &&
            value.kind === "video" &&
            value.active !== false &&
            !/rtx|red|ulpfec/i.test(report.get(value.codecId)?.mimeType ?? ""),
        );
        if (!row) return { id: "unavailable", timestamp: 0 };
        return { ...row, codec: report.get(row.codecId) };
      };
      return {
        sender: select(outbound, "outbound-rtp"),
        receiver: select(inbound, "inbound-rtp"),
        at: performance.now(),
        source: { ...source.counters },
        presentedFrames,
      };
    };
    let previous = await read();
    const startupStart = previous.at;
    const startup = [];
    let firstFullResolutionSeconds = null;
    const observeStartup = (row) => {
      const atSeconds = (row.at - startupStart) / 1000;
      const dimensions =
        Number.isInteger(row.sender.frameWidth) &&
        Number.isInteger(row.sender.frameHeight)
          ? [row.sender.frameWidth, row.sender.frameHeight]
          : null;
      if (
        firstFullResolutionSeconds === null &&
        dimensions?.[0] === config.width &&
        dimensions?.[1] === config.height
      )
        firstFullResolutionSeconds = atSeconds;
      return {
        atSeconds,
        resolution: dimensions,
        codec: row.sender.codec?.mimeType ?? null,
        limitedBy: row.sender.qualityLimitationReason ?? null,
      };
    };
    startup.push(observeStartup(previous));
    while (previous.at - startupStart < config.warmup * 1000) {
      await sleep(
        Math.min(
          250,
          Math.max(0, config.warmup * 1000 - (previous.at - startupStart)),
        ),
      );
      previous = await read();
      startup.push(observeStartup(previous));
      if (source.error) throw source.error;
    }
    const initial = previous;
    const samples = [];
    const end = previous.at + config.seconds * 1000;
    while (performance.now() < end) {
      await sleep(Math.min(1000, Math.max(0, end - performance.now())));
      const current = await read();
      observeStartup(current);
      const sender = metrics.interval(current.sender, previous.sender);
      const receiver = metrics.interval(current.receiver, previous.receiver);
      const seconds = (current.at - previous.at) / 1000;
      const sourceRates = Object.fromEntries(
        Object.keys(source.counters).map((key) => [
          key,
          (current.source[key] - previous.source[key]) / seconds,
        ]),
      );
      samples.push({
        ...sender,
        atSeconds: (current.at - initial.at) / 1000,
        sourceRates,
        decodedFps: receiver.decodedFps,
        receivedFps: receiver.receivedFps,
        presentedFpsInHiddenRenderer:
          current.presentedFrames !== null &&
          previous.presentedFrames !== null &&
          current.presentedFrames >= previous.presentedFrames
            ? (current.presentedFrames - previous.presentedFrames) / seconds
            : null,
      });
      previous = current;
      if (source.error) throw source.error;
    }
    const elapsed = (previous.at - initial.at) / 1000;
    const summary = metrics.aggregate(samples, config.width, config.height);
    summary.firstFullResolutionSecondsFromConfiguredSender =
      firstFullResolutionSeconds;
    summary.suppliedFps =
      (previous.source.accepted - initial.source.accepted) / elapsed;
    summary.writtenFps =
      (previous.source.written - initial.source.written) / elapsed;
    summary.sourceBackpressure =
      previous.source.backpressure - initial.source.backpressure;
    summary.sourceSchedulerSkips =
      previous.source.scheduleSkipped - initial.source.scheduleSkipped;
    return {
      validCodec:
        samples.length > 0 &&
        samples.every(
          (value) =>
            value.codec?.toLowerCase() === `video/${requestedCodec}` &&
            (requestedCodec === "h265"
              ? metrics.sameH265Profile
              : metrics.sameProfile)(
              metrics.profile(codec.sdpFmtpLine),
              value.profile,
            ),
        ),
      mode: config.mode,
      codecPreference: {
        codec: requestedCodec,
        profile: config.profile,
        parameters: metrics.profile(codec.sdpFmtpLine),
      },
      availableH264Profiles: capabilities
        .filter((value) => value.mimeType.toLowerCase() === "video/h264")
        .map((value) => metrics.profile(value.sdpFmtpLine)),
      availableH265Profiles: capabilities
        .filter((value) => value.mimeType.toLowerCase() === "video/h265")
        .map((value) => metrics.profile(value.sdpFmtpLine)),
      startup: {
        note: "Sampled from the first stats read after sender configuration; not exact connection/first-pixel timing.",
        samples: startup,
      },
      summary,
      samples,
      source: {
        elapsedSeconds: elapsed,
        targetFps: config.fps,
        pattern: "moving NV12 luma blocks with a frame-dependent chroma value",
        contentHint: source.track.contentHint,
      },
      encoding: {
        ceilingBps: config.bitrate,
        maxFramerate: config.fps,
        scaleResolutionDownBy: 1,
        degradationPreference: "maintain-framerate",
      },
      cleanup:
        "Tracks, writer, receiver video and both peer connections are closed in finally.",
    };
  } finally {
    send?.close();
    receive?.close();
    video.srcObject?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    if (presentationCallback !== undefined)
      video.cancelVideoFrameCallback(presentationCallback);
    if (source) await source.stop();
  }
};

function makeSource(config) {
  let track, writer, canvas, context;
  const bytes = new Uint8Array((config.width * config.height * 3) / 2);
  try {
    if (config.mode === "generator") {
      if (typeof MediaStreamTrackGenerator === "undefined")
        throw new Error("MediaStreamTrackGenerator is unavailable");
      track = new MediaStreamTrackGenerator({ kind: "video" });
      writer = track.writable.getWriter();
    } else {
      canvas = document.createElement("canvas");
      canvas.width = config.width;
      canvas.height = config.height;
      context = canvas.getContext("2d");
      track = canvas.captureStream(0).getVideoTracks()[0];
      if (!context || !track?.requestFrame)
        throw new Error("Manual canvas capture is unavailable");
    }
  } catch (error) {
    track?.stop();
    writer?.releaseLock();
    throw error;
  }
  const counters = {
    produced: 0,
    accepted: 0,
    written: 0,
    backpressure: 0,
    scheduleSkipped: 0,
  };
  let start,
    timer,
    stopped = false,
    pending = null,
    index = 0,
    error = null;
  const run = () => {
    if (stopped) return;
    const now = performance.now();
    const due = Math.floor(((now - start) * config.fps) / 1000);
    if (due > index) {
      counters.scheduleSkipped += due - index;
      index = due;
    }
    const width = config.width,
      height = config.height;
    if (pending || (writer && writer.desiredSize <= 0)) counters.backpressure++;
    else {
      counters.produced++;
      for (let y = 0; y < height; y++) {
        const offset = y * width;
        bytes.fill(30 + ((y >> 5) % 4) * 40, offset, offset + width);
        for (let x = (index * 7) % 96; x < width; x += 96)
          bytes.fill(
            210 - ((index + y) % 30),
            offset + x,
            offset + Math.min(x + 32, width),
          );
      }
      bytes.fill(112 + (index % 32), width * height);
      let frame;
      try {
        frame = new VideoFrame(bytes, {
          format: "NV12",
          codedWidth: width,
          codedHeight: height,
          timestamp: Math.round((index * 1_000_000) / config.fps),
          duration: Math.round(1_000_000 / config.fps),
        });
        if (writer) {
          const write = writer.write(frame);
          counters.accepted++;
          pending = Promise.resolve(write)
            .then(
              () => counters.written++,
              (failure) => {
                error = failure;
              },
            )
            .finally(() => {
              frame.close();
              pending = null;
            });
        } else {
          context.drawImage(frame, 0, 0, width, height);
          track.requestFrame();
          counters.accepted++;
          counters.written++;
          frame.close();
        }
      } catch (failure) {
        frame?.close();
        error = failure;
        stopped = true;
        return;
      }
    }
    index++;
    timer = setTimeout(
      run,
      Math.max(0, start + (index * 1000) / config.fps - performance.now()),
    );
  };
  return {
    track,
    counters,
    get error() {
      return error;
    },
    start() {
      start = performance.now();
      run();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      track.stop();
      if (writer) {
        try {
          await writer.abort();
        } catch {
          /* Already closed. */
        }
        try {
          writer.releaseLock();
        } catch {
          /* Pending write cleanup owns it. */
        }
      }
      if (pending) await pending;
    },
  };
}
