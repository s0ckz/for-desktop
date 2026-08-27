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
// the WGC capture item/session/frame pool, and then polls
// IDirect3D11CaptureFramePool::TryGetNextFrame() on a fixed cadence tied to
// the requested fps, instead of subscribing to the pool's FrameArrived
// event. Frame pools created with CreateFreeThreaded() do not require a
// DispatcherQueue/message pump to deliver frames either way; polling from a
// plain background thread avoids implementing the ABI's parameterized
// ITypedEventHandler<Direct3D11CaptureFramePool, IInspectable> callback
// interface, which needs no extra WinRT projection machinery beyond what
// this file already includes. Every frame we retrieve and don't use for
// pacing purposes is released immediately (its ComPtr going out of scope),
// which is what returns the buffer to the pool -- so a "drop" costs nothing
// beyond the Release.

#include <napi.h>

#include <windows.h>
#include <roapi.h>
#include <winstring.h>
#include <inspectable.h>
#include <wrl/client.h>
#include <timeapi.h>  // timeBeginPeriod/timeEndPeriod -- see CaptureThread

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
// capture thread's teardown, and is only ever touched from that one thread
// (the JS-facing Start/Stop/LastError calls only set flags/join it).
// ---------------------------------------------------------------------------

std::thread g_thread;
std::atomic<bool> g_running{false};
HANDLE g_stopEvent = nullptr;
Napi::ThreadSafeFunction g_tsfn;
std::string g_lastError;

UINT32 g_targetW = 0;
UINT32 g_targetH = 0;
double g_fps = 30.0;

ComPtr<ID3D11Device> g_device;
ComPtr<ID3D11DeviceContext> g_context;
ComPtr<ID3D11VideoDevice> g_videoDevice;
ComPtr<ID3D11VideoContext> g_videoContext;
ComPtr<WGDD::IDirect3DDevice> g_wgDevice;
ComPtr<WGC::IDirect3D11CaptureFramePoolStatics2> g_poolStatics2;
ComPtr<WGC::IGraphicsCaptureItem> g_item;
ComPtr<WGC::IDirect3D11CaptureFramePool> g_framePool;
ComPtr<WGC::IGraphicsCaptureSession> g_session;

// Rebuilt by EnsurePipeline() whenever the captured window's content size
// changes (WGC frames can change size mid-session, e.g. the game window is
// resized or a fullscreen-exclusive toggle happens).
ComPtr<ID3D11VideoProcessorEnumerator> g_vpEnum;
ComPtr<ID3D11VideoProcessor> g_videoProcessor;
ComPtr<ID3D11Texture2D> g_outputTex;   // D3D11_USAGE_DEFAULT, NV12, VP output target
ComPtr<ID3D11Texture2D> g_stagingTex;  // D3D11_USAGE_STAGING, CPU-readable copy of the above
ComPtr<ID3D11VideoProcessorOutputView> g_outputView;
UINT32 g_srcW = 0;
UINT32 g_srcH = 0;
UINT32 g_outW = 0;
UINT32 g_outH = 0;

