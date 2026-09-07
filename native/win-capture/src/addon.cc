// GPU-downscaled window capture for Windows.
//
// Chromium's own desktop capture path (Windows.Graphics.Capture wrapped by
// DesktopCaptureDevice) always copies the ENTIRE captured surface GPU->CPU
// before anything downstream gets to touch it, and throttles itself to
// 2 x last_capture_duration between frames. At 3440x1440 under game-GPU
// contention that grab alone measures ~31ms, which caps capture at ~16fps --
// nowhere near the 30fps/16.6ms budget a screen share needs.
//
// This module reverses the order: scale AND convert colour space to NV12 on
// the GPU (ID3D11VideoProcessor::VideoProcessorBlt, a single fixed-function
// hardware step on Intel/AMD/NVIDIA alike) and only then read back -- so the
// CPU copy moves ~1.5MB instead of ~20MB. It is also not a
// DesktopCaptureDevice, so Chromium's 2x-duration governor never applies.
//
// Frames are delivered as NV12 (Y plane, then interleaved UV) at exactly the
// size fit inside targetWidth x targetHeight, aspect preserved.
//
// Threading model, deliberately simple: capture runs entirely from ONE
// dedicated thread that we own end to end -- it creates the D3D11 device,
// the WGC capture item/session/frame pool, subscribes to the pool's
// FrameArrived event, and waits on that subscription (CaptureThread, below)
// instead of polling TryGetNextFrame() on a fixed cadence.
//
// This module used to poll instead, on purpose, specifically to avoid
// implementing the ABI's parameterized
// ITypedEventHandler<Direct3D11CaptureFramePool, IInspectable> callback
// interface. That tradeoff is reversed here: polling at ~fps against a
// source presenting at its own unrelated rate is a sampling-vs-source-rate
// aliasing problem, and it showed up exactly where that theory predicts -- a
// 60Hz game polled at ~60Hz drifts in and out of phase with its own presents,
// so some polls see 0 new frames and the next sees 2 (dup/skip judder despite
// every individual frame being correct), plus up to one whole poll interval
// of pure latency between a present and this thread noticing it. Subscribing
// removes both, and implementing the callback interface needed nothing more
// than a small Microsoft::WRL::RuntimeClass<ClassicCom, ITypedEventHandler
// <...>> -- see FrameArrivedHandler below -- not the extra projection
// machinery the old comment here worried about. Frame pools created with
// CreateFreeThreaded() never needed a DispatcherQueue/message pump either
// way, polled or subscribed; that part of the old reasoning was never the
// actual issue.
//
// FrameArrived's handler does nothing but SetEvent() a HANDLE this thread
// waits on -- see FrameArrivedHandler's own comment for why nothing else is
// safe there. Delivery is paced on each frame's own
// frame->get_SystemRelativeTime() (a 100ns-unit timestamp WGC stamps on the
// frame itself) rather than on wall-clock arrival time -- see the pacing
// comment above lastDeliveredTs in CaptureThread for why that, not the event
// subscription by itself, is what removes the aliasing above. A
// CreateWaitableTimerExW high-resolution timer still wakes this loop roughly
// once an interval when FrameArrived does not fire at all (a static window
// legitimately produces no FrameArrived events), purely so the liveness
// checks -- window still exists, stop requested -- keep running promptly; it
// has no say any more in which frames get delivered.
//
// Every frame we retrieve and don't use -- draining the pool to the newest
// one, or a frame arriving faster than the requested pacing allows -- is
// released immediately (its ComPtr going out of scope), which is what
// returns the buffer to the pool, so a "drop" costs nothing beyond the
// Release.

#include <napi.h>

#include <windows.h>
#include <roapi.h>
#include <winstring.h>
#include <inspectable.h>
#include <wrl/client.h>
#include <wrl/implements.h>  // Microsoft::WRL::RuntimeClass/MakeAndInitialize -- see FrameArrivedHandler
#include <timeapi.h>  // timeBeginPeriod/timeEndPeriod -- see CaptureThread (fallback path only, now)

#include <d3d11.h>
#include <dxgi.h>

#include <windows.graphics.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.h>
#include <windows.graphics.directx.direct3d11.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace WG = ABI::Windows::Graphics;
namespace WGC = ABI::Windows::Graphics::Capture;
namespace WGDD = ABI::Windows::Graphics::DirectX::Direct3D11;

// ---------------------------------------------------------------------------
// Small WinRT activation helper. The runtime classes we need
// (GraphicsCaptureItem, Direct3D11CaptureFramePool, GraphicsCaptureSession)
// are OS-provided -- there is no app metadata to register, RoGetActivationFactory
// resolves them directly from the system's own WinMD.
// ---------------------------------------------------------------------------

template <typename T>
HRESULT GetActivationFactory(const wchar_t* runtimeClass, ComPtr<T>& out) {
  HSTRING name = nullptr;
  HRESULT hr = WindowsCreateString(runtimeClass, static_cast<UINT32>(wcslen(runtimeClass)), &name);
  if (FAILED(hr)) return hr;
  hr = RoGetActivationFactory(name, IID_PPV_ARGS(&out));
  WindowsDeleteString(name);
  return hr;
}

