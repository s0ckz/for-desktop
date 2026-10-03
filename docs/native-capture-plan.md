# Native screenshare plan

Updated 2 October 2026. This document records the tested baseline, completed work and remaining native capture roadmap for this fork. Desktop changes belong in `s0ckz/for-desktop`; browser telemetry belongs in `s0ckz/for-web`.

## Working baseline

Windows monitor and window sharing use Windows Graphics Capture (WGC), capture on the source adapter, scale/convert to NV12, perform bounded nonblocking GPU readback, deliver through a bounded MessagePort/ACK path and submit to Chromium's WebRTC encoder. Desktop Duplication remains an experimental opt-in monitor backend. Chromium capture remains available when native startup is unsupported or unusable.

The latest rainy LMU test used the Batch B build after a machine reboot. Another viewer confirmed smoothness at both 720p30 and 1080p30. FSR Quality and a 60 FPS game cap were planned; those settings were not independently recorded by analytics. Source resolution was 1920×1080 at 120 Hz on NVIDIA GeForce RTX 4060 Ti; H.264 was negotiated and actual encoder identity was unavailable.

Final three-minute sampled portions:

| Metric                               | Earlier rainy 720p30 | Latest rainy 720p30 | Latest rainy 1080p30 |
| ------------------------------------ | -------------------: | ------------------: | -------------------: |
| Retrieved source images/s            |                23.52 |               58.36 |                57.84 |
| Native emitted frames/s              |                22.37 |               29.99 |                29.99 |
| Sender encoded/sent frames/s         |                21.16 |               29.89 |                29.96 |
| Readback observation mean            |             82.64 ms |            16.89 ms |             16.84 ms |
| Estimated frame-weighted encode mean |              6.43 ms |             5.49 ms |             12.29 ms |

The latest tail windows contain approximately 177 seconds of matching logged intervals. Initial 720p intervals included source pauses and 10–20 FPS; its whole matched-preset sender mean was 26.31 FPS. The 1080p interval stayed near 30 FPS. 17,422 frames were successfully written and acknowledged, with no native/renderer/port errors, backpressure or expired readbacks.

Reboot, build, planned game cap and potentially physical source changed together. Display names differed across runs and can change with enumeration. These observations establish useful operation under the tested conditions, not a causal Batch B FPS gain or a guarantee of 30/60 FPS under every workload. Preserve this WGC baseline and confirm stability during ordinary rainy use before promoting another performance experiment.

## Completed batches

### A: measurement and native health

- Separate received, decoded, RTC-rendered and video-element compositor Presented FPS. Prefer counter deltas over browser estimates; keep estimates separately labelled.
- Display zero correctly, reset baselines across tracks/counter resets/visibility changes and invalidate stale asynchronous samples. Poll serially.
- Keep sender analytics active independently of the panel and report encoded/sent/source rates, bitrate, codec, encoder identity where available, limits and limitation durations without participant credentials or captured media.
- Detect an explicitly stopped native worker even if its death callback is lost. Preserve a live static/minimized source rather than interpreting silence alone as failure.
- Preserve signed source timestamp offsets, use monotonic JS elapsed time, separate stage counters and retain bounded ordered diagnostic logs.

### B: capture correctness and startup

- Classify WGC surface/content/interop failures. Device failures terminate immediately; other consecutive operational failures have an eight-failure budget reset by successful processing. Static/empty content does not spend the budget.
- Require validated native pixels and a successful first generator write or canvas draw/request before replacing Chromium. Retain the initial static image, bound startup and retire repeated renderer failures through the owning session's recovery.
- Guard WGC event signaling and handle retirement against callbacks already in flight. Revoke/close outside the handler mutex.
- Acknowledge accepted preset values using session, request and configuration-version guards. Serialize requests and keep actual delivered dimensions distinct from accepted targets. Enforce bounded constraints, source aspect ratio, even NV12 dimensions and the command-line cap.
- Keep Chromium available during audio setup; retire cancelled video/audio resources once, bound partial worklet startup and prevent late track publication. Preserve system-audio isolation safeguards.

Validation includes 25 desktop JavaScript tests, portable C++ failure/lifetime/policy tests, WGC/Duplication smoke checks on three physical monitors, six actual Electron native/port/generator/canvas starts, rebuilt addon/export checks, TypeScript/lint and exact packaged-binary/preload checks. Web sampler/helper regressions, full typecheck, production build and CI checks cover browser telemetry. Physical GPU removal and exhaustive fullscreen/HDR/display-removal tests remain outside this validation.

