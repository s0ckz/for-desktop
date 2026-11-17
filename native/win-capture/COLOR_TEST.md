# Screen share color conversion

The capture pipeline takes full-range SDR BGRA and produces limited-range
BT.709 NV12. `src/capture_color.h` configures every newly created video
processor; `src/native/screenCapturePatch.ts` explicitly declares the same
range and matrix when constructing each `VideoFrame`. Both WGC and desktop
duplication use this conversion, as do generator and canvas delivery.

Do not rely on video-processor defaults. On the tested NVIDIA GeForce RTX
4060 Ti, the previous unconfigured processor emitted full-range YUV (black
0, white 255). WebCodecs defaults non-RGB frames to limited-range BT.709.
Reading those pixels as limited range crushed shadows and clipped highlights
before either local preview or encoding. Driver defaults can differ.

The explicit processor output has black 16, white 235, neutral chroma 128,
and BT.709 matrix coefficients. Automatic video enhancements are disabled.
This is the existing SDR transport; it does not add HDR tone mapping.

## GPU regression test

From an x64 Visual Studio developer PowerShell at the repository root:

```powershell
cl /nologo /EHsc /std:c++17 /DNOMINMAX native/win-capture/test-color.cc /Fe:$env:TEMP/capture-color-test.exe /Fo:$env:TEMP/capture-color-test.obj /link d3d11.lib
& "$env:TEMP/capture-color-test.exe"
```

This uses the actual hardware video processor and the production color
configuration. It checks a grayscale ramp, saturated primaries, and mixed
colors against limited-range BT.709 equations (one code-value tolerance).
An unsupported video processor is an explicit failure, not a skipped pass.

An optional first argument writes the packed 256x32 NV12 fixture. A second
argument, `--defaults`, omits the production configuration for comparison;
the assertions still require the correct output, so a wrong driver default
causes a nonzero exit code. This comparison need not fail on every driver.

```powershell
& "$env:TEMP/capture-color-test.exe" "$env:TEMP/capture-fixed.nv12"
& "$env:TEMP/capture-color-test.exe" "$env:TEMP/capture-defaults.nv12" --defaults
node --test src/native/screenCapture.hardening.test.cjs
```

## Local verification

On Electron 43.4.0 / Chromium 150.0.7871.224, GPU-generated fixtures were
passed through the production renderer patch, both generator and canvas,
and a local H.264 Constrained Baseline peer connection. The source grayscale
ramp `[0,16,32,64,96,128,160,192,224,235,255]` produced:

| Stage                     | Previous defaults                        | Explicit conversion                       |
| ------------------------- | ---------------------------------------- | ----------------------------------------- |
| Preview, both paths       | `[0,0,19,56,93,130,168,205,242,255,255]` | `[0,16,33,64,95,128,159,192,223,235,255]` |
| H.264 receiver, generator | Same as preview                          | Same as preview                           |
| H.264 receiver, canvas    | Same as preview                          | `[0,16,33,64,95,128,159,192,222,235,255]` |

These are sampled RGB pixel values, not a physical display measurement or
a live SFU test. Saturated-color errors remain in Chromium's rendering and
canvas/encoder conversions; the one-to-two-level result above describes
grayscale, not all RGB channels.

References: [D3D11 color-space members](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ns-d3d11-d3d11_video_processor_color_space),
[nominal ranges](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_video_processor_nominal_range),
and [WebCodecs color-space selection](https://www.w3.org/TR/webcodecs/#pick-color-space).