void SetError(const char* stage, HRESULT hr) {
  char buf[192];
  snprintf(buf, sizeof(buf), "%s failed (hr=0x%08lX)", stage, static_cast<unsigned long>(hr));
  g_lastError = buf;
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
// (Re)build the video processor + output/staging textures for a given source
// size. Cheap to call every frame (it no-ops when nothing changed); expensive
// only on the first frame and on a resize.
// ---------------------------------------------------------------------------

bool EnsurePipeline(UINT32 srcW, UINT32 srcH) {
  if (srcW == g_srcW && srcH == g_srcH && g_vpEnum) return true;

  HRESULT hr;
  WG::SizeInt32 size{static_cast<INT32>(srcW), static_cast<INT32>(srcH)};

  if (!g_framePool) {
    hr = g_poolStatics2->CreateFreeThreaded(
        g_wgDevice.Get(), WG::DirectX::DirectXPixelFormat_B8G8R8A8UIntNormalized, 2, size,
        &g_framePool);
    if (FAILED(hr)) {
      SetError("Direct3D11CaptureFramePool::CreateFreeThreaded", hr);
      return false;
    }
  } else {
    hr = g_framePool->Recreate(
        g_wgDevice.Get(), WG::DirectX::DirectXPixelFormat_B8G8R8A8UIntNormalized, 2, size);
    if (FAILED(hr)) {
      SetError("Direct3D11CaptureFramePool::Recreate", hr);
      return false;
    }
  }

  // Fit-inside scaling: never stretch, always fit the whole source inside the
  // requested bounding box, then round to the nearest even number on each
  // axis -- NV12 requires even dimensions (the chroma plane is subsampled
  // 2x2). A 3440x1440 source targeting a 1920x1080 box is width-constrained
  // (scale = 1920/3440) and lands on 1920x804, not 1920x1080.
  const double scale = (std::min)(static_cast<double>(g_targetW) / srcW,
                                   static_cast<double>(g_targetH) / srcH);
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

  D3D11_TEXTURE2D_DESC stagingDesc = outDesc;
  stagingDesc.Usage = D3D11_USAGE_STAGING;
  stagingDesc.BindFlags = 0;
  stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> stagingTex;
  hr = g_device->CreateTexture2D(&stagingDesc, nullptr, &stagingTex);
  if (FAILED(hr)) {
    SetError("CreateTexture2D(staging)", hr);
    return false;
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
  g_stagingTex = stagingTex;
  g_outputView = outView;
  g_srcW = srcW;
  g_srcH = srcH;
  g_outW = outW;
  g_outH = outH;
  return true;
}

// Delivered to JS alongside the pixel buffer so the harness (and eventually
// the renderer) can see the two readback costs separately: the GPU-side
// scale/convert step, and the CPU-side copy the whole module exists to
// shrink.
struct FramePayload {
  std::vector<uint8_t> nv12;
  UINT32 width;
  UINT32 height;
  double bltMs;
  double grabMs;
};

void Emit(FramePayload* payload) {
  auto status = g_tsfn.NonBlockingCall(payload, [](Napi::Env env, Napi::Function cb, FramePayload* p) {
    // Napi::Buffer::Copy is the same per-chunk pattern win-app-audio uses for
    // its (much smaller) PCM chunks -- see the harness/report for whether it
    // actually keeps up at NV12 video rates.
    auto buffer = Napi::Buffer<uint8_t>::Copy(env, p->nv12.data(), p->nv12.size());
    auto meta = Napi::Object::New(env);
    meta.Set("width", Napi::Number::New(env, p->width));
    meta.Set("height", Napi::Number::New(env, p->height));
    meta.Set("bltMs", Napi::Number::New(env, p->bltMs));
    meta.Set("grabMs", Napi::Number::New(env, p->grabMs));
    delete p;
    cb.Call({buffer, meta});
  });
  // Drop, don't queue: if the JS side hasn't drained the previous call yet
  // (queue size is 1, see Start()), NonBlockingCall fails fast instead of
  // buffering, and we simply discard this frame.
  if (status != napi_ok) delete payload;
}

// Scale+convert the given source texture into the shared output texture, read
// it back, pack it as tight NV12, and deliver it. Returns false only on a
// hard D3D/WGC failure (frame skips for pacing reasons are handled by the
// caller and never reach here).
bool ProcessFrame(ID3D11Texture2D* srcTex, UINT32 srcW, UINT32 srcH) {
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
  g_context->CopyResource(g_stagingTex.Get(), g_outputTex.Get());
  D3D11_MAPPED_SUBRESOURCE mapped{};
  hr = g_context->Map(g_stagingTex.Get(), 0, D3D11_MAP_READ, 0, &mapped);
  const auto t2 = std::chrono::steady_clock::now();
  if (FAILED(hr)) {
    SetError("Map(staging texture)", hr);
    return false;
  }

  auto* payload = new FramePayload();
  payload->width = g_outW;
  payload->height = g_outH;
  payload->bltMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
  payload->grabMs = std::chrono::duration<double, std::milli>(t2 - t1).count();

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
  g_context->Unmap(g_stagingTex.Get(), 0);

  Emit(payload);
  return true;
}

// ---------------------------------------------------------------------------
// Capture thread: owns the whole session lifetime. Runs entirely as one
// polling loop paced to the requested fps -- see the file header for why we
// poll TryGetNextFrame() rather than subscribing to FrameArrived.
// ---------------------------------------------------------------------------

void CaptureThread(HWND hwnd) {
  HRESULT hr = RoInitialize(RO_INIT_MULTITHREADED);
  const bool roInitialised = SUCCEEDED(hr) || hr == S_FALSE;

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

    if (!EnsurePipeline(static_cast<UINT32>(itemSize.Width), static_cast<UINT32>(itemSize.Height))) break;

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

    const auto interval = std::chrono::duration<double>(1.0 / g_fps);

    // Windows' default system timer resolution is ~15.6ms, so without this,
    // WaitForSingleObject(..., 33) actually wakes up on the next ~15.6ms tick
    // after the requested duration -- i.e. closer to 48ms, not 33ms. That
    // alone was enough to cap this loop at ~21fps when asked for 30 (measured
    // directly: harness showed ~47ms actual inter-frame spacing against a
    // 33ms request). timeBeginPeriod(1) asks the scheduler for ~1ms
    // resolution for as long as this thread runs; timeEndPeriod(1) below
    // gives it back.
    timeBeginPeriod(1);

    // Fixed-cadence scheduling: target the next tick at a constant offset
    // from the *previous target*, not from "now" -- a plain fixed-length
    // sleep would add each iteration's own processing time (CreateVideoProcessorInputView,
    // the Blt, the grab, the NV12 packing copy) on top of the wait, drifting
    // the achieved rate below the requested one by roughly that amount every
    // frame. Computing the wait as "time until the next scheduled tick"
    // instead absorbs that processing time into the interval rather than
    // adding to it.
    auto nextTick = std::chrono::steady_clock::now() + interval;

    while (g_running.load()) {
      const auto now = std::chrono::steady_clock::now();
      const auto waitFor = std::chrono::duration_cast<std::chrono::milliseconds>(nextTick - now);
      const DWORD waitMs = waitFor.count() > 0 ? static_cast<DWORD>(waitFor.count()) : 0;
      nextTick += std::chrono::duration_cast<std::chrono::steady_clock::duration>(interval);

      // WaitForSingleObject IS the pacing: whatever WGC produced during this
      // sleep beyond the single frame we grab below is simply left in the
      // pool to be dropped by the drain loop, never queued up for later.
      if (WaitForSingleObject(g_stopEvent, waitMs) == WAIT_OBJECT_0) break;
      if (!IsWindow(hwnd)) {
        SetError("captured window", HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE));
        break;
      }

      // Drain the pool, keeping only the newest frame -- under load WGC can
      // have queued more than one since our last poll.
      ComPtr<WGC::IDirect3D11CaptureFrame> frame;
      for (;;) {
        ComPtr<WGC::IDirect3D11CaptureFrame> next;
        HRESULT frHr = g_framePool->TryGetNextFrame(&next);
        if (FAILED(frHr) || !next) break;
        frame = next;  // the previously-held frame (if any) is Released here
      }
      if (!frame) continue;  // nothing new since last poll

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

      ProcessFrame(srcTex.Get(), static_cast<UINT32>(contentSize.Width), static_cast<UINT32>(contentSize.Height));
    }

    timeEndPeriod(1);
  } while (false);

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
  g_stagingTex.Reset();
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

  g_targetW = info[1].As<Napi::Number>().Uint32Value();
  g_targetH = info[2].As<Napi::Number>().Uint32Value();
  g_fps = info[3].As<Napi::Number>().DoubleValue();
  if (!(g_fps > 0)) g_fps = 30.0;
  if (g_targetW < 2 || g_targetH < 2) {
    Napi::Error::New(env, "targetWidth/targetHeight must be >= 2").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  g_lastError.clear();
  g_srcW = g_srcH = g_outW = g_outH = 0;
  if (g_stopEvent) CloseHandle(g_stopEvent);
  g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);

  // maxQueueSize = 1: NonBlockingCall fails immediately instead of buffering
  // once one call is already pending, which is what makes Emit()'s drop
  // path real rather than a queue in disguise.
  g_tsfn = Napi::ThreadSafeFunction::New(env, info[4].As<Napi::Function>(), "winCapture", 1, 1);
  g_running.store(true);
  g_thread = std::thread(CaptureThread, hwnd);
  return Napi::Boolean::New(env, true);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_running.load() && !g_thread.joinable()) return env.Undefined();
  g_running.store(false);
  if (g_stopEvent) SetEvent(g_stopEvent);
  if (g_thread.joinable()) g_thread.join();
  if (g_stopEvent) {
    CloseHandle(g_stopEvent);
    g_stopEvent = nullptr;
  }
  return env.Undefined();
}

Napi::Value LastError(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), g_lastError);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("lastError", Napi::Function::New(env, LastError));
  return exports;
}

}  // namespace

NODE_API_MODULE(win_capture, Init)
