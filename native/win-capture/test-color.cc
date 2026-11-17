#include <d3d11.h>
#include "src/capture_color.h"
#include <wrl/client.h>
#include <array>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
void Check(HRESULT hr) {
  if (FAILED(hr)) throw std::runtime_error("D3D11 failed: " + std::to_string(hr));
}

// Solid 16x32 tiles avoid testing 4:2:0 edge interpolation instead of color.
const std::array<std::array<unsigned char, 3>, 16> colors{{
  {0,0,0}, {16,16,16}, {32,32,32}, {64,64,64}, {96,96,96}, {128,128,128},
  {160,160,160}, {192,192,192}, {224,224,224}, {235,235,235}, {255,255,255},
  {255,0,0}, {0,255,0}, {0,0,255}, {32,80,160}, {180,120,60}
}};

int main(int argc, char** argv) {
  try {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    Check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
      D3D11_CREATE_DEVICE_VIDEO_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
      &device, nullptr, &context));
    ComPtr<ID3D11VideoDevice> video;
    ComPtr<ID3D11VideoContext> vc;
    Check(device.As(&video)); Check(context.As(&vc));
    constexpr UINT width = 256, height = 32;
    std::vector<unsigned char> rgb(width * height * 4);
    for (UINT y = 0; y < height; ++y) for (UINT x = 0; x < width; ++x) {
      const auto& c = colors[x / 16];
      auto* p = rgb.data() + (y * width + x) * 4;
      p[0] = c[2]; p[1] = c[1]; p[2] = c[0]; p[3] = 255;
    }
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = width; desc.Height = height; desc.MipLevels = desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    D3D11_SUBRESOURCE_DATA data{rgb.data(), width * 4, 0};
    ComPtr<ID3D11Texture2D> input, output, staging;
    Check(device->CreateTexture2D(&desc, &data, &input));
    desc.Format = DXGI_FORMAT_NV12;
    Check(device->CreateTexture2D(&desc, nullptr, &output));
    desc.Usage = D3D11_USAGE_STAGING; desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    Check(device->CreateTexture2D(&desc, nullptr, &staging));
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = content.OutputWidth = width;
    content.InputHeight = content.OutputHeight = height;
    content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    ComPtr<ID3D11VideoProcessor> processor;
    Check(video->CreateVideoProcessorEnumerator(&content, &enumerator));
    Check(video->CreateVideoProcessor(enumerator.Get(), 0, &processor));
    if (argc < 3 || std::string(argv[2]) != "--defaults")
      ConfigureCaptureColor(vc.Get(), processor.Get());
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inDesc{};
    inDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    ComPtr<ID3D11VideoProcessorInputView> inView;
    Check(video->CreateVideoProcessorInputView(input.Get(), enumerator.Get(), &inDesc, &inView));
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outDesc{};
    outDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    ComPtr<ID3D11VideoProcessorOutputView> outView;
    Check(video->CreateVideoProcessorOutputView(output.Get(), enumerator.Get(), &outDesc, &outView));
    RECT rect{0,0,width,height};
    vc->VideoProcessorSetStreamSourceRect(processor.Get(), 0, TRUE, &rect);
    vc->VideoProcessorSetStreamDestRect(processor.Get(), 0, TRUE, &rect);
    D3D11_VIDEO_PROCESSOR_STREAM stream{};
    stream.Enable = TRUE; stream.pInputSurface = inView.Get();
    Check(vc->VideoProcessorBlt(processor.Get(), outView.Get(), 0, 1, &stream));
    context->CopyResource(staging.Get(), output.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    Check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped));
    const auto* bytes = static_cast<const unsigned char*>(mapped.pData);
    std::vector<unsigned char> nv12(width * height * 3 / 2);
    for (UINT y = 0; y < height * 3 / 2; ++y)
      std::copy_n(bytes + y * mapped.RowPitch, width, nv12.data() + y * width);
    context->Unmap(staging.Get(), 0);
    if (argc > 1) {
      std::ofstream file(argv[1], std::ios::binary);
      file.write(reinterpret_cast<const char*>(nv12.data()), nv12.size());
      if (!file) throw std::runtime_error("Could not write NV12 fixture");
    }
    bool passed = true;
    for (UINT i = 0; i < colors.size(); ++i) {
      const UINT x = i * 16 + 8, y = 16;
      const int Y = nv12[y * width + x];
      const int U = nv12[width * height + (y / 2) * width + x];
      const int V = nv12[width * height + (y / 2) * width + x + 1];
      const auto& c = colors[i];
      std::cout << "RGB " << int(c[0]) << ',' << int(c[1]) << ',' << int(c[2])
                << " -> YUV " << Y << ',' << U << ',' << V << '\n';
      const double luma = .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
      const int expectedY = static_cast<int>(std::round(16 + 219 * luma / 255));
      const int expectedU = static_cast<int>(std::round(128 + 224 * (c[2] - luma) / (255 * 1.8556)));
      const int expectedV = static_cast<int>(std::round(128 + 224 * (c[0] - luma) / (255 * 1.5748)));
      if (std::abs(Y - expectedY) > 1 || std::abs(U - expectedU) > 1 || std::abs(V - expectedV) > 1) {
        passed = false;
        std::cerr << "Expected limited BT.709 " << expectedY << ',' << expectedU << ',' << expectedV << '\n';
      }
    }
    if (!passed) throw std::runtime_error("Capture color conversion changed pixel levels");
    std::cout << "CAPTURE COLOR PASS\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
