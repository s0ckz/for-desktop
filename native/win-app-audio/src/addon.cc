// Per-process audio loopback capture for Windows.
//
// Windows mixes every application's audio before it reaches the speakers, so
// the classic loopback API can only ever hand back the full mix. Since Windows
// 10 2004 the audio engine can instead produce a private submix for a single
// process tree, which is what lets us capture "just this window's app" the way
// Discord and OBS do.
//
// Audio is delivered to JavaScript as 48 kHz, stereo, signed 16-bit LE PCM.
//
// A second capture mode lives in this file alongside the original single-
// process one: startSystemExcluding() mixes together every audible process
// EXCEPT a caller-supplied blocklist (Discord and friends), in C++, into the
// same PCM wire format. It exists because PROCESS_LOOPBACK_MODE has exactly
// two values -- include-tree and exclude-tree -- and neither can express
// "everything except these two processes" in one activation. See the mixer
// section below for the enumeration/filtering/mixing design; the reasoning
// for *why* this mode exists at all lives in the accompanying plan doc, not
// here, but every non-obvious choice in the implementation is commented in
// place.

#include <napi.h>

#include <windows.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <avrt.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cwctype>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
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

// --- Mixer tuning constants -------------------------------------------------
// Grouped here, all named, so the reasoning for each number lives in one
// place instead of scattered as magic literals through the mixer below.

// 10ms of frames per mixer tick. Matches the wire format's natural
// granularity (48kHz stereo S16LE) and is short enough to keep mixer-induced
// latency low without waking the mixer thread implausibly often.
constexpr UINT32 kTickFrames = 480;

// Per-stream ring capacity. Must be a power of two (see Ring::Write/Read's
// masking). 8192 frames is ~170ms @ 48kHz -- generous slack against
// scheduling jitter between a client's own capture thread and the mixer's
// fixed 10ms cadence, while keeping worst-case per-stream memory bounded
// (8192 * 2ch * 2 bytes = 32KB, times a 24-stream cap = under 1MB total).
constexpr size_t kRingCapacityFrames = 8192;

// A stream must bank this many frames before it is allowed to contribute to
// the mix. ~30ms @ 48kHz. Below this, a freshly-attached (or just re-primed)
// client would hand the mixer a half-filled tick, which sounds like a click;
// priming trades a fixed, silent, one-time delay for never producing that.
constexpr UINT32 kPrimeFrames = 1440;

// Above this backlog, a stream is considered overrun and is skipped forward
// to the prime level rather than left to grow. ~60ms @ 48kHz -- twice the
// prime level, so a stream has room to breathe under normal jitter before
// this kicks in.
constexpr UINT32 kHighWaterFrames = 2880;

// Control-thread poll period. IAudioSessionNotification is deliberately not
// used instead -- this poll is needed anyway as the backstop for process
// death (which generates no session notification), so a second, more
// complex mechanism would only shave latency on the "app starts playing"
// case, at the cost of a second thing that can go wrong.
constexpr int kRescanIntervalMs = 2000;

// Hard cap on simultaneously mixed clients. Chosen generously above any
// realistic number of apps a person has making sound at once; exists so a
// pathological host (dozens of stale/zombie audio sessions) can't grow the
// mixer's per-tick cost or thread-wait-object count without bound.
// WaitForMultipleObjects tops out at 64 handles; 24 clients + 2 control
// handles leaves comfortable headroom.
constexpr int kMaxMixStreams = 24;

// Bound on the parent-chain walk used for own-tree/descendant-tree
// detection. Real process trees are a handful of hops deep; this only
// guards against a corrupt or (should it ever happen) cyclic toolhelp
// snapshot turning a scan into an infinite loop.
constexpr int kMaxAncestorHops = 32;

// Backpressure valve for Emit(), in units of "chunks currently queued to the
// JS thread but not yet delivered". ~500ms of backlog at the mixer's 10ms
// cadence (single-process capture chunks are similar size in practice).
// Past this, new chunks are dropped instead of queued -- see Emit()'s
// comment for why an unbounded *queue* (kept unbounded on purpose) still
// needs a bounded *backlog counter* layered on top.
constexpr int kMaxOutstandingChunks = 50;

enum class CaptureMode { Idle, Single, Mix };
std::atomic<CaptureMode> g_mode{CaptureMode::Idle};

std::thread g_thread;
std::atomic<bool> g_running{false};
HANDLE g_stopEvent = nullptr;
Napi::ThreadSafeFunction g_tsfn;
std::atomic<int> g_outstanding{0};
std::string g_lastError;

void SetError(const char* stage, HRESULT hr) {
  char buf[160];
  snprintf(buf, sizeof(buf), "%s failed (hr=0x%08lX)", stage, static_cast<unsigned long>(hr));
  g_lastError = buf;
}

