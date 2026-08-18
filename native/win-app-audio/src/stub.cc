// Non-Windows builds get a stub so the package installs cleanly everywhere.
// Per-process loopback capture has no equivalent outside Windows; Linux is
// handled separately by the PipeWire virtual mic.
#include <napi.h>

namespace {

Napi::Value NotSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Value Noop(const Napi::CallbackInfo& info) {
  return info.Env().Undefined();
}

Napi::Value Zero(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), 0);
}

Napi::Value EmptyString(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "unsupported platform");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, NotSupported));
  exports.Set("pidFromWindowHandle", Napi::Function::New(env, Zero));
  exports.Set("start", Napi::Function::New(env, Noop));
  exports.Set("stop", Napi::Function::New(env, Noop));
  exports.Set("lastError", Napi::Function::New(env, EmptyString));
  exports.Set("sampleRate", Napi::Number::New(env, 48000));
  exports.Set("channels", Napi::Number::New(env, 2));
  return exports;
}

}  // namespace

NODE_API_MODULE(win_app_audio, Init)
