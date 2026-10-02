<div align="center">
<h1>
  Stoat for Desktop
  
  [![Stars](https://img.shields.io/github/stars/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/stargazers)
  [![Forks](https://img.shields.io/github/forks/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/network/members)
  [![Pull Requests](https://img.shields.io/github/issues-pr/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/pulls)
  [![Issues](https://img.shields.io/github/issues/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/issues)
  [![Contributors](https://img.shields.io/github/contributors/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/graphs/contributors)
  [![License](https://img.shields.io/github/license/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/blob/main/LICENSE)
</h1>
Application for Windows, macOS, and Linux.
</div>
<br/>

## Installation

<a href="https://repology.org/project/stoat-desktop/versions">
    <img src="https://repology.org/badge/vertical-allrepos/stoat-desktop.svg" alt="Packaging status" align="right">
</a>

- All downloads and instructions for Stoat can be found on our [Website](https://stoat.chat/download).

## Releases & Auto-Update

Releases are cut automatically by [`win-app-audio.yml`](.github/workflows/win-app-audio.yml) on every push to `main`. It looks at the commits since the last `v[0-9]*` tag and applies [release-please](https://github.com/googleapis/release-please)'s own bump rule to their subjects: any `feat:` bumps minor, else any `fix:`/`perf:`/`revert:` bumps patch, else (only `chore:`/`docs:`/`ci:`/`style:`/`test:`/`refactor:`) nothing is released. A `!` before the colon, or a `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer at the start of a line, forces a major bump regardless.

**`main`'s current version is read from the latest `v<version>` git tag, not from `package.json`.** When a release is warranted, the workflow writes the new version into `package.json` *in the CI runner's working tree only* — it is never committed, and nothing is ever pushed to `main` — then tags and pushes `v<version>`, and only *after* that builds from that bumped source and publishes a real GitHub release (not a pre-release) containing the full Squirrel output (`RELEASES`, the `*-full.nupkg`, and `Setup.exe`) — no portable `.zip` is included in a versioned release; see below. **`package.json` on `main` is consequently stale by design and does not reflect the released version** — do not read it as one. The `v<version>` tags are the only durable record of what has actually shipped, and every release is computed from the latest one.

This is a deliberate change from an earlier version of this workflow, which *did* commit the bump (as `chore(release): v<version>`) and push it straight to `main`. `main` carries a repository ruleset requiring changes to go through a pull request, and that direct push was rejected by it (GitHub error `GH013`) on this workflow's first two real release-worthy runs. The clean fix — adding the `github-actions` app to the ruleset's bypass list — needs the repo owner and was not adopted, so the workflow stopped pushing to `main` at all rather than continuing to fail against a rule that was never going to open for it. If that bypass is ever added later, restoring the commit-and-push is possible but not a small change — the version this replaced also deleted a 5-attempt fetch/rebase retry loop and its branch-ruleset GH013 detection, both needed only because a direct push races a `main` that can move underneath it, so reverting means rewriting that from scratch. Reading the current version from the latest tag rather than `package.json` should stay either way — it isn't something this change should undo, since the tag is the one record that can't silently stop advancing.

If a build or publish step fails *after* the version's tag has already been pushed, the workflow deletes that `v<version>` tag so there's never a tag without a matching release. There is no version-bump commit to worry about cleaning up on `main` in this case any more — nothing is ever committed there.

If instead the tag push itself never lands, the workflow does not abort. It restores `package.json` to its pre-bump state in the runner's working tree and still builds and republishes the rolling `win-per-app-audio` pre-release below from that unbumped source, exactly as it would on a push that never warranted a release at all. The run still ends red on purpose, because a release that was due and silently didn't happen needs to be noticed — check the last step's log for the actual cause rather than assuming the rolling build failed too. (The likeliest cause is a plain "tag already exists" rejection, not a ruleset — no tag-protection ruleset is known to exist on this repo, and both real `GH013` failures hit here so far were on the branch ruleset governing `main`, not a tag ruleset; see the workflow's own comments for how it tells the two apart.)

`CHANGELOG.md` and `release-please-config.json`/`.release-please-manifest.json` are left over from when this repo ran the actual [release-please](https://github.com/googleapis/release-please) GitHub Action; that workflow was removed, so nothing updates `CHANGELOG.md` anymore. `win-app-audio.yml` no longer writes to `.release-please-manifest.json` either — with no commit ever landing on `main`, doing so would be a pure no-op, so that step was removed along with the branch push. The manifest file (and `release-please-config.json`) now sit entirely unused.

Two things to know about how updates actually reach users:

- **Auto-update only works for the `Setup.exe` install.** The app uses Squirrel.Windows for updates, and Squirrel only knows how to patch an install it made itself. The portable `.zip` build (only ever produced by the rolling pre-release below, not by a versioned release) has no updater wired into it at all -- it has to be re-downloaded by hand for a new version.
- **The rolling `win-per-app-audio` build is not, and cannot be, an update source.** It publishes a "latest main build" download on a fixed tag for testing, and it's deliberately marked as a pre-release so it doesn't fight with real releases for that tag name. `update.electronjs.org` (what the app's auto-updater talks to) only ever serves the latest release that is *both* semver-tagged *and* not a pre-release, so it ignores that build entirely -- by design, not by accident.

## Development Guide

_Contribution guidelines for Desktop app TBA!_

<!-- Before contributing, make yourself familiar with [our contribution guidelines](https://developers.revolt.chat/contrib.html), the [code style guidelines](./GUIDELINES.md), and the [technical documentation for this project](https://revoltchat.github.io/frontend/). -->

Before getting started, you'll want to install:

- [Git](https://git-scm.com/install/)
- [mise-en-place](https://mise.jdx.dev/getting-started.html)

Then proceed to setup:

```bash
# clone the repository
git clone --recursive https://github.com/stoatchat/for-desktop stoat-for-desktop
cd stoat-for-desktop

# Install tools from mise
mise install

# install all packages
mise install:frozen

# start the application
mise dev
# ... or build the bundle
mise build
# ... or build all distributables
mise make
```

Various useful commands for development testing:

```bash
# connect to the development server
mise exec -- pnpm start -- --force-server=http://localhost:5173

# test the flatpak (after `make`)
mise exec -- pnpm install:flatpak
mise exec -- pnpm run:flatpak
# ... also connect to dev server like so:
mise exec -- pnpm run:flatpak --force-server=http://localhost:5173

# Nix-specific instructions for testing
pnpm package
pnpm run:nix
# ... as before:
pnpm run:nix --force-server=http://localhost:5173
# a better solution would be telling
# Electron Forge where system Electron is
```

### Pulling in Stoat's assets

If you want to pull in Stoat brand assets after pulling, run the following:

```bash
# update the assets
mise assets
```

Currently, this is required to build, any forks are expected to provide their own assets.

## Screen share diagnostics

On Windows, native window and monitor shares write diagnostics to
`%APPDATA%/stoat-desktop/logs/app-audio.log`. Rotation retains the current 2MiB
file plus four numbered archives (`.1` is newest); preserve all five files
when comparing sessions. Start/final snapshots identify the session, target,
app/Electron/native build and actual capture adapter/monitor/backend.
`screen capture: stages` is emitted
approximately every 10 seconds independently of pixel delivery, including
when a share has frozen. It reports incoming frames, frames discarded while
draining the pool, pacing skips, processing attempts/failures, surface/pool
read failures, submitted/emitted frames, expired/coalesced readbacks and
readback/queue pressure as **interval deltas**. `stillDrawing` now counts
nonblocking polls with pending GPU work; it does **not** count dropped frames.
`ringFull` counts skipped submissions. `expiredReadbacks` counts completed
copies older than 250ms discarded when newer source submissions exist; the
last/static image is retained. `sessionMaxFrameAgeMs` measures source-to-native
delivery age, excluding renderer/encoder/network latency. `delivery` contains
cumulative posts, acknowledgements, coalesces and failures, plus queue state.
Renderer counters distinguish construction, backpressure, accepted writes,
write errors and canvas draws. `incomingFps`
is the retrieved source frame rate, not encoded or viewer FPS. `longLoopGaps`
counts intervals exceeding twice the requested frame interval;
`sessionMaxLoopGapMs` is a session maximum. Loop gaps include waiting,
scheduling, and prior processing; they are not GPU execution timings.
`loopIdleMs` and `frameDroughtMs` distinguish lack of thread progress from
lack of delivered frames. `lastError` may describe a recovered failure.

`timings` contains cumulative bounded-memory distributions: `sourceGap`
(source timestamp intervals), `acquireAge` (source timestamp to acquisition),
`readbackWait` (copy submission to successful nonblocking Map), `frameAge`
(source timestamp to Map, including readbacks later expired), and CPU wall
time for acquisition, GPU bridge submission and pipeline submission.
These are approximate snapshots; p50/p95/p99 are histogram bucket upper
bounds, not exact percentiles. Empty distributions have null values.
Readback wait includes GPU queue/execution, thread scheduling and polling
delay; it does not isolate GPU execution. Source dimensions and adapter LUID
help detect unexpected resolution and cross-adapter capture.

Monitor capture defaults to Windows Graphics Capture (WGC). An experimental
Desktop Duplication backend is selected with `--native-monitor-backend=duplication`
or `run-capture-test.ps1 -Backend duplication`. Windows still use WGC.
The prototype creates its device on the monitor's adapter, normalizes pixels
on the GPU, and reuses the existing NV12/downscale/readback/delivery pipeline.
It polls acquisition without blocking, ignores cursor-only updates and retries
access loss at most five times per recovery episode. Unsupported initial setup
falls back to WGC and records the reason. Failures after readiness end the session.
Rotated outputs are unsupported. Hardware cursor overlay is not implemented;
HDR scRGB input is converted to SDR with clipped highlights. This backend is
for FPS comparison, pending game/fullscreen/display-transition and image-quality
validation; it is not a claim of improved performance under GPU saturation.

The matching web-client sender diagnostics appear as `[rtc] screen share sender`
and are forwarded into this same file by the desktop shell. These require the
web-client diagnostics change to be loaded, either from its hosted deployment
or with `--force-server` pointing to a local client. Closing the stats panel
does not stop collection. These measurements do not alter capture quality,
codec choice, bitrate, or scheduling.

Validation commands:

```powershell
node src/native/screenCapture.behavior.test.cjs
node src/native/screenCapture.diagnostics.test.cjs
node src/native/diagnosticLog.test.cjs
node src/native/appAudio.log.test.cjs
node native/win-capture/check-exports.js
node native/win-capture/check-package.js out-capture-batch3/Stoat-win32-x64
# After rebuilding the native addon for Electron:
.\node_modules\electron\dist\electron.exe native/win-capture/test-diagnostics.js
```

The Electron smoke test captures attached monitors briefly and requires a
delivered first image, including a static monitor. It checks counters,
teardown and invalid monitor selection. Compile `test-policy.cc` with a
C++17 compiler for deterministic pacing, sizing, recovery, metrics and freshness
tests. `test-bridge.cc` validates known SDR and HDR pixels on D3D11 WARP; link
with d3d11.lib and d3dcompiler.lib. The smoke test runs both backends on all
attached monitors (or accepts `wgc` / `duplication` as its first argument).

Native frame submission uses bounded timestamp credit to tolerate jitter;
pending readbacks drain independently of source arrivals. The main-to-renderer
port allows one frame in transit and one replaceable latest frame, validated
by session/frame acknowledgements. Generator backpressure is checked before
constructing a VideoFrame; the canvas fallback manually requests each draw.
CPU submission/readback timings are not GPU execution timings. Readiness
confirms native setup before Chromium's original track is stopped.

On Windows, `native/win-capture/build-electron.ps1` synchronizes the copied
file dependency, rebuilds against the installed Electron headers, and fails
on missing/stale binaries. It also accepts `-Module win-app-audio`.
For the local packaged test build, `run-capture-test.ps1 -CheckOnly` verifies
the packaged native binary and local web sender diagnostics. Without
`-CheckOnly`, it requires other Stoat instances to be closed, verifies the
web frontend served on port 4173, then opens the test app with
`--force-server=http://127.0.0.1:4173`. The desktop package does not bundle the
web UI. No backend configuration changes are made by this helper.