// Emits one PCM chunk to JavaScript. `tsfn`/`outstanding` are passed in
// rather than hardcoded so both the single-process path and the mixer share
// one implementation (see the backpressure comment below).
//
// The ThreadSafeFunction queue itself is created with size 0 (unbounded) in
// both Start() and StartSystemExcluding() -- and must stay that way. Stop()
// joins the producing thread from the JS thread; if the queue were bounded,
// BlockingCall could park that producer thread waiting for room, and it
// would never get it, because the only thread that drains the queue (the JS
// thread) is the one sitting in join(). That is a guaranteed deadlock, not a
// theoretical one.
//
// An unbounded queue trades that deadlock for a different risk: if the JS
// event loop stalls, chunks queue up without limit. `outstanding` is a
// non-blocking valve for exactly that case -- it counts chunks queued but
// not yet delivered, and Emit drops (rather than queues) once the backlog
// implies the JS thread has fallen behind by about half a second. Dropping
// audio during that condition is far better than growing memory unboundedly
// or, worse, ever blocking here.
void Emit(Napi::ThreadSafeFunction& tsfn, std::atomic<int>& outstanding, const BYTE* data, size_t bytes) {
  if (!bytes) return;
  if (outstanding.load(std::memory_order_relaxed) >= kMaxOutstandingChunks) return;
  outstanding.fetch_add(1, std::memory_order_relaxed);
  auto* copy = new std::vector<BYTE>(data, data + bytes);
  auto status = tsfn.BlockingCall(copy, [&outstanding](Napi::Env env, Napi::Function cb, std::vector<BYTE>* chunk) {
    outstanding.fetch_sub(1, std::memory_order_relaxed);
    auto buffer = Napi::Buffer<BYTE>::Copy(env, chunk->data(), chunk->size());
    delete chunk;
    cb.Call({buffer});
  });
  if (status != napi_ok) {
    outstanding.fetch_sub(1, std::memory_order_relaxed);
    delete copy;
  }
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
          Emit(g_tsfn, g_outstanding, silence.data(), silence.size());
        } else {
          Emit(g_tsfn, g_outstanding, data, bytes);
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
  // Restores Idle so a later Start() (or StartSystemExcluding()) is not
  // permanently blocked by a capture that ended on its own -- e.g. an
  // activation failure -- without Stop() ever being called. Stop() also
  // sets this on the normal shutdown path; setting it here too just closes
  // the self-termination gap the enum guard would otherwise open up.
  g_mode.store(CaptureMode::Idle);
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

// Lowercases and strips the directory from a full image path. Factored out
// of IsApplicationFrameHost (which used to do this inline) because the
// mixer's blocklist/self-tree matching needs the exact same basename
// extraction, and a second hand-rolled copy of a towlower loop is exactly
// the kind of thing that quietly drifts out of sync with the first.
std::wstring BaseNameLower(const std::wstring& full) {
  const size_t slash = full.find_last_of(L"\\/");
  std::wstring name = slash == std::wstring::npos ? full : full.substr(slash + 1);
  for (auto& ch : name) ch = static_cast<wchar_t>(towlower(ch));
  return name;
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
    isFrameHost = BaseNameLower(std::wstring(path, length)) == L"applicationframehost.exe";
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

// ===========================================================================
// System mixer -- startSystemExcluding()
//
// See the file header for why this exists. Summary of the shape: enumerate
// every process with an audio session, filter out our own tree and the
// blocklist, activate one INCLUDE_TARGET_PROCESS_TREE client per survivor,
// and sum their streams into the same PCM wire format the single-process
// path already produces.
//
// Threading: three long-lived threads once StartSystemExcluding() returns.
//   - MixControlThread: owns activation and the 2s rescan. Activation blocks
//     on WaitForSingleObject(handler->done_, INFINITE) exactly like
//     CaptureThread above; putting that wait on its own thread means one
//     wedged activation stalls only the rescan, never audio delivery.
//   - MixCaptureThread: WaitForMultipleObjects across every live client's
//     sample-ready event (100ms timeout) and drains whichever ones are
//     signalled -- on ANY wake, including a timeout, ALL clients are
//     drained regardless of which handle(s) actually signalled.
//     WaitForMultipleObjects only reports the lowest-index signalled
//     handle, so servicing just that one would starve higher-index streams
//     whenever two signal in the same instant; draining an idle client is
//     one GetBuffer() returning AUDCLNT_S_BUFFER_EMPTY, so this costs
//     nothing measurable.
//   - MixerThread: fixed 10ms-tick deadline loop that reads each stream's
//     ring, sums, clamps, and emits.
// This is deliberately three threads and not one thread per client: WASAPI's
// buffer here is only 20ms deep (matching CaptureThread's Initialize call
// above), so one stall anywhere in the emit path would overflow every
// client's buffer at once if capture and mixing shared a thread.
//
// Lifetime: g_live is a vector of std::shared_ptr<Stream>, mutated only by
// MixControlThread under g_liveMutex, with g_liveVersion bumped on every
// change. MixCaptureThread and MixerThread each keep their own local
// snapshot (a copy of the shared_ptrs, so they hold strong references) and
// only refresh it when they notice the version changed. Because a snapshot
// is a strong reference, a Stream removed from g_live cannot be destroyed
// while either thread still has it in its own snapshot/wait array -- which
// is what makes closing sampleReady from that Stream's destructor safe no
// matter which thread's snapshot happens to be the last to let go of it.
// ===========================================================================

// Converts a UTF-16 string to UTF-8 for handing names back to JavaScript.
std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int size = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return std::string();
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), out.data(), size, nullptr, nullptr);
  return out;
}

// Ensures COM is usable on the calling thread without fighting whatever
// apartment Electron's main thread already picked for itself. Only used by
// entry points that are called directly on the JS thread and need COM
// there (listAudioProcesses()); the mixer's own worker threads each call
// CoInitializeEx once for their whole lifetime instead.
struct ComScope {
  bool ownsInit = false;
  ComScope() {
    // RPC_E_CHANGED_MODE means some other component (very plausibly
    // Electron/Chromium itself) already initialised this thread into a
    // different apartment. That's fine -- COM calls still work on it -- we
    // just must not CoUninitialize an init we did not perform.
    ownsInit = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
  }
  ~ComScope() {
    if (ownsInit) CoUninitialize();
  }
};

// Resolves a process's full image path. False (leaving *outPath untouched)
// covers both "process already exited" and "we lack rights to query it" --
// both are indistinguishable to a caller and, per the fail-closed rule
// applied at every call site, both must be treated as "cannot prove this is
// not a blocked app."
bool ResolveImagePath(DWORD pid, std::wstring* outPath) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return false;
  wchar_t path[MAX_PATH] = {};
  DWORD length = MAX_PATH;
  bool ok = QueryFullProcessImageNameW(process, 0, path, &length) && length;
  if (ok) *outPath = std::wstring(path, length);
  CloseHandle(process);
  return ok;
}

uint64_t ProcessStartTime(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return 0;
  FILETIME create{}, exit{}, kernel{}, user{};
  uint64_t result = 0;
  if (GetProcessTimes(process, &create, &exit, &kernel, &user)) {
    result = (static_cast<uint64_t>(create.dwHighDateTime) << 32) | create.dwLowDateTime;
  }
  CloseHandle(process);
  return result;
}

// One pid -> parent-pid table from a fresh toolhelp snapshot, rebuilt every
// scan (the plan calls this out explicitly: process trees change constantly,
// and a stale table is worse than the cost of re-snapshotting once per 2s
// rescan). Empty on failure; callers must treat that the same as "ancestry
// unknown", not "no ancestors".
std::unordered_map<DWORD, DWORD> SnapshotParentTable() {
  std::unordered_map<DWORD, DWORD> table;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return table;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snap, &entry)) {
    do {
      table[entry.th32ProcessID] = entry.th32ParentProcessID;
    } while (Process32NextW(snap, &entry));
  }
  CloseHandle(snap);
  return table;
}

// Walks upward from `pid` through the snapshot's parent table looking for
// `ancestorPid`. Descendants only -- never walks past a mismatch looking for
// alternate paths, and callers only ever ask "is X under Y", never "is X
// related to Y". This asymmetry matters: our own parent is usually
// explorer.exe, and if this walked ancestors as well as descendants it would
// falsely mark half the desktop as being in our tree.
//
// Every hop is guarded three ways: a visited-set against cycles, a hard hop
// cap (kMaxAncestorHops) against a corrupt table, and a creation-time check
// against PID reuse -- a real parent cannot have been created after its
// child, so if the table's "parent" claims a later creation time, that PID
// slot has been recycled onto an unrelated, newer process and the walk
// stops rather than misattribute ancestry through it.
bool IsDescendantOf(const std::unordered_map<DWORD, DWORD>& parents, DWORD pid, DWORD ancestorPid,
                    uint64_t ancestorStart) {
  if (parents.empty()) return false;  // snapshot failed; ancestry is unknown, not "none"
  std::unordered_set<DWORD> visited;
  DWORD current = pid;
  uint64_t currentStart = ProcessStartTime(current);

  for (int hop = 0; hop < kMaxAncestorHops; ++hop) {
    if (!visited.insert(current).second) return false;  // cycle in the table
    auto it = parents.find(current);
    if (it == parents.end()) return false;  // walked off the top without finding ancestorPid
    DWORD parentPid = it->second;
    if (parentPid == 0 || parentPid == current) return false;

    uint64_t parentStart = ProcessStartTime(parentPid);
    if (parentStart != 0 && currentStart != 0 && parentStart > currentStart) {
      return false;  // "parent" was created after "child" -- recycled PID, stale table
    }

    if (parentPid == ancestorPid) {
      return ancestorStart == 0 || parentStart == 0 || parentStart == ancestorStart;
    }

    current = parentPid;
    currentStart = parentStart;
  }
  return false;  // hop cap hit
}

