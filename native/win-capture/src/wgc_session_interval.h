#pragma once
#include <windows.graphics.capture.h>
#include <wrl/client.h>
#include "session_interval.h"

namespace capture_session {
#if defined(____x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession5_INTERFACE_DEFINED__)
using Session5 = ABI::Windows::Graphics::Capture::IGraphicsCaptureSession5;
#else
// Stable WinRT ABI from Windows SDK 10.0.26100.0/windows.graphics.capture.h:
// IID, IInspectable base and get/put vtable order match the OS metadata.
// Runtime QueryInterface, rather than the build SDK, determines availability.
MIDL_INTERFACE("67c0ea62-1f85-5061-925a-239be0ac09cb")
Session5 : public IInspectable {
  virtual HRESULT STDMETHODCALLTYPE get_MinUpdateInterval(ABI::Windows::Foundation::TimeSpan* value) = 0;
  virtual HRESULT STDMETHODCALLTYPE put_MinUpdateInterval(ABI::Windows::Foundation::TimeSpan value) = 0;
};
#endif

class WgcIntervalApi {
 public:
  explicit WgcIntervalApi(IInspectable* session) {
    queryResult_ = session->QueryInterface(IID_PPV_ARGS(&session_));
  }
  bool Supported() const { return SUCCEEDED(queryResult_) && session_; }
  int32_t SupportError() const { return queryResult_; }
  int32_t Read(int64_t& value) {
    ABI::Windows::Foundation::TimeSpan interval{};
    const auto hr = session_->get_MinUpdateInterval(&interval);
    if (SUCCEEDED(hr)) value = interval.Duration;
    return hr;
  }
  int32_t Write(int64_t value) {
    const ABI::Windows::Foundation::TimeSpan interval{value};
    return session_->put_MinUpdateInterval(interval);
  }
 private:
  Microsoft::WRL::ComPtr<Session5> session_;
  HRESULT queryResult_ = E_NOINTERFACE;
};
}  // namespace capture_session
