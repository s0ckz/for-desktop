#include "src/session_interval.h"
#include <cassert>
#include <iostream>
#include <limits>
#include <vector>
using capture_session::IntervalPolicy;
using capture_session::IntervalState;
constexpr int32_t kFailure = static_cast<int32_t>(0x80004005u);
constexpr int32_t kUnavailable = static_cast<int32_t>(0x80004002u);

struct Api {
  bool supported = true, failRead = false, failWrite = false;
  bool changeOnFailure = false, ignoreWrite = false, failNextRead = false;
  int64_t value = 160000;
  unsigned reads = 0;
  std::vector<int64_t> writes;
  bool Supported() const { return supported; }
  int32_t SupportError() const { return kUnavailable; }
  int32_t Read(int64_t& result) {
    ++reads;
    if (failRead || failNextRead) { failNextRead = false; return kFailure; }
    result = value;
    return 0;
  }
  int32_t Write(int64_t target) {
    writes.push_back(target);
    if (failWrite) {
      if (changeOnFailure) value = target;
      return kFailure;
    }
    if (!ignoreWrite) value = target;
    return 0;
  }
};

int main() {
  for (const auto original : {0, 160000, 200000}) {
    Api api; api.value = original;
    IntervalPolicy policy;
    assert(policy.Update(30, api));
    assert(api.writes.empty());
    assert(policy.Read().state == IntervalState::SessionDefault);
    assert(policy.Update(60, api));
    assert(api.value == 0);
    assert(policy.Read().state == IntervalState::Unthrottled);
    const auto reads = api.reads;
    const auto writes = api.writes.size();
    for (int i = 0; i < 10000; ++i) assert(!policy.Update(60, api));
    assert(!policy.Update(45, api)); // same rate mode: no per-frame property work
    assert(api.reads == reads && api.writes.size() == writes);
    assert(policy.Update(30, api));
    assert(api.value == original && policy.Read().current100ns == original);
    assert(policy.Update(120, api));
    assert(api.value == 0);
  }
  {
    Api api; api.supported = false;
    IntervalPolicy policy;
    assert(policy.Update(60, api));
    assert(policy.Read().state == IntervalState::Unavailable);
    assert(policy.Read().error == kUnavailable);
    assert(api.reads == 0 && api.writes.empty());
    assert(!policy.Update(30, api) && !policy.Update(60, api));
  }
  for (bool unreadable : {false, true}) {
    Api api; api.failRead = unreadable; api.value = -1;
    IntervalPolicy policy;
    assert(policy.Update(60, api));
    assert(policy.Read().state == IntervalState::ReadFailed);
    assert(policy.Read().original100ns == -1 && api.writes.empty());
    assert(!policy.Update(60, api));
  }
  for (bool partial : {false, true}) {
    Api api; api.failWrite = true; api.changeOnFailure = partial;
    IntervalPolicy policy;
    assert(policy.Update(60, api));
    assert(policy.Read().state == IntervalState::WriteFailed);
    assert(policy.Read().error == kFailure && policy.Read().disabled);
    assert(api.value == 160000); // partial mutation gets one best-effort restoration
    assert(api.writes.size() == (partial ? 2u : 1u));
    for (int i = 0; i < 10000; ++i) assert(!policy.Update(i % 2 ? 30 : 60, api));
  }
  {
    Api api; api.ignoreWrite = true;
    IntervalPolicy policy;
    assert(policy.Update(60, api));
    assert(policy.Read().state == IntervalState::VerifyFailed);
    assert(api.writes.size() == 1 && api.value == 160000);
  }
  {
    struct FailsVerification : Api {
      int32_t Write(int64_t target) {
        const auto result = Api::Write(target);
        if (target == 0) failNextRead = true;
        return result;
      }
    } api;
    IntervalPolicy policy;
    assert(policy.Update(60, api));
    assert(policy.Read().state == IntervalState::VerifyFailed);
    assert(api.value == 160000 && api.writes.size() == 2);
    assert(policy.Read().current100ns == 160000);
  }
  {
    Api api;
    IntervalPolicy policy;
    assert(policy.Update(60, api));
    api.failWrite = true;
    assert(policy.Update(30, api));
    assert(policy.Read().state == IntervalState::WriteFailed);
    assert(api.value == 0 && policy.Read().current100ns == 0); // report failed restoration honestly
    assert(api.writes.size() == 2 && !policy.Update(30, api));
    Api restartedApi;
    IntervalPolicy restarted;
    assert(restarted.Update(30, restartedApi));
    assert(restarted.Read().state == IntervalState::SessionDefault);
    assert(restartedApi.writes.empty());
  }
  {
    Api api;
    IntervalPolicy policy;
    for (double fps : {0.0, -1.0, 121.0, std::numeric_limits<double>::quiet_NaN(),
                       std::numeric_limits<double>::infinity()})
      assert(!policy.Update(fps, api));
    assert(api.reads == 0 && api.writes.empty());
    assert(policy.Update(30, api));
  }
  std::cout << "Session interval transitions, optional API failures and bounded retries pass.\n";
}
