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

// ---------------------------------------------------------------------------
// GPU scheduling priority (items 2 and 3 of the focused-game-FPS fix,
// alongside the deeper staging ring above). Both are best-effort asks of the
// OS/driver scheduler that this capture's own GPU work -- VideoProcessorBlt +
// CopyResource in ProcessFrame -- not sit behind a focused game's queued work
// indefinitely; see kStagingRingSize's own doc comment for the measurement
// that motivated all of this. Set once per session in CaptureThread, right
// after D3D11CreateDevice succeeds.
//
// Deliberately NOT routed through g_lastError/SetErrorText: that channel is
// read as "the terminal reason this session ended" (LastError(), the death
// signal's `reason`) and is overwritten by SetError() on the next real
// failure -- exactly wrong for two calls that are expected to often "fail"
// (see D3DKMTSetProcessSchedulingPriorityClass below) without the session
// failing, and whose result needs to survive, unmolested, for as long as the
// session runs so the FIRST live frame's meta can report it. A separate
// mutex-guarded pair of strings, read the same way g_lastError is (never the
// bare variable), keeps that information addressable on its own instead of
// competing with real errors for the one slot.
std::mutex g_gpuPriorityMutex;
std::string g_gpuThreadPriorityInfo = "not attempted";
std::string g_schedulingPriorityInfo = "not attempted";

std::string GetGpuThreadPriorityInfo() {
  std::lock_guard<std::mutex> lock(g_gpuPriorityMutex);
  return g_gpuThreadPriorityInfo;
}

void SetGpuThreadPriorityInfo(std::string message) {
  std::lock_guard<std::mutex> lock(g_gpuPriorityMutex);
  g_gpuThreadPriorityInfo = std::move(message);
}

std::string GetSchedulingPriorityInfo() {
  std::lock_guard<std::mutex> lock(g_gpuPriorityMutex);
  return g_schedulingPriorityInfo;
}

void SetSchedulingPriorityInfo(std::string message) {
  std::lock_guard<std::mutex> lock(g_gpuPriorityMutex);
  g_schedulingPriorityInfo = std::move(message);
}

// D3DKMTSetProcessSchedulingPriorityClass lives in d3dkmthk.h, a driver-kit
// header this project does not otherwise need and gdi32.lib, a link
// dependency it does not otherwise have -- pulling in either for three lines
// of best-effort code is not worth it, so both the enum value and the
// function's signature are declared by hand here (this is the whole ABI
// contract; it does not change across Windows versions) and the function
// itself is resolved dynamically from gdi32.dll, which is already loaded in
// every Windows process. See CaptureThread for the GetProcAddress call and
// why a missing/failing export is expected, not an error.
// NTSTATUS is not otherwise declared in this translation unit (it normally
// comes from winternl.h/ntdef.h, neither of which this file includes) --
// but it is always a plain LONG typedef, never a macro, so redeclaring it
// identically here is legal C++ even if some other header this file already
// includes happens to have typedef'd it too; there is nothing to guard
// against, unlike a #define.
typedef LONG NTSTATUS;
enum D3DKMT_SCHEDULINGPRIORITYCLASS {
  D3DKMT_SCHEDULINGPRIORITYCLASS_IDLE = 0,
  D3DKMT_SCHEDULINGPRIORITYCLASS_BELOW_NORMAL = 1,
  D3DKMT_SCHEDULINGPRIORITYCLASS_NORMAL = 2,
  D3DKMT_SCHEDULINGPRIORITYCLASS_ABOVE_NORMAL = 3,
  D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH = 4,
  D3DKMT_SCHEDULINGPRIORITYCLASS_REALTIME = 5,
};
// NOTE: the enum above intentionally mirrors the real d3dkmthk.h layout in
// full (IDLE..REALTIME) even though only HIGH is used, so the numeric value
// passed to the real driver-validated API matches what d3dkmthk.h itself
// would generate -- a hand-declared enum that omitted the earlier members
// would still compile but silently send the wrong ordinal.
typedef NTSTATUS(APIENTRY* PFN_D3DKMTSetProcessSchedulingPriorityClass)(HANDLE, D3DKMT_SCHEDULINGPRIORITYCLASS);

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
 * Now: CopyResource into the NEXT slot, and Map the OLDEST one -- the slot
 * whose own CopyResource is kStagingRingSize-1 frame intervals in the past,
 * not merely the one written last call (see ProcessFrame's readSlot for why
 * "oldest", not "previous", is the correct target at any ring depth) -- with
 * D3D11_MAP_FLAG_DO_NOT_WAIT. Whatever GPU work is still outstanding for the
 * oldest slot has had kStagingRingSize-1 intervals to land, so by the time
 * this call reaches it, it is normally done; DO_NOT_WAIT turns "normally"
 * into a guarantee -- Map() returns immediately either way,
 * DXGI_ERROR_WAS_STILL_DRAWING if the GPU is for some reason still behind,
 * in which case that frame is skipped exactly like any other pacing drop
 * rather than blocked on.
 *
 * 2 was shipped as "the minimum that works" on the theory that it would only
 * be worth going deeper if it was measured to skip often in practice. It has
 * now been measured: a user's app-audio.log 10s summaries showed `refused=0`,
 * `bltMs=0.00`, `grabMs<0.5` throughout -- nothing CPU-side was slow and
 * nothing was queued -- while `stillDrawing` jumped from 0 to ~270-390 per
 * 10s (~27/s) exactly when the shared window (a game) had focus, and
 * `produced` collapsed from ~53fps to 1-14fps in the same window. A focused
 * game saturates the GPU's own queue; this module's VideoProcessorBlt +
 * CopyResource then regularly takes longer than one frame interval to reach
 * the front of it, so by the time Map(DO_NOT_WAIT) polls the slot, the copy
 * has not landed and the frame is skipped.
 *
 * 3 gives the GPU two frame intervals of head start instead of one (see
 * ProcessFrame's readSlot -- the slot read is always the OLDEST of the ring,
 * not merely the previous one) at the cost of one extra ~1.5MB staging
 * texture and one more frame of latency (~17ms at 60fps). Not going straight
 * to 4+: each extra slot buys diminishing head start against a fixed cost in
 * memory and glass-to-glass latency, and the 10s summary already reports
 * `stillDrawing` for free -- so the move is to ship 3, watch that counter
 * under real contention, and only go deeper if it is still nonzero.
 */
