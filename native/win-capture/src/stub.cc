// Non-Windows builds get a stub so the package installs cleanly everywhere.
// Windows Graphics Capture has no equivalent outside Windows; other platforms
// simply never call isSupported() true, so the caller keeps using Chromium's
// own desktop capture path unconditionally.
#include <napi.h>

namespace {

Napi::Value NotSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Value FalseNoop(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Value Noop(const Napi::CallbackInfo& info) {
  return info.Env().Undefined();
}

Napi::Value EmptyString(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "unsupported platform");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, NotSupported));
  exports.Set("start", Napi::Function::New(env, FalseNoop));
  exports.Set("stop", Napi::Function::New(env, Noop));
  exports.Set("lastError", Napi::Function::New(env, EmptyString));
  return exports;
}

}  // namespace

NODE_API_MODULE(win_capture, Init)