bool SameImageAsSelf(const std::wstring& candidatePath) {
  wchar_t self[MAX_PATH] = {};
  DWORD len = GetModuleFileNameW(nullptr, self, MAX_PATH);
  if (!len || candidatePath.empty()) return false;
  // Case-insensitive compare via the same lowercasing helper used
  // everywhere else in this file (BaseNameLower's towlower loop), rather
  // than reaching for a separate CRT string-compare function for just this
  // one call site.
  std::wstring selfLower(self, len);
  std::wstring candidateLower = candidatePath;
  for (auto& ch : selfLower) ch = static_cast<wchar_t>(towlower(ch));
  for (auto& ch : candidateLower) ch = static_cast<wchar_t>(towlower(ch));
  return selfLower == candidateLower;
}

// Own-tree detection has two independent nets, both required:
//
//   1. A parent-chain walk up to our own pid. This has to be a walk, not a
//      name match -- Electron's audio service host runs as
//      "Stoat.exe --type=utility", the exact same basename as our main
//      process, so a name rule would only catch it by coincidence and would
//      also wrongly catch any unrelated app that happens to share our
//      basename.
//   2. An image-path equality check against our own GetModuleFileNameW.
//      This is independent of the process tree entirely, so a *second copy*
//      of Stoat launched outside our tree (a second login, a portable copy
//      run standalone) is still excluded even though the parent walk would
//      never find it.
bool IsInOwnTree(const std::unordered_map<DWORD, DWORD>& parents, DWORD pid, const std::wstring& imagePath) {
  if (SameImageAsSelf(imagePath)) return true;
  static const DWORD selfPid = GetCurrentProcessId();
  static const uint64_t selfStart = ProcessStartTime(selfPid);
  return IsDescendantOf(parents, pid, selfPid, selfStart);
}

bool IsBlocklisted(const std::wstring& baseNameLower, const std::vector<std::wstring>& blockedLower) {
  return std::find(blockedLower.begin(), blockedLower.end(), baseNameLower) != blockedLower.end();
}

struct EnumeratedProcess {
  DWORD pid = 0;
  std::wstring baseName;       // original-case exe basename; empty if unreadable
  std::wstring baseNameLower;  // empty if unreadable
  std::wstring fullPath;       // only valid when pathResolved
  bool pathResolved = false;
  AudioSessionState state = AudioSessionStateInactive;
};

// Enumerates every audio session's owning pid across every ACTIVE render
// endpoint -- not just the default device. Windows 10 1803+ lets individual
// apps be routed to a non-default output, and the process-loopback virtual
// device is not endpoint-scoped, so scanning only the default endpoint would
// silently miss those apps, regressing relative to today's whole-mix
// capture (which hears everything regardless of routing). Dedupes pids
// across endpoints.
//
// AudioSessionStateExpired sessions are skipped -- they are gone for good.
// IsSystemSoundsSession() sessions are skipped. AudioSessionStateInactive
// sessions are KEPT: an app can hold an open, silent stream (nothing queued
// yet) for a while before the user hits play, and dropping it here would
// mean re-discovering it a rescan or two later, clipping the first seconds
// of audio every single time.
//
// Returns false only on a genuine enumeration failure (COM/device errors);
// zero audio sessions found is success with an empty result, and callers
// must tell the two apart -- see the "failed enumeration leaves the live
// set untouched" rule at the call site in RunScanPass.
bool EnumerateAudioSessionPids(std::vector<EnumeratedProcess>* out) {
  out->clear();
  std::unordered_set<DWORD> seen;

  IMMDeviceEnumerator* devEnum = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&devEnum));
  if (FAILED(hr) || !devEnum) return false;

  IMMDeviceCollection* devices = nullptr;
  hr = devEnum->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices);
  if (FAILED(hr) || !devices) {
    devEnum->Release();
    return false;
  }

  UINT deviceCount = 0;
  devices->GetCount(&deviceCount);

  for (UINT d = 0; d < deviceCount; ++d) {
    IMMDevice* device = nullptr;
    if (FAILED(devices->Item(d, &device)) || !device) continue;

    IAudioSessionManager2* sessionMgr = nullptr;
    HRESULT hrAct = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                     reinterpret_cast<void**>(&sessionMgr));
    device->Release();
    if (FAILED(hrAct) || !sessionMgr) continue;

    IAudioSessionEnumerator* sessionEnum = nullptr;
    if (SUCCEEDED(sessionMgr->GetSessionEnumerator(&sessionEnum)) && sessionEnum) {
      int sessionCount = 0;
      sessionEnum->GetCount(&sessionCount);

      for (int s = 0; s < sessionCount; ++s) {
        IAudioSessionControl* control = nullptr;
        if (FAILED(sessionEnum->GetSession(s, &control)) || !control) continue;

        IAudioSessionControl2* control2 = nullptr;
        if (SUCCEEDED(control->QueryInterface(__uuidof(IAudioSessionControl2),
                                              reinterpret_cast<void**>(&control2))) && control2) {
          AudioSessionState state = AudioSessionStateInactive;
          HRESULT hrState = control2->GetState(&state);
          bool isSystemSounds = control2->IsSystemSoundsSession() == S_OK;

          if (SUCCEEDED(hrState) && state != AudioSessionStateExpired && !isSystemSounds) {
            DWORD pid = 0;
            if (SUCCEEDED(control2->GetProcessId(&pid)) && pid != 0 && seen.insert(pid).second) {
              EnumeratedProcess proc;
              proc.pid = pid;
              proc.state = state;
              std::wstring path;
              proc.pathResolved = ResolveImagePath(pid, &path);
              if (proc.pathResolved) {
                proc.fullPath = path;
                proc.baseNameLower = BaseNameLower(path);
                const size_t slash = path.find_last_of(L"\\/");
                proc.baseName = slash == std::wstring::npos ? path : path.substr(slash + 1);
              }
              out->push_back(std::move(proc));
            }
          }
          control2->Release();
        }
        control->Release();
      }
      sessionEnum->Release();
    }
    sessionMgr->Release();
  }

  devices->Release();
  devEnum->Release();
  return true;
}

// Drops any candidate that is a descendant (in this scan's snapshot) of
// another surviving candidate. Every survivor is started with
// INCLUDE_TARGET_PROCESS_TREE, which already captures its whole subtree --
// PROCESS_LOOPBACK_MODE has no "this process only" value (see the file
// header), so if a child of an already-included process were also started
// as its own client, that child's audio would be summed twice: once via the
// parent's tree client, once via its own. There is no way to ask WASAPI for
// "this process, not its descendants" instead, so double-counting has to be
// solved here, at candidate selection, rather than at activation.
std::vector<EnumeratedProcess> PruneDescendants(const std::unordered_map<DWORD, DWORD>& parents,
                                                std::vector<EnumeratedProcess> candidates) {
  std::vector<EnumeratedProcess> kept;
  for (const auto& candidate : candidates) {
    bool isDescendant = false;
    for (const auto& other : candidates) {
      if (other.pid == candidate.pid) continue;
      if (IsDescendantOf(parents, candidate.pid, other.pid, ProcessStartTime(other.pid))) {
        isDescendant = true;
        break;
      }
    }
    if (!isDescendant) kept.push_back(candidate);
  }
  return kept;
}

