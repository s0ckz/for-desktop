#include "src/capture_policy.h"
#include "src/capture_metrics.h"
#include <cassert>
#include <iostream>

int main() {
  for (const auto source : {20, 50, 70, 99, 144}) {
    for (const auto target : {30, 60}) {
      capture_policy::Pacer pacer;
      int accepted = 0;
      bool discontinuity;
      for (int i = 0; i < source * 10; ++i)
        accepted += pacer.Take(i * 1.0e7 / source, target, discontinuity);
      const int expected = (std::min)(source, target) * 10;
      assert(accepted >= expected - 1 && accepted <= expected + 1);
    }
  }
  capture_policy::Pacer jitter;
  bool discontinuity;
  int accepted = 0;
  for (int i = 0; i < 200; ++i)
    accepted += jitter.Take(((i / 2) * 100 + (i % 2 ? 20 : 0)) * 10000.0, 30, discontinuity);
  assert(accepted >= 198);  // old policy accepted only 100
  assert(!jitter.Take(99200000, 30, discontinuity));  // duplicate
  assert(jitter.Take(100, 30, discontinuity) && discontinuity);
  assert(jitter.Take(200, 60, discontinuity));  // rate change takes effect
  capture_policy::Pacer stall;
  stall.Take(0, 30, discontinuity);
  assert(stall.Take(1e9, 30, discontinuity));
  assert(stall.Take(1e9 + 1, 30, discontinuity));
  assert(!stall.Take(1e9 + 2, 30, discontinuity));  // at most two after stall
  for (int i = 0; i < 1000; ++i) assert(capture_policy::Heartbeat100ns(30) <= 100000);
  assert(!capture_policy::Pacer::ValidFps(INFINITY));
  assert(!capture_policy::ValidDimension(-1));
  assert(!capture_policy::ValidDimension(2.5));
  assert(capture_policy::Expired(250001, 1, 2));
  assert(!capture_policy::Expired(250000, 1, 2));
  assert(!capture_policy::Expired(1e9, 2, 2));
  capture_policy::RecoveryBudget recovery;
  for (int i = 0; i < 5; ++i) assert(recovery.Take());
  assert(!recovery.Take());
  recovery.Healthy(); assert(recovery.Take());
  capture_metrics::Distribution distribution;
  assert(distribution.Read().count == 0);
  for (int i = 0; i < 100; ++i) distribution.Add(i < 95 ? 3 : 200);
  auto metric = distribution.Read();
  assert(metric.count == 100 && metric.p50 == 4 && metric.p95 == 4 && metric.p99 == 250 && metric.maximum == 200);
  distribution.Add(INFINITY); distribution.Add(-1);
  assert(distribution.Read().count == 100);
  distribution.Reset(); assert(distribution.Read().count == 0);
  const auto size = capture_policy::Fit(3440, 1440, 1279, 719);
  assert(size.width <= 1279 && size.height <= 719 && !(size.width % 2) && !(size.height % 2));
  std::cout << "CAPTURE POLICY PASS\n";
}
