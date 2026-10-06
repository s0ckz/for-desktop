# Local screen share encoder diagnostic

Run an isolated Electron renderer with deterministic NV12 moving input and two
local RTCPeerConnections. It does not load Stoat, use an account, join LiveKit,
request camera/microphone permissions, capture another app, or contact a server.
Its hidden renderer has background throttling disabled. Normal Stoat settings,
Chromium feature switches and codec policy are untouched.

From the desktop repository, with the existing pnpm dependencies installed:

```powershell
pnpm diagnostic:screen-share --fps=60 --seconds=12 --warmup=3 --trace --output=C:/Temp/encoder-cbp.json
pnpm diagnostic:screen-share --fps=30 --mode=canvas --trace --output=C:/Temp/encoder-canvas.json
```

The default input is 1280x720, 6 Mbps, H.264 Constrained Baseline (`42e0`), with
NV12 `VideoFrame` construction and a single pending track-generator write,
matching the production frame ingestion shape. Canvas mode draws those same
NV12 frames and calls `requestFrame()`, matching the fallback shape. Supply is
scheduled against a monotonic deadline, with overdue frames skipped rather than
bursts or duplicates. Source scheduling and writer backpressure are reported.

Diagnostic-only profile comparisons can isolate a profile-specific encoder
failure; they do not change any live publisher or its receiver compatibility:

```powershell
pnpm diagnostic:screen-share --profile=baseline --fps=60 --trace --output=C:/Temp/encoder-baseline.json
pnpm diagnostic:screen-share --profile=main --fps=60 --trace --output=C:/Temp/encoder-main.json
pnpm diagnostic:screen-share --profile=high --fps=60 --trace --output=C:/Temp/encoder-high.json
pnpm diagnostic:screen-share --software --fps=60 --trace --output=C:/Temp/encoder-software.json
```

Profiles are selected from actual RTP capabilities with packetization mode 1.
Missing profiles fail explicitly, never silently choose a different codec.
Validation requires the same profile/constraint bytes and packetization mode;
SDP can negotiate a different level. Both full profile-level IDs are reported.
The helper does not parse the bitstream to verify level conformance.
`--software` disables acceleration for the entire helper, including its decoder
and compositor; it is a diagnostic reference, not a pure encoder-only A/B test.

FPS is restricted to 30 or 60; measurement is 5..60 seconds; warm-up is 2..10
seconds. The Node parent enforces a final runtime bound and removes its own
temporary profile after Electron exits. The helper stops the source/writer,
receiver tracks/video callbacks and both peers on completion or setup failure.
Use the `run.cjs` launcher through the pnpm command, not `main.cjs` directly.

## Interpret the report

The JSON contains configuration/runtime/source hash, actual RTP codec/profile,
supplied/written/encoded/sent/received/decoded rates, actual dimensions and
sampled dimension transitions, RTP bitrate, mean encode time and limitation
durations. Means are weighted by valid stat intervals. A browser-reported
encoder or power-efficiency value stays unknown when omitted. A reset or stream
replacement starts a new baseline. A successful exit means the requested codec
and flowing video were measured, not that hardware encoding succeeded or the
requested resolution/FPS remained stable.

GPU feature status and active-adapter information describe **availability**.
`--trace` additionally writes adjacent `.trace.json` and `.chromium.log` files
using Electron's supported tracing/logging APIs. Sanitized summaries include
encoder trace event counts and explicit hardware-init/fallback/output-media-type
error markers. An initialization attempt or supported-profile probe is not
proof that hardware encoded frames; look for actual encode/output processing
and corroborating device activity. Nonexistent log/identity fields stay unknown.
The JSON omits SDP, candidate addresses and media pixels. Raw traces/logs are
local investigation artifacts; keep them out of committed or public reports.

This synthetic loopback excludes native Windows capture, LiveKit and internet.
It does not launch or control games; existing device load still affects it.
Hidden-renderer presentation does not measure a viewer's
physical screen. A 60 FPS result at 480x270 is not stable 720p60. Native arrival
timing and live viewer/game performance still require separate measurements.

## H.265 and bitrate comparisons