// Single-producer/single-consumer ring of interleaved stereo S16 frames.
// Producer is a per-client capture callback (MixCaptureThread, via
// DrainStream); consumer is the mixer tick (MixerThread, via
// RingAccumulate). Frame-indexed w/r atomics, masked into the (power-of-two)
// buffer -- no lock needed since there is exactly one writer and one reader.
struct Ring {
  std::vector<int16_t> buf = std::vector<int16_t>(kRingCapacityFrames * kChannels);
  std::atomic<size_t> w{0};
  std::atomic<size_t> r{0};

  size_t Available() const {
    return w.load(std::memory_order_acquire) - r.load(std::memory_order_relaxed);
  }
  size_t Free() const { return kRingCapacityFrames - Available(); }

  // Producer only. Truncates (drops the tail) rather than blocking or
  // growing when the ring is already full -- a full ring means the mixer
  // has stopped draining this stream, and the elastic-buffer state machine
  // in MixerThread is what decides what that means for audibility, not this
  // write call.
  size_t Write(const int16_t* frames, size_t frameCount) {
    size_t writable = (std::min)(frameCount, Free());
    size_t widx = w.load(std::memory_order_relaxed);
    for (size_t i = 0; i < writable; ++i) {
      size_t pos = (widx + i) & (kRingCapacityFrames - 1);
      buf[pos * kChannels + 0] = frames[i * kChannels + 0];
      buf[pos * kChannels + 1] = frames[i * kChannels + 1];
    }
    w.store(widx + writable, std::memory_order_release);
    return writable;
  }

  // Consumer only.
  size_t Read(int16_t* out, size_t frameCount) {
    size_t readable = (std::min)(frameCount, Available());
    size_t ridx = r.load(std::memory_order_relaxed);
    for (size_t i = 0; i < readable; ++i) {
      size_t pos = (ridx + i) & (kRingCapacityFrames - 1);
      out[i * kChannels + 0] = buf[pos * kChannels + 0];
      out[i * kChannels + 1] = buf[pos * kChannels + 1];
    }
    r.store(ridx + readable, std::memory_order_release);
    return readable;
  }

  // Consumer only. Advances the read cursor without copying out -- used to
  // skip an overrun stream forward to the prime level.
  void Drop(size_t frameCount) {
    size_t droppable = (std::min)(frameCount, Available());
    r.fetch_add(droppable, std::memory_order_release);
  }
};

enum class StreamPhase { Priming, Running };

// One live per-PID client. Held via shared_ptr in g_live and in each of
// MixCaptureThread's/MixerThread's local snapshots -- see the lifetime note
// in the mixer section header for why that makes teardown safe without a
// lock on the hot path.
struct Stream {
  DWORD pid = 0;
  std::wstring baseName;
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  HANDLE sampleReady = nullptr;
  // PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, held for the stream's
  // whole life. Two jobs for one handle: WaitForSingleObject(handle, 0)
  // gives free process-death detection on every rescan, and holding it open
  // pins this PID against reuse for as long as we might still be comparing
  // ancestry against it.
  HANDLE processHandle = nullptr;
  Ring ring;
  std::atomic<StreamPhase> phase{StreamPhase::Priming};
  // Per-stream gain applied in RingAccumulate. Always 1.0f today -- see
  // RingAccumulate's comment for why this parameter exists ahead of need.
  float gain = 1.0f;
  // Set by MixCaptureThread when this client's WASAPI session errors out
  // unrecoverably. Only MixControlThread acts on it (reaping on the next
  // rescan); one sick client must never take the whole mix down, so the
  // capture/mixer threads just stop touching it and wait for the reap.
  std::atomic<bool> dead{false};

  ~Stream() {
    if (capture) capture->Release();
    if (client) client->Release();
    if (sampleReady) CloseHandle(sampleReady);
    if (processHandle) CloseHandle(processHandle);
  }
};

// Activates one INCLUDE_TARGET_PROCESS_TREE client for `pid` -- always
// include-tree, never exclude: PROCESS_LOOPBACK_MODE has only two values
// and both are tree modes, so per-PID capture in a mixer that sums N
// streams has exactly one correct choice here (see the file header; using
// exclude-tree per PID would produce N copies of everything, loudest for
// whichever app has the most co-mixed clients). Double-counting from
// nested trees is handled earlier, at candidate selection (PruneDescendants),
// not by varying the mode here.
//
// Mirrors CaptureThread's activation block above almost verbatim on
// purpose, including the INFINITE activation wait -- this function only
// ever runs on MixControlThread, which exists specifically so a wedged
// activation stalls a rescan, not audio delivery (see the mixer section
// header). It deliberately does NOT call client->Start(): the caller
// (RunScanPass) must publish the new Stream into g_live and signal
// g_refreshEvent before starting the client, so MixCaptureThread's wait
// array already includes this stream's sampleReady handle by the time
// WASAPI might start signalling it.
bool ActivateStream(DWORD pid, const std::wstring& baseName, std::shared_ptr<Stream>* outStream,
                    std::string* outError) {
  compat::ActParams params{};
  params.activationType = compat::ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.loopback.targetProcessId = pid;
  params.loopback.mode = compat::INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT pv{};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto* handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                           __uuidof(IAudioClient), &pv, handler, &op);
  if (FAILED(hr)) {
    if (outError) *outError = "ActivateAudioInterfaceAsync failed";
    handler->Release();
    return false;
  }

  WaitForSingleObject(handler->done_, INFINITE);
  hr = handler->result_;
  IAudioClient* client = handler->client_;
  handler->client_ = nullptr;
  handler->Release();
  if (op) op->Release();

  if (FAILED(hr) || !client) {
    if (outError) *outError = "process loopback activation failed";
    return false;
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = kBitsPerSample;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                          200000, 0, &format, nullptr);
  if (FAILED(hr)) {
    if (outError) *outError = "IAudioClient::Initialize failed";
    client->Release();
    return false;
  }

  HANDLE sampleReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(sampleReady);
  if (FAILED(hr)) {
    if (outError) *outError = "SetEventHandle failed";
    client->Release();
    CloseHandle(sampleReady);
    return false;
  }

  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
  if (FAILED(hr)) {
    if (outError) *outError = "GetService(IAudioCaptureClient) failed";
    client->Release();
    CloseHandle(sampleReady);
    return false;
  }

  auto stream = std::make_shared<Stream>();
  stream->pid = pid;
  stream->baseName = baseName;
  stream->client = client;
  stream->capture = capture;
  stream->sampleReady = sampleReady;
  stream->processHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  *outStream = stream;
  return true;
}