namespace {

// ---------------------------------------------------------------------------
// Capture session state -- all of it lives only between Start() and the
// capture thread's teardown, and (g_lastError aside) is only ever touched
// from that one thread; the JS-facing Start()/Stop()/LastError() calls only
// set flags, create/close g_stopEvent, or (Stop(), via StopWorker) join it.
// g_lastError is the one exception: it is written by the capture thread but
// also read AND written from the JS thread (IsSupported()), so it alone
// needs the mutex below -- see its own comment for why.
// ---------------------------------------------------------------------------

std::thread g_thread;
std::atomic<bool> g_running{false};
// Set the instant a stop is requested (signalStop, or the AddCleanupHook
// path) and cleared only once the join has actually completed (StopWorker::
// OnOK/OnError). g_thread itself cannot serve as that flag once Stop()
// std::move()s it into the worker -- joinable() goes false the moment the
// move happens, well before the join it names has finished -- so this is
// the one thing Start() can check to refuse "previous capture still
// shutting down" for the whole window the async join is in flight.
std::atomic<bool> g_stopping{false};
HANDLE g_stopEvent = nullptr;
Napi::ThreadSafeFunction g_tsfn;
// stop() calls that arrived while g_stopping was already true -- i.e. while
// an earlier stop()'s StopWorker join was still in flight. Resolved (or
// rejected, on the OnError path) alongside the primary deferred once that
// join actually completes -- see Stop()'s own comment for why this exists.
// JS-thread-only: Stop() and StopWorker::OnOK/OnError both run there, so no
// lock is needed.
std::vector<Napi::Promise::Deferred> g_pendingStopDeferreds;

// g_lastError is written by the capture thread (SetError, and the dropped-
// death-signal message in Emit) while the JS/main thread both reads it
// (LastError()) and writes it (IsSupported(), which buildState() in the JS
// layer reaches on every broadcastState() -- so this races on essentially
// every frame). std::string is not safe to read/write concurrently without
// this: a torn SSO-to-heap transition is real UB, not just a stale-value
// nuisance. The mutex is intentionally the least clever fix available --
// every access goes through GetErrorText()/SetErrorText() below, never the
// bare variable.
//
// Named GetErrorText/SetErrorText, not GetLastError/SetLastError: those are
// Win32 API functions (windows.h, above), and a same-named helper in this
// anonymous namespace shadows them for every unqualified call below it in
// this translation unit -- IsSupported()'s GetLastError() calls a few
// hundred lines down need the real Win32 one back.
std::mutex g_lastErrorMutex;
std::string g_lastError;

std::string GetErrorText() {
  std::lock_guard<std::mutex> lock(g_lastErrorMutex);
  return g_lastError;
}

void SetErrorText(std::string message) {
  std::lock_guard<std::mutex> lock(g_lastErrorMutex);
  g_lastError = std::move(message);
}

/**
 * Buffers in the WGC frame pool.
 *
 * Left at 2 -- the WGC default -- because raising it was measured and did
 * nothing. The hypothesis was that holding one frame for the whole of
 * ProcessFrame left WGC only one buffer to capture into, forcing it to wait
 * for our release and land the next frame a vsync later, which would produce
 * delivery at exactly half the refresh rate. That matched the symptom
 * suspiciously well (49.5fps measured on a 99Hz display, twice) and it is
 * what Chromium's ZeroCopyDesktopCapture path does (2 -> 5).
 *
 * It is still wrong: at 4 buffers the delivered rate was 49.56 and 49.49fps
 * across two runs -- identical to 2 buffers, to within noise. Each buffer is
 * a full BGRA copy of the *source* surface (~20MB at 3440x1440), so raising
 * this costs real GPU memory for no measured gain.
 *
 * Recorded here so the next person does not spend the same afternoon on it.
 * The ~49.5fps ceiling at a 60fps target was the poll-vs-present aliasing
 * the file header now describes -- see there, and lastDeliveredTs's comment
 * in CaptureThread, for the fix (event-driven capture, paced on real frame
 * timestamps) rather than a buffer-count workaround.
 */
constexpr int kFramePoolBuffers = 2;

/**
 * Target bounding box frames are scaled to fit inside -- see EnsurePipeline's
 * fit-inside comment for the exact math. Atomic for the same reason as g_fps
 * just below, and changed the same way (SetTarget(), item 1 of PR C3): the
 * web client's screen-share quality picker resolves *after* the share has
 * already started, so a box fixed at Start() would strand every later preset
 * change (1080p -> 720p) the same way a rate fixed at Start() used to strand
 * a framerate change -- see SetTarget()'s own doc comment.
 */
std::atomic<UINT32> g_targetW{0};
std::atomic<UINT32> g_targetH{0};
/**
 * Delivery cadence, changeable while capture is running.
 *
 * Atomic because the capture thread reads it every iteration while SetFps()
 * writes it from the JS thread. The web client picks a screen-share quality
 * *after* the share has already started (the picker resolves once capture is
 * live), so a rate fixed at Start() would strand every later quality change --
 * which is exactly the bug this exists to fix.
 */
std::atomic<double> g_fps{30.0};

ComPtr<ID3D11Device> g_device;
ComPtr<ID3D11DeviceContext> g_context;
ComPtr<ID3D11VideoDevice> g_videoDevice;
ComPtr<ID3D11VideoContext> g_videoContext;
ComPtr<WGDD::IDirect3DDevice> g_wgDevice;
ComPtr<WGC::IDirect3D11CaptureFramePoolStatics2> g_poolStatics2;
ComPtr<WGC::IGraphicsCaptureItem> g_item;
ComPtr<WGC::IDirect3D11CaptureFramePool> g_framePool;
ComPtr<WGC::IGraphicsCaptureSession> g_session;

// Rebuilt by EnsurePipeline() whenever the TEXTURE we actually hold changes
// size. Deliberately keyed on the texture, not on the window's content size:
// see EnsurePool below (which owns the frame pool, keyed on content size
// instead) and the ProcessFrame call site in CaptureThread for why the two
// are tracked separately and can disagree for up to one frame after a
// resize.
ComPtr<ID3D11VideoProcessorEnumerator> g_vpEnum;
ComPtr<ID3D11VideoProcessor> g_videoProcessor;
ComPtr<ID3D11Texture2D> g_outputTex;  // D3D11_USAGE_DEFAULT, NV12, VP output target
ComPtr<ID3D11VideoProcessorOutputView> g_outputView;
UINT32 g_srcW = 0;  // dimensions EnsurePipeline last built the VP/textures for
UINT32 g_srcH = 0;
UINT32 g_outW = 0;
UINT32 g_outH = 0;
UINT32 g_lastTargetW = 0;  // g_targetW/g_targetH EnsurePipeline last built the above for
UINT32 g_lastTargetH = 0;

/**
 * Staging texture ring depth (item 2 of PR C3).
 *
 * Was a single D3D11_USAGE_STAGING texture: CopyResource into it, then
 * Map(D3D11_MAP_READ) with no flags, which -- CopyResource only *starts* the
 * GPU copy, it does not wait for it -- forced a full CPU/GPU pipeline stall
 * on every single frame. Under game-GPU contention that stall was real time,
 * not free synchronisation.
 *
 * Now: CopyResource into the NEXT slot, and Map the PREVIOUS one with
 * D3D11_MAP_FLAG_DO_NOT_WAIT (see ProcessFrame). Whatever GPU work is still
 * outstanding for the previous slot started a whole frame interval ago, so
 * by the time this call reaches it, it is normally done; DO_NOT_WAIT turns
 * "normally" into a guarantee -- Map() returns immediately either way,
 * DXGI_ERROR_WAS_STILL_DRAWING if the GPU is for some reason still behind,
 * in which case that frame is skipped exactly like any other pacing drop
 * rather than blocked on.
 *
 * 2 is the minimum that works (one slot being written, one being read) and
 * is what the plan asks for. A deeper ring would tolerate the GPU falling
 * further behind before a frame gets skipped, at the cost of more latency
 * and memory per extra slot -- not worth it unless 2 is measured to skip
 * often in practice, which C3's own verification (grabMs, dropped-before-
 * encode) will show if it ever needs revisiting.
 */
constexpr int kStagingRingSize = 2;
struct StagingSlot {
  ComPtr<ID3D11Texture2D> tex;  // D3D11_USAGE_STAGING, CPU-readable copy of g_outputTex
  // This slot's own frame timestamp, captured at CopyResource time and read
  // back out one call later alongside the pixels -- see ProcessFrame. Without
  // this, the ring's one-frame delivery lag would pair frame N's own
  // timestampUs with frame N-1's pixels, silently reintroducing the kind of
  // timestamp/content mismatch PR C2 removed.
  double timestampUs = 0;
};
StagingSlot g_stagingRing[kStagingRingSize];
int g_stagingRingIndex = 0;   // next slot ProcessFrame will CopyResource into
int g_stagingRingFilled = 0;  // slots written at least once since the last EnsurePipeline rebuild, capped at kStagingRingSize

// The frame pool's own buffer size, tracked separately from g_srcW/g_srcH --
// see EnsurePool.
UINT32 g_poolW = 0;
UINT32 g_poolH = 0;

void SetError(const char* stage, HRESULT hr) {
  char buf[192];
  snprintf(buf, sizeof(buf), "%s failed (hr=0x%08lX)", stage, static_cast<unsigned long>(hr));
  SetErrorText(buf);
}

// desktopCapturer hands window ids out as strings; accept either form, same
// convention win-app-audio uses for the same source-id shape.
HWND HwndFromValue(const Napi::Value& value) {
  unsigned long long raw = 0;
  if (value.IsString()) {
    raw = strtoull(value.As<Napi::String>().Utf8Value().c_str(), nullptr, 10);
  } else if (value.IsNumber()) {
    raw = static_cast<unsigned long long>(value.As<Napi::Number>().Int64Value());
  }
  if (!raw) return nullptr;
  return reinterpret_cast<HWND>(static_cast<uintptr_t>(raw));
}

// ---------------------------------------------------------------------------
// (Re)create the WGC frame pool for a given content size.
//
// Split out from EnsurePipeline (below) on purpose: this is keyed on the
// window's CURRENT content size (what we ask WGC to capture into), while
// EnsurePipeline is keyed on the dimensions of whatever texture we actually
// have in hand *right now*. Those two were the same call once, sharing one
// cached size (g_srcW/g_srcH) -- which is exactly what produced the original
// bug (see the REJECTED comment at the ProcessFrame call site in
// CaptureThread): recreating the pool and rebuilding the video processor
// together, off the frame's ContentSize, while still holding a texture from
// the *old* pool. Keeping them separate means a resize can update the pool
// for future frames without ever touching what this frame is blitted with.
// ---------------------------------------------------------------------------

bool EnsurePool(UINT32 w, UINT32 h) {
  if (w == g_poolW && h == g_poolH && g_framePool) return true;

  HRESULT hr;
  WG::SizeInt32 size{static_cast<INT32>(w), static_cast<INT32>(h)};

  if (!g_framePool) {
    hr = g_poolStatics2->CreateFreeThreaded(
        g_wgDevice.Get(), WG::DirectX::DirectXPixelFormat_B8G8R8A8UIntNormalized,
        kFramePoolBuffers, size, &g_framePool);
    if (FAILED(hr)) {
      SetError("Direct3D11CaptureFramePool::CreateFreeThreaded", hr);
      return false;
    }
  } else {
    hr = g_framePool->Recreate(
        g_wgDevice.Get(), WG::DirectX::DirectXPixelFormat_B8G8R8A8UIntNormalized,
        kFramePoolBuffers, size);
    if (FAILED(hr)) {
      SetError("Direct3D11CaptureFramePool::Recreate", hr);
      return false;
    }
  }
  g_poolW = w;
  g_poolH = h;
  return true;
}

// ---------------------------------------------------------------------------
// (Re)build the video processor + output/staging textures for the size of the
// texture we are about to blit. Cheap to call every frame (it no-ops when
// nothing changed, which is every frame between resizes); expensive only on
// the first frame and right after a resize lands a differently-sized texture.
// Does NOT touch the frame pool -- see EnsurePool above.
// ---------------------------------------------------------------------------

bool EnsurePipeline(UINT32 srcW, UINT32 srcH) {
  // Re-keyed on the TARGET as well as the source size, since PR C3 item 1:
  // SetTarget() can change g_targetW/g_targetH while this pipeline is
  // otherwise perfectly valid for the current source size (a mid-share
  // 1080p -> 720p preset change on a window that never resized), and that
  // must rebuild the video processor and output/staging textures for the new
  // output box exactly the way a source resize already does.
  const UINT32 targetW = g_targetW.load(std::memory_order_relaxed);
  const UINT32 targetH = g_targetH.load(std::memory_order_relaxed);
  if (srcW == g_srcW && srcH == g_srcH && targetW == g_lastTargetW && targetH == g_lastTargetH && g_vpEnum) {
    return true;
  }

  HRESULT hr;

  // Fit-inside scaling: never stretch, always fit the whole source inside the
  // requested bounding box, then round to the nearest even number on each
  // axis -- NV12 requires even dimensions (the chroma plane is subsampled
  // 2x2). A 3440x1440 source targeting a 1920x1080 box is width-constrained
  // (scale = 1920/3440) and lands on 1920x804, not 1920x1080.
  //
  // Clamped to 1: without it, a source smaller than the target box (an
  // 800x600 window against the 1920x1080 target) gets scale > 1 here and is
  // blown up to fill the box, spending bitrate on invented pixels instead of
  // the real ones. Fit-inside should only ever shrink.
  const double scale = (std::min)({static_cast<double>(targetW) / srcW,
                                    static_cast<double>(targetH) / srcH,
                                    1.0});
  UINT32 outW = static_cast<UINT32>(std::lround(srcW * scale));
  UINT32 outH = static_cast<UINT32>(std::lround(srcH * scale));
  if (outW % 2) outW += 1;
  if (outH % 2) outH += 1;
  outW = (std::max)(outW, 2u);
  outH = (std::max)(outH, 2u);

  D3D11_VIDEO_PROCESSOR_CONTENT_DESC vpDesc{};
  vpDesc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  vpDesc.InputWidth = srcW;
  vpDesc.InputHeight = srcH;
  vpDesc.OutputWidth = outW;
  vpDesc.OutputHeight = outH;
  vpDesc.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;

  ComPtr<ID3D11VideoProcessorEnumerator> vpEnum;
  hr = g_videoDevice->CreateVideoProcessorEnumerator(&vpDesc, &vpEnum);
  if (FAILED(hr)) {
    SetError("CreateVideoProcessorEnumerator", hr);
    return false;
  }

  ComPtr<ID3D11VideoProcessor> vp;
  hr = g_videoDevice->CreateVideoProcessor(vpEnum.Get(), 0, &vp);
  if (FAILED(hr)) {
    SetError("CreateVideoProcessor", hr);
    return false;
  }

  D3D11_TEXTURE2D_DESC outDesc{};
  outDesc.Width = outW;
  outDesc.Height = outH;
  outDesc.MipLevels = 1;
  outDesc.ArraySize = 1;
  outDesc.Format = DXGI_FORMAT_NV12;
  outDesc.SampleDesc.Count = 1;
  outDesc.Usage = D3D11_USAGE_DEFAULT;
  outDesc.BindFlags = D3D11_BIND_RENDER_TARGET;
  ComPtr<ID3D11Texture2D> outTex;
  hr = g_device->CreateTexture2D(&outDesc, nullptr, &outTex);
  if (FAILED(hr)) {
    SetError("CreateTexture2D(NV12 output)", hr);
    return false;
  }

  // Ring of kStagingRingSize staging textures -- see the struct/array's own
  // declaration for why. Built as a local array first, same pattern as
  // outTex/vp/vpEnum above, so a failure partway through (slot 1 of 2) never
  // touches the globals and leaves the previous, still-valid pipeline in
  // place for EnsurePipeline's caller to keep using.
  D3D11_TEXTURE2D_DESC stagingDesc = outDesc;
  stagingDesc.Usage = D3D11_USAGE_STAGING;
  stagingDesc.BindFlags = 0;
  stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> stagingTex[kStagingRingSize];
  for (int i = 0; i < kStagingRingSize; i++) {
    hr = g_device->CreateTexture2D(&stagingDesc, nullptr, &stagingTex[i]);
    if (FAILED(hr)) {
      SetError("CreateTexture2D(staging)", hr);
      return false;
    }
  }

  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outViewDesc{};
  outViewDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  outViewDesc.Texture2D.MipSlice = 0;
  ComPtr<ID3D11VideoProcessorOutputView> outView;
  hr = g_videoDevice->CreateVideoProcessorOutputView(outTex.Get(), vpEnum.Get(), &outViewDesc, &outView);
  if (FAILED(hr)) {
    SetError("CreateVideoProcessorOutputView", hr);
    return false;
  }

  g_vpEnum = vpEnum;
  g_videoProcessor = vp;
  g_outputTex = outTex;
  g_outputView = outView;
  g_srcW = srcW;
  g_srcH = srcH;
  g_outW = outW;
  g_outH = outH;
  g_lastTargetW = targetW;
  g_lastTargetH = targetH;

  // Every texture just built above is a fresh, never-copied-into resource,
  // regardless of whether this rebuild was the very first one this session
  // or a later resize/setTarget() -- so the ring's write/read bookkeeping
  // must restart from empty here too, on the same trigger, or ProcessFrame
  // could try to Map a "primed" slot from before this rebuild that no longer
  // exists (a resize replaces the ComPtrs entirely, it does not reuse them).
  // See ProcessFrame's own comment on g_stagingRingFilled for the other half
  // of this contract, and the struct's declaration above for why the first
  // kStagingRingSize-1 frames after any rebuild have nothing to read yet.
  for (int i = 0; i < kStagingRingSize; i++) {
    g_stagingRing[i].tex = stagingTex[i];
    g_stagingRing[i].timestampUs = 0;
  }
  g_stagingRingIndex = 0;
  g_stagingRingFilled = 0;
  return true;
}

// Delivered to JS alongside the pixel buffer so the harness (and eventually
// the renderer) can see the two readback costs separately: the GPU-side
// scale/convert step, and the CPU-side copy the whole module exists to
// shrink.
struct FramePayload {
  std::vector<uint8_t> nv12;
  UINT32 width = 0;
  UINT32 height = 0;
  double bltMs = 0;
  double grabMs = 0;
  // frame->get_SystemRelativeTime(), converted to microseconds (100ns units
  // / 10) -- see CaptureThread's pacing comment above lastDeliveredTs. Real
  // per-frame time, not wall-clock delivery time; the page patch uses this
  // directly for VideoFrame.timestamp and its own delta for duration (see
  // appAudioPatch.ts), replacing a fixed duration computed once at build
  // time. Unset (0) for a death-signal payload, same as width/height/bltMs/
  // grabMs below.
  double timestampUs = 0;
  // Set only for the one death-signal payload CaptureThread emits on loop
  // exit (see its teardown, below) -- frame arrives as null in JS and
  // `reason` carries lastError() at that moment. See index.d.ts.
  bool isDeath = false;
  std::string reason;
};

/**
 * Frames the JS side was not ready to receive, cumulative for this session.
 *
 * Reported in each frame's metadata so the shortfall has a direct measurement
 * instead of being inferred from inter-arrival gaps. The harness previously
 * counted "gap > 1.5x target" and labelled it as N-API falling behind, which
 * cannot distinguish a frame we refused from one the source never painted.
 */
std::atomic<uint64_t> g_framesRefused{0};

/**
 * Times the frame pool was actually Create()'d/Recreate()'d for a new content
 * size this session -- i.e. how many resize events EnsurePool absorbed.
 *
 * REJECTED: an earlier version of this fix dropped the current frame instead
 * of blitting it whenever the texture and content size disagreed (a resize
 * in flight), and counted *that* here as "frames dropped on resize". It broke
 * under a continuous resize -- dragging a window edge, or an engine's
 * fullscreen transition animating over a second -- because contentSize
 * changes on every poll while the pool is still catching up, so *every* frame
 * got dropped and this session delivered nothing until FRAME_WATCHDOG_MS (the
 * JS-side watchdog in screenCapture.ts) killed it: the exact symptom this
 * module exists to fix, reached by a new route. See the ProcessFrame call
 * site in CaptureThread for the fix (always blit the texture we hold).
 *
 * With nothing ever dropped, this now counts pool-resize events instead --
 * still useful in the same spot: a session that died with this at zero was a
 * real capture failure, one that died with this climbing was mid-resize when
 * it happened (screenCapture.ts's watchdog logs it alongside lastError() for
 * exactly that distinction).
 */
std::atomic<uint64_t> g_poolResizes{0};

// Named (not an inline lambda at the call site) so Emit() below can pass it
// to more than one NonBlockingCall attempt when retrying a death payload.
void EmitToJs(Napi::Env env, Napi::Function cb, FramePayload* p) {
  auto meta = Napi::Object::New(env);
  meta.Set("refused", Napi::Number::New(env, static_cast<double>(g_framesRefused.load())));
  meta.Set("poolResizes", Napi::Number::New(env, static_cast<double>(g_poolResizes.load())));
  if (p->isDeath) {
    // No pixel buffer for a death signal -- see FramePayload::isDeath.
    meta.Set("reason", Napi::String::New(env, p->reason));
    delete p;
    cb.Call({env.Null(), meta});
    return;
  }
  // Copy, and it has to be a copy: Napi::Buffer::New over our own memory
  // (zero-copy, with a finalizer) is the obvious optimisation here -- it
  // would save a ~3MB memcpy and a fresh 3MB V8 allocation per frame, some
  // 180MB/s of allocation churn at 60fps -- but **Electron rejects external
  // buffers outright**. V8's memory-cage/sandbox hardening means every such
  // call throws `External buffers are not allowed` before the callback
  // runs, delivering zero frames. Node swallows that exception by default
  // (it only surfaces as a DEP0168 warning), so it fails silently and looks
  // like a capture bug rather than an API misuse. Measured directly on
  // Electron 43.4.0: 0 frames delivered at both 30 and 60fps.
  //
  // If this ever needs optimising, the route is a preallocated pool the JS
  // side reads from, not an external Buffer.
  auto buffer = Napi::Buffer<uint8_t>::Copy(env, p->nv12.data(), p->nv12.size());
  meta.Set("width", Napi::Number::New(env, p->width));
  meta.Set("height", Napi::Number::New(env, p->height));
  meta.Set("bltMs", Napi::Number::New(env, p->bltMs));
  meta.Set("grabMs", Napi::Number::New(env, p->grabMs));
  meta.Set("timestampUs", Napi::Number::New(env, p->timestampUs));
  // Safe before the call: Buffer::Copy above already took its own copy of
  // the pixels, so nothing here outlives this scope. Leaking instead would
  // cost a whole frame (~3MB) every time, ~180MB/s at 60fps.
  delete p;
  cb.Call({buffer, meta});
}

/**
 * Bounded retry for a dropped death payload alone -- see Emit() below for why
 * a frame drop and a death drop are not the same risk. 10 attempts x 5ms caps
 * the added delay at ~50ms, which is negligible next to how long the capture
 * thread otherwise takes to unwind (D3D/WGC teardown) and unobservable by
 * any caller -- since item 3, nothing blocks on this thread exiting any more
 * (stop()'s join runs on the libuv threadpool; see StopWorker), so this bound
 * is no longer trading against a blocked JS thread, just against how long
 * the death signal can take to land after everything else has already wound
 * down. Still a real cap worth keeping small: see Emit() for why retrying
 * can occasionally still fail to land it at all, in which case 50ms is what
 * this costs for nothing.
 */
constexpr int kDeathRetries = 10;
constexpr DWORD kDeathRetryDelayMs = 5;

void Emit(FramePayload* payload) {
  auto status = g_tsfn.NonBlockingCall(payload, EmitToJs);
  // Drop, don't queue: once the queue is full NonBlockingCall fails fast
  // instead of buffering. For an ordinary frame that is correct as-is --
  // delivering a stale frame late is worse than skipping it. See the queue
  // size in Start() for why it is not 1.
  if (status == napi_ok) return;
  if (!payload->isDeath) {
    g_framesRefused.fetch_add(1, std::memory_order_relaxed);
    delete payload;
    return;
  }

  // The death payload is not a frame: it's the only fatal signal left on the
  // state-readable path in screenCapture.ts (the old FRAME_WATCHDOG_HARD_LEAK_MS
  // hard-leak guard was deliberately removed on the assumption that this
  // signal always lands -- see the REJECTED comment above startWatchdogs
  // there). Dropping it silently the same way a frame is dropped would leave
  // a session whose capture thread died, but whose window is still open,
  // paused forever with nothing to notice. So retry a bounded number of times
  // instead of giving up on the first full queue.
  //
  // UPDATED for item 3 (async stop): both paths that can reach here now
  // leave the JS thread free to drain the queue for the whole retry window,
  // so a retry should usually land on the first or second attempt:
  //  - Abnormal death (nothing called stop()): always true -- the JS thread
  //    was never blocked on this thread in this case.
  //  - Ordinary stop(): stop()'s join no longer runs on the JS/main thread --
  //    it runs on the libuv threadpool via StopWorker (see Stop() below), so
  //    the JS thread is free to run its event loop, and this queue, for the
  //    whole join. Before item 3, Stop() was synchronously blocked in
  //    g_thread.join() right here, so every retry on this path was
  //    guaranteed to exhaust -- that guarantee is gone now, which is why
  //    this comment needed updating, not because the retry loop itself
  //    changed.
  //
  // One path can still starve it: the AddCleanupHook added by item 5 (quit
  // without an explicit stop() first) runs its own bounded
  // WaitForSingleObject(thread.native_handle(), 3000) synchronously on the
  // JS/main thread. If this NonBlockingCall lands while that hook is still
  // waiting, the JS thread is once again not draining the queue -- so the
  // retry can still legitimately exhaust, and that is fine for the same
  // reason it always was: nothing JS-side is depending on this signal once
  // shutdown has gone this far.
  //
  // This is exactly why Emit() must stay a NonBlockingCall retry loop and
  // never become a BlockingCall: a call that blocks waiting for queue space
  // only the JS thread can drain would deadlock that cleanup-hook wait the
  // same way it used to deadlock Stop()'s old synchronous join.
  //
  // kDeathRetries x kDeathRetryDelayMs (10 x 5ms = 50ms) is kept as-is: it
  // was already generous for a queue that now drains almost immediately in
  // the common case, and it stays cheap insurance for the one path above
  // that can still legitimately exhaust it.
  for (int attempt = 0; attempt < kDeathRetries && status != napi_ok; attempt++) {
    Sleep(kDeathRetryDelayMs);
    status = g_tsfn.NonBlockingCall(payload, EmitToJs);
  }
  if (status != napi_ok) {
    // Retries exhausted -- record the drop through the normal error channel
    // instead of losing it silently. Overwrites whatever g_lastError held
    // (the death payload's own `reason`, already lost with it); still
    // surfaced through lastError(), e.g. in the FRAME_WATCHDOG_NO_STATE_MS
    // log line in screenCapture.ts.
    SetErrorText("death signal dropped: TSFN queue stayed full after retries");
    delete payload;
  }
}

// Scale+convert the given source texture into the shared output texture, read
// it back, pack it as tight NV12, and deliver it. srcW/srcH must be the
// *texture's own* dimensions (srcTex->GetDesc), not the frame's ContentSize --
// see the caller in CaptureThread for why those can briefly disagree and what
// goes wrong if you pass ContentSize here instead. timestampUs is the frame's
// own get_SystemRelativeTime(), already converted -- see FramePayload's field
// of the same name. Called for every frame the capture loop decides to
// process -- there is no resize case that skips this call any more, only the
// pacing skips upstream of it (the drain loop and the pacing check against
// lastDeliveredTs). Returns false only on a hard D3D/WGC failure.
bool ProcessFrame(ID3D11Texture2D* srcTex, UINT32 srcW, UINT32 srcH, double timestampUs) {
  if (!EnsurePipeline(srcW, srcH)) return false;

  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inDesc{};
  inDesc.FourCC = 0;
  inDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  inDesc.Texture2D.MipSlice = 0;
  inDesc.Texture2D.ArraySlice = 0;
  ComPtr<ID3D11VideoProcessorInputView> inputView;
  HRESULT hr = g_videoDevice->CreateVideoProcessorInputView(srcTex, g_vpEnum.Get(), &inDesc, &inputView);
  if (FAILED(hr)) {
    SetError("CreateVideoProcessorInputView", hr);
    return false;
  }

  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = inputView.Get();

  RECT srcRect{0, 0, static_cast<LONG>(srcW), static_cast<LONG>(srcH)};
  RECT dstRect{0, 0, static_cast<LONG>(g_outW), static_cast<LONG>(g_outH)};
  g_videoContext->VideoProcessorSetStreamSourceRect(g_videoProcessor.Get(), 0, TRUE, &srcRect);
  g_videoContext->VideoProcessorSetStreamDestRect(g_videoProcessor.Get(), 0, TRUE, &dstRect);

  const auto t0 = std::chrono::steady_clock::now();
  hr = g_videoContext->VideoProcessorBlt(g_videoProcessor.Get(), g_outputView.Get(), 0, 1, &stream);
  const auto t1 = std::chrono::steady_clock::now();
  if (FAILED(hr)) {
    SetError("VideoProcessorBlt", hr);
    return false;
  }

  // This is the number the whole module exists to shrink: on Chromium's own
  // path this Map() blocks on a ~20MB GPU->CPU copy under game-GPU
  // contention. Downscaling before this point (above) is what gets it to
  // ~1.5MB instead.
  //
  // Staging ring (item 2 of PR C3): write this frame's blit result into the
  // NEXT ring slot, but read back the PREVIOUS slot's -- already blitted a
  // whole frame interval ago -- content, instead of the one just copied into.
  // CopyResource only *starts* the GPU->CPU copy; it does not wait for it, so
  // Map()'ing the slot just copied into would still pay the full pipeline
  // stall this item exists to remove. Reading the other slot means whatever
  // GPU work is still outstanding for it had a whole interval's head start,
  // so D3D11_MAP_FLAG_DO_NOT_WAIT normally succeeds immediately; on the rare
  // case it has not, Map() returns DXGI_ERROR_WAS_STILL_DRAWING right away
  // instead of blocking, and this call skips the frame exactly like any
  // other pacing drop -- see kStagingRingSize's declaration for more.
  const int writeSlot = g_stagingRingIndex;
  g_context->CopyResource(g_stagingRing[writeSlot].tex.Get(), g_outputTex.Get());
  g_stagingRing[writeSlot].timestampUs = timestampUs;
  g_stagingRingIndex = (writeSlot + 1) % kStagingRingSize;

  // The first kStagingRingSize-1 frames after Start() or after EnsurePipeline
  // resets this ring (a resize or a setTarget() -- see its own comment) have
  // no N-1 slot with real content to read: every slot is a freshly created,
  // never-copied-into STAGING texture. Returning true with nothing emitted is
  // not a failure -- CaptureThread already treats "no Emit() this iteration"
  // as an ordinary drop (the same path a too-fast frame or a still-drawing
  // GPU takes), so the caller sees no difference from any other skipped
  // frame; it is just guaranteed for a session's or a rebuild's first couple
  // of frames instead of merely likely.
  if (g_stagingRingFilled < kStagingRingSize) {
    g_stagingRingFilled++;
    return true;
  }

  const int readSlot = (writeSlot + kStagingRingSize - 1) % kStagingRingSize;
  D3D11_MAPPED_SUBRESOURCE mapped{};
  hr = g_context->Map(g_stagingRing[readSlot].tex.Get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
  const auto t2 = std::chrono::steady_clock::now();
  if (hr == DXGI_ERROR_WAS_STILL_DRAWING) {
    // Not a failure -- see the comment above this block. The pixels are not
    // lost, only this call's chance to read them; readSlot's own content
    // gets another chance once the ring cycles back to it.
    return true;
  }
  if (FAILED(hr)) {
    SetError("Map(staging texture)", hr);
    return false;
  }

  auto* payload = new FramePayload();
  payload->width = g_outW;
  payload->height = g_outH;
  payload->bltMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
  // No longer a GPU-wait measurement now that Map() is DO_NOT_WAIT -- it
  // normally reads near zero, which is the point of this item, not a bug.
  // grabMs still exists as a field so the harness/renderer can tell a
  // healthy near-zero value apart from the rare WAS_STILL_DRAWING skip above
  // (which never reaches here to report one).
  payload->grabMs = std::chrono::duration<double, std::milli>(t2 - t1).count();
  // This slot's OWN timestamp, captured when it was written one call ago --
  // not the `timestampUs` argument, which belongs to the frame just blitted
  // into the OTHER (write) slot this same call. Using the argument here
  // would pair this frame's pixels with the next frame's timestamp, silently
  // undoing PR C2's real-per-frame-timestamp fix for the one-frame lag this
  // ring adds.
  payload->timestampUs = g_stagingRing[readSlot].timestampUs;

  // D3D11 maps an NV12 texture as one contiguous region: the Y plane
  // (height rows of RowPitch bytes) immediately followed by the half-height,
  // full-RowPitch UV plane. RowPitch is normally larger than the logical
  // width (driver row alignment), so we copy row by row to hand JS a tightly
  // packed buffer instead of forwarding the padding.
  const size_t ySize = static_cast<size_t>(g_outW) * g_outH;
  const size_t uvSize = ySize / 2;
  payload->nv12.resize(ySize + uvSize);
  const auto* src = static_cast<const uint8_t*>(mapped.pData);

  for (UINT32 row = 0; row < g_outH; row++) {
    memcpy(payload->nv12.data() + static_cast<size_t>(row) * g_outW, src + static_cast<size_t>(row) * mapped.RowPitch,
           g_outW);
  }
  const uint8_t* uvSrc = src + static_cast<size_t>(mapped.RowPitch) * g_outH;
  for (UINT32 row = 0; row < g_outH / 2; row++) {
    memcpy(payload->nv12.data() + ySize + static_cast<size_t>(row) * g_outW,
           uvSrc + static_cast<size_t>(row) * mapped.RowPitch, g_outW);
  }
  g_context->Unmap(g_stagingRing[readSlot].tex.Get(), 0);

  Emit(payload);
  return true;
}

// ---------------------------------------------------------------------------
// FrameArrived handler. Runs on a thread WinRT itself owns -- NOT the
// capture thread -- so it must do nothing beyond SetEvent(). In particular
// it must never touch g_tsfn: Start()'s ThreadSafeFunction::New() call seeds
// initialThreadCount at 1 on the guarantee that exactly one thread (the
// capture thread, via Emit()) ever calls NonBlockingCall and matches it with
// the one Release() in CaptureThread's own teardown -- see the comment on
// that New() call for what breaks if a second thread ever reaches g_tsfn.
// SetEvent on a HANDLE is the one operation that's safe to do here from any
// thread: no COM re-entrancy, and nothing shared with the capture thread
// except the HANDLE value itself, which the capture thread guarantees stays
// valid for as long as this handler could still be invoked (see
// CaptureThread's teardown: remove_FrameArrived happens, and is given the
// chance to finish any in-flight Invoke, before the event handle is ever
// closed).
//
// Belt and braces on top of that: remove_FrameArrived is the standard WinRT
// event-source contract for "no Invoke is still in flight once this
// returns", but nothing here depends on that guarantee being ironclad across
// every WinRT implementation. If a straggler Invoke ever did land after
// CaptureThread closed frameEvent, SetEvent on a stale HANDLE value is not
// just wrong, it is dangerous: Windows recycles HANDLE values, so it could
// signal a completely unrelated kernel object created after this one closed.
// ClearEvent() (called from CaptureThread's teardown, strictly before the
// close) makes that provably harmless instead: frameEvent_ is an atomic, so
// a straggler reads nullptr and calls SetEvent(nullptr), which fails benignly
// (returns 0, GetLastError() ERROR_INVALID_HANDLE) rather than touching
// anything real.
// ---------------------------------------------------------------------------

class FrameArrivedHandler
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          ABI::Windows::Foundation::ITypedEventHandler<WGC::Direct3D11CaptureFramePool*, IInspectable*>> {
 public:
  HRESULT RuntimeClassInitialize(HANDLE frameEvent) {
    frameEvent_.store(frameEvent, std::memory_order_release);
    return S_OK;
  }

  IFACEMETHODIMP Invoke(WGC::IDirect3D11CaptureFramePool*, IInspectable*) override {
    // Load once rather than SetEvent(frameEvent_.load()) inline -- not for
    // correctness (both read it exactly once either way), just so the value
    // actually being signalled is visible in a debugger/crash dump.
    HANDLE h = frameEvent_.load(std::memory_order_acquire);
    if (h) SetEvent(h);  // null after ClearEvent() -- see the class comment above
    return S_OK;
  }

  // Called by CaptureThread's teardown, after remove_FrameArrived and before
  // frameEvent is closed -- see the class comment above for why this exists
  // as a second line of defence rather than trusting remove_FrameArrived
  // alone. Atomic: written from the capture thread, read from whatever
  // thread WinRT happens to run Invoke() on.
  void ClearEvent() { frameEvent_.store(nullptr, std::memory_order_release); }

 private:
  std::atomic<HANDLE> frameEvent_{nullptr};  // not owned; CaptureThread owns and closes it
};

// ---------------------------------------------------------------------------
// Capture thread: owns the whole session lifetime. FrameArrived (subscribed
// below, once the frame pool exists) wakes this thread the instant WGC has a
// new surface -- see the file header for why this replaced polling
// TryGetNextFrame() on a fixed cadence. All D3D/WGC work still happens here,
// on this one thread, exactly as before: FrameArrivedHandler's own Invoke()
// (a WinRT-owned thread) does nothing but SetEvent() the handle this thread
// waits on.
// ---------------------------------------------------------------------------

void CaptureThread(HWND hwnd) {
  HRESULT hr = RoInitialize(RO_INIT_MULTITHREADED);
  const bool roInitialised = SUCCEEDED(hr) || hr == S_FALSE;

  // Thread-owned for this session's whole life: created here, closed in this
  // function's own teardown below, and touched by no other thread except
  // FrameArrivedHandler::Invoke() calling SetEvent on frameEvent -- see that
  // class's comment for why that is the only safe thing it does. Locals, not
  // globals like g_stopEvent: nothing outside this thread ever needs to see
  // or signal them. g_stopEvent has to be a global because Stop() (JS thread)
  // creates/signals/closes it before this thread even exists, on the first
  // two counts; the frame-arrived event and its registration token have no
  // such cross-thread requirement.
  HANDLE frameEvent = nullptr;
  EventRegistrationToken frameArrivedToken{};
  bool frameArrivedRegistered = false;
  // Function-scope, not the nested block it used to be built in below --
  // kept alive here, deliberately, through the ClearEvent()/CloseHandle(
  // frameEvent) pair in this function's teardown, so the FrameArrivedHandler
  // object itself cannot be destroyed out from under a straggler Invoke()
  // either -- see ClearEvent()'s own comment on the class for the handle
  // half of this defence; this is the object-lifetime half. add_FrameArrived
  // below takes its own reference too (the standard WinRT event-source
  // contract), so this ComPtr is redundant in the common case -- it only
  // matters if that reference is ever dropped before this thread expects.
  ComPtr<FrameArrivedHandler> frameArrivedHandler;

  // High-resolution pacing/heartbeat timer (item 3 of this PR). Not the
  // delivery-pacing decision any more -- see lastDeliveredTs below -- just
  // what wakes this loop close to every requested interval when FrameArrived
  // alone would not: a static window legitimately produces no FrameArrived
  // events at all, and without some periodic wake this thread would never
  // re-check IsWindow(hwnd) or g_stopEvent until content changed again, which
  // could be never. Needs Windows 10 1803+ (build 17134) for
  // CREATE_WAITABLE_TIMER_HIGH_RESOLUTION; CreateWaitableTimerExW returns
  // NULL below that, in which case this falls back to timeBeginPeriod(1) + a
  // plain millisecond WaitForMultipleObjects timeout -- the same ~1ms-of-
  // slack this file always paid on those systems before this PR. Created
  // once here and closed once in the unconditional teardown below,
  // deliberately not paired tightly around the while loop the way the old
  // timeBeginPeriod/timeEndPeriod calls were -- so an early `break` out of
  // the setup steps just below can never leave it unclosed or leave
  // timeBeginPeriod uncompensated. See the teardown for where that happens.
  HANDLE pacingTimer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
  const bool haveHighResTimer = pacingTimer != nullptr;
  if (!haveHighResTimer) {
    // Windows' default system timer resolution is ~15.6ms, so without this,
    // a millisecond-granularity wait actually wakes up on the next ~15.6ms
    // tick after the requested duration. Only needed on this fallback path --
    // the high-resolution timer above does not depend on the global system
    // timer resolution at all.
    timeBeginPeriod(1);
  }

  do {
    if (!roInitialised) {
      SetError("RoInitialize", hr);
      break;
    }

    D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, levels, 2,
                            D3D11_SDK_VERSION, &g_device, nullptr, &g_context);
    if (FAILED(hr)) {
      SetError("D3D11CreateDevice", hr);
      break;
    }

    hr = g_device.As(&g_videoDevice);
    if (FAILED(hr)) {
      SetError("QueryInterface(ID3D11VideoDevice)", hr);
      break;
    }
    hr = g_context.As(&g_videoContext);
    if (FAILED(hr)) {
      SetError("QueryInterface(ID3D11VideoContext)", hr);
      break;
    }

    // WGC frames arrive as WinRT surfaces; bridge our own D3D11 device into
    // the WinRT object model so the frame pool can hand us frames on it.
    ComPtr<IDXGIDevice> dxgiDevice;
    hr = g_device.As(&dxgiDevice);
    if (FAILED(hr)) {
      SetError("QueryInterface(IDXGIDevice)", hr);
      break;
    }
    ComPtr<IInspectable> wgDeviceInsp;
    hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), &wgDeviceInsp);
    if (FAILED(hr)) {
      SetError("CreateDirect3D11DeviceFromDXGIDevice", hr);
      break;
    }
    hr = wgDeviceInsp.As(&g_wgDevice);
    if (FAILED(hr)) {
      SetError("QueryInterface(IDirect3DDevice)", hr);
      break;
    }