H.265 Main and the reviewed 6/8 Mbps comparison are available in the local
loopback. These use actual RTP capabilities and normal acceleration policy;
the helper does not force extra HEVC feature switches or silently fall back to
H.264. A missing Main capability or nonmatching negotiated codec/profile fails
explicitly. Main profile/space/tier defaults follow
[RFC 7798](https://www.rfc-editor.org/rfc/rfc7798.html#section-7.1). Offered and
negotiated levels are reported separately, without bitstream conformance
validation. Constraint/compatibility parameters must match.

```powershell
pnpm diagnostic:screen-share --codec=h265 --bitrate=6000000 --fps=60 --seconds=20 --trace --output=C:/Temp/hevc-6mbps.json
pnpm diagnostic:screen-share --codec=h265 --bitrate=8000000 --fps=60 --seconds=20 --trace --output=C:/Temp/hevc-8mbps.json
```

Only 6,000,000 or 8,000,000 bits/s can be selected. H.264/Constrained Baseline
at 6 Mbps remains the diagnostic default. Codec/bitrate choices do not alter any
production preset or receiver policy.

Startup stats are sampled every 250 ms during warm-up and then every second.
First sampled full-resolution time is relative to the first stats read after
sender configuration. Zero means it was already full resolution at that read;
it is not exact connection/first-pixel latency. `fullResolutionSampleFraction`
counts interval-end observations, not exact time spent at quality. Limitation
totals use valid monotonic counter deltas; missing evidence stays unknown.

## Native moving-window measurement (Windows)

```powershell
pnpm diagnostic:native-capture --fps=60 --seconds=12 --warmup=3 --output=C:/Temp/native60.json
pnpm diagnostic:native-capture --fps=30 --seconds=12 --warmup=3 --output=C:/Temp/native30.json
pnpm diagnostic:native-capture --fps=60 --seconds=12 --warmup=3 --trace --output=C:/Temp/native60-trace.json
```

This command briefly shows its own borderless animated 1280x720 window, without
taking focus, and closes it automatically. The source requests 60 draws/s even
when capture is capped at 30. It captures only that window's handle through the
installed `win-capture` WGC addon. There is no arbitrary window/monitor selector,
account, Stoat startup, permission prompt, encoder, network or game control.
The renderer denies remote requests/navigation and uses a separate temporary
profile. The parent removes that profile after Electron exits.

Actual canvas draws, native arrivals/submissions and JS deliveries are measured
separately. A 16-bit luma marker verifies distinct source images and distinguishes
repeated pixels from callbacks; sentinel checks reject an incorrect crop or
unsupported luma reading. Marker skips can be expected at the 30 FPS cap. Raw
media is never saved. Native snapshots include backend/adapter/build identity,
queue/failure counters and cumulative timing distributions including warm-up.
Readback residence includes scheduling/polling and overlaps across slots; it is
not a serial GPU execution time or a basis for a fixed FPS ceiling.

Canvas draws are not physical presentation counts. Optional compositor tracing
records source-renderer identity and measurement marks; its sanitized event
counts alone must not be called presented FPS. Keep adjacent raw traces outside
Git and consider tracing overhead when comparing runs.

The test excludes application IPC/track ingestion and downstream encode. It
does not change games, GPU routing, OS preferences or normal app settings.
Existing game/device load can affect either diagnostic; record it separately
and do not describe such a run as an idle-device benchmark. Success means valid
moving pixels and cleanup, not that requested 720p60 was sustained.

Source APIs: [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)
(`showInactive`, `getNativeWindowHandle`, `backgroundThrottling`, `thickFrame`)
and [Chromium compositor terminology](https://github.com/chromium/chromium/blob/main/cc/README.md).

## Regression checks

```powershell
node --test tools/screen-share-diagnostic/diagnostic.test.cjs
pnpm exec prettier --check tools/screen-share-diagnostic/
```

CI runs these contracts without requiring a GPU. Real encoder checks remain a
local investigation, because drivers, adapter routing and encoder profiles vary.

API references: [GPU information](https://www.electronjs.org/docs/latest/api/app#appgetgpuinfoinfotype),
[GPU feature status](https://www.electronjs.org/docs/latest/api/structures/gpu-feature-status/),
[content tracing](https://www.electronjs.org/docs/latest/api/content-tracing),
and [Chromium logging switches](https://www.electronjs.org/docs/latest/api/command-line-switches).