constexpr int kStagingRingSize = 3;
struct StagingSlot {
  ComPtr<ID3D11Texture2D> tex;  // D3D11_USAGE_STAGING, CPU-readable copy of g_outputTex
  // This slot's own frame timestamp, captured at CopyResource time and read
  // back out kStagingRingSize-1 calls later alongside the pixels -- see
  // ProcessFrame. Without this, the ring's kStagingRingSize-1-frame delivery
  // lag would pair frame N's own timestampUs with frame N-(kStagingRingSize-1)'s
  // pixels, silently reintroducing the kind of timestamp/content mismatch PR
  // C2 removed.
  double timestampUs = 0;
};
StagingSlot g_stagingRing[kStagingRingSize];
int g_stagingRingIndex = 0;   // next slot ProcessFrame will CopyResource into
// Priming counter, not a slot-written count: it only ever climbs to
// kStagingRingSize - 1 (see ProcessFrame's priming check) -- the point at
// which the slot about to be read next already has real content,
// kStagingRingSize-1 intervals old, not kStagingRingSize (every slot ever
// written).
int g_stagingRingFilled = 0;

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
  // outTex/vp/vpEnum above, so a failure partway through (e.g. slot 1 of
  // kStagingRingSize) never touches the globals and leaves the previous,
  // still-valid pipeline in place for EnsurePipeline's caller to keep using.
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

// Pool of live-frame payloads (PR A4 item 3), sized to match the TSFN queue
// depth argued for in Start()'s g_tsfn comment (3) -- a `new`/`delete`
// FramePayload per frame was a ~3MB heap alloc/dealloc pair at up to 60fps,
// on top of the memcpy this whole module already exists to shrink. This is a
// fixed global array, not per-session: it survives across Start()/Stop()
// cycles untouched (nothing about it needs resetting -- see the doc comment
// on AcquirePooledPayload for why that is safe), the same way the staging
// texture ring's slots do.
//
// Does NOT cover the death-signal payload (Emit()'s other caller, in
// CaptureThread's teardown) -- that one stays a plain `new`/`delete`,
// deliberately. It happens at most once per session, so pooling it buys
// nothing, and pooling it WOULD introduce a real hazard: the death payload
// goes through Emit()'s bounded retry loop specifically because the queue
// can legitimately be full at that moment (see kDeathRetries' comment), and
// a payload drawn from this same 3-slot pool could still be sitting
// queued-but-not-yet-drained from an ordinary frame at that exact moment --
// there is no guarantee a free slot exists to hand the death signal in the
// first place, which would turn "retry until the queue has room" into
// "retry until a *pool slot* frees up AND the queue has room", a strictly
// harder and unnecessary problem for a payload this module can afford to
// heap-allocate once per session.
constexpr int kFramePoolSize = 3;
FramePayload g_framePayloadPool[kFramePoolSize];
std::atomic<bool> g_framePayloadInUse[kFramePoolSize] = {};

// Only the capture thread ever calls this (the same single-writer invariant
// documented on g_tsfn's New() call in Start() -- Emit() is CaptureThread's
// alone to call), so the linear scan below needs no producer-side lock: at
// most one thread is ever racing the *consumer* side (the JS thread, via
// ReleasePooledPayload below), never itself.
//
// Returns nullptr when all kFramePoolSize slots are still owned by a
// payload the JS thread has not yet finished reading -- the caller (
// ProcessFrame) treats that exactly like Emit()'s own full-queue drop: bump
// g_framesRefused and skip the frame, never blocking. A free slot found here
// is not a guarantee the *TSFN queue* itself has room -- Emit() still
// separately handles that with its own drop path -- so a frame can still be
// refused by Emit() even after successfully acquiring a slot here; see that
// refusal branch for why the slot is released, not leaked, when that
// happens.
FramePayload* AcquirePooledPayload() {
  for (int i = 0; i < kFramePoolSize; i++) {
    bool expected = false;
    if (g_framePayloadInUse[i].compare_exchange_strong(expected, true, std::memory_order_acquire)) {
      return &g_framePayloadPool[i];
    }
  }
  return nullptr;
}

