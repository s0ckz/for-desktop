// Per-process audio loopback capture for Windows.
//
// Windows mixes every application's audio before it reaches the speakers, so
// the classic loopback API can only ever hand back the full mix. Since Windows
// 10 2004 the audio engine can instead produce a private submix for a single
// process tree, which is what lets us capture "just this window's app" the way
// Discord and OBS do.
//
// Audio is delivered to JavaScript as 48 kHz, stereo, signed 16-bit LE PCM.

#include <napi.h>

#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>

#include <atomic>
#include <cwctype>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// The Windows 11 SDK ships <audioclientactivationparams.h>, but the 10.0.19041
// SDK does not, and we would like to build against either. These declarations
// match the documented ABI exactly, so activation works on any host SDK as long
// as the *running* OS supports it.
// ---------------------------------------------------------------------------

#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

namespace compat {

// Member names are irrelevant to the ABI -- only the layout matters -- so they
// are kept distinct from the type names to avoid any shadowing surprises.
enum LoopbackMode : int {
  INCLUDE_TARGET_PROCESS_TREE = 0,
  EXCLUDE_TARGET_PROCESS_TREE = 1
};

struct LoopbackParams {
  DWORD targetProcessId;
  LoopbackMode mode;
};

enum ActType : int {
  ACTIVATION_TYPE_DEFAULT = 0,
  ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
};

struct ActParams {
  ActType activationType;
  union {
    LoopbackParams loopback;
  };
};

}  // namespace compat

// ---------------------------------------------------------------------------
// ActivateAudioInterfaceAsync is asynchronous; this handler just parks the
// calling thread until the activation result is available.
// ---------------------------------------------------------------------------

class ActivationHandler : public IActivateAudioInterfaceCompletionHandler,
                          public IAgileObject {
 public:
  ActivationHandler() {
    done_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  }

  ~ActivationHandler() {
    if (done_) CloseHandle(done_);
  }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT hrActivate = S_OK;
    IUnknown* punk = nullptr;
    result_ = op->GetActivateResult(&hrActivate, &punk);
    if (SUCCEEDED(result_)) result_ = hrActivate;
    if (SUCCEEDED(result_) && punk) {
      result_ = punk->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client_));
    }
    if (punk) punk->Release();
    SetEvent(done_);
    return S_OK;
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) ||
        riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    } else if (riid == __uuidof(IAgileObject)) {
      *ppv = static_cast<IAgileObject*>(this);
    } else {
      *ppv = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }

  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }

  STDMETHODIMP_(ULONG) Release() override {
    ULONG n = --refs_;
    if (n == 0) delete this;
    return n;
  }

  HANDLE done_ = nullptr;
  HRESULT result_ = E_FAIL;
  IAudioClient* client_ = nullptr;

 private:
  std::atomic<ULONG> refs_{1};
};

// ---------------------------------------------------------------------------
// Capture session
// ---------------------------------------------------------------------------

namespace {

constexpr DWORD kSampleRate = 48000;
constexpr WORD kChannels = 2;
constexpr WORD kBitsPerSample = 16;

std::thread g_thread;
std::atomic<bool> g_running{false};
HANDLE g_stopEvent = nullptr;
Napi::ThreadSafeFunction g_tsfn;
std::string g_lastError;

void SetError(const char* stage, HRESULT hr) {
  char buf[160];
  snprintf(buf, sizeof(buf), "%s failed (hr=0x%08lX)", stage, static_cast<unsigned long>(hr));
  g_lastError = buf;
}

// Emits one PCM chunk to JavaScript. Runs on the capture thread.
void Emit(const BYTE* data, size_t bytes) {
  if (!bytes) return;
  auto* copy = new std::vector<BYTE>(data, data + bytes);
  auto status = g_tsfn.BlockingCall(copy, [](Napi::Env env, Napi::Function cb, std::vector<BYTE>* chunk) {
    auto buffer = Napi::Buffer<BYTE>::Copy(env, chunk->data(), chunk->size());
    delete chunk;
    cb.Call({buffer});
  });
  if (status != napi_ok) delete copy;
}

void CaptureThread(DWORD pid, bool includeTree) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInitialised = SUCCEEDED(hr);

  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  HANDLE sampleReady = nullptr;

