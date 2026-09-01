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

Napi::Value NoWindow(const Napi::CallbackInfo& info) {
  Napi::Object state = Napi::Object::New(info.Env());
  state.Set("exists", Napi::Boolean::New(info.Env(), false));
  state.Set("visible", Napi::Boolean::New(info.Env(), false));
  state.Set("iconic", Napi::Boolean::New(info.Env(), false));
  return state;
}

Napi::Value EmptyArray(const Napi::CallbackInfo& info) {
  return Napi::Array::New(info.Env(), 0);
}

// Matches the shape of a real MixReport with every list empty -- there is
// nothing to enumerate or mix outside Windows.
Napi::Value NoopMixReport(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object report = Napi::Object::New(env);
  report.Set("enumerated", Napi::Array::New(env, 0));
  report.Set("blocked", Napi::Array::New(env, 0));
  report.Set("started", Napi::Array::New(env, 0));
  report.Set("failed", Napi::Array::New(env, 0));
  return report;
}

Napi::Value DeadMixState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object state = Napi::Object::New(env);
  state.Set("running", Napi::Boolean::New(env, false));
  state.Set("clients", Napi::Array::New(env, 0));
  state.Set("scans", Napi::Number::New(env, 0));
  state.Set("lastError", Napi::String::New(env, "unsupported platform"));
  return state;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, NotSupported));
  exports.Set("pidFromWindowHandle", Napi::Function::New(env, Zero));
  exports.Set("windowState", Napi::Function::New(env, NoWindow));
  exports.Set("start", Napi::Function::New(env, Noop));
  exports.Set("stop", Napi::Function::New(env, Noop));
  exports.Set("lastError", Napi::Function::New(env, EmptyString));
  exports.Set("listAudioProcesses", Napi::Function::New(env, EmptyArray));
  exports.Set("startSystemExcluding", Napi::Function::New(env, NoopMixReport));
  exports.Set("mixState", Napi::Function::New(env, DeadMixState));
  exports.Set("sampleRate", Napi::Number::New(env, 48000));
  exports.Set("channels", Napi::Number::New(env, 2));
  return exports;
}

}  // namespace

NODE_API_MODULE(win_app_audio, Init)
