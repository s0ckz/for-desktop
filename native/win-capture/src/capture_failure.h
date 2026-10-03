#pragma once
#include <cstdint>

namespace capture_failure {
enum class Action { Retry, RepeatedFailure, DeviceFailure };
// HRESULTs from DXGI: removed, hung, reset and driver-internal-error. Other
// failed operations get a short retry budget; silence/empty content does not.
inline bool DeviceFailure(int32_t hr) {
  const auto code = static_cast<uint32_t>(hr);
  return code == 0x887A0005u || code == 0x887A0006u ||
         code == 0x887A0007u || code == 0x887A0020u;
}
class SurfaceFailures {
 public:
  static constexpr unsigned kLimit = 8;
  Action Failed(int32_t hr, int32_t deviceReason) {
    ++consecutive_;
    if (DeviceFailure(hr) || deviceReason < 0) return Action::DeviceFailure;
    return consecutive_ >= kLimit ? Action::RepeatedFailure : Action::Retry;
  }
  void Processed() { consecutive_ = 0; }
  unsigned Consecutive() const { return consecutive_; }
 private:
  unsigned consecutive_ = 0;
};
}