  do {
    compat::ActParams params{};
    params.activationType = compat::ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.loopback.targetProcessId = pid;
    params.loopback.mode = includeTree ? compat::INCLUDE_TARGET_PROCESS_TREE
                                       : compat::EXCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT pv{};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    auto* handler = new ActivationHandler();
    IActivateAudioInterfaceAsyncOperation* op = nullptr;

    hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                     __uuidof(IAudioClient), &pv, handler, &op);
    if (FAILED(hr)) {
      SetError("ActivateAudioInterfaceAsync", hr);
      handler->Release();
      break;
    }

    WaitForSingleObject(handler->done_, INFINITE);
    hr = handler->result_;
    client = handler->client_;
    handler->client_ = nullptr;
    handler->Release();
    if (op) op->Release();

    if (FAILED(hr) || !client) {
      SetError("process loopback activation", hr);
      break;
    }

    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = kChannels;
    format.nSamplesPerSec = kSampleRate;
    format.wBitsPerSample = kBitsPerSample;
    format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    format.cbSize = 0;

    // 200000 * 100ns = 20ms of buffering, matching Microsoft's sample.
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            200000, 0, &format, nullptr);
    if (FAILED(hr)) {
      SetError("IAudioClient::Initialize", hr);
      break;
    }

    sampleReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    hr = client->SetEventHandle(sampleReady);
    if (FAILED(hr)) {
      SetError("SetEventHandle", hr);
      break;
    }

    hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
    if (FAILED(hr)) {
      SetError("GetService(IAudioCaptureClient)", hr);
      break;
    }

    hr = client->Start();
    if (FAILED(hr)) {
      SetError("IAudioClient::Start", hr);
      break;
    }

    HANDLE waits[2] = {g_stopEvent, sampleReady};
    const size_t frameBytes = format.nBlockAlign;

    while (g_running.load()) {
      DWORD signalled = WaitForMultipleObjects(2, waits, FALSE, 2000);
      if (signalled == WAIT_OBJECT_0) break;          // stop requested
      if (signalled == WAIT_TIMEOUT) continue;        // silent app, keep waiting

      for (;;) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (hr == AUDCLNT_S_BUFFER_EMPTY || FAILED(hr) || frames == 0) {
          if (SUCCEEDED(hr) && frames == 0) capture->ReleaseBuffer(0);
          break;
        }

        const size_t bytes = static_cast<size_t>(frames) * frameBytes;
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          std::vector<BYTE> silence(bytes, 0);
          Emit(silence.data(), silence.size());
        } else {
          Emit(data, bytes);
        }
        capture->ReleaseBuffer(frames);
      }
    }

    client->Stop();
  } while (false);

  if (capture) capture->Release();
  if (client) client->Release();
  if (sampleReady) CloseHandle(sampleReady);
  if (comInitialised) CoUninitialize();

  g_running.store(false);
  g_tsfn.Release();
}

// ---------------------------------------------------------------------------
// JavaScript surface
// ---------------------------------------------------------------------------

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // Process loopback landed in Windows 10 2004 (build 19041).
  using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return Napi::Boolean::New(env, false);
  auto fn = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (!fn) return Napi::Boolean::New(env, false);
  RTL_OSVERSIONINFOW vi{};
  vi.dwOSVersionInfoSize = sizeof(vi);
  if (fn(&vi) != 0) return Napi::Boolean::New(env, false);
  return Napi::Boolean::New(env, vi.dwBuildNumber >= 19041);
}

// UWP/Store apps (Calculator, Store games, anything packaged) do not own their
// top-level window: it belongs to ApplicationFrameHost.exe, whose process tree
// renders no audio at all. The real application lives in a child window owned
// by a different process, so for a frame host we hand back the child's pid.
// Normal windows are left exactly as they were -- an app that embeds another
// process' window (WebView2 and friends) must keep resolving to its own pid.