// Marks a slot free again. Called from two places: Emit(), when
// NonBlockingCall refuses a live payload outright (it was never queued, so
// nothing else can be reading it), and EmitToJs, on the JS thread, once
// Napi::Buffer::Copy has taken its own copy of `nv12` and every scalar field
// has been read into `meta` -- i.e. once nothing downstream still needs this
// slot's contents, not only once the JS callback has returned. Releasing
// that early (rather than after `cb.Call`) keeps this pool's "in use" window
// as close as possible to the TSFN's own internal queue-occupancy window;
// see EmitToJs for the exact ordering. The release-store here is
// AcquirePooledPayload's compare_exchange's pairing acquire, which is what
// makes it safe for the capture thread to start overwriting this slot's
// `nv12` for a new frame the instant this returns, without a data race.
void ReleasePooledPayload(FramePayload* payload) {
  const auto index = payload - g_framePayloadPool;
  g_framePayloadInUse[index].store(false, std::memory_order_release);
}

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

/**
 * Times ProcessFrame's Map(readSlot, D3D11_MAP_FLAG_DO_NOT_WAIT) returned
 * DXGI_ERROR_WAS_STILL_DRAWING, cumulative for this session -- see the
 * comment on that branch for why this is an ordinary pacing drop, not a
 * failure. It used to be silent: the early `return true` reported nothing,
 * so a run of these -- e.g. every frame, if the missing Flush() this counter
 * was added alongside were ever reintroduced -- looked identical to a
 * healthy session that simply had nothing to deliver. Reported alongside
 * `refused`/`poolResizes` so the 10s summary in screenCapture.ts can name
 * this specific stage instead of a share that produces nothing being
 * indistinguishable from one that was never asked to produce anything.
 */
std::atomic<uint64_t> g_framesStillDrawing{0};

/**
 * Times CaptureThread's frame->get_SystemRelativeTime() read failed, or
 * "succeeded" with Duration == 0, and pacing fell back to QpcNow100ns()
 * instead -- cumulative for this session. See QpcNow100ns's own doc comment
 * for why a failed read must never be treated as a genuine 0. Surfaced the
 * same way as the other counters above so screenCapture.ts can log once, on
 * the 0 -> nonzero edge, rather than the native side owning a log line of
 * its own -- see this file's SetErrorText/lastError() split for why a
 * transient, self-recovering condition like this one does not belong there.
 */
std::atomic<uint64_t> g_timestampFallbacks{0};

/**
 * Times CaptureThread's pacing clock reset because `ts` (from whichever of
 * get_SystemRelativeTime()/QpcNow100ns() was used for this frame -- see
 * g_timestampFallbacks just above) landed BEFORE lastDeliveredTs instead of
 * merely too close to it -- cumulative for this session. Deliberately a
 * separate counter from g_timestampFallbacks, not a reuse of it: falling
 * back to QpcNow100ns() and hitting this backward jump are not the same
 * event. A session can use the fallback on every frame after the first
 * without ever landing here (the QPC-derived value stays consistently ahead
 * of lastDeliveredTs), and this can just as well fire coming BACK OUT of the
 * fallback -- a genuine, smaller get_SystemRelativeTime() read following a
 * larger QpcNow100ns() one -- which never touches g_timestampFallbacks at
 * all, since that frame took the successful-read branch. Counting them
 * together would blur "we used a substitute clock" (harmless by itself, per
 * QpcNow100ns's doc comment) with "the two clocks just disagreed about
 * order" (the actual precondition for the stall this counter exists to make
 * visible -- see the re-baseline just above the pacing check in
 * CaptureThread for the fix, and QpcNow100ns's doc comment for why the
 * re-baseline, not this counter, is what keeps it from recurring).
 */
std::atomic<uint64_t> g_timestampDiscontinuities{0};

