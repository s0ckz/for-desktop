#pragma once
#include <cmath>
#include <cstdint>

namespace capture_session {
enum class IntervalState { NotAttempted, NotApplicable, Unavailable, ReadFailed,
                           SessionDefault, Unthrottled, WriteFailed, VerifyFailed };
inline const char* StateName(IntervalState state) {
  switch (state) {
    case IntervalState::NotApplicable: return "not_applicable";
    case IntervalState::Unavailable: return "api_unavailable";
    case IntervalState::ReadFailed: return "default_read_failed";
    case IntervalState::SessionDefault: return "session_default";
    case IntervalState::Unthrottled: return "unthrottled";
    case IntervalState::WriteFailed: return "write_failed";
    case IntervalState::VerifyFailed: return "verification_failed";
    default: return "not_attempted";
  }
}
struct IntervalSnapshot {
  IntervalState state = IntervalState::NotAttempted;
  bool supported = false, disabled = false;
  int64_t original100ns = -1, desired100ns = -1, current100ns = -1;
  uint32_t setterAttempts = 0;
  int32_t error = 0;
};

// One capture-thread owner. No retries on frame/event/heartbeat wakes after
// an optional API failure; the native frame pacer remains authoritative.
class IntervalPolicy {
 public:
  template <class Api> bool Update(double fps, Api& api) {
    if (!std::isfinite(fps) || fps < 1 || fps > 120 || snapshot_.disabled) return false;
    if (!initialized_) {
      initialized_ = true;
      snapshot_.supported = api.Supported();
      if (!snapshot_.supported) {
        Fail(IntervalState::Unavailable, api.SupportError());
        return true;
      }
      int64_t original = -1;
      const auto hr = api.Read(original);
      if (hr < 0 || original < 0) {
        Fail(IntervalState::ReadFailed, hr < 0 ? hr : kUnexpected);
        return true;
      }
      snapshot_.original100ns = snapshot_.current100ns = original;
    }
    const bool fast = fps > 30;
    if (modeKnown_ && fast == fast_) return false;
    modeKnown_ = true;
    fast_ = fast;
    const int64_t desired = fast ? 0 : snapshot_.original100ns;
    snapshot_.desired100ns = desired;
    if (desired != snapshot_.current100ns) {
      ++snapshot_.setterAttempts;
      const auto written = api.Write(desired);
      if (written < 0) {
        Observe(api);
        Fail(IntervalState::WriteFailed, written);
        // Failed setters are not assumed atomic. Restore the saved default
        // once if a failed zero request changed it or its outcome is unknown.
        RestoreIfNeeded(api, desired);
        return true;
      }
      const auto observed = Observe(api);
      if (observed < 0 || snapshot_.current100ns != desired) {
        Fail(IntervalState::VerifyFailed, observed < 0 ? observed : kUnexpected);
        RestoreIfNeeded(api, desired);
        return true;
      }
    }
    snapshot_.state = fast ? IntervalState::Unthrottled : IntervalState::SessionDefault;
    snapshot_.error = 0;
    return true;
  }
  const IntervalSnapshot& Read() const { return snapshot_; }

 private:
  static constexpr int32_t kUnexpected = static_cast<int32_t>(0x8000ffffu);
  void Fail(IntervalState state, int32_t error) {
    snapshot_.state = state;
    snapshot_.error = error;
    snapshot_.disabled = true;
  }
  template <class Api> int32_t Observe(Api& api) {
    int64_t value = -1;
    const auto hr = api.Read(value);
    snapshot_.current100ns = hr >= 0 && value >= 0 ? value : -1;
    return hr < 0 ? hr : value < 0 ? kUnexpected : 0;
  }
  template <class Api> void RestoreIfNeeded(Api& api, int64_t attempted) {
    if (attempted == snapshot_.original100ns ||
        snapshot_.current100ns == snapshot_.original100ns) return;
    ++snapshot_.setterAttempts;
    api.Write(snapshot_.original100ns);  // best effort, preserve first failure
    Observe(api);
  }
  IntervalSnapshot snapshot_{};
  bool initialized_ = false, modeKnown_ = false, fast_ = false;
};
}  // namespace capture_session