    ComPtr<IGraphicsCaptureItemInterop> itemInterop;
    hr = GetActivationFactory(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem, itemInterop);
    if (FAILED(hr)) {
      SetError("ActivationFactory(GraphicsCaptureItem)", hr);
      break;
    }
    hr = itemInterop->CreateForWindow(hwnd, IID_PPV_ARGS(&g_item));
    if (FAILED(hr)) {
      SetError("IGraphicsCaptureItemInterop::CreateForWindow", hr);
      break;
    }

    hr = GetActivationFactory(RuntimeClass_Windows_Graphics_Capture_Direct3D11CaptureFramePool, g_poolStatics2);
    if (FAILED(hr)) {
      SetError("ActivationFactory(Direct3D11CaptureFramePool)", hr);
      break;
    }

    WG::SizeInt32 itemSize{};
    hr = g_item->get_Size(&itemSize);
    if (FAILED(hr) || itemSize.Width <= 0 || itemSize.Height <= 0) {
      SetError("IGraphicsCaptureItem::get_Size", hr);
      break;
    }

    if (!EnsurePool(static_cast<UINT32>(itemSize.Width), static_cast<UINT32>(itemSize.Height))) break;
    if (!EnsurePipeline(static_cast<UINT32>(itemSize.Width), static_cast<UINT32>(itemSize.Height))) break;