// Reads up to `frames` frames from `ring`, scales by `gain`, and adds into
// `accum` (int32 accumulator, one entry per interleaved sample).
//
// `gain` is threaded through from the very first version of this function,
// even though every call site passes 1.0f today. Step 0 of the plan this
// implements is an empirical check of whether include-mode process loopback
// captures pre- or post-volume-slider audio; today's whole-mix exclude-mode
// capture is unambiguously post-volume (mute a session in the Volume Mixer,
// it's silent in the share). If include-mode turns out to be pre-volume,
// the fix is to pull ISimpleAudioVolume::GetMasterVolume/GetMute per
// session on each rescan into Stream::gain -- and because the parameter is
// already here, that fix is a one-line change at the call site below, not a
// signature change touching both threads that call this.
void RingAccumulate(Ring& ring, int32_t* accum, size_t frames, float gain) {
  static thread_local std::vector<int16_t> scratch;
  scratch.assign(frames * kChannels, 0);
  size_t got = ring.Read(scratch.data(), frames);
  (void)got;  // short reads are handled by the caller's phase/available checks before calling in
  for (size_t i = 0; i < frames * kChannels; ++i) {
    accum[i] += static_cast<int32_t>(static_cast<float>(scratch[i]) * gain);
  }
}

// Drains one client's WASAPI buffer into its ring. Runs on MixCaptureThread.
// Marks the stream dead on any unrecoverable error rather than propagating
// the failure -- see Stream::dead's comment for why that is the right unit
// of blast radius here.
void DrainStream(const std::shared_ptr<Stream>& stream) {
  for (;;) {
    BYTE* data = nullptr;
    UINT32 frames = 0;
    DWORD flags = 0;
    HRESULT hr = stream->capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
    if (hr == AUDCLNT_S_BUFFER_EMPTY) break;
    if (FAILED(hr)) {
      stream->dead.store(true, std::memory_order_relaxed);
      break;
    }
    if (frames == 0) {
      stream->capture->ReleaseBuffer(0);
      break;
    }

    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
      // Written into the ring as real zero frames, not skipped: silence is
      // elapsed time at this stream's position in the mix, and skipping it
      // would permanently shift that stream's timeline against every other
      // stream's (which all share the same audio-engine clock -- see the
      // clock-drift note in MixerThread).
      static thread_local std::vector<int16_t> silence;
      silence.assign(static_cast<size_t>(frames) * kChannels, 0);
      stream->ring.Write(silence.data(), frames);
    } else {
      stream->ring.Write(reinterpret_cast<const int16_t*>(data), frames);
    }
    stream->capture->ReleaseBuffer(frames);
  }
}

// --- Reporting -------------------------------------------------------------

struct AudioProcessInfo {
  DWORD pid = 0;
  std::wstring name;
};

struct BlockedProcessInfo {
  DWORD pid = 0;
  std::wstring name;
  const char* reason = "blocklist";  // "blocklist" | "self-tree"
};

struct FailedProcessInfo {
  DWORD pid = 0;
  std::wstring name;
  std::string error;
};

struct ScanReport {
  std::vector<AudioProcessInfo> enumerated;
  std::vector<BlockedProcessInfo> blocked;
  std::vector<AudioProcessInfo> started;
  std::vector<FailedProcessInfo> failed;
};

// --- Mix-mode state ----------------------------------------------------

std::thread g_mixControlThread;
std::thread g_mixCaptureThread;
std::thread g_mixerThread;
std::atomic<bool> g_mixRunning{false};
HANDLE g_mixStopEvent = nullptr;
HANDLE g_refreshEvent = nullptr;   // set by MixControlThread whenever g_live changes; index 1 in MixCaptureThread's wait array
HANDLE g_firstScanDone = nullptr;  // set once, after the first rescan completes
Napi::ThreadSafeFunction g_mixTsfn;
std::atomic<int> g_mixOutstanding{0};
std::string g_mixLastError;

std::mutex g_liveMutex;
std::vector<std::shared_ptr<Stream>> g_live;
std::atomic<uint64_t> g_liveVersion{0};
std::atomic<int> g_scans{0};

// Set once at StartSystemExcluding() and read-only for the rest of the
// session -- safe to read from MixControlThread without a lock because the
// write happens-before that thread is even created.
std::vector<std::wstring> g_blockedLower;

std::mutex g_reportMutex;
ScanReport g_lastReport;

// Control-thread-only bookkeeping (never touched by any other thread, so no
// lock): per-pid activation backoff, and a consecutive-absence counter used
// to require two straight missed scans (not one) before reaping a client
// that just didn't show up in one enumeration pass.
struct BackoffEntry {
  int failCount = 0;
  std::chrono::steady_clock::time_point nextAttempt;
};
std::unordered_map<DWORD, BackoffEntry> g_backoff;
std::unordered_map<DWORD, int> g_missedScans;

