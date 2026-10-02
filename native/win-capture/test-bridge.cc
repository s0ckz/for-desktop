#include "src/duplication_bridge.h"
#include <cassert>
#include <cmath>
#include <iostream>

// Known pixels catch shader compilation, drawing and transfer-function errors,
// independently of whatever happens to be displayed during capture smoke tests.
int main() {
  using Microsoft::WRL::ComPtr;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  assert(SUCCEEDED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0,
      nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context)));
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = desc.Height = 2; desc.MipLevels = desc.ArraySize = 1;
  desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
  desc.Format = DXGI_FORMAT_R16G16B16A16_FLOAT;
  const uint16_t half[] = {0,0,0,0x3c00, 0x3400,0x3400,0x3400,0x3c00,
      0x3800,0x3800,0x3800,0x3c00, 0x4000,0x4000,0x4000,0x3c00};
  D3D11_SUBRESOURCE_DATA data{half, 16, 0};
  ComPtr<ID3D11Texture2D> source;
  assert(SUCCEEDED(device->CreateTexture2D(&desc, &data, &source)));
  DuplicationBridge bridge;
  assert(SUCCEEDED(bridge.Copy(device.Get(), context.Get(), source.Get())));
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> staging;
  assert(SUCCEEDED(device->CreateTexture2D(&desc, nullptr, &staging)));
  auto check = [&](const unsigned char* expected) {
    context->CopyResource(staging.Get(), bridge.Texture());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    assert(SUCCEEDED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped)));
    for (int y = 0; y < 2; ++y) for (int x = 0; x < 2; ++x) {
      const auto* pixel = static_cast<unsigned char*>(mapped.pData) + y * mapped.RowPitch + x * 4;
      for (int c = 0; c < 4; ++c) assert(std::abs(int(pixel[c]) - expected[(y * 2 + x) * 4 + c]) <= 1);
    }
    context->Unmap(staging.Get(), 0);
  };
  const unsigned char gamma[] = {0,0,0,255, 137,137,137,255, 188,188,188,255, 255,255,255,255};
  check(gamma);
  desc.Usage = D3D11_USAGE_DEFAULT; desc.CPUAccessFlags = 0;
  const unsigned char bgra[] = {13,29,47,255, 0,80,200,255, 33,66,99,255, 255,0,5,255};
  data.pSysMem = bgra; data.SysMemPitch = 8;
  source.Reset();
  assert(SUCCEEDED(device->CreateTexture2D(&desc, &data, &source)));
  assert(SUCCEEDED(bridge.Copy(device.Get(), context.Get(), source.Get())));
  check(bgra);
  std::cout << "DUPLICATION GPU BRIDGE PASS\n";
}