    // Subscribe before StartCapture() below so no frame can arrive
    // un-observed. Keyed off the pool's creation, not every EnsurePool call:
    // EnsurePool's Recreate() branch (buffer size/format/count change on a
    // resize) reuses the same frame-pool COM object and therefore the same
    // subscription, so this only needs to run once per session -- the
    // EnsurePool call just above always takes its creation branch here,
    // since g_framePool was reset to null by the previous session's own
    // teardown (see below) before this thread ever started.
    frameEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!frameEvent) {
      SetError("CreateEvent(frameEvent)", HRESULT_FROM_WIN32(GetLastError()));
      break;
    }
    hr = Microsoft::WRL::MakeAndInitialize<FrameArrivedHandler>(&frameArrivedHandler, frameEvent);
    if (FAILED(hr)) {
      SetError("MakeAndInitialize(FrameArrivedHandler)", hr);
      break;
    }
    hr = g_framePool->add_FrameArrived(frameArrivedHandler.Get(), &frameArrivedToken);
    if (FAILED(hr)) {
      SetError("Direct3D11CaptureFramePool::add_FrameArrived", hr);
      break;
    }
    frameArrivedRegistered = true;

    hr = g_framePool->CreateCaptureSession(g_item.Get(), &g_session);
    if (FAILED(hr)) {
      SetError("CreateCaptureSession", hr);
      break;
    }
    hr = g_session->StartCapture();
    if (FAILED(hr)) {
      SetError("StartCapture", hr);
      break;
    }

    // Real per-frame timestamps (item 2 of this PR): pace and deliver on
    // frame->get_SystemRelativeTime() -- a 100ns-unit, monotonically
    // increasing clock WGC stamps on the frame itself -- not on wall-clock
    // time this thread happens to observe the frame at. That distinction is
    // what actually removes the poll-vs-present aliasing the file header
    // describes: FrameArrived alone only fixes *when* this thread wakes up,
    // not *which* frame it is looking at relative to the source's own
    // cadence. A source presenting faster than the requested delivery rate
    // (a 144Hz desktop feeding a 30fps share) still needs frames dropped
    // deliberately, not accidentally by whichever one happened to be newest
    // when a fixed-cadence poll landed.
    double lastDeliveredTs = -1.0;  // 100ns units; negative = "always take the first frame"

    // nextTick now only drives pacingTimer -- see that HANDLE's own comment
    // above for why it no longer has any say in which frames get delivered.
    auto nextTick = std::chrono::steady_clock::now();

    while (g_running.load()) {
      const auto now = std::chrono::steady_clock::now();
      // Re-read every iteration, same reasoning as before this PR: a
      // mid-share setFps() must take effect on the very next wait, not the
      // next session.
      const double fps = g_fps.load(std::memory_order_relaxed);
      const auto interval = std::chrono::duration<double>(1.0 / fps);
      const double interval100ns = 1.0e7 / fps;

      // Resync, not accumulate, when behind: if this loop has fallen more
      // than one whole interval behind schedule (a slow VideoProcessorBlt/
      // Map, the process itself getting descheduled, ...), snapping nextTick
      // forward to now avoids the old failure mode this exact pattern used to
      // have here -- repeatedly adding one interval to a nextTick that is
      // already in the past computes a wait of 0 on every following
      // iteration until the deficit is paid off one interval at a time, i.e.
      // a busy spin. The stakes are lower now than before this PR --
      // pacingTimer no longer paces delivery, only wakes the liveness checks
      // below -- but the failure mode is exactly as easy to reintroduce, so
      // it gets the same fix.
      if (now - nextTick > interval) nextTick = now;
      nextTick += std::chrono::duration_cast<std::chrono::steady_clock::duration>(interval);

      DWORD waitResult;
      if (haveHighResTimer) {
        const auto waitDuration = nextTick - now;
        const LONGLONG wait100ns = (std::max)(
            static_cast<LONGLONG>(0),
            std::chrono::duration_cast<std::chrono::duration<LONGLONG, std::ratio<1, 10000000>>>(waitDuration)
                .count());
        LARGE_INTEGER dueTime;
        dueTime.QuadPart = -wait100ns;  // negative = relative to now, 100ns units
        if (!SetWaitableTimerEx(pacingTimer, &dueTime, 0, nullptr, nullptr, nullptr, 0)) {
          SetError("SetWaitableTimerEx", HRESULT_FROM_WIN32(GetLastError()));
          break;
        }
        HANDLE handles[3] = {g_stopEvent, frameEvent, pacingTimer};
        waitResult = WaitForMultipleObjects(3, handles, FALSE, INFINITE);
      } else {
        // Fallback: the coarse millisecond wait this file used exclusively
        // before this PR, now racing frameEvent too instead of being the
        // sole pacing mechanism -- see the file header.
        const auto waitFor = std::chrono::duration_cast<std::chrono::milliseconds>(nextTick - now);
        const DWORD waitMs = waitFor.count() > 0 ? static_cast<DWORD>(waitFor.count()) : 0;
        HANDLE handles[2] = {g_stopEvent, frameEvent};
        waitResult = WaitForMultipleObjects(2, handles, FALSE, waitMs);
      }

      if (waitResult == WAIT_OBJECT_0) break;  // g_stopEvent
      if (waitResult == WAIT_FAILED) {
        SetError("WaitForMultipleObjects", HRESULT_FROM_WIN32(GetLastError()));
        break;
      }
      // Anything else -- frameEvent, pacingTimer, or WAIT_TIMEOUT on the
      // fallback path -- all fall through to the same check-and-drain below.
      // Which one woke this iteration does not matter: draining to the
      // newest frame and pacing on its own timestamp behaves correctly
      // whether this wait was satisfied by new content, the heartbeat, or a
      // coarse timeout.
      if (!IsWindow(hwnd)) {
        SetError("captured window", HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE));
        break;
      }

      // Drain the pool, keeping only the newest frame -- under load WGC can
      // still have queued more than one since our last wait (the event tells
      // us "at least one", not "exactly one").
      ComPtr<WGC::IDirect3D11CaptureFrame> frame;
      for (;;) {
        ComPtr<WGC::IDirect3D11CaptureFrame> next;
        HRESULT frHr = g_framePool->TryGetNextFrame(&next);
        if (FAILED(frHr) || !next) break;
        frame = next;  // the previously-held frame (if any) is Released here
      }
      if (!frame) continue;  // nothing new since last wait

      // Pace on the frame's own timestamp -- see the comment above
      // lastDeliveredTs's declaration for why wall-clock time would not do.
      // 0.9x instead of a strict >= interval100ns leaves headroom for
      // ordinary sub-frame jitter in exactly when WGC stamps (and this
      // thread observes) each present -- without it, a delivery landing a
      // hair under one full interval late would be pushed out to two
      // intervals instead of one.
      ABI::Windows::Foundation::TimeSpan relativeTime{};
      hr = frame->get_SystemRelativeTime(&relativeTime);
      const double ts = SUCCEEDED(hr) ? static_cast<double>(relativeTime.Duration) : 0.0;
      if (lastDeliveredTs >= 0.0 && (ts - lastDeliveredTs) < 0.9 * interval100ns) {
        continue;  // faster than the requested delivery rate -- drop (Release only, same as any other drop)
      }
      lastDeliveredTs = ts;

      WG::SizeInt32 contentSize{};
      frame->get_ContentSize(&contentSize);
      if (contentSize.Width <= 0 || contentSize.Height <= 0) continue;

      ComPtr<WGDD::IDirect3DSurface> surface;
      hr = frame->get_Surface(&surface);
      if (FAILED(hr)) {
        SetError("IDirect3D11CaptureFrame::get_Surface", hr);
        continue;
      }
      // Note: unlike the other WinRT types in this file, this interop
      // interface is declared directly in ::Windows::Graphics::DirectX::
      // Direct3D11 (no ABI:: prefix) -- it ships in the interop header, not
      // the generated ABI metadata header.
      ComPtr<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
      hr = surface.As(&access);
      if (FAILED(hr)) {
        SetError("QueryInterface(IDirect3DDxgiInterfaceAccess)", hr);
        continue;
      }
      ComPtr<ID3D11Texture2D> srcTex;
      hr = access->GetInterface(IID_PPV_ARGS(&srcTex));
      if (FAILED(hr)) {
        SetError("IDirect3DDxgiInterfaceAccess::GetInterface", hr);
        continue;
      }

      // REJECTED #1: passing contentSize.Width/Height straight into
      // ProcessFrame here, as this originally did. contentSize is the
      // window's CURRENT content extent per WGC, but srcTex is a frame-pool
      // texture -- its *actual* dimensions are whatever the pool was last
      // Recreate()'d to, which lags one frame behind a resize. ProcessFrame
      // fed its (srcW, srcH) straight into EnsurePipeline (which rebuilt the
      // video processor for the size WGC just reported) and into srcRect for
      // VideoProcessorBlt -- so on the frame right after a resize this passed
      // the NEW size as the source rect while srcTex still held the OLD
      // pool's texture, and VideoProcessorBlt failed with E_INVALIDARG
      // (0x80070057) on every single frame until the pool caught up. This is
      // exactly the failure a racing sim toggling fullscreen/borderless hit
      // in production, repeatedly, and it is an easy mistake to reintroduce
      // because contentSize *looks* like the right value to pass -- it is,
      // just not for a texture that has not been resized to match it yet.
      //
      // REJECTED #2: once the above was caught, the fix here dropped this
      // frame (instead of blitting it) whenever srcTex's own dimensions
      // disagreed with contentSize, and recreated the pool for the new size
      // before continuing. That is correct for a *discrete* resize (one
      // Recreate, no oscillation) but breaks under a *continuous* one --
      // dragging a window edge, or an engine's fullscreen transition
      // animating over a second -- where contentSize changes faster than a
      // Recreate (which itself costs a full enumerator + processor + two
      // CreateTexture2D calls) can keep up. Every poll during that window
      // sees a fresh mismatch, so every frame gets dropped and this session
      // delivers nothing until FRAME_WATCHDOG_MS (screenCapture.ts) kills it
      // for lack of frames -- the exact symptom this module exists to fix,
      // reached by a new route.
      //
      // The actual fix: there is no correctness reason to drop. srcTex is
      // valid at its own dimensions regardless of what contentSize says --
      // on *grow* WGC has cropped the larger window into the smaller
      // surface (every pixel real, just cropped); on *shrink* the top-left
      // region matching the new, smaller content is valid and the margin
      // outside it is 1-2 frames of stale ghost pixels. Both are invisible
      // at 30fps next to seconds of black. So always blit the texture we
      // actually hold, sized to itself (srcRect == texture bounds by
      // construction, matching vpDesc.InputWidth/Height exactly --
      // E_INVALIDARG from a size mismatch becomes structurally impossible
      // rather than merely avoided), and use contentSize only to decide,
      // separately and without blocking this frame, whether the pool needs
      // recreating for frames still to come. Do NOT try to clamp srcRect to
      // min(srcDesc, contentSize) to trim the shrink-case ghost margin --
      // that puts vpDesc.InputWidth/Height out of step with the input view's
      // actual texture again, which is the exact shape the original bug
      // lived in.
      D3D11_TEXTURE2D_DESC srcDesc{};
      srcTex->GetDesc(&srcDesc);
      ProcessFrame(srcTex.Get(), srcDesc.Width, srcDesc.Height, ts / 10.0);

      // Recreate the pool for the window's current content size if it has
      // drifted from what the pool was last built for. Deliberately after
      // ProcessFrame and gated on the POOL's own last size (g_poolW/g_poolH),
      // not on whether it differs from srcDesc -- this frame's texture came
      // from the pool as it was *before* any Recreate below, so it will
      // legitimately still show a resize in progress on the very next wait
      // too; that is expected, not a bug, and is exactly what keeps this
      // converging (one Recreate per real size change) instead of every
      // frame re-deciding based on a comparison that's already stale by the
      // time it runs.
      if (contentSize.Width != static_cast<INT32>(g_poolW) ||
          contentSize.Height != static_cast<INT32>(g_poolH)) {
        g_poolResizes.fetch_add(1, std::memory_order_relaxed);
        if (!EnsurePool(static_cast<UINT32>(contentSize.Width), static_cast<UINT32>(contentSize.Height))) {
          // Pool recreation failing mid-session is worse than the 4s the JS
          // watchdog would otherwise burn waiting for frames that are never
          // coming: end the capture thread now, the same way !IsWindow(hwnd)
          // does above, with lastError() already populated by EnsurePool.
          break;
        }
      }
    }
  } while (false);

  // Signal exit to JS, once, whatever kind of exit this was -- including an
  // ordinary JS-driven stop() (g_lastError may be empty, or stale from an
  // earlier transient hiccup this session survived; the JS side already
  // discards this signal correctly for a normal stop, since `active` is null
  // there by the time it arrives). This is what lets screenCapture.ts's
  // onFrame react immediately instead of waiting out the watchdog. See A3
  // item 5.
  {
    auto* death = new FramePayload();
    death->isDeath = true;
    death->reason = GetErrorText();
    Emit(death);
  }

  // Revoke the FrameArrived subscription before closing the frame pool --
  // required ordering, not just tidiness: Close() below tells WGC to stop
  // capturing immediately, and revoking first guarantees no Invoke can land
  // on a handler this thread is about to outlive. remove_FrameArrived is the
  // standard WinRT event-source contract for this: it does not return until
  // any in-flight Invoke on another thread has finished, and guarantees no
  // future one is dispatched -- which is exactly what makes it safe to close
  // frameEvent, below, once teardown reaches it. See FrameArrivedHandler's
  // own comment for the other half of this guarantee.
  if (frameArrivedRegistered && g_framePool) {
    g_framePool->remove_FrameArrived(frameArrivedToken);
    frameArrivedRegistered = false;
  }
  // Second line of defence, ordered strictly after remove_FrameArrived and
  // strictly before CloseHandle(frameEvent) below -- see ClearEvent()'s own
  // comment on the FrameArrivedHandler class for why this exists even though
  // remove_FrameArrived already claims to guarantee the same thing. Guarded,
  // not unconditional: frameArrivedHandler is still null if
  // MakeAndInitialize itself never succeeded (an early break above), in
  // which case there was never a subscription for a straggler to invoke.
  if (frameArrivedHandler) frameArrivedHandler->ClearEvent();

  // Teardown, in reverse order of acquisition. Closing the session/pool
  // (rather than only Releasing them) tells WGC to stop capturing
  // immediately instead of waiting for the last reference to drop.
  if (g_session) {
    ComPtr<ABI::Windows::Foundation::IClosable> closable;
    if (SUCCEEDED(g_session.As(&closable))) closable->Close();
  }
  if (g_framePool) {
    ComPtr<ABI::Windows::Foundation::IClosable> closable;
    if (SUCCEEDED(g_framePool.As(&closable))) closable->Close();
  }

  g_outputView.Reset();
  for (auto& slot : g_stagingRing) slot.tex.Reset();
  g_outputTex.Reset();
  g_videoProcessor.Reset();
  g_vpEnum.Reset();
  g_session.Reset();
  g_framePool.Reset();
  g_item.Reset();
  g_poolStatics2.Reset();
  g_wgDevice.Reset();
  g_videoContext.Reset();
  g_videoDevice.Reset();
  g_context.Reset();
  g_device.Reset();
  g_srcW = g_srcH = g_outW = g_outH = 0;
  g_poolW = g_poolH = 0;
  g_lastTargetW = g_lastTargetH = 0;
  g_stagingRingIndex = 0;
  g_stagingRingFilled = 0;

  // frameEvent is safe to close now regardless of how CaptureThread got here
  // (a clean stop, a mid-setup failure, an unrecoverable per-frame error) --
  // remove_FrameArrived above already guarantees the one other thread that
  // could ever touch it (FrameArrivedHandler::Invoke) can no longer be
  // invoked, and ClearEvent() just above means even a straggler that beat
  // that guarantee reads nullptr instead of this about-to-be-closed value.
  // frameArrivedHandler itself is still alive here too (it does not go out
  // of scope until this function returns), so there is no window where the
  // handler object exists with a dangling frameEvent_ pointing at a closed
  // handle. If a break happened before frameEvent was even created (an
  // early device/session setup failure), it is still nullptr here and this
  // is a no-op.
  if (frameEvent) {
    CloseHandle(frameEvent);
    frameEvent = nullptr;
  }
  // Paired with the unconditional creation at the top of this function, not
  // with any single point inside the loop -- see pacingTimer's own comment
  // there for why it is closed once here instead of immediately after the
  // while loop the way the old timeBeginPeriod/timeEndPeriod pair was.
  if (pacingTimer) {
    CloseHandle(pacingTimer);
  } else {
    timeEndPeriod(1);
  }

  if (roInitialised) RoUninitialize();

  g_running.store(false);
  g_tsfn.Release();
}

