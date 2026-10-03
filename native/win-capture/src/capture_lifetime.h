#pragma once
#include <mutex>

namespace capture_lifetime {
// The resource owner retires this guard before closing the resource. A signal
// already inside With() completes first; later callbacks cannot obtain it.
// Never revoke a source or close a resource while holding this mutex.
template <typename Resource>
class SignalGuard {
 public:
  explicit SignalGuard(Resource resource = {}) : resource_(resource) {}
  void Set(Resource resource) {
    std::lock_guard<std::mutex> lock(mutex_);
    resource_ = resource;
  }
  template <typename Signal>
  void With(Signal signal) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (resource_) signal(resource_);
  }
  void Retire() { Set({}); }
 private:
  std::mutex mutex_;
  Resource resource_{};
};
}
