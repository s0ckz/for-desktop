#include "src/capture_failure.h"
#include "src/capture_lifetime.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <future>
#include <iostream>
#include <thread>

int main() {
  constexpr int32_t failedOperation = static_cast<int32_t>(0x80004005u);
  capture_failure::SurfaceFailures failures;
  for (unsigned i = 1; i < failures.kLimit; ++i) {
    assert(failures.Failed(failedOperation, 0) == capture_failure::Action::Retry);
    assert(failures.Consecutive() == i);
  }
  // No image/static content does not call Failed or Processed. The next
  // observed failure still exhausts the existing streak, without a timer.
  assert(failures.Failed(failedOperation, 0) == capture_failure::Action::RepeatedFailure);
  failures.Processed();
  assert(failures.Consecutive() == 0);
  assert(failures.Failed(failedOperation, 0) == capture_failure::Action::Retry);
  failures.Processed();
  for (const uint32_t code : {0x887A0005u, 0x887A0006u, 0x887A0007u, 0x887A0020u}) {
    assert(failures.Failed(static_cast<int32_t>(code), 0) == capture_failure::Action::DeviceFailure);
    failures.Processed();
    assert(failures.Failed(failedOperation, static_cast<int32_t>(code)) == capture_failure::Action::DeviceFailure);
    failures.Processed();
  }
  assert(!capture_failure::DeviceFailure(failedOperation));

  // Force retirement while a callback already holds the resource. It must
  // wait for that signal before the owner is permitted to close/reuse it.
  capture_lifetime::SignalGuard<int> guard(7);
  std::promise<void> entered, allowSignal, retiring;
  auto release = allowSignal.get_future().share();
  std::atomic<bool> retired{false};
  std::atomic<unsigned> signals{0};
  std::thread callback([&] {
    guard.With([&](int resource) {
      entered.set_value(); release.wait();
      assert(resource == 7 && !retired.load());
      ++signals;
    });
  });
  entered.get_future().wait();
  std::thread retirement([&] { retiring.set_value(); guard.Retire(); retired.store(true); });
  retiring.get_future().wait();
  assert(!retired.load());
  allowSignal.set_value();
  callback.join(); retirement.join();
  assert(retired.load() && signals == 1);
  for (unsigned i = 0; i < 1000; ++i) guard.With([&](int) { ++signals; });
  assert(signals == 1);  // late callbacks cannot signal a recycled handle
  for (unsigned run = 0; run < 1000; ++run) {
    capture_lifetime::SignalGuard<int> session(7);
    session.With([&](int) { ++signals; });
    session.Retire();
    session.With([&](int) { assert(false); });
  }
  std::cout << "CAPTURE HARDENING PASS: injected surface/device failures, in-flight signal retirement and 1000 lifetimes\n";
}
