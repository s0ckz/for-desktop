#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace capture_policy {

// A one-frame jitter allowance preserves scarce, bursty arrivals. Credit is
// capped at two frames, so a stall cannot create an unbounded catch-up burst.
// Over any interval accepted frames are bounded by elapsed * fps + 2.
class Pacer {
 public:
  bool Take(double timestamp100ns, double fps, bool& discontinuity) {
    discontinuity = false;
    if (!std::isfinite(timestamp100ns) || !ValidFps(fps)) return false;
    if (last_ >= 0 && timestamp100ns == last_) return false;
    if (last_ < 0 || fps != fps_ || timestamp100ns < last_) {
      discontinuity = last_ >= 0 && timestamp100ns < last_;
      last_ = timestamp100ns;
      fps_ = fps;
      credit_ = 0;
      return true;
    }
    credit_ = (std::min)(2.0, credit_ + (timestamp100ns - last_) * fps / 1.0e7);
    last_ = timestamp100ns;
    if (credit_ + 1e-9 < 1) return false;
    credit_ = (std::max)(0.0, credit_ - 1);
    return true;
  }

  static bool ValidFps(double fps) { return std::isfinite(fps) && fps >= 1 && fps <= 120; }

 private:
  double last_ = -1;
  double fps_ = 0;
  double credit_ = 0;
};

inline bool ValidDimension(double value) {
  return std::isfinite(value) && value >= 2 && value <= 8192 && std::floor(value) == value;
}

struct Size { uint32_t width; uint32_t height; };
inline Size Fit(uint32_t width, uint32_t height, uint32_t targetWidth, uint32_t targetHeight) {
  const double scale = (std::min)({static_cast<double>(targetWidth) / width,
                                  static_cast<double>(targetHeight) / height, 1.0});
  // NV12 requires even dimensions. Round down to stay inside the bounding box.
  return {(std::max)(2u, static_cast<uint32_t>(width * scale) & ~1u),
          (std::max)(2u, static_cast<uint32_t>(height * scale) & ~1u)};
}

// Always bound the next heartbeat relative to now; frame-event wakes must
// never advance a cumulative deadline into the distant future.
inline double Heartbeat100ns(double fps) { return (std::min)(100000.0, 1.0e7 / fps); }

// Preserve the last/static image; discard old copies only if newer work exists.
inline bool Expired(double ageUs, uint64_t sequence, uint64_t newestSequence) {
  return ageUs > 250000 && sequence < newestSequence;
}

// Five recreation attempts per recovery episode; a healthy frame clears it.
class RecoveryBudget {
 public:
  bool Take() { return attempts_++ < 5; }
  void Healthy() { attempts_ = 0; }
 private:
  unsigned attempts_ = 0;
};

}  // namespace capture_policy