## Remaining batches and gates

| Batch                              | Work                                                                                                                                            | Promotion gate                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C: Duplication costs               | Isolate release/acquire ownership; investigate direct compatible BGRA processor input as a separate change                                      | Exact releases on all exits, access-loss/mode-change tests, bridge fallback preserved and a measured gain under matched game workload. WGC remains default.                    |
| D: adapter and color compatibility | Explicit monitor adapter selection, processor capability/content descriptors, color/HDR policy, cache ownership/retry and stale harness cleanup | NVIDIA/AMD capability probes, mixed DPI/negative coordinates, SDR color bars, HDR policy, rotated/removed display checks; ordinary presets and compatible fallbacks preserved. |
| E: AMD feasibility                 | Evaluate verified browser/encoder offload first; only then consider cross-adapter conversion/readback prototypes                                | Actual AMD work/encoder identity verified, transfer cost fits the budget, game and viewer frame-time/latency tails do not worsen and the route is reversible and opt-in.       |
| F: native ownership                | Environment/session/TSFN/payload lifetime, delayed shutdown and profiled reuse                                                                  | Queued-data cleanup, allocation/worker teardown and delayed-stop tests; no leaked sessions, use-after-free or unbounded exit. Preserve Electron external-buffer restrictions.  |

C is the next implementation candidate if the bottleneck recurs or 60 FPS capture becomes the objective. A stable 30 FPS baseline does not require switching backends. Adapter selection/capability fixes may be pulled forward as isolated prerequisites for AMD experiments; keep large color/HDR changes separate from throughput comparisons.

## AMD options, benefits and risks

| Option                                                   | Possible benefit                                        | Cost or failure risk                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep NVIDIA capture; run Chromium/WebRTC encoding on AMD | Relieve NVIDIA encoding or downstream contention        | Browser GPU preference may affect the whole renderer, may not select AMD encoding and may add cross-adapter transfer. H.264 negotiation alone does not prove NVENC or AMD encoding.                   |
| NVIDIA acquisition, AMD conversion/scaling/readback      | Move more processing away from the saturated GPU        | Full-resolution transfer precedes scaling. Cross-vendor texture sharing/synchronization may be unsupported; CPU staging can cost more than it saves. Resize, HDR and device loss complicate recovery. |
| Move the captured display to AMD                         | Avoid some acquisition cross-adapter constraints        | Requires physical display routing; may change the game's rendering/presentation path and worsen game performance. It is a separate configuration experiment.                                          |
| Custom native AMD encoder integrated with RTC            | Explicit encoder choice and potentially fewer transfers | Large integration: encoded-track publication, codec negotiation, timestamps, rate control, keyframes, transport and A/V sync. It is not a small replacement for the current Chromium track.           |

Encoder-only offload cannot create source images that acquisition never supplied. The integrated GPU has limited shared memory/bandwidth and platform-specific media capabilities; verify the actual supported pipeline on this machine before adopting a route. Stop a feasibility route if AMD work cannot be selected and verified. Do not double-encode just to fit a custom encoder into the existing path.

## Measurement and release discipline

Use the same physical monitor, game scene/weather/lap markers, game cap, FSR, share preset, viewer and network route for comparisons. Record native, sent, decoded and presented rates alongside game/viewer frame-time tails, longest stalls, source age/readback/transfer time, actual adapter/encoder identity, queue/drop counts and A/V sync. A moving source marker can identify repeated content; do not hash full frames continuously in production. Compositor Presented FPS is not physical scanout or unique-motion FPS.

Native diagnostics live in `%APPDATA%/stoat-desktop/logs/app-audio.log`; preserve rotation archives and exact build/session identities. Accepted targets can precede new-sized delivered pixels. Readback observation includes GPU readiness plus polling delay; submission CPU time is not GPU execution time.

Ship web telemetry and desktop capture together through their existing PRs. Web `main` builds `ghcr.io/s0ckz/for-web:main`; updating the running service must use the existing production deployment mechanism and retain the backend configuration. Desktop `main` triggers the versioned Windows/Squirrel release workflow; CI computes the version from release tags. Do not hand-edit versions or replace the release process with the locally versioned test executable. Verify released assets, update feed and served web telemetry after deployment. Keep rollback source/image/release identities in the deployment record.