// ---------------------------------------------------------------------------
// JavaScript surface
// ---------------------------------------------------------------------------

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // Windows Graphics Capture's free-threaded frame pool (what this module
  // needs) landed in the Windows.Foundation.UniversalApiContract v7 update,
  // Windows 10 1903 (build 18362).
  // Every `false` below records why. A bare unexplained `false` here is what
  // sent us hunting through the wrong layer once already -- the caller logs
  // lastError() alongside the verdict.
  using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) {
    SetError("GetModuleHandle(ntdll)", HRESULT_FROM_WIN32(GetLastError()));
    return Napi::Boolean::New(env, false);
  }
  auto fn = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (!fn) {
    SetError("GetProcAddress(RtlGetVersion)", HRESULT_FROM_WIN32(GetLastError()));
    return Napi::Boolean::New(env, false);
  }
  RTL_OSVERSIONINFOW vi{};
  vi.dwOSVersionInfoSize = sizeof(vi);
  if (fn(&vi) != 0 || vi.dwBuildNumber < 18362) {
    SetError("Windows build too old for WGC free-threaded capture (need 18362+)", E_NOTIMPL);
    return Napi::Boolean::New(env, false);
  }

  // Belt and braces: ask the platform directly too, since some GPU/driver
  // combinations on an otherwise-supported build still refuse capture.
  // This runs on whichever thread called us. In the Electron *main* process
  // that is a GUI thread whose COM apartment is already initialised as an STA,
  // so asking for RO_INIT_MULTITHREADED comes back RPC_E_CHANGED_MODE. That is
  // not an error -- it means "an apartment exists, just not the model you asked
  // for" -- and the activation factory below works perfectly well on it.
  // Treating it as failure is what made this report `GPU capture supported:
  // false` inside the app while passing in the standalone harness, where the
  // process has no pre-initialised apartment and the call simply succeeds.
  //
  // Only uninitialise when we were the ones who initialised: calling
  // RoUninitialize() after RPC_E_CHANGED_MODE would release a reference we
  // never took and tear down the host's own apartment.
  HRESULT hr = RoInitialize(RO_INIT_MULTITHREADED);
  const bool weInitialised = SUCCEEDED(hr);  // S_OK, or S_FALSE if already MTA
  if (!weInitialised && hr != RPC_E_CHANGED_MODE) {
    SetError("RoInitialize", hr);
    return Napi::Boolean::New(env, false);
  }

  bool supported = false;
  {
    // Scoped so the factory ComPtr is released (Release() needs a live WinRT
    // apartment) strictly *before* RoUninitialize() tears it down below --
    // releasing a WinRT object after uninitializing the apartment crashes.
    ComPtr<WGC::IGraphicsCaptureSessionStatics> statics;
    HRESULT factoryHr = GetActivationFactory(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureSession, statics);
    if (FAILED(factoryHr)) {
      SetError("GetActivationFactory(GraphicsCaptureSession)", factoryHr);
    } else {
      boolean result = FALSE;
      HRESULT supportedHr = statics->IsSupported(&result);
      if (FAILED(supportedHr)) {
        SetError("GraphicsCaptureSession::IsSupported", supportedHr);
      } else {
        supported = result != FALSE;
        if (!supported) SetError("GraphicsCaptureSession::IsSupported returned false", S_OK);
      }
    }
  }
  if (weInitialised) RoUninitialize();
  return Napi::Boolean::New(env, supported);
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // Checked before g_running: once Stop() below moves g_thread into a
  // StopWorker, g_thread.joinable() goes false immediately even though the
  // join it names is still running on the threadpool, so g_running/joinable
  // alone cannot tell "idle" from "still shutting down" for that whole
  // window. g_stopping is the flag that covers it (set in Stop(), cleared
  // only once StopWorker::OnOK/OnError actually runs). g_thread.joinable()
  // is kept here too as a belt-and-braces check for any future path that
  // might leave g_thread set without going through g_stopping.
  if (g_stopping.load() || g_thread.joinable()) {
    Napi::Error::New(env, "previous capture still shutting down").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_running.load()) {
    Napi::Error::New(env, "capture already running").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 5 || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber() ||
      !info[4].IsFunction()) {
    Napi::TypeError::New(env, "expected (hwnd, targetWidth, targetHeight, fps, onFrame)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  HWND hwnd = HwndFromValue(info[0]);
  if (!hwnd || !IsWindow(hwnd)) {
    Napi::Error::New(env, "invalid window handle").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const UINT32 targetW = info[1].As<Napi::Number>().Uint32Value();
  const UINT32 targetH = info[2].As<Napi::Number>().Uint32Value();
  const double startFps = info[3].As<Napi::Number>().DoubleValue();
  g_fps.store(startFps > 0 ? startFps : 30.0);
  if (targetW < 2 || targetH < 2) {
    Napi::Error::New(env, "targetWidth/targetHeight must be >= 2").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  g_targetW.store(targetW, std::memory_order_relaxed);
  g_targetH.store(targetH, std::memory_order_relaxed);

  SetErrorText(std::string());
  g_srcW = g_srcH = g_outW = g_outH = 0;
  g_poolW = g_poolH = 0;
  g_lastTargetW = g_lastTargetH = 0;
  g_stagingRingIndex = 0;
  g_stagingRingFilled = 0;
  if (g_stopEvent) CloseHandle(g_stopEvent);
  g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);

  // Queue depth is a jitter allowance, not a buffer. At 30fps a single slot
  // was fine -- the JS thread always drained inside the 33ms budget, and the
  // harness measured zero refusals. At 60fps the budget halves to 16.6ms and
  // one slot leaves *zero* tolerance for ordinary JS-thread scheduling
  // jitter: any hiccup longer than a frame interval refuses the frame
  // outright. That alone capped delivery at ~49.5fps against a 60fps target
  // (a ~17% refusal rate) while the capture thread sat at ~22% of one core
  // and grab time was unchanged from 30fps -- i.e. nothing was saturated,
  // frames were simply being turned away.
  //
  // Three slots absorb that jitter while still bounding latency to two extra
  // frames (~33ms at 60fps) and still dropping rather than growing without
  // limit, so Emit()'s drop path stays real.
  //
  // New()'s signature is (env, callback, resourceName, maxQueueSize,
  // initialThreadCount) -- the "3" below is the queue depth just argued for
  // above, NOT a thread count. initialThreadCount is 1 because exactly one
  // native thread ever touches g_tsfn: CaptureThread does every
  // NonBlockingCall (via Emit(), woken by its own WaitForMultipleObjects
  // wait loop -- see the file header for the FrameArrived-subscription model
  // and FrameArrivedHandler's own comment for why that WinRT-owned callback
  // thread does nothing but SetEvent() and never reaches g_tsfn itself) and
  // also owns the one and only Release() in its own teardown further down
  // this file. initialThreadCount has to equal the
  // number of Release() calls that will ever happen: N-API seeds the TSFN's
  // reference count at this value instead of requiring N separate Acquire()
  // calls, and the TSFN only finalises -- freeing its libuv handle -- once
  // that count is released back to zero. Set this above the number of
  // Release() calls actually made and the count never reaches zero: the TSFN
  // is never finalised and a libuv handle leaks every session.
  g_tsfn = Napi::ThreadSafeFunction::New(env, info[4].As<Napi::Function>(), "winCapture", 3, 1);
  // Per-session, so a later share does not inherit an earlier one's count.
  g_framesRefused.store(0);
  g_poolResizes.store(0);
  g_running.store(true);
  g_thread = std::thread(CaptureThread, hwnd);
  return Napi::Boolean::New(env, true);
}

// Sets the flags that ask the capture thread to exit and returns
// immediately -- never blocks, never touches g_thread. Split out of Stop()
// so both Stop() and the AddCleanupHook registered in Init() (process exit
// without an explicit stop() first -- see R5) can request the same
// shutdown without duplicating it.
void SignalStop() {
  g_running.store(false);
  if (g_stopEvent) SetEvent(g_stopEvent);
}

// Joins the capture thread off the main thread and resolves stop()'s
// promise once that join completes. This is item 3's whole point: the old
// synchronous Stop() ran g_thread.join() directly on the JS/Electron main
// thread, which could block it for as long as one CaptureThread iteration
// takes to notice g_stopEvent and unwind (WGC session close, D3D device
// teardown) -- exactly the main-thread freeze this PR exists to remove
// (R4).
//
// g_thread is moved in, not referenced: Execute() below runs on a libuv
// threadpool thread, so this worker needs its own copy of the std::thread
// handle rather than touching the global from two threads at once. The
// move also makes g_thread.joinable() go false the instant Stop() returns,
// which is exactly what lets a concurrent Start() tell "idle" from "still
// shutting down" via g_stopping instead (see Start()'s guard above).
class StopWorker : public Napi::AsyncWorker {
 public:
  StopWorker(Napi::Env env, Napi::Promise::Deferred deferred, std::thread thread)
      : Napi::AsyncWorker(env), deferred_(deferred), thread_(std::move(thread)) {}

  // Runs on the libuv threadpool -- must not touch any Napi:: type (env,
  // values, the deferred) from here; that is exactly what OnOK/OnError
  // (called back on the JS thread once this returns) are for.
  void Execute() override {
    if (thread_.joinable()) thread_.join();
  }

  // Back on the JS thread. Handle close happens here, not in Execute(), per
  // item 5's instruction -- keeping every mutation of g_stopEvent on this
  // one thread (as opposed to split across two) keeps its lifetime story
  // simple: exactly one thread (JS) ever creates or closes it, exactly one
  // thread (the capture thread, via WaitForSingleObject) ever waits on it.
  void OnOK() override {
    if (g_stopEvent) {
      CloseHandle(g_stopEvent);
      g_stopEvent = nullptr;
    }
    g_stopping.store(false);
    deferred_.Resolve(Env().Undefined());
    // Any stop() calls that arrived while this join was still in flight
    // (see Stop()'s comment) resolve now too, alongside the primary
    // deferred -- same outcome, same tick.
    for (auto& d : g_pendingStopDeferreds) d.Resolve(Env().Undefined());
    g_pendingStopDeferreds.clear();
  }

  void OnError(const Napi::Error& e) override {
    // Execute() above only calls std::thread::join(), which does not throw
    // for a joinable thread, so this path is not expected to run in
    // practice. It exists so g_stopping cannot get stuck true forever (and
    // Start() permanently refuse) if AsyncWorker's own machinery ever
    // reports a failure some other way; reject rather than resolve so a
    // caller who somehow hits this sees it instead of believing stop()
    // silently succeeded.
    g_stopping.store(false);
    deferred_.Reject(e.Value());
    for (auto& d : g_pendingStopDeferreds) d.Reject(e.Value());
    g_pendingStopDeferreds.clear();
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::thread thread_;
};

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  // A stop is already in flight: g_stopping is set below and only cleared
  // once StopWorker::OnOK/OnError actually runs. By the time it is true,
  // g_running is already false (SignalStop cleared it) and g_thread is
  // already non-joinable (std::move()'d into the worker below) -- so the
  // "nothing to stop" check just past this one would otherwise resolve a
  // second stop() immediately, before the in-flight join has actually
  // finished. That breaks the contract Start() relies on (it throws
  // "previous capture still shutting down" for the whole g_stopping
  // window): a caller doing `await stop(); start()` would see this stop()
  // resolve early and then hit that throw anyway. Queue this deferred
  // instead and let the in-flight StopWorker's OnOK/OnError resolve/reject
  // it alongside the primary one.
  if (g_stopping.load()) {
    g_pendingStopDeferreds.push_back(std::move(deferred));
    return g_pendingStopDeferreds.back().Promise();
  }
  if (!g_running.load() && !g_thread.joinable()) {
    // Nothing to stop -- resolve immediately. Matches the stub's
    // already-resolved promise (see stub.cc) so callers see the same shape
    // on every platform regardless of whether anything was actually
    // running.
    deferred.Resolve(env.Undefined());
    return deferred.Promise();
  }
  SignalStop();
  g_stopping.store(true);
  auto* worker = new StopWorker(env, deferred, std::move(g_thread));
  worker->Queue();
  return deferred.Promise();
}

Napi::Value LastError(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), GetErrorText());
}

