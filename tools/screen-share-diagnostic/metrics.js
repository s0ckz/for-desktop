"use strict";

// Shared by the isolated renderer and Node regression tests. Reports contain no
// candidate addresses, SDP, media pixels, participant IDs or raw GPU information.
(() => {
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  function difference(now, before) {
    return finite(now) && finite(before) && now >= before ? now - before : null;
  }
  function profile(fmtp = "") {
    const allowed = new Set([
      "profile-level-id",
      "packetization-mode",
      "level-asymmetry-allowed",
      "profile-id",
      "profile-space",
      "tier-flag",
      "level-id",
      "interop-constraints",
      "profile-compatibility-indicator",
    ]);
    return Object.fromEntries(
      fmtp.split(";").flatMap((part) => {
        const [key, value] = part.trim().split("=");
        return allowed.has(key)
          ? [
              [
                key,
                /^[a-zA-Z0-9-]{1,16}$/.test(value ?? "") ? value : "invalid",
              ],
            ]
          : [];
      }),
    );
  }
  function sameProfile(requested, negotiated) {
    const id = (parameters) => parameters?.["profile-level-id"]?.toLowerCase();
    const wanted = id(requested),
      actual = id(negotiated);
    // The SDP engine negotiates the level independently (RFC 6184 section 8.2.2).
    // Require identical profile/constraint bytes and packetization mode here;
    // retain both complete IDs in the report. This does not validate bitstream level.
    return (
      /^[0-9a-f]{6}$/.test(wanted ?? "") &&
      /^[0-9a-f]{6}$/.test(actual ?? "") &&
      wanted.slice(0, 4) === actual.slice(0, 4) &&
      requested["packetization-mode"] === "1" &&
      negotiated["packetization-mode"] === "1"
    );
  }
  function h265Main(parameters) {
    const value = (key, fallback) => parameters?.[key] ?? fallback;
    // RFC 7798 defaults: Main profile, profile space 0, Main tier.
    // Reject malformed values rather than turning a parse failure into a default.
    return (
      value("profile-id", "1") === "1" &&
      value("profile-space", "0") === "0" &&
      value("tier-flag", "0") === "0"
    );
  }
  function sameH265Profile(requested, negotiated) {
    return (
      h265Main(requested) &&
      h265Main(negotiated) &&
      ["interop-constraints", "profile-compatibility-indicator"].every(
        (key) =>
          requested?.[key]?.toLowerCase() === negotiated?.[key]?.toLowerCase(),
      )
    );
  }
  function interval(now, before) {
    const valid =
      before &&
      ["id", "ssrc", "codecId", "transportId", "mediaSourceId"].every(
        (key) => now[key] === before[key],
      ) &&
      ![
        "framesEncoded",
        "framesSent",
        "bytesSent",
        "framesDecoded",
        "framesReceived",
      ].some(
        (key) =>
          finite(now[key]) && finite(before[key]) && now[key] < before[key],
      );
    const seconds =
      valid &&
      finite(now.timestamp) &&
      finite(before.timestamp) &&
      now.timestamp > before.timestamp
        ? (now.timestamp - before.timestamp) / 1000
        : null;
    const delta = (key) =>
      seconds === null ? null : difference(now[key], before[key]);
    const rate = (key) => (delta(key) === null ? null : delta(key) / seconds);
    const frames = delta("framesEncoded"),
      encode = delta("totalEncodeTime");
    const durations = Object.fromEntries(
      ["cpu", "bandwidth", "none", "other"].map((key) => [
        key,
        seconds === null
          ? null
          : difference(
              now.qualityLimitationDurations?.[key],
              before.qualityLimitationDurations?.[key],
            ),
      ]),
    );
    const dims = (row) =>
      row &&
      Number.isInteger(row.frameWidth) &&
      row.frameWidth > 0 &&
      Number.isInteger(row.frameHeight) &&
      row.frameHeight > 0;
    return {
      intervalSeconds: seconds,
      encodedFps: rate("framesEncoded"),
      sentFps: rate("framesSent"),
      decodedFps: rate("framesDecoded"),
      receivedFps: rate("framesReceived"),
      bitrateBps: rate("bytesSent") === null ? null : rate("bytesSent") * 8,
      meanEncodeMs:
        frames > 0 && encode !== null ? (encode * 1000) / frames : null,
      encodedFrames: frames,
      encodeSeconds: encode,
      resolution: dims(now) ? [now.frameWidth, now.frameHeight] : null,
      observedResolutionChanges:
        seconds !== null && dims(now) && dims(before)
          ? Number(
              now.frameWidth !== before.frameWidth ||
                now.frameHeight !== before.frameHeight,
            )
          : null,
      codec: now.codec?.mimeType ?? null,
      profile: profile(now.codec?.sdpFmtpLine),
      encoder:
        typeof now.encoderImplementation === "string"
          ? now.encoderImplementation.slice(0, 120)
          : null,
      powerEfficientEncoder:
        typeof now.powerEfficientEncoder === "boolean"
          ? now.powerEfficientEncoder
          : null,
      limitedBy: now.qualityLimitationReason ?? null,
      limitedSeconds: durations,
    };
  }
  function aggregate(samples, width = 1280, height = 720) {
    const weighted = (field) => {
      const rows = samples.filter(
        (row) => finite(row[field]) && row.intervalSeconds > 0,
      );
      const seconds = rows.reduce((sum, row) => sum + row.intervalSeconds, 0);
      return seconds
        ? rows.reduce((sum, row) => sum + row[field] * row.intervalSeconds, 0) /
            seconds
        : null;
    };
    const encoded = samples.filter(
      (row) => finite(row.encodedFrames) && finite(row.encodeSeconds),
    );
    const frames = encoded.reduce((sum, row) => sum + row.encodedFrames, 0);
    const resolutions = samples.filter((row) => row.resolution);
    return {
      intervals: samples.length,
      encodedFps: weighted("encodedFps"),
      sentFps: weighted("sentFps"),
      decodedFps: weighted("decodedFps"),
      receivedFps: weighted("receivedFps"),
      bitrateBps: weighted("bitrateBps"),
      fullResolutionSampleFraction: resolutions.length
        ? resolutions.filter(
            (row) =>
              row.resolution[0] === width && row.resolution[1] === height,
          ).length / resolutions.length
        : null,
      limitationDurationSeconds: Object.fromEntries(
        ["cpu", "bandwidth", "none", "other"].map((key) => {
          const rows = samples.filter(
            (row) =>
              row.intervalSeconds > 0 && finite(row.limitedSeconds?.[key]),
          );
          return [
            key,
            rows.length
              ? rows.reduce((sum, row) => sum + row.limitedSeconds[key], 0)
              : null,
          ];
        }),
      ),
      meanEncodeMs: frames
        ? (encoded.reduce((sum, row) => sum + row.encodeSeconds, 0) * 1000) /
          frames
        : null,
      resolutions: [
        ...new Set(
          samples
            .filter((row) => row.resolution)
            .map((row) => row.resolution.join("x")),
        ),
      ],
      observedResolutionTransitions: samples.some((row) =>
        finite(row.observedResolutionChanges),
      )
        ? samples.reduce(
            (sum, row) => sum + (row.observedResolutionChanges ?? 0),
            0,
          )
        : null,
      encoders: [...new Set(samples.map((row) => row.encoder).filter(Boolean))],
      browserPowerEfficientReports: [
        ...new Set(
          samples
            .map((row) => row.powerEfficientEncoder)
            .filter((value) => typeof value === "boolean"),
        ),
      ],
    };
  }
  const api = {
    interval,
    aggregate,
    profile,
    sameProfile,
    h265Main,
    sameH265Profile,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.ScreenShareDiagnosticMetrics = api;
})();