// One enumeration + filter + activate/reap pass. Runs on MixControlThread,
// both for the very first scan (before StartSystemExcluding returns) and
// every kRescanIntervalMs after that -- one code path for both, so "the
// enumerator is a snapshot, rebuild the whole chain each rescan" is
// trivially true instead of something the first-scan path could drift away
// from.
void RunScanPass() {
  std::vector<EnumeratedProcess> enumerated;
  bool ok = EnumerateAudioSessionPids(&enumerated);
  g_scans.fetch_add(1, std::memory_order_relaxed);

  if (!ok) {
    // A transient COM/device failure must never silently mute a live
    // share -- leave g_live exactly as it is and try again next rescan.
    g_mixLastError = "audio session enumeration failed";
    return;
  }

  auto parents = SnapshotParentTable();

  ScanReport report;
  std::vector<EnumeratedProcess> candidates;

  for (auto& proc : enumerated) {
    report.enumerated.push_back({proc.pid, proc.baseName});

    if (!proc.pathResolved) {
      // Fail closed: an image path we cannot read is treated as "cannot
      // prove this is not a blocked app," not as "assume it's fine." The
      // asymmetry in the two failure modes (a silent share is loud and
      // reported; a leaking share is silent and rebroadcasts a private
      // call) makes this the only defensible default.
      report.blocked.push_back({proc.pid, proc.baseName, "blocklist"});
      continue;
    }
    if (IsInOwnTree(parents, proc.pid, proc.fullPath)) {
      report.blocked.push_back({proc.pid, proc.baseName, "self-tree"});
      continue;
    }
    if (IsBlocklisted(proc.baseNameLower, g_blockedLower)) {
      report.blocked.push_back({proc.pid, proc.baseName, "blocklist"});
      continue;
    }
    candidates.push_back(proc);
  }

  candidates = PruneDescendants(parents, std::move(candidates));

  // Active sorted before Inactive so that, if the kMaxMixStreams cap ever
  // actually binds, it trims silent-for-now sessions before ones that are
  // audible right now.
  std::stable_sort(candidates.begin(), candidates.end(), [](const EnumeratedProcess& a, const EnumeratedProcess& b) {
    return (a.state == AudioSessionStateActive) > (b.state == AudioSessionStateActive);
  });

  std::unordered_set<DWORD> candidatePids;
  for (auto& c : candidates) candidatePids.insert(c.pid);

  // --- Reap: dead clients, exited processes, and two-consecutive-misses ---
  std::vector<std::shared_ptr<Stream>> keep;
  {
    std::lock_guard<std::mutex> lock(g_liveMutex);
    for (auto& stream : g_live) {
      if (stream->dead.load(std::memory_order_relaxed)) continue;
      if (stream->processHandle && WaitForSingleObject(stream->processHandle, 0) == WAIT_OBJECT_0) continue;

      if (candidatePids.count(stream->pid)) {
        g_missedScans.erase(stream->pid);
      } else {
        // One flaky enumeration must not retire a healthy client -- only
        // two straight absences do.
        if (++g_missedScans[stream->pid] >= 2) continue;
      }
      keep.push_back(stream);
    }
  }

  std::unordered_set<DWORD> keptPids;
  for (auto& s : keep) keptPids.insert(s->pid);

  // --- Activate newly-seen, allowed candidates -------------------------
  for (auto& c : candidates) {
    if (keptPids.count(c.pid)) continue;
    if (keep.size() >= static_cast<size_t>(kMaxMixStreams)) continue;

    auto backoffIt = g_backoff.find(c.pid);
    if (backoffIt != g_backoff.end() && std::chrono::steady_clock::now() < backoffIt->second.nextAttempt) {
      continue;  // still backing off from a recent activation failure
    }

    std::shared_ptr<Stream> stream;
    std::string error;
    if (!ActivateStream(c.pid, c.baseName, &stream, &error)) {
      report.failed.push_back({c.pid, c.baseName, error});
      g_mixLastError = error;
      auto& backoff = g_backoff[c.pid];
      backoff.failCount++;
      // Capped exponential backoff -- a permanently un-activatable process
      // (e.g. one WASAPI simply refuses, for reasons of its own) must not
      // be retried every single 2s rescan forever.
      int delaySec = (std::min)(30, 1 << (std::min)(backoff.failCount, 5));
      backoff.nextAttempt = std::chrono::steady_clock::now() + std::chrono::seconds(delaySec);
      continue;
    }

    // Publish before Start(): see ActivateStream's comment for why this
    // ordering (not the reverse) is what the mixer section header promises.
    keep.push_back(stream);
    {
      std::lock_guard<std::mutex> lock(g_liveMutex);
      g_live = keep;
      g_liveVersion.fetch_add(1, std::memory_order_release);
    }
    SetEvent(g_refreshEvent);

    HRESULT hrStart = stream->client->Start();
    if (FAILED(hrStart)) {
      keep.pop_back();
      {
        std::lock_guard<std::mutex> lock(g_liveMutex);
        g_live = keep;
        g_liveVersion.fetch_add(1, std::memory_order_release);
      }
      report.failed.push_back({c.pid, c.baseName, "IAudioClient::Start failed"});
      g_mixLastError = "IAudioClient::Start failed";
      continue;
    }

    report.started.push_back({c.pid, c.baseName});
    g_backoff.erase(c.pid);
  }

  // Publish the final reaped set even if nothing new was activated this
  // pass (a pure reap still changes g_live).
  {
    std::lock_guard<std::mutex> lock(g_liveMutex);
    g_live = keep;
    g_liveVersion.fetch_add(1, std::memory_order_release);
  }
  SetEvent(g_refreshEvent);

  {
    std::lock_guard<std::mutex> lock(g_reportMutex);
    g_lastReport = std::move(report);
  }
}

void MixControlThread() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInitialised = SUCCEEDED(hr);

  bool firstPass = true;
  while (g_mixRunning.load()) {
    RunScanPass();
    if (firstPass) {
      firstPass = false;
      SetEvent(g_firstScanDone);
    }
    // Waited on rather than slept so Stop() is immediate instead of
    // waiting out up to kRescanIntervalMs.
    if (WaitForSingleObject(g_mixStopEvent, kRescanIntervalMs) == WAIT_OBJECT_0) break;
  }

  // Drop this thread's references to every live Stream -- i.e. clear the
  // global g_live -- here, before CoUninitialize() below, and NOT in
  // StopMix() on the JS thread. Stream::~Stream() releases raw
  // IAudioClient/IAudioCaptureClient pointers that were activated under
  // this thread's own CoInitializeEx(MTA); releasing an MTA-activated COM
  // interface from a different apartment (Electron's JS/main thread is a
  // GUI thread already in its own STA, or under ELECTRON_RUN_AS_NODE may
  // never have called CoInitializeEx at all) is undefined behaviour and
  // segfaults in practice. Doing this while still inside this thread's own
  // CoInitializeEx/CoUninitialize bracket guarantees that if g_live holds
  // the last shared_ptr to a Stream, it is destroyed on an MTA thread.
  // MixCaptureThread and MixerThread apply the same rule to their own local
  // snapshot vectors below, for the same reason. StopMix()'s own
  // g_live.clear() (on the JS thread) is a defensive no-op that runs after
  // all three threads have already been joined and have already done this.
  {
    std::lock_guard<std::mutex> lock(g_liveMutex);
    g_live.clear();
    g_liveVersion.fetch_add(1, std::memory_order_release);
  }

  if (comInitialised) CoUninitialize();
}

void MixCaptureThread() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInitialised = SUCCEEDED(hr);

  std::vector<std::shared_ptr<Stream>> snapshot;
  uint64_t seenVersion = ~static_cast<uint64_t>(0);  // force the first refresh

  while (g_mixRunning.load()) {
    if (g_liveVersion.load(std::memory_order_acquire) != seenVersion) {
      std::lock_guard<std::mutex> lock(g_liveMutex);
      snapshot = g_live;
      seenVersion = g_liveVersion.load(std::memory_order_relaxed);
    }

    std::vector<HANDLE> waits;
    waits.reserve(snapshot.size() + 2);
    waits.push_back(g_mixStopEvent);
    waits.push_back(g_refreshEvent);
    for (auto& s : snapshot) waits.push_back(s->sampleReady);

    // 100ms timeout: short enough that a newly-activated client's arrival
    // (signalled via g_refreshEvent) is noticed promptly, long enough that
    // this thread mostly sleeps. See the mixer section header for why every
    // wake -- including this timeout -- drains every client rather than
    // just whichever handle WaitForMultipleObjects happened to report.
    DWORD signalled = WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, 100);
    if (signalled == WAIT_OBJECT_0) break;  // g_mixStopEvent

    for (auto& s : snapshot) DrainStream(s);
  }

  // Must run before CoUninitialize() below, not merely before this
  // function returns: `snapshot` is declared above and would otherwise be
  // destroyed by scope exit AFTER CoUninitialize() runs, which releases
  // its Streams' COM interfaces on a thread that has already left its MTA
  // -- the same class of bug as clearing g_live from the JS thread (see
  // MixControlThread's teardown comment above).
  snapshot.clear();

  if (comInitialised) CoUninitialize();
}