struct ChildPidSearch {
  DWORD hostPid;
  DWORD found;
};

BOOL CALLBACK FindForeignChildPid(HWND child, LPARAM param) {
  auto* search = reinterpret_cast<ChildPidSearch*>(param);
  DWORD childPid = 0;
  GetWindowThreadProcessId(child, &childPid);
  if (childPid && childPid != search->hostPid) {
    search->found = childPid;
    return FALSE;  // stop enumerating
  }
  return TRUE;
}

bool IsApplicationFrameHost(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return false;

  wchar_t path[MAX_PATH] = {};
  DWORD length = MAX_PATH;
  bool isFrameHost = false;
  if (QueryFullProcessImageNameW(process, 0, path, &length) && length) {
    std::wstring full(path, length);
    const size_t slash = full.find_last_of(L"\\/");
    std::wstring name =
        slash == std::wstring::npos ? full : full.substr(slash + 1);
    for (auto& ch : name) ch = static_cast<wchar_t>(towlower(ch));
    isFrameHost = name == L"applicationframehost.exe";
  }
  CloseHandle(process);
  return isFrameHost;
}

// desktopCapturer hands window ids out as strings; accept either form.
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

Napi::Value PidFromWindowHandle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1) return Napi::Number::New(env, 0);

  HWND hwnd = HwndFromValue(info[0]);
  if (!hwnd || !IsWindow(hwnd)) return Napi::Number::New(env, 0);

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);

  if (pid && IsApplicationFrameHost(pid)) {
    ChildPidSearch search{pid, 0};
    EnumChildWindows(hwnd, FindForeignChildPid, reinterpret_cast<LPARAM>(&search));
    if (search.found) pid = search.found;
  }

  return Napi::Number::New(env, static_cast<double>(pid));
}

// Whether a window can be captured again after a share died. Windows Graphics
// Capture refuses minimised windows, so re-acquiring has to wait for the user
// to restore the application rather than grabbing a dead handle.
Napi::Value WindowState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object state = Napi::Object::New(env);
  bool exists = false;
  bool visible = false;
  bool iconic = false;

  if (info.Length() >= 1) {
    HWND hwnd = HwndFromValue(info[0]);
    if (hwnd && IsWindow(hwnd)) {
      exists = true;
      visible = IsWindowVisible(hwnd) != FALSE;
      iconic = IsIconic(hwnd) != FALSE;
    }
  }

  state.Set("exists", Napi::Boolean::New(env, exists));
  state.Set("visible", Napi::Boolean::New(env, visible));
  state.Set("iconic", Napi::Boolean::New(env, iconic));
  return state;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_running.load()) {
    Napi::Error::New(env, "capture already running").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 3 || !info[0].IsNumber() || !info[2].IsFunction()) {
    Napi::TypeError::New(env, "expected (pid, includeTree, callback)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const DWORD pid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());
  const bool includeTree = info[1].ToBoolean().Value();

  g_lastError.clear();
  if (g_stopEvent) CloseHandle(g_stopEvent);
  g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);

  g_tsfn = Napi::ThreadSafeFunction::New(env, info[2].As<Napi::Function>(),
                                         "winAppAudio", 0, 1);
  g_running.store(true);
  g_thread = std::thread(CaptureThread, pid, includeTree);
  return env.Undefined();
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
  exports.Set("pidFromWindowHandle", Napi::Function::New(env, PidFromWindowHandle));
  exports.Set("windowState", Napi::Function::New(env, WindowState));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("lastError", Napi::Function::New(env, LastError));
  exports.Set("sampleRate", Napi::Number::New(env, kSampleRate));
  exports.Set("channels", Napi::Number::New(env, kChannels));
  return exports;
}

}  // namespace

NODE_API_MODULE(win_app_audio, Init)
