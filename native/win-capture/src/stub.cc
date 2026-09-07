// Non-Windows builds get a stub so the package installs cleanly everywhere.
// Windows Graphics Capture has no equivalent outside Windows; other platforms
// simply never call isSupported() true, so the caller keeps using Chromium's
// own desktop capture path unconditionally. start() below never touches the
// onFrame callback at all -- it always returns false without starting a
// session, so index.d.ts's null-frame death signal never applies here.
#include <napi.h>

namespace {

Napi::Value NotSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Value FalseNoop(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

// Real stop() (addon.cc) is now async -- Napi::Promise<void>, resolved once
// the capture thread's join actually completes off the main thread (item
// 3). start() above never starts anything on this platform, so there is
// nothing to join here, but the stub still needs to hand back a promise
// (already resolved) so callers on every platform can `await stop()`
// unconditionally without a platform check.
Napi::Value ResolvedStop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  deferred.Resolve(env.Undefined());
  return deferred.Promise();
}

Napi::Value EmptyString(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "unsupported platform");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, NotSupported));
  exports.Set("start", Napi::Function::New(env, FalseNoop));
  exports.Set("stop", Napi::Function::New(env, ResolvedStop));
  exports.Set("lastError", Napi::Function::New(env, EmptyString));
  return exports;
}

}  // namespace

NODE_API_MODULE(win_capture, Init)
