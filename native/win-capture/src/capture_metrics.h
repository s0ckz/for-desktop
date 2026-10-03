#pragma once
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>

namespace capture_metrics {
// Fixed memory; one capture-thread writer and an asynchronous JS reader.
// Quantiles are bucket upper bounds, not precise GPU execution measurements.
class Distribution {
 public:
  static constexpr std::array<double, 13> bounds{{1, 2, 4, 8, 16, 33, 50, 100, 250, 500, 1000, 5000, INFINITY}};
  struct Snapshot { uint64_t count; double mean, maximum, p50, p95, p99; };
  void Reset() {
    for (auto& bucket : buckets_) bucket.store(0);
    totalUs_.store(0); maximumUs_.store(0);
  }
  void Add(double ms) {
    if (!std::isfinite(ms) || ms < 0) return;
    const auto us = static_cast<uint64_t>(ms * 1000);
    size_t i = 0;
    while (ms > bounds[i]) ++i;
    buckets_[i].fetch_add(1, std::memory_order_relaxed);
    totalUs_.fetch_add(us, std::memory_order_relaxed);
    if (us > maximumUs_.load()) maximumUs_.store(us);
  }
  Snapshot Read() const {
    std::array<uint64_t, 13> values{};
    uint64_t n = 0;
    for (size_t i = 0; i < values.size(); ++i) n += values[i] = buckets_[i].load();
    const double maximum = maximumUs_.load() / 1000.0;
    auto quantile = [&](double fraction) {
      uint64_t sum = 0;
      const auto needed = static_cast<uint64_t>(std::ceil(n * fraction));
      for (size_t i = 0; i < values.size(); ++i) {
        sum += values[i];
        if (n && sum >= needed) return std::isfinite(bounds[i]) ? bounds[i] : maximum;
      }
      return 0.0;
    };
    return {n, n ? totalUs_.load() / (1000.0 * n) : 0, maximum, quantile(.5), quantile(.95), quantile(.99)};
  }
 private:
  std::array<std::atomic<uint64_t>, 13> buckets_{};
  std::atomic<uint64_t> totalUs_{0}, maximumUs_{0};
};

// Source timestamps are diagnostic clock inputs: preserve future/negative
// offsets instead of silently making them look like zero latency.
class SignedOffset {
 public:
  struct Snapshot { uint64_t count, negative; double mean, minimum, maximum; };
  void Reset() {
    count_.store(0); negative_.store(0);
    total_.store(0); minimum_.store(0); maximum_.store(0);
  }
  void Add(double ms) {
    if (!std::isfinite(ms)) return;
    const auto count = count_.load();
    total_.store(total_.load() + ms);
    if (!count || ms < minimum_.load()) minimum_.store(ms);
    if (!count || ms > maximum_.load()) maximum_.store(ms);
    if (ms < 0) negative_.fetch_add(1);
    count_.fetch_add(1);
  }
  Snapshot Read() const {
    const auto count = count_.load();
    return {count, negative_.load(), count ? total_.load() / count : 0,
      minimum_.load(), maximum_.load()};
  }
 private:
  std::atomic<uint64_t> count_{0}, negative_{0};
  std::atomic<double> total_{0}, minimum_{0}, maximum_{0};
};
}  // namespace capture_metrics