/**
 * Change the delivery cadence of the running capture.
 *
 * Cheap and safe at any time: the capture thread re-reads g_fps every
 * iteration and nothing else depends on the rate, so there is no session to
 * tear down and no pipeline to rebuild. Returns false when nothing is
 * capturing or the value is not usable, so the caller can log rather than
 * assume it took.
 */
Napi::Value SetFps(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_running.load()) return Napi::Boolean::New(env, false);
  if (info.Length() < 1 || !info[0].IsNumber()) return Napi::Boolean::New(env, false);
  const double fps = info[0].As<Napi::Number>().DoubleValue();
  if (!(fps > 0) || fps > 240) return Napi::Boolean::New(env, false);
  g_fps.store(fps, std::memory_order_relaxed);
  return Napi::Boolean::New(env, true);
}

/**
 * Change the target bounding box of the capture already running (item 1 of
 * PR C3: a mid-share preset change, e.g. 1080p -> 720p).
 *
 * Cheap and safe at any time, same reasoning as SetFps just above: the
 * capture thread's own EnsurePipeline call re-reads g_targetW/g_targetH
 * every frame (see its re-key check) and rebuilds the video processor and
 * output/staging textures for the new box on the very next frame -- there is
 * no session to tear down and no pipeline to rebuild here on the JS thread.
 * Returns false when nothing is capturing or the values are not usable, so
 * the caller can log rather than assume it took, same contract as SetFps.
 */