void MixerThread() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInitialised = SUCCEEDED(hr);

  // Multimedia Class Scheduler boost, so the 10ms tick cadence holds up
  // under general system load. Reverted symmetrically below.
  DWORD taskIndex = 0;
  HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

  std::vector<std::shared_ptr<Stream>> snapshot;
  uint64_t seenVersion = ~static_cast<uint64_t>(0);

  std::vector<int32_t> accum(static_cast<size_t>(kTickFrames) * kChannels);
  std::vector<int16_t> mixed(static_cast<size_t>(kTickFrames) * kChannels);

  using Clock = std::chrono::steady_clock;
  const auto tickDuration = std::chrono::microseconds(1000000LL * kTickFrames / kSampleRate);
  auto nextTick = Clock::now() + tickDuration;

  while (g_mixRunning.load()) {
    if (g_liveVersion.load(std::memory_order_acquire) != seenVersion) {
      std::lock_guard<std::mutex> lock(g_liveMutex);
      snapshot = g_live;
      seenVersion = g_liveVersion.load(std::memory_order_relaxed);
    }

    std::fill(accum.begin(), accum.end(), 0);

    // Clock drift is a non-problem: every process-loopback client is driven
    // by the same audio-engine clock, so streams do not drift against each
    // other and no resampling is needed anywhere in this mixer. The only
    // drift is engine-vs-QPC (this thread's own timing), on the order of
    // ~100ppm, which crosses the ~30ms elastic window (kPrimeFrames) roughly
    // once every five minutes -- one inaudible trim per stream that rarely.
    for (auto& s : snapshot) {
      if (s->dead.load(std::memory_order_relaxed)) continue;

      StreamPhase phase = s->phase.load(std::memory_order_relaxed);
      size_t available = s->ring.Available();

      if (phase == StreamPhase::Priming) {
        if (available >= kPrimeFrames) {
          s->phase.store(StreamPhase::Running, std::memory_order_relaxed);
        } else {
          continue;  // contribute nothing while priming
        }
      }

      if (available > kHighWaterFrames) {
        // Overrun: skip forward to the prime level and re-enter Priming
        // rather than let latency grow without bound.
        s->ring.Drop(available - kPrimeFrames);
        s->phase.store(StreamPhase::Priming, std::memory_order_relaxed);
        continue;
      }

      if (available < kTickFrames) {
        // Underrun mid-stream: do NOT zero-fill a partial tick. Stitching
        // silence into the middle of otherwise-live audio produces exactly
        // the waveform shape of a click. Contribute nothing this tick and
        // re-prime, so the next contribution starts from a clean cushion.
        s->phase.store(StreamPhase::Priming, std::memory_order_relaxed);
        continue;
      }

      RingAccumulate(s->ring, accum.data(), kTickFrames, s->gain);
    }

    // Unity-gain sum, never divide-by-N: dividing would make a single
    // playing app quieter than today's baseline (a regression against the
    // whole-mix capture this replaces) and would duck the entire mix every
    // time a second app starts making sound -- audible as a mixing bug even
    // though it would technically be "working as designed."
    for (size_t i = 0; i < accum.size(); ++i) {
      mixed[i] = static_cast<int16_t>(std::clamp<int32_t>(accum[i], -32768, 32767));
    }

    // Zero-client heartbeat: emitted unconditionally, even with an empty
    // snapshot. Load-bearing, not a nicety -- it is JS's only unambiguous
    // liveness signal (the watchdog has no other way to tell "mixer alive,
    // nobody making sound" from "mixer wedged"), and it keeps the
    // renderer's pcm-player worklet fed between apps.
    Emit(g_mixTsfn, g_mixOutstanding, reinterpret_cast<const BYTE*>(mixed.data()), mixed.size() * sizeof(int16_t));

    nextTick += tickDuration;
    auto now = Clock::now();
    if (now > nextTick) {
      if (now - nextTick > std::chrono::milliseconds(200)) {
        // More than ~200ms behind -- e.g. a system suspend/resume. There is
        // nothing left to legitimately catch up TO (that audio is simply
        // gone), so resync the deadline to now instead of free-running
        // through a burst of back-to-back ticks trying to make up lost time.
        nextTick = now + tickDuration;
      }
      continue;  // late: catch up immediately, no sleep, never discard a tick
    }
    std::this_thread::sleep_until(nextTick);
  }

  if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
  // Only this thread releases g_mixTsfn, mirroring CaptureThread's
  // single-owner release pattern above (addon.cc's original single-process
  // path): the mixer thread is the sole producer into the JS callback in Mix
  // mode, exactly as CaptureThread is the sole producer in Single mode.
  g_mixTsfn.Release();
  // Same reasoning as MixCaptureThread's teardown: must run before
  // CoUninitialize() below, not left to scope-exit after it.
  snapshot.clear();
  if (comInitialised) CoUninitialize();
}

Napi::Object MakeAudioProcess(Napi::Env env, DWORD pid, const std::wstring& name) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("pid", Napi::Number::New(env, static_cast<double>(pid)));
  o.Set("name", Napi::String::New(env, WideToUtf8(name)));
  return o;
}

Napi::Object BuildMixReport(Napi::Env env, const ScanReport& report) {
  Napi::Object out = Napi::Object::New(env);

  Napi::Array enumerated = Napi::Array::New(env, static_cast<uint32_t>(report.enumerated.size()));
  for (size_t i = 0; i < report.enumerated.size(); ++i) {
    enumerated.Set(static_cast<uint32_t>(i), MakeAudioProcess(env, report.enumerated[i].pid, report.enumerated[i].name));
  }
  out.Set("enumerated", enumerated);

  Napi::Array blocked = Napi::Array::New(env, static_cast<uint32_t>(report.blocked.size()));
  for (size_t i = 0; i < report.blocked.size(); ++i) {
    Napi::Object o = MakeAudioProcess(env, report.blocked[i].pid, report.blocked[i].name);
    o.Set("reason", Napi::String::New(env, report.blocked[i].reason));
    blocked.Set(static_cast<uint32_t>(i), o);
  }
  out.Set("blocked", blocked);

  Napi::Array started = Napi::Array::New(env, static_cast<uint32_t>(report.started.size()));
  for (size_t i = 0; i < report.started.size(); ++i) {
    started.Set(static_cast<uint32_t>(i), MakeAudioProcess(env, report.started[i].pid, report.started[i].name));
  }
  out.Set("started", started);

  Napi::Array failed = Napi::Array::New(env, static_cast<uint32_t>(report.failed.size()));
  for (size_t i = 0; i < report.failed.size(); ++i) {
    Napi::Object o = MakeAudioProcess(env, report.failed[i].pid, report.failed[i].name);
    o.Set("error", Napi::String::New(env, report.failed[i].error));
    failed.Set(static_cast<uint32_t>(i), o);
  }
  out.Set("failed", failed);

  return out;
}

Napi::Value ListAudioProcesses(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComScope comScope;

  std::vector<EnumeratedProcess> enumerated;
  bool ok = EnumerateAudioSessionPids(&enumerated);

  Napi::Array result = Napi::Array::New(env, ok ? static_cast<uint32_t>(enumerated.size()) : 0);
  if (ok) {
    for (size_t i = 0; i < enumerated.size(); ++i) {
      result.Set(static_cast<uint32_t>(i), MakeAudioProcess(env, enumerated[i].pid, enumerated[i].baseName));
    }
  }
  return result;
}