// Named (not an inline lambda at the call site) so Emit() below can pass it
// to more than one NonBlockingCall attempt when retrying a death payload.
void EmitToJs(Napi::Env env, Napi::Function cb, FramePayload* p) {
  auto meta = Napi::Object::New(env);
  meta.Set("refused", Napi::Number::New(env, static_cast<double>(g_framesRefused.load())));
  meta.Set("poolResizes", Napi::Number::New(env, static_cast<double>(g_poolResizes.load())));
  meta.Set("stillDrawing", Napi::Number::New(env, static_cast<double>(g_framesStillDrawing.load())));
  meta.Set("timestampFallbacks", Napi::Number::New(env, static_cast<double>(g_timestampFallbacks.load())));
  meta.Set("timestampDiscontinuities",
           Napi::Number::New(env, static_cast<double>(g_timestampDiscontinuities.load())));
  // Set once per session by CaptureThread, right after D3D11CreateDevice --
  // see g_gpuThreadPriorityInfo's own comment. Read on every frame/death
  // signal exactly like the counters above rather than plumbed through a
  // separate one-shot channel, so it is visible on the very first frame
  // without screenCapture.ts having to special-case "first frame" itself.
  meta.Set("gpuThreadPriority", Napi::String::New(env, GetGpuThreadPriorityInfo()));
  meta.Set("schedulingPriority", Napi::String::New(env, GetSchedulingPriorityInfo()));
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
  // the pixels, and every scalar field has already been read into `meta` --
  // nothing below this line still reads `p`. Released back to the pool
  // (item 3) rather than deleted: `p` is one of g_framePayloadPool's
  // kFramePoolSize slots, not a heap allocation, for every live frame (see
  // ProcessFrame/AcquirePooledPayload) -- freeing it here would double-free
  // the moment the capture thread next wrote into that same slot. Released
  // *before* `cb.Call`, not after: see ReleasePooledPayload's doc comment
  // for why that ordering matters.
  ReleasePooledPayload(p);
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
    // Never queued (NonBlockingCall refused it outright), so nothing else
    // can be reading this slot -- released back to the pool (item 3), not
    // deleted: this is one of g_framePayloadPool's slots, not a heap
    // allocation.
    ReleasePooledPayload(payload);
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
  // Staging ring (item 2 of PR C3, deepened by the focused-game-FPS fix):
  // write this frame's blit result into the NEXT ring slot, but read back
  // the OLDEST slot's -- blitted kStagingRingSize-1 frame intervals ago --
  // content, instead of the one just copied into. CopyResource only
  // *starts* the GPU->CPU copy; it does not wait for it, so Map()'ing the
  // slot just copied into would still pay the full pipeline stall this item
  // exists to remove. Reading the oldest slot means whatever GPU work is
  // still outstanding for it had the longest possible head start this ring
  // depth can offer, so D3D11_MAP_FLAG_DO_NOT_WAIT normally succeeds
  // immediately; on the rare case it has not, Map() returns
  // DXGI_ERROR_WAS_STILL_DRAWING right away instead of blocking, and this
  // call skips the frame exactly like any other pacing drop -- see
  // kStagingRingSize's declaration for more.
  const int writeSlot = g_stagingRingIndex;
  g_context->CopyResource(g_stagingRing[writeSlot].tex.Get(), g_outputTex.Get());
  g_stagingRing[writeSlot].timestampUs = timestampUs;
  g_stagingRingIndex = (writeSlot + 1) % kStagingRingSize;

  // CopyResource above only *records* the GPU->CPU copy into the immediate
  // context's command list -- it does not submit it, and with no Present()
  // anywhere in this headless capture path nothing else submits it either,
  // short of the driver eventually auto-flushing on a full command buffer
  // (bursty at best, and in practice never happens before the caller gives
  // up). Flush() here is what actually hands the copy to the GPU. Without
  // it, Map(..., D3D11_MAP_FLAG_DO_NOT_WAIT) below has nothing to poll but
  // work that was never submitted, so it returns DXGI_ERROR_WAS_STILL_DRAWING
  // -- forever, not just on the rare occasion the comment above the read
  // slot describes -- and this function never delivers a single frame. This
  // is a plain Flush(), not a wait: it costs a driver call to hand off the
  // command list, not a pipeline stall, so it does not undo the point of
  // moving Map() to DO_NOT_WAIT above.
  g_context->Flush();

  // The first kStagingRingSize-1 frames after Start() or after EnsurePipeline
  // resets this ring (a resize or a setTarget() -- see its own comment) have
  // no OLDEST slot with real content to read: every slot is a freshly
  // created, never-copied-into STAGING texture. Returning true with nothing
  // emitted is not a failure -- CaptureThread already treats "no Emit() this
  // iteration" as an ordinary drop (the same path a too-fast frame or a
  // still-drawing GPU takes), so the caller sees no difference from any
  // other skipped frame; it is just guaranteed for a session's or a
  // rebuild's first kStagingRingSize-1 frame(s) instead of merely likely.
  //
  // Compared against kStagingRingSize - 1, not kStagingRingSize: this
  // reasoning is depth-independent, not specific to N=2 or N=3. filled==0
  // means writeSlot's own copy (just issued above) is the only content the
  // ring has ever held, so priming this call's own return is correct. Each
  // subsequent call increments filled by exactly one, and once filled
  // reaches kStagingRingSize-1, that many DISTINCT slots (every slot except
  // the one just written this call) have each been written at least once --
  // which is exactly the set the ring can ever read from, so the oldest of
  // them (readSlot below) is guaranteed to hold real content, one whole
  // priming phase old, exactly like the steady-state case. The old
  // `< kStagingRingSize` bound primed for one call too many, discarding a
  // frame that was already readable, on every EnsurePipeline rebuild -- and
  // `0c836e28` made those rebuilds happen on every quality change, not just
  // at session start.
  if (g_stagingRingFilled < kStagingRingSize - 1) {
    g_stagingRingFilled++;
    return true;
  }

  // The OLDEST slot, not "one behind" writeSlot: g_stagingRingIndex advances
  // by exactly 1 (mod kStagingRingSize) every single call, so the slot whose
  // content is furthest from being overwritten again is always the one
  // immediately AHEAD of writeSlot in the cycle, i.e. (writeSlot + 1) % N --
  // the slot this same call will become the write target for, N calls from
  // now (N-1 calls from the NEXT call). This looks identical to "one behind"
  // at N=2, where +1 and -1 land on the same single other slot, which is why
  // the collapse to (writeSlot + N - 1) % N is behaviour-preserving at N=2
  // but WRONG for any N>2, where it keeps reading the slot written just one
  // interval ago no matter how deep the ring is declared -- silently giving
  // a deeper ring zero extra GPU head start. Bumping kStagingRingSize alone,
  // without also moving this expression to the true oldest slot, changes
  // nothing about how much head start a read gets.
  const int readSlot = (writeSlot + 1) % kStagingRingSize;
  D3D11_MAPPED_SUBRESOURCE mapped{};
  hr = g_context->Map(g_stagingRing[readSlot].tex.Get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
  const auto t2 = std::chrono::steady_clock::now();
  if (hr == DXGI_ERROR_WAS_STILL_DRAWING) {
    // Not a failure -- see the comment above this block. The pixels
    // themselves are not corrupted, only unread -- but there is no "gets
    // another chance once the ring cycles back to it" at any ring depth,
    // because of phase-locking: readSlot is a FIXED function of writeSlot
    // ((writeSlot + 1) % N, always), and writeSlot advances by exactly 1
    // (mod N) every single call with no dependence on whether the previous
    // read succeeded. A fixed function of a value that itself advances in
    // lockstep visits each ring position exactly once per N-call cycle, at
    // the same fixed phase offset relative to writeSlot every time -- so
    // read and write visit each slot at a fixed relative distance, cycle
    // after cycle, never drifting apart to open a second read window. Here
    // that fixed distance is one call (readSlot this call == writeSlot next
    // call, by construction), i.e. zero room for a retry: whatever this call
    // just failed to read is the very slot CopyResource overwrites on the
    // next iteration. So a failed Map() is a dropped frame, full stop. What
    // a deeper ring buys is not a retry, it is more elapsed GPU time before
    // this one attempt -- lowering how often the attempt fails at all.
    // Counted (not just silently returned) so a session that skips every
    // single frame this way -- e.g. the Flush() above being lost again some
    // future PR -- is visible in the 10s summary (screenCapture.ts) instead
    // of looking identical to a healthy session with nothing to deliver.
    g_framesStillDrawing.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
  if (FAILED(hr)) {
    SetError("Map(staging texture)", hr);
    return false;
  }

  // Pooled (item 3), not `new`: see AcquirePooledPayload's doc comment for
  // what a null return means and why it is handled exactly like Emit()'s own
  // full-queue drop rather than falling back to a heap allocation -- this
  // function must never block or grow unboundedly on a slow JS thread any
  // more than the queue itself does.
  auto* payload = AcquirePooledPayload();
  if (!payload) {
    g_framesRefused.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
  payload->width = g_outW;
  payload->height = g_outH;
  payload->bltMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
  // No longer a GPU-wait measurement now that Map() is DO_NOT_WAIT -- it
  // normally reads near zero, which is the point of this item, not a bug.
  // grabMs still exists as a field so the harness/renderer can tell a
  // healthy near-zero value apart from the rare WAS_STILL_DRAWING skip above
  // (which never reaches here to report one).
  payload->grabMs = std::chrono::duration<double, std::milli>(t2 - t1).count();
  // This slot's OWN timestamp, captured when it was written
  // kStagingRingSize-1 calls ago -- not the `timestampUs` argument, which
  // belongs to the frame just blitted into writeSlot (a DIFFERENT slot than
  // readSlot) this same call. Using the argument here would pair this
  // frame's pixels with a future frame's timestamp, silently undoing PR C2's
  // real-per-frame-timestamp fix for the kStagingRingSize-1-frame lag this
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

// This handler MUST be agile. The frame pool it subscribes to (created above
// via CreateFreeThreaded) is itself free-threaded, and a free-threaded
// source is entitled to raise FrameArrived on whatever thread pool thread it
// pleases -- never guaranteed to be the thread that called add_FrameArrived.
// WinRT enforces that guarantee at subscription time, not delivery time: the
// free-threaded frame pool's add_FrameArrived calls QueryInterface for
// IAgileObject on the handler it's given, and if that fails, refuses the
// subscription outright with RO_E_MUST_BE_AGILE (0x8000001C) rather than
// risk marshalling a non-agile object across apartments later. Plain
// RuntimeClassFlags<ClassicCom> gets none of that: it's a bare classic-COM
// object with no apartment/marshalling story of its own, so it fails that
// QueryInterface. Adding Microsoft::WRL::FtmBase to the template list mixes
// in IAgileObject (satisfying the check) plus the free-threaded marshaler's
// IMarshal implementation (satisfying the ACTUAL cross-apartment call once
// subscribed) -- both for free, without changing anything about how Invoke()
// runs or on which thread. Do not remove FtmBase: without it, add_FrameArrived
// fails every single time against a free-threaded pool, silently -- the
// event-driven capture path never fires and every share falls back to
// Chromium's capturer with only a log line (see SetError below) to show why.
class FrameArrivedHandler
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          ABI::Windows::Foundation::ITypedEventHandler<WGC::Direct3D11CaptureFramePool*, IInspectable*>,
          Microsoft::WRL::FtmBase> {
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

/**
 * Monotonic fallback for frame delivery pacing, in the same 100ns units as
 * frame->get_SystemRelativeTime() (see CaptureThread's pacing comment above
 * nextDeliverTs/lastDeliveredTs).
 *
 * get_SystemRelativeTime() can fail, and -- observed in the wild, not just
 * hypothesised -- some drivers hand back a "successful" HRESULT with
 * Duration == 0. Either way, the caller must never treat that as a genuine
 * timestamp: the pacing check below is `ts < nextDeliverTs`, and nothing but
 * an actual delivery ever advances nextDeliverTs. A `ts` of exactly 0 only
 * costs one dropped frame if nextDeliverTs was already ahead of it -- but if
 * THIS were the very first frame of the session, nextDeliverTs would latch
 * onto `0 + interval100ns` as the schedule's starting point, and every later
 * frame's own (also fabricated-as-0-on-failure, or worse, genuinely small)
 * value would keep failing to reach that mark, permanently. A single bad
 * read used to be enough to end delivery for the rest of the session with
 * nothing in the logs to explain why -- which is exactly why `ts` is never
 * allowed to actually be a fabricated 0 in the first place: substituting
 * QpcNow100ns() below keeps `ts` itself genuinely, unboundedly advancing
 * even when get_SystemRelativeTime() never recovers, so the schedule stays
 * reachable.
 *
 * QueryPerformanceCounter is this thread's own monotonic wall clock -- not
 * comparable to WGC's SystemRelativeTime in absolute terms (different
 * epochs), and pacing here compares a given `ts` against either the running
 * delivery schedule (nextDeliverTs) or the previously delivered frame's own
 * timestamp (lastDeliveredTs, kept solely for the discontinuity guard) -- so
 * switching which clock backs `ts`, in either direction, can make either of
 * those comparisons land wrong instead of merely imprecise. Left unguarded,
 * that is not "at most one wrongly-paced frame": a `ts` from the new clock
 * landing far behind the old clock's epoch would fail `ts < nextDeliverTs`
 * forever, since nothing but a delivery advances nextDeliverTs -- the exact
 * same permanent-stall shape described above, just triggered by a clock
 * switch instead of a fabricated 0. What actually makes the epoch mismatch
 * survivable is CaptureThread's own discontinuity guard, immediately before
 * the pacing check: any `ts` that reads BEFORE lastDeliveredTs re-baselines
 * pacing (resets both lastDeliveredTs and nextDeliverTs to the "take the
 * next frame unconditionally" sentinel) the moment it happens, rather than
 * trusting the two clocks to ever agree on absolute values. With that guard
 * in place, a one-time epoch mismatch on the frame where a clock switch
 * happens costs at most one re-baselined frame, not a stall -- see
 * g_timestampDiscontinuities for the counter that makes a session which
 * actually hits this leave a trace.
 * QueryPerformanceFrequency cannot fail on any Windows version this addon
 * targets (Vista+); the cached frequency is read once and reused, same
 * reasoning as every other per-process-constant cache in this file.
 */
double QpcNow100ns() {
  static const LARGE_INTEGER kFrequency = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return f;
  }();
  LARGE_INTEGER counter;
  QueryPerformanceCounter(&counter);
  return static_cast<double>(counter.QuadPart) * 1.0e7 / static_cast<double>(kFrequency.QuadPart);
}

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

    // GPU scheduling priority (items 2 and 3 of the focused-game-FPS fix --
    // see g_gpuThreadPriorityInfo's own comment for why this is a separate
    // channel from SetErrorText/g_lastError). Neither call can fail this
    // session: a rejected or unavailable priority bump leaves capture exactly
    // as it would have run without this block, just slower under contention
    // than it would otherwise be -- the ring-depth fix above is what actually
    // has to work. Both go right here, immediately after device creation,
    // because (2) needs g_device already created and (3) is a one-time,
    // process-wide call that has no reason to wait for anything later in this
    // function -- doing both before the (failure-prone, WinRT-heavy) setup
    // below means a session that fails further down still recorded whether
    // the GPU/scheduler cooperated, instead of that information depending on
    // how far setup got.

    // (2) IDXGIDevice::SetGPUThreadPriority -- the documented, no-privilege-
    // required knob for "this device's GPU work should be scheduled ahead of
    // others sharing the GPU". Range is -7..7; 7 is the maximum boost this
    // API allows. SetGPUThreadPriority is declared on the base IDXGIDevice
    // interface itself, not IDXGIDevice1 (which only adds the unrelated
    // SetMaximumFrameLatency/GetMaximumFrameLatency pair), so this is the
    // same interface the WGC bridge QIs for below -- QueryInterface'd
    // separately here anyway since that one is not obtained until after this
    // block and QI itself is cheap.
    {
      ComPtr<IDXGIDevice> priorityDxgiDevice;
      HRESULT priHr = g_device.As(&priorityDxgiDevice);
      if (SUCCEEDED(priHr)) {
        priHr = priorityDxgiDevice->SetGPUThreadPriority(7);
      }
      char buf[128];
      if (SUCCEEDED(priHr)) {
        snprintf(buf, sizeof(buf), "SetGPUThreadPriority(7)=ok");
      } else {
        snprintf(buf, sizeof(buf), "SetGPUThreadPriority(7) failed (hr=0x%08lX)",
                 static_cast<unsigned long>(priHr));
      }
      SetGpuThreadPriorityInfo(buf);
    }

    // (3) D3DKMTSetProcessSchedulingPriorityClass(..., HIGH) -- what OBS's
    // own "GPU priority" option calls under the hood. Unlike (2) above, this
    // changes the whole PROCESS's GPU scheduling class, not just this one
    // device's queue, and is the lever that actually solves starvation under
    // a focused game rather than merely reducing it -- but raising a
    // process's scheduling priority above NORMAL requires
    // SeIncreaseBasePriorityPrivilege, which an ordinary, non-elevated Stoat
    // install does not hold. On a normal install this call is EXPECTED to
    // fail (typically STATUS_PRIVILEGE_NOT_HELD) -- that is not an error
    // condition, just a fact about this install worth recording, exactly
    // like a rejected SetGPUThreadPriority above. See
    // PFN_D3DKMTSetProcessSchedulingPriorityClass's own declaration for why
    // this is resolved dynamically instead of linked.
    {
      auto fn = reinterpret_cast<PFN_D3DKMTSetProcessSchedulingPriorityClass>(
          GetProcAddress(GetModuleHandleW(L"gdi32.dll"), "D3DKMTSetProcessSchedulingPriorityClass"));
      // 256, not 128: the failure branch's message (status code plus the
      // "expected without SeIncreaseBasePriorityPrivilege" reassurance) runs
      // to 151 chars, which a 128-byte buffer silently truncates -- cutting
      // off exactly the part of the message that explains the failure is
      // expected, right when a reader needs it most.
      char buf[256];
      if (!fn) {
        snprintf(buf, sizeof(buf), "D3DKMTSetProcessSchedulingPriorityClass not available on this Windows build");
      } else {
        const NTSTATUS status = fn(GetCurrentProcess(), D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH);
        if (status >= 0) {
          // NTSTATUS success codes are non-negative; there is no single
          // STATUS_SUCCESS-only convention worth special-casing here.
          snprintf(buf, sizeof(buf), "D3DKMTSetProcessSchedulingPriorityClass(HIGH)=ok");
        } else {
          snprintf(buf, sizeof(buf),
                   "D3DKMTSetProcessSchedulingPriorityClass(HIGH) failed (status=0x%08lX) -- expected without "
                   "SeIncreaseBasePriorityPrivilege (i.e. an elevated install)",
                   static_cast<unsigned long>(status));
        }
      }
      SetSchedulingPriorityInfo(buf);
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

    // The delivery SCHEDULE, distinct from lastDeliveredTs just above (which
    // exists purely to feed the discontinuity guard in the loop below).
    // Advanced by exactly one interval100ns per delivery, never by a delta
    // computed from `ts` -- see the comment above the pacing check in the
    // loop for why a delta from the last DELIVERED frame aliases against
    // certain source/target fps ratios and an evenly-ticking schedule does
    // not. Same sentinel convention as lastDeliveredTs: negative means "no
    // schedule yet -- take the next frame unconditionally", which is also
    // how a clock-discontinuity re-baseline (below) un-parks it.
    double nextDeliverTs = -1.0;

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
      // lastDeliveredTs's declaration for why wall-clock time would not do --
      // against a running SCHEDULE (nextDeliverTs), not a delta from the
      // last DELIVERED frame. This used to be delta-based: drop unless
      // `(ts - lastDeliveredTs) >= 0.9 * interval100ns`, i.e. unless the new
      // frame landed at least ~0.9 intervals past the previous DELIVERY.
      // That aliases badly whenever the source's own interval does not
      // divide evenly into the target interval, because each delivery moves
      // the base the next comparison is measured from, so a shortfall never
      // averages out -- it repeats every single time. Concretely, a 70fps
      // source into a 30fps target: target interval 33.33ms, 0.9x threshold
      // 30ms, source interval 14.29ms. 1 source interval (14.29ms) is below
      // 30ms -- drop. 2 (28.57ms) are STILL below it, by 1.4ms -- drop. 3
      // (42.86ms) finally clears it -- deliver. Every delivered frame resets
      // the base to itself, so this 1-in-3 pattern holds for the entire
      // session: 70/3 = 23.3fps delivered, never the 30fps target, no matter
      // how long the share runs (this is the exact shape measured in
      // production: 24.7fps delivered against a 30fps target). A schedule
      // does not have this failure mode because it never re-bases on the
      // frame that happened to satisfy it: nextDeliverTs ticks forward by
      // exactly one interval100ns per delivery regardless of how early or
      // late the frame that crossed it arrived, so every 33.33ms window
      // takes exactly one frame -- whichever source frame is first to reach
      // it -- and the long-run delivered rate is min(sourceFps, targetFps)
      // for any source/target ratio, not just the ones that divide evenly
      // (144fps into 60fps: one frame every ~16.67ms window, i.e. 60fps
      // delivered, not some 144-vs-60 aliased rate). The old 0.9x fudge
      // factor existed purely to absorb jitter under delta-based pacing -- a
      // frame landing a hair under one full interval since the last
      // DELIVERY still needed to count as "on time" instead of being pushed
      // out an extra interval. Schedule-based pacing needs no equivalent: a
      // frame arriving before nextDeliverTs simply is not this window's
      // frame yet, and the next frame to reach the mark is -- there is no
      // "last delivery" for jitter to be measured against, so nothing here
      // needs fudging.
      ABI::Windows::Foundation::TimeSpan relativeTime{};
      hr = frame->get_SystemRelativeTime(&relativeTime);
      // FAILED(hr) is the obvious failure; Duration == 0 is the one observed
      // in the wild that is not -- some drivers report S_OK with a zero
      // timestamp. Both get the same fallback: a fabricated 0.0 here is
      // indistinguishable from a genuine one to the pacing check below, and
      // if nextDeliverTs ever latched onto a fabricated 0's schedule, every
      // later frame's own (also-possibly-fabricated) value could keep
      // failing to reach it -- see QpcNow100ns's doc comment for the full
      // failure mode this replaces.
      double ts;
      if (SUCCEEDED(hr) && relativeTime.Duration != 0) {
        ts = static_cast<double>(relativeTime.Duration);
      } else {
        ts = QpcNow100ns();
        g_timestampFallbacks.fetch_add(1, std::memory_order_relaxed);
      }
      // Guard against a clock discontinuity before trusting the pacing check
      // below at all. `ts` above can come from either clock on any given
      // frame -- a genuine frame->get_SystemRelativeTime() read, or the
      // QpcNow100ns() fallback -- and those two are not comparable in
      // absolute terms (different epochs; see QpcNow100ns's doc comment).
      // Whenever this session switches from one to the other -- entering the
      // fallback, leaving it, or flapping between the two on alternating
      // frames if a driver's Duration==0 glitch is itself intermittent -- the
      // new `ts` can land BEFORE lastDeliveredTs, not just too close to it.
      // Falling through to the pacing check below with nextDeliverTs still
      // anchored to a schedule built from an earlier reading on the OTHER
      // clock would be wrong in exactly the way this guard exists to fix:
      // `ts < nextDeliverTs` would be satisfied forever, since nextDeliverTs
      // is a schedule the new clock's `ts` values may never reach, and
      // nothing but an actual delivery ever advances it -- so every later
      // frame this session would be dropped, silently, for the same
      // structural reason the fabricated-0 bug was (see QpcNow100ns's doc
      // comment), just reached by a clock switch instead of a fabricated
      // value. Re-baseline instead of clamping or skipping: reset BOTH
      // lastDeliveredTs and nextDeliverTs to the same "always take the next
      // frame"/"no schedule yet" sentinel the very first frame of the
      // session uses, so this frame is delivered unconditionally, a fresh
      // schedule starts from it, and every frame after it paces off
      // whichever clock is now in use. Resetting only one of the two would
      // not be enough to fix anything: nextDeliverTs is what the pacing
      // check below actually tests, so leaving it parked at the old clock's
      // epoch would keep rejecting every subsequent frame even after
      // lastDeliveredTs itself was cleared -- exactly the kind of
      // permanently-stalled schedule this whole guard exists to prevent.
      if (lastDeliveredTs >= 0.0 && ts < lastDeliveredTs) {
        g_timestampDiscontinuities.fetch_add(1, std::memory_order_relaxed);
        lastDeliveredTs = -1.0;
        nextDeliverTs = -1.0;
      }
      if (nextDeliverTs >= 0.0 && ts < nextDeliverTs) {
        continue;  // before the next scheduled delivery -- drop (Release only, same as any other drop)
      }
      lastDeliveredTs = ts;
      if (nextDeliverTs < 0.0) {
        // First delivery this session, or the first since a re-baseline
        // above: start the schedule exactly one interval past this frame.
        nextDeliverTs = ts + interval100ns;
      } else {
        nextDeliverTs += interval100ns;
        if (nextDeliverTs <= ts) {
          // The schedule fell a full interval or more behind `ts` -- the
          // source stalled, this thread got descheduled for a while, or
          // setFps() just changed the target rate out from under a schedule
          // computed for the old one. Resync to this frame instead of
          // leaving nextDeliverTs in the past: ticking it forward one
          // interval100ns at a time from here would let every frame until
          // the deficit is paid off through as a burst of catch-up
          // deliveries, which is exactly the "producing nothing, then
          // everything at once" failure this file has already had to fix in
          // more than one shape (see nextTick's own resync above, and its
          // comment on why repeatedly adding one interval to a stale base is
          // a busy-spin waiting to happen).
          nextDeliverTs = ts + interval100ns;
        }
      }

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
  g_framesStillDrawing.store(0);
  g_timestampFallbacks.store(0);
  g_timestampDiscontinuities.store(0);
  // Same reasoning: a later share should never look like it inherited an
  // earlier session's GPU-priority outcome before CaptureThread (below) has
  // had a chance to run its own attempt and overwrite this.
  SetGpuThreadPriorityInfo("not attempted");
  SetSchedulingPriorityInfo("not attempted");
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