Napi::Value SetTarget(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_running.load()) return Napi::Boolean::New(env, false);
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) return Napi::Boolean::New(env, false);
  const double w = info[0].As<Napi::Number>().DoubleValue();
  const double h = info[1].As<Napi::Number>().DoubleValue();
  // Same >= 2 floor Start() enforces (NV12's 2x2 chroma subsampling), and an
  // upper bound generous enough to never be the limiting factor for any real
  // preset -- EnsurePipeline's own fit-inside clamp-to-1 is what actually
  // stops a source from being upscaled, this is only a sanity check against
  // a clearly-wrong value crossing IPC from a remote page.
  if (!(w >= 2) || !(h >= 2) || w > 8192 || h > 8192) return Napi::Boolean::New(env, false);
  g_targetW.store(static_cast<UINT32>(w), std::memory_order_relaxed);
  g_targetH.store(static_cast<UINT32>(h), std::memory_order_relaxed);
  return Napi::Boolean::New(env, true);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("setFps", Napi::Function::New(env, SetFps));
  exports.Set("setTarget", Napi::Function::New(env, SetTarget));
  exports.Set("lastError", Napi::Function::New(env, LastError));

  // Item 5 / R5: nothing previously stopped native capture on quit. Left
  // alone, an in-progress g_thread reaches static destruction as a still-
  // joinable std::thread, which is std::terminate() -- or, if teardown
  // order goes the other way, a deadlock in DLL detach instead. This hook
  // runs synchronously on the JS/main thread as the environment is torn
  // down (Electron quit, or a plain process exit), so it is the last
  // chance to request an orderly stop before that.
  //
  // Bounded, not join()-forever: a wedged capture thread must not hang
  // process exit. 3000ms is generous against how long CaptureThread's own
  // teardown actually takes (WGC session/pool Close(), a handful of D3D
  // Release() calls) while still bounding the worst case. On timeout,
  // detach rather than join -- a detached thread that outlives the process
  // by a few more milliseconds while the OS is tearing everything down
  // anyway is harmless; destroying a still-joinable std::thread is not.
  //
  // If stop() was already called and is mid-flight (StopWorker joining on
  // the threadpool), g_thread was already std::move()'d out of and is not
  // joinable here, so this is a no-op -- correctly: that join is already
  // in progress and Node keeps the loop alive for it regardless.
  env.AddCleanupHook([]() {
    if (!g_thread.joinable()) return;
    SignalStop();
    HANDLE handle = g_thread.native_handle();
    if (WaitForSingleObject(handle, 3000) == WAIT_OBJECT_0) {
      g_thread.join();
      // Safe here, and ONLY here: the one thread that ever waits on
      // g_stopEvent has now fully exited (join() would not have returned
      // otherwise), so nothing can touch this handle again. In the detach
      // branch below the thread may still be running -- possibly not yet
      // as far as its own WaitForSingleObject(g_stopEvent, ...) call --
      // closing the handle there would hand that call an invalid handle.
      // Leaking it in that one case is deliberate: the process is exiting
      // either way, and the OS reclaims the handle regardless.
      if (g_stopEvent) {
        CloseHandle(g_stopEvent);
        g_stopEvent = nullptr;
      }
    } else {
      g_thread.detach();
    }
  });

  return exports;
}

}  // namespace

NODE_API_MODULE(win_capture, Init)