Napi::Value StartSystemExcluding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_mode.load() != CaptureMode::Idle) {
    Napi::Error::New(env, "capture already running").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "expected (excludedNames, callback)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array namesArr = info[0].As<Napi::Array>();
  g_blockedLower.clear();
  for (uint32_t i = 0; i < namesArr.Length(); ++i) {
    Napi::Value v = namesArr.Get(i);
    if (!v.IsString()) continue;
    std::string s = v.As<Napi::String>().Utf8Value();
    std::wstring w(s.begin(), s.end());  // blocklist entries are ASCII exe basenames
    for (auto& ch : w) ch = static_cast<wchar_t>(towlower(ch));
    g_blockedLower.push_back(w);
  }

  g_mixLastError.clear();
  g_scans.store(0);
  g_backoff.clear();
  g_missedScans.clear();
  {
    std::lock_guard<std::mutex> lock(g_reportMutex);
    g_lastReport = ScanReport{};
  }
  // g_live is already guaranteed empty here (Idle mode -- checked above --
  // is only reached once StopMix() has run its teardown, which is the only
  // place that touches g_live on the JS thread and is documented there).
  // This is therefore the same defensive no-op as StopMix()'s: it must
  // never be what actually destroys a Stream, because that would release
  // MTA-activated COM interfaces from the JS thread's apartment. See
  // StopMix()'s comment for the full reasoning.
  {
    std::lock_guard<std::mutex> lock(g_liveMutex);
    g_live.clear();
    g_liveVersion.fetch_add(1, std::memory_order_release);
  }

  g_mixStopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  g_refreshEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  g_firstScanDone = CreateEventW(nullptr, TRUE, FALSE, nullptr);

  g_mixTsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "winAppAudioMix", 0, 1);

  g_mode.store(CaptureMode::Mix);
  g_mixRunning.store(true);
  g_mixControlThread = std::thread(MixControlThread);
  g_mixCaptureThread = std::thread(MixCaptureThread);
  g_mixerThread = std::thread(MixerThread);

  // Blocks the caller for the first scan only (enumeration + filtering +
  // activation of whatever passed), so the MixReport handed back reflects
  // real decisions rather than an empty stub -- callers use this for their
  // startup log line. Bounded, not INFINITE: a wedged first activation must
  // not hang whoever called us (in practice, Electron's main thread). If
  // the timeout fires, MixControlThread just keeps running in the
  // background and finishes that scan regardless; mixState() will reflect
  // it moments later. 5s is generous against real activation latency
  // (typically tens of ms) while still bounding a caller-visible stall.
  WaitForSingleObject(g_firstScanDone, 5000);

  ScanReport report;
  {
    std::lock_guard<std::mutex> lock(g_reportMutex);
    report = g_lastReport;
  }
  return BuildMixReport(env, report);
}

Napi::Value MixState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);

  bool running = g_mode.load() == CaptureMode::Mix;
  out.Set("running", Napi::Boolean::New(env, running));

  std::vector<std::shared_ptr<Stream>> live;
  if (running) {
    std::lock_guard<std::mutex> lock(g_liveMutex);
    live = g_live;
  }
  Napi::Array clients = Napi::Array::New(env, static_cast<uint32_t>(live.size()));
  for (size_t i = 0; i < live.size(); ++i) {
    clients.Set(static_cast<uint32_t>(i), MakeAudioProcess(env, live[i]->pid, live[i]->baseName));
  }
  out.Set("clients", clients);
  out.Set("scans", Napi::Number::New(env, g_scans.load()));
  out.Set("lastError", Napi::String::New(env, g_mixLastError));
  return out;
}

void StopMix() {
  if (!g_mixRunning.load() && !g_mixControlThread.joinable()) return;
  g_mixRunning.store(false);
  if (g_mixStopEvent) SetEvent(g_mixStopEvent);

  // Join order matches the mixer section header: control, then capture,
  // then mixer. Control must stop enumerating/activating first so nothing
  // new gets published into g_live while capture and mixer are winding
  // down; capture must stop touching stream rings before the mixer (the
  // last reader) exits and releases its tsfn.
  if (g_mixControlThread.joinable()) g_mixControlThread.join();
  if (g_mixCaptureThread.joinable()) g_mixCaptureThread.join();
  if (g_mixerThread.joinable()) g_mixerThread.join();  // releases g_mixTsfn just before returning

  if (g_mixStopEvent) { CloseHandle(g_mixStopEvent); g_mixStopEvent = nullptr; }
  if (g_refreshEvent) { CloseHandle(g_refreshEvent); g_refreshEvent = nullptr; }
  if (g_firstScanDone) { CloseHandle(g_firstScanDone); g_firstScanDone = nullptr; }

  // Defensive no-op, not the real teardown -- every Stream's last
  // shared_ptr reference must be dropped on one of the three mixer threads
  // (each CoInitializeEx(MTA)'d), never here. This function runs on the JS
  // thread, which in Electron's main process is a GUI thread already in a
  // different COM apartment (an STA), or under ELECTRON_RUN_AS_NODE may
  // never have called CoInitializeEx at all; releasing an MTA-activated
  // IAudioClient/IAudioCaptureClient from that thread is undefined
  // behaviour and segfaults in practice (this was exactly that bug).
  // MixControlThread clears the global g_live, and MixCaptureThread/
  // MixerThread each clear their own local snapshot, as their own last act
  // before their own CoUninitialize -- all three have already been joined
  // by the time we get here, so g_live should already be empty and every
  // Stream already gone. This clear only guards against that invariant
  // somehow not holding (e.g. a future change upstream) and must never be
  // the call that actually destroys a Stream.
  {
    std::lock_guard<std::mutex> lock(g_liveMutex);
    g_live.clear();
    g_liveVersion.fetch_add(1, std::memory_order_release);
  }
  g_backoff.clear();
  g_missedScans.clear();
}

// ===========================================================================

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_mode.load() != CaptureMode::Idle) {
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
  g_mode.store(CaptureMode::Single);
  g_running.store(true);
  g_thread = std::thread(CaptureThread, pid, includeTree);
  return env.Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  switch (g_mode.load()) {
    case CaptureMode::Idle:
      break;

    case CaptureMode::Single: {
      if (!g_running.load() && !g_thread.joinable()) {
        g_mode.store(CaptureMode::Idle);
        break;
      }
      g_running.store(false);
      if (g_stopEvent) SetEvent(g_stopEvent);
      if (g_thread.joinable()) g_thread.join();
      if (g_stopEvent) {
        CloseHandle(g_stopEvent);
        g_stopEvent = nullptr;
      }
      g_mode.store(CaptureMode::Idle);
      break;
    }

    case CaptureMode::Mix: {
      StopMix();
      g_mode.store(CaptureMode::Idle);
      break;
    }
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
  exports.Set("listAudioProcesses", Napi::Function::New(env, ListAudioProcesses));
  exports.Set("startSystemExcluding", Napi::Function::New(env, StartSystemExcluding));
  exports.Set("mixState", Napi::Function::New(env, MixState));
  exports.Set("sampleRate", Napi::Number::New(env, kSampleRate));
  exports.Set("channels", Napi::Number::New(env, kChannels));
  return exports;
}

}  // namespace

NODE_API_MODULE(win_app_audio, Init)
